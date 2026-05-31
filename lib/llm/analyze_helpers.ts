import {
  AIInitialAnalysisOutputSchema,
  AIPartialAnalysisOutputSchema,
  AIRefreshAnalysisOutputSchema,
  type AIInitialAnalysisOutput,
  type AIPartialAnalysisOutput,
  type AIRefreshAnalysisOutput,
} from "../schema/analysis";
import type {
  AISuggestion,
  DisplayPriority,
  Suggestion,
} from "../schema/suggestion";
import type {
  AnalyzeInputBundle,
  AnalyzeInputBundleInitial,
  AnalyzeInputBundlePartial,
  AnalyzeInputBundleRefresh,
} from "../schema/input";

// Phase C 防衛三段の Part 3: AI 出力の追加検証 + リトライメッセージ生成。
// Phase D で refresh モードを mode 分岐で受け入れる(キックオフ判断 D-6)。
//   - initial:  AIInitialAnalysisOutputSchema で parse、interview_questions 数チェック有効
//   - refresh:  AIRefreshAnalysisOutputSchema で parse、interview_questions 数チェックは無条件スキップ
//   - partial (Phase G Step 3b-2):  AIPartialAnalysisOutputSchema で parse、updated /
//                                   deleted / added の context-dependent refine も行う
// 他の検証(原文の捏造、evidence_id の捏造、URL 不整合、指摘数超過、数値スコア混入、
// alternative カテゴリの alternatives 空チェック)は全モード共通。

// 検証エラーの判別ユニオン。AI に伝えるためのリトライメッセージはここから組み立てる。
export type ValidationIssue =
  | {
      kind: "schema_format";
      message: string;
      issues: Array<{ path: string; code: string; message: string }>;
    }
  | {
      kind: "original_not_in_es";
      suggestionId: string;
      original: string;
    }
  | {
      kind: "evidence_id_not_approved";
      suggestionId: string;
      evidenceId: string;
    }
  | {
      kind: "url_not_in_company_summary";
      suggestionId: string;
      url: string;
    }
  | {
      kind: "suggestions_over_limit";
      count: number;
    }
  | {
      kind: "numeric_score_in_summary";
      matched: string;
    }
  | {
      kind: "interview_questions_count";
      count: number;
    }
  | {
      kind: "alternative_without_alternatives";
      suggestionId: string;
    }
  // 統合改修パッケージ (2026-05-25): 同領域への複数指摘の検出
  //   全 suggestion の `original` 文字列同士で「片方が他方を完全に含む」または
  //   「部分一致 70% 以上」が成立する場合に検出される。サーバ側は merge を行わず、
  //   AI に「統合 or related_suggestion_ids で関連明示」をリトライ要求する。
  //   1 ペア検出につき 1 issue を起こすが、related_suggestion_ids で互いを明示している
  //   場合は許容(別経路で UI に関連表示できるため、構造的に重複扱いしない)。
  | {
      kind: "original_overlap_detected";
      suggestionAId: string;
      suggestionBId: string;
      overlapRatio: number; // 0.0-1.0、計算根拠を log / UI 説明に使う
      originalA: string;
      originalB: string;
    }
  // Phase G Step 3b-2 (2026-05-23): partial update 専用の context-dependent issue 群
  | {
      // updated に指定された id が既存 suggestions に存在しない
      kind: "partial_updated_id_unknown";
      suggestionId: string;
    }
  | {
      // updated に指定された id の category が元と一致しない
      kind: "partial_updated_category_mismatch";
      suggestionId: string;
      originalCategory: string;
      newCategory: string;
    }
  | {
      // updated に指定された id が「ユーザー採用済 / 編集済 / 却下済」
      kind: "partial_updated_user_handled";
      suggestionId: string;
      userAction: "accepted" | "rejected" | "edited";
    }
  | {
      // deleted に指定された id が既存 suggestions に存在しない(消すものがない)
      kind: "partial_deleted_id_unknown";
      suggestionId: string;
    }
  | {
      // deleted に指定された id が「ユーザー採用済 / 編集済 / 却下済」
      kind: "partial_deleted_user_handled";
      suggestionId: string;
      userAction: "accepted" | "rejected" | "edited";
    }
  | {
      // added に指定された id が既存 suggestions に既に存在する
      kind: "partial_added_id_conflict";
      suggestionId: string;
    }
  | {
      // updated[i].original_span.start が元 span から大きくズレている(別箇所への指摘変更を防ぐ)
      // 実 span 解決後にチェックするため、analyze_helpers では LLM 出力の original 文字列が
      // 元 suggestion の original と「あまりに違う」場合を狙う(span 解決は server の resolve 経路で行う)。
      // ここでは「元 original と完全一致 or 元 original を部分文字列として含む / 含まれる」関係を
      // 必須として「全く別の文字列」を弾く程度の緩い検証に留める(LLM が同箇所の指摘を改良する
      // 経路を許容するため厳格すぎる検証は避ける、dispatch §3-5 を文字列ベースで近似)。
      kind: "partial_updated_original_drift";
      suggestionId: string;
      originalOriginal: string;
      newOriginal: string;
    }
  | {
      // updated + 残存(existing - deleted - user_handled - updated)の合計が 15 件を超過
      kind: "partial_total_over_limit";
      total: number;
    };

// 数値スコア検出の正規表現(initial / refresh 共通):
//  - 「85点」「100点」のような「整数+点」
//  - 「A+」「S」「★3」のようなランク表現(B〜D / S / ★ 系)
//  - 「7/10」「9/10」のような分数スコア
const NUMERIC_SCORE_PATTERNS: RegExp[] = [
  /\d+\s*点/, // N 点(例: 85点)
  /[★☆]\s*\d/, // ★3、★ 4
  /\b[A-D][+\-]?\s*評価/, // A+ 評価、B 評価
  /\b\d+\s*\/\s*10\b/, // 7/10
  /\b\d+\s*\/\s*100\b/, // 85/100
];

// 入力 Bundle から「承認済み evidence_id リスト」を抽出する。
// company_summary が無い、または evidence[] が空のときは空配列。
// initial / refresh で同じロジック(キックオフ D-6)。
export function getApprovedEvidenceIds(input: AnalyzeInputBundle): string[] {
  const summary = input.company_summary;
  if (!summary) return [];
  return summary.evidence.map((ev) => ev.id);
}

// 入力 Bundle から「承認済み source_url リスト」を抽出する(company_value.url 検証用)。
// Phase E 拡張(2026-05-23): 自由テキスト経路で生成された CompanySummary では evidence[].source_url
// が "user-input"(EVIDENCE_SOURCE_USER_INPUT)で揃う。summary.evidence をそのまま map すれば
// その placeholder が承認集合に入り、自由テキスト由来の company_value 指摘でも url が許容される。
function getApprovedCompanyUrls(input: AnalyzeInputBundle): string[] {
  const summary = input.company_summary;
  if (!summary) return [];
  return summary.evidence.map((ev) => ev.source_url);
}

// =============================================================================
// URL 一致判定の正規化(2026-05-24 retry コスト削減 — url_not_in_company_summary
// 起因の false positive を構造的に削減)
// =============================================================================
// 防衛三段の本質は「LLM が承認 URL リストの外側にあるドメイン / path を捏造しない」
// こと。文字列完全一致は表記揺れ(末尾スラッシュ、fragment、tracking query)を全て
// 別 URL 扱いするため、本物の捏造ではない違反で retry が走り Vercel タイムアウトに
// 至っていた(2026-05-24 本番事故、`docs/dispatch/2026-05-24-retry-cost-reduction.md`)。
//
// 一致判定の階層(順に試して、いずれかで一致したら一致とみなす):
//   1. 完全一致(従来の挙動)
//   2. WHATWG URL でパース可能なら正規化(末尾 `/` 統一 + fragment 除去 + tracking
//      query 除去)後の文字列一致
//   3. host が異なる、または path が「前方一致でも後方一致でもない」場合は拒否
//
// 「user-input」のような placeholder は WHATWG URL でパース不能。その場合は手順 1
// の完全一致のみで判定する(自由テキスト経路の整合は壊さない)。
//
// 注意:
//   - host を必ず一致させる(別ドメインへの捏造を防ぐ)
//   - path も完全一致または「正規化後の完全一致」が必須(`/recruit` を `/blog/fake`
//     に書き換える捏造は拒否)
//   - クエリは tracking 系のみ除去(本質的な query は残す)。「ID=xxx」のような
//     非 tracking クエリは引き続き比較対象にする
const TRACKING_QUERY_PARAM_PATTERNS: ReadonlyArray<RegExp> = [
  /^utm_/i, // utm_source, utm_medium, utm_campaign, ...
  /^gclid$/i, // Google Click Identifier
  /^fbclid$/i, // Facebook Click Identifier
  /^mc_eid$/i, // Mailchimp Email ID
  /^mc_cid$/i, // Mailchimp Campaign ID
  /^ref$/i, // 一般的な referrer 識別子
  /^_ga$/i, // GA cookie
  /^yclid$/i, // Yandex Click ID
];

function isTrackingQueryParam(key: string): boolean {
  return TRACKING_QUERY_PARAM_PATTERNS.some((re) => re.test(key));
}

// 1 つの URL を「比較用の正規化形」に変換する。
// パース不能(placeholder 等)なら null を返し、呼び出し側で完全一致のみにフォールバック。
function normalizeUrlForComparison(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  // fragment は無視(anchor は同一ページ扱い)
  parsed.hash = "";

  // tracking query を除去
  const keysToDelete: string[] = [];
  parsed.searchParams.forEach((_, key) => {
    if (isTrackingQueryParam(key)) keysToDelete.push(key);
  });
  for (const k of keysToDelete) parsed.searchParams.delete(k);

  // 末尾スラッシュの正規化: path が `/` で終わるなら剥がす(ただし path 全体が "/" のときは残す)
  let pathname = parsed.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  parsed.pathname = pathname;

  // host は小文字化(URL の host は WHATWG の仕様で既に小文字だが、念のため)
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
}

// 候補 URL が「承認済みリスト中のいずれか」と一致するかを判定する。
// 完全一致 → 正規化後一致 の順に試す。両方とも一致しなければ捏造として扱う。
export function urlMatchesApproved(
  candidate: string,
  approved: ReadonlyArray<string>,
): boolean {
  // 1. 完全一致(高速パス + placeholder("user-input")対応)
  for (const a of approved) {
    if (a === candidate) return true;
  }

  // 2. 正規化後の一致
  const candNorm = normalizeUrlForComparison(candidate);
  if (candNorm === null) {
    // パース不能 — 1. の完全一致しか判定できない。既に 1. で false なので拒否
    return false;
  }
  for (const a of approved) {
    const aNorm = normalizeUrlForComparison(a);
    if (aNorm !== null && aNorm === candNorm) return true;
  }

  // 3. host / path のいずれも合致しない捏造として拒否
  return false;
}

// =============================================================================
// Phase G Step 3b-2 (2026-05-23): ヒューリスティック priority 補正
// =============================================================================
// LLM の internal_priority(1-10)に対してサーバ側でルールベースの補正をかけ、
// 最終的な display_priority(high/medium/low、3 段階文字列タグ)を生成する。
//
// 補正ルール(dispatch §5):
//  0. error は対象外(自動修正済、SuggestionListPanel メインリストに出ない)
//     → display_priority を付与しない(undefined のまま、UI 側でフォールバック表示)
//  1. base = internal_priority(LLM が出さなかった場合は 5 = 標準で fallback)
//  2. rationale_source.type === "company_value" → +2 段階(企業価値接続を強くプッシュ)
//  3. original_span.start < 50 → +1 段階(冒頭部の改善はインパクトが大きい)
//  4. related_suggestion_ids が採用済とマッチ → -1 段階(既に対応領域が動いているため
//     重要度を下げて判断疲労を緩和)
//  5. 補正後 1-10 にクランプ
//  6. 1-3 = low、4-6 = medium、7-10 = high の 3 段階タグに変換
//
// 設計判断:
//  - 数値スコアは UI に絶対渡らない、サーバ計算 → 文字列タグのみ UI に渡る
//  - convention / alternative のみ補正(error は自動修正済、display_priority は不要)
//  - 補正値の妥当性は実機運用後に再評価(数値の根拠は dispatch 推奨値、Phase H で
//    実測 LLM 出力分布を見てチューニング余地あり)
export function applyPriorityHeuristics(args: {
  // v2 Phase B1 (2026-05-26) → B3 (2026-05-26) 本実装:
  // Suggestion.category が "structural" を含むため literal union も拡張。
  // structural は段落単位の構造変更で派生 ES 全体に影響が及ぶため、
  // priority 高め(base high)で評価する(下記 structural 専用分岐参照)。
  category: "error" | "convention" | "alternative" | "structural";
  internalPriority: number | undefined;
  rationaleSourceType: string;
  originalSpanStart: number;
  relatedSuggestionIds: ReadonlyArray<string>;
  acceptedSuggestionIds: ReadonlyArray<string>;
}): DisplayPriority | undefined {
  // 0. error は対象外(自動修正済、SuggestionListPanel メインリストに出ない)
  if (args.category === "error") {
    return undefined;
  }
  // v2 Phase B3 (2026-05-26): structural の優先度判定。
  // 設計判断:
  //  - 構造変更は文単位の書き換えよりも派生 ES への影響範囲が大きい
  //    (段落削除 = 字数削減大、順番変更 = 論理構造改善、統合 = 冗長解消、等)
  //  - operation 別の細分化は overengineering の可能性が高いため、本実装では
  //    structural 全般 = "high" を base とし、関連既採用ペナルティのみ適用する
  //  - 関連既採用ペナルティ: related_suggestion_ids が採用済とマッチ → "medium" に降格
  //    (他カテゴリの -1 ペナルティ相当、判断疲労を緩和)
  //  - 数値スコアは UI に出ない(string tag のみ返却、AGENTS.md L25 遵守)
  //  - operation 別微調整は v3 候補(実機運用後に LLM 出力分布を見てチューニング)
  if (args.category === "structural") {
    const acceptedSet = new Set(args.acceptedSuggestionIds);
    const hasAcceptedRelated = args.relatedSuggestionIds.some((rid) =>
      acceptedSet.has(rid),
    );
    return hasAcceptedRelated ? "medium" : "high";
  }

  // 1. base — LLM が出さなかった場合は中央値 5 で fallback
  let priority = args.internalPriority ?? 5;

  // 2. company_value ブースト
  if (args.rationaleSourceType === "company_value") {
    priority += 2;
  }

  // 3. 冒頭出現位置ブースト
  if (args.originalSpanStart < 50) {
    priority += 1;
  }

  // 4. 重複度ペナルティ(関連指摘が採用済とマッチ)
  const acceptedSet = new Set(args.acceptedSuggestionIds);
  const hasAcceptedRelated = args.relatedSuggestionIds.some((rid) =>
    acceptedSet.has(rid),
  );
  if (hasAcceptedRelated) {
    priority -= 1;
  }

  // 5. クランプ
  if (priority < 1) priority = 1;
  if (priority > 10) priority = 10;

  // 6. 3 段階タグに変換
  if (priority >= 7) return "high";
  if (priority >= 4) return "medium";
  return "low";
}

// 1 件の Suggestion(span 解決済)に対して display_priority を計算 + 付与する。
// 同時に internal_priority は **UI 渡しの前に消す**(同関数で消す経路を統一)。
//
// 設計判断:
//  - applyPriorityHeuristics の入力をまとめる関数として独立
//  - 戻り値は新しい Suggestion(immutable update、原 Suggestion は壊さない)
//  - error の場合 display_priority は undefined のまま(internal_priority も消す)
export function assignDisplayPriority(
  suggestion: Suggestion,
  acceptedSuggestionIds: ReadonlyArray<string>,
): Suggestion {
  const display = applyPriorityHeuristics({
    category: suggestion.category,
    internalPriority: suggestion.internal_priority,
    rationaleSourceType: suggestion.rationale_source.type,
    originalSpanStart: suggestion.original_span.start,
    relatedSuggestionIds: suggestion.related_suggestion_ids,
    acceptedSuggestionIds,
  });
  // internal_priority は UI に渡さないため除去(rest 構文で意図的に分離)。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { internal_priority, ...rest } = suggestion;
  return display !== undefined
    ? { ...rest, display_priority: display }
    : { ...rest };
}

// initial / refresh 共通の意味的検証ロジック。
// 与えられた AI 出力(suggestions と overall_assessment を持つ)に対して、
// 原文の捏造 / evidence_id の捏造 / URL 不整合 / 指摘数超過 / 数値スコア混入 / alternatives 空を検出する。
function collectCommonIssues(
  data: { suggestions: AISuggestion[]; overall_assessment: { summary: string } },
  input: AnalyzeInputBundle,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // 指摘数の上限(Zod max(15) でも弾けるが、ここで明示的に集める)
  if (data.suggestions.length > 15) {
    issues.push({ kind: "suggestions_over_limit", count: data.suggestions.length });
  }

  // 数値スコアの混入を summary に対して走査
  for (const pattern of NUMERIC_SCORE_PATTERNS) {
    const match = data.overall_assessment.summary.match(pattern);
    if (match) {
      issues.push({ kind: "numeric_score_in_summary", matched: match[0] });
      break;
    }
  }

  // 各 suggestion の意味的検証
  const approvedEvidenceIds = new Set(getApprovedEvidenceIds(input));
  const approvedUrls = getApprovedCompanyUrls(input);
  for (const sug of data.suggestions) {
    // alternative カテゴリで alternatives が空(refine でも弾くが二重検出)
    if (sug.category === "alternative" && sug.alternatives.length === 0) {
      issues.push({ kind: "alternative_without_alternatives", suggestionId: sug.id });
    }

    // original が ES 本体に存在するか(複数ヒットの曖昧性は es_anchor.ts で吸収)
    if (!input.es_body.includes(sug.original)) {
      issues.push({
        kind: "original_not_in_es",
        suggestionId: sug.id,
        original: sug.original,
      });
    }

    // company_value のときの evidence_id / url の承認リスト整合
    if (sug.rationale_source.type === "company_value") {
      const src = sug.rationale_source;
      if (src.evidence_id !== undefined && !approvedEvidenceIds.has(src.evidence_id)) {
        issues.push({
          kind: "evidence_id_not_approved",
          suggestionId: sug.id,
          evidenceId: src.evidence_id,
        });
      }
      // url は CompanySummary.evidence[].source_url のいずれかと一致すべき。
      // 2026-05-24: 末尾スラッシュ / fragment / tracking query 等の表記揺れを
      // 正規化してから比較(urlMatchesApproved)。host / path 不一致は引き続き拒否。
      if (!urlMatchesApproved(src.url, approvedUrls)) {
        issues.push({
          kind: "url_not_in_company_summary",
          suggestionId: sug.id,
          url: src.url,
        });
      }
    }
  }

  // 統合改修パッケージ (2026-05-25): 同領域への複数指摘の検出
  //   suggestion ペアの `original` 文字列同士で
  //     片方が他方を完全に含む / 部分一致 70%+ を「overlap」として検出。
  //   ただし両者が互いに related_suggestion_ids で関連明示している場合は
  //   許容(UI が「関連指摘あり」と表示できる構造になっているため)。
  //   検出された場合、AI に「統合 or related で関連明示」をリトライ要求する。
  collectOverlapIssues(data.suggestions, issues);

  return issues;
}

// 統合改修パッケージ (2026-05-25): 同領域複数指摘 overlap 検出 helper
//
// 検出ロジック:
//  1. 全 suggestion ペア(i < j)を走査
//  2. 短い方 / 長い方を判定し、長い方が短い方を完全に含むなら overlap=1.0
//  3. 部分一致は最長共通連続部分文字列(LCS substring)の比率を計算
//  4. 比率 >= 0.7 で overlap と判定
//  5. 両者が related_suggestion_ids で互いを参照している場合は許容(skip)
//  6. 同じ id ペアでも複数 issue 発火を避けるため、1 ペア = 1 issue
//
// 設計判断:
//  - 完全包含: 7文字以上の suggestion 同士で「片方が他方を完全に含む」場合に検出
//    (極短文字列の偶発一致は誤検出になるため最小長閾値を設ける)
//  - 部分一致 70%: 短い方の長さに対する LCS 比率
//  - related_suggestion_ids 双方向参照は許容: 「片方向のみ」だと弱い宣言なので双方向必須
//  - 計算量 O(N^2 × L) は許容(N≤15、L≤200)
function collectOverlapIssues(
  suggestions: ReadonlyArray<AISuggestion>,
  issues: ValidationIssue[],
): void {
  const MIN_LENGTH = 7; // この長さ未満は overlap 判定の対象外(短すぎる偶発一致を弾く)
  const OVERLAP_THRESHOLD = 0.7;

  for (let i = 0; i < suggestions.length; i++) {
    for (let j = i + 1; j < suggestions.length; j++) {
      const a = suggestions[i];
      const b = suggestions[j];
      const aLen = a.original.length;
      const bLen = b.original.length;
      // 双方が MIN_LENGTH 未満なら overlap 判定対象外
      if (aLen < MIN_LENGTH && bLen < MIN_LENGTH) continue;

      // 完全包含チェック: 長い方が短い方を完全に含む
      const [shorter, longer] =
        aLen <= bLen ? [a.original, b.original] : [b.original, a.original];
      let overlapRatio = 0;
      if (longer.includes(shorter) && shorter.length >= MIN_LENGTH) {
        overlapRatio = 1.0;
      } else {
        // 部分一致: 最長共通連続部分文字列の長さ / 短い方の長さ
        const lcs = longestCommonSubstring(a.original, b.original);
        const shortLen = Math.min(aLen, bLen);
        if (shortLen >= MIN_LENGTH) {
          overlapRatio = lcs.length / shortLen;
        }
      }

      if (overlapRatio < OVERLAP_THRESHOLD) continue;

      // 両者が related_suggestion_ids で互いに参照していれば許容(関連明示済)
      const aRefersToB = a.related_suggestion_ids.includes(b.id);
      const bRefersToA = b.related_suggestion_ids.includes(a.id);
      if (aRefersToB && bRefersToA) continue;

      issues.push({
        kind: "original_overlap_detected",
        suggestionAId: a.id,
        suggestionBId: b.id,
        overlapRatio,
        originalA: a.original,
        originalB: b.original,
      });
    }
  }
}

// 2 文字列の最長共通連続部分文字列を返す(空文字なら "")。
// 動的計画法、O(M*N) のシンプル実装(M*N ≤ 200*200 = 40,000 で十分軽量)。
function longestCommonSubstring(a: string, b: string): string {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return "";
  // 行を 2 つだけ持つ rolling DP(メモリ削減)
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);
  let maxLen = 0;
  let maxEnd = 0;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        if (curr[j] > maxLen) {
          maxLen = curr[j];
          maxEnd = i;
        }
      } else {
        curr[j] = 0;
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return a.slice(maxEnd - maxLen, maxEnd);
}

// AI 出力に対する完全検証。違反項目を ValidationIssue[] として返す。
// 第1段階で mode に応じた Schema を safeParse、失敗時は schema_format で1件。
// 第2段階で意味的な制約(共通)+ mode 固有のチェックを検出。
export function validateAnalysisAgainstInput(
  rawOutput: unknown,
  input: AnalyzeInputBundleInitial,
):
  | { ok: true; data: AIInitialAnalysisOutput; issues: [] }
  | { ok: false; issues: ValidationIssue[] };
export function validateAnalysisAgainstInput(
  rawOutput: unknown,
  input: AnalyzeInputBundleRefresh,
):
  | { ok: true; data: AIRefreshAnalysisOutput; issues: [] }
  | { ok: false; issues: ValidationIssue[] };
export function validateAnalysisAgainstInput(
  rawOutput: unknown,
  input: AnalyzeInputBundlePartial,
):
  | { ok: true; data: AIPartialAnalysisOutput; issues: [] }
  | { ok: false; issues: ValidationIssue[] };
export function validateAnalysisAgainstInput(
  rawOutput: unknown,
  input: AnalyzeInputBundle,
):
  | {
      ok: true;
      data:
        | AIInitialAnalysisOutput
        | AIRefreshAnalysisOutput
        | AIPartialAnalysisOutput;
      issues: [];
    }
  | { ok: false; issues: ValidationIssue[] } {
  // mode で parser を切り替える(Phase D 判断 D-6 + Step 3b-2)
  if (input.mode === "initial") {
    const parsed = AIInitialAnalysisOutputSchema.safeParse(rawOutput);
    if (!parsed.success) {
      return {
        ok: false,
        issues: [
          {
            kind: "schema_format",
            message: parsed.error.message,
            issues: parsed.error.issues.slice(0, 12).map((i) => ({
              path: i.path.join(".") || "(root)",
              code: i.code,
              message: i.message,
            })),
          },
        ],
      };
    }

    const data = parsed.data;
    const issues = collectCommonIssues(data, input);

    // initial 専用: interview_questions の件数(Zod min(3)/max(5) でも弾けるが二重検出)
    const qCount = data.interview_questions.questions.length;
    if (qCount < 3 || qCount > 5) {
      issues.push({ kind: "interview_questions_count", count: qCount });
    }

    if (issues.length === 0) {
      return { ok: true, data, issues: [] };
    }
    return { ok: false, issues };
  }

  if (input.mode === "refresh") {
    const parsed = AIRefreshAnalysisOutputSchema.safeParse(rawOutput);
    if (!parsed.success) {
      return {
        ok: false,
        issues: [
          {
            kind: "schema_format",
            message: parsed.error.message,
            issues: parsed.error.issues.slice(0, 12).map((i) => ({
              path: i.path.join(".") || "(root)",
              code: i.code,
              message: i.message,
            })),
          },
        ],
      };
    }

    const data = parsed.data;
    const issues = collectCommonIssues(data, input);
    // refresh では interview_questions チェックを無条件スキップ(キックオフ判断 D-6)

    if (issues.length === 0) {
      return { ok: true, data, issues: [] };
    }
    return { ok: false, issues };
  }

  // partial モード(Phase G Step 3b-2)
  const parsed = AIPartialAnalysisOutputSchema.safeParse(rawOutput);
  if (!parsed.success) {
    return {
      ok: false,
      issues: [
        {
          kind: "schema_format",
          message: parsed.error.message,
          issues: parsed.error.issues.slice(0, 12).map((i) => ({
            path: i.path.join(".") || "(root)",
            code: i.code,
            message: i.message,
          })),
        },
      ],
    };
  }

  const data = parsed.data;
  const issues = collectPartialIssues(data, input);

  if (issues.length === 0) {
    return { ok: true, data, issues: [] };
  }
  return { ok: false, issues };
}

// =============================================================================
// Phase G Step 3b-2 (2026-05-23): partial update 専用の context-dependent 検証
// =============================================================================
// schema レベルでは取れない検証(input bundle の context 必須):
//   - updated/deleted の id が既存 suggestions に存在するか
//   - updated[i].category が元 category と一致するか
//   - updated/deleted がユーザー操作済 id を含んでいないか
//   - added の id が既存と被っていないか(schema 内 refine では updated/deleted との
//     重複だけチェック、existing との重複は context 必須)
//   - updated[i].original が元 suggestion の original から大きくドリフトしていないか
//     (別箇所への指摘変更を防ぐ)
//   - updated + 残存(existing - deleted - user_handled - updated)の合計 ≤ 15
//
// 共通 issue(原文捏造、evidence_id 不正、URL 不整合、数値スコア、alternative 空)も
// updated / added の suggestion[] に対して走査する(collectCommonIssues は input が
// initial/refresh/partial 共通の AnalyzeInputBundle を取るが、overall_assessment を
// 持たないケースを考慮して個別に走らせる必要があるため、partial 用に再実装する)。
//
// Phase G 再修正 (2026-05-24): 副次的な候補プール構造の撤去に伴い、関連する内容改変
// 検出ヘルパは削除。added.length 検証は Zod schema の max(1) + refine 4 で十分
// (schema_format issue として捕捉される)。
function collectPartialIssues(
  data: AIPartialAnalysisOutput,
  input: AnalyzeInputBundlePartial,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // ----- context lookup -----
  const existingById = new Map(
    input.existing_suggestions.map((s) => [s.id, s]),
  );
  const acceptedSet = new Set(input.accepted_suggestion_ids);
  const rejectedSet = new Set(input.rejected_suggestion_ids);
  const editedSet = new Set(input.edited_suggestion_ids);
  function userActionFor(
    id: string,
  ): "accepted" | "rejected" | "edited" | null {
    if (editedSet.has(id)) return "edited";
    if (acceptedSet.has(id)) return "accepted";
    if (rejectedSet.has(id)) return "rejected";
    return null;
  }

  // Phase G 再修正 (2026-05-24): added.length > 1 は Zod schema の max(1) + refine 4 で
  // 弾く(schema_format issue として捕捉)。pool 内 entry 改変検出も削除。

  // ----- updated の検証 -----
  for (const sug of data.updated) {
    // 既存 ID か
    const original = existingById.get(sug.id);
    if (!original) {
      issues.push({ kind: "partial_updated_id_unknown", suggestionId: sug.id });
      continue; // 以降の比較は意味がない
    }
    // category 変更不可
    if (sug.category !== original.category) {
      issues.push({
        kind: "partial_updated_category_mismatch",
        suggestionId: sug.id,
        originalCategory: original.category,
        newCategory: sug.category,
      });
    }
    // ユーザー操作済 id を含んでいないか
    const handled = userActionFor(sug.id);
    if (handled !== null) {
      issues.push({
        kind: "partial_updated_user_handled",
        suggestionId: sug.id,
        userAction: handled,
      });
    }
    // original のドリフト検出(完全別文字列を弾く緩い検証)。
    // 「元 original の前方 / 後方部分文字列」「元 original を含む拡張」「元 original を
    // 部分として持つ縮約」のいずれかに収まらない場合は drift とみなす。
    // ES 本文上の同箇所の指摘改良を許容しつつ、別箇所への指摘変更を弾く。
    const a = original.original;
    const b = sug.original;
    const isSame = a === b;
    const aContainsB = a.includes(b);
    const bContainsA = b.includes(a);
    if (!isSame && !aContainsB && !bContainsA) {
      issues.push({
        kind: "partial_updated_original_drift",
        suggestionId: sug.id,
        originalOriginal: a,
        newOriginal: b,
      });
    }
  }

  // ----- deleted の検証 -----
  for (const id of data.deleted) {
    if (!existingById.has(id)) {
      issues.push({ kind: "partial_deleted_id_unknown", suggestionId: id });
      continue;
    }
    const handled = userActionFor(id);
    if (handled !== null) {
      issues.push({
        kind: "partial_deleted_user_handled",
        suggestionId: id,
        userAction: handled,
      });
    }
  }

  // ----- added の検証 -----
  for (const sug of data.added) {
    if (existingById.has(sug.id)) {
      issues.push({ kind: "partial_added_id_conflict", suggestionId: sug.id });
    }
  }

  // ----- 共通 issue(原文捏造、evidence_id、URL、数値スコア、alternative 空) -----
  // updated + added の各 suggestion について collectCommonIssues 相当の検証を行う。
  // common 検証は AnalyzeInputBundle を引数に取るが、partial は AnalyzeInputBundle に
  // 含まれるため流用可能。overall_assessment は data.overall_assessment(任意)を使う。
  const assessmentForCommon = data.overall_assessment ?? input.overall_assessment;
  const candidateSuggestions = [...data.updated, ...data.added];
  const commonIssues = collectCommonIssues(
    {
      suggestions: candidateSuggestions,
      overall_assessment: assessmentForCommon,
    },
    input,
  );
  issues.push(...commonIssues);

  // ----- 残存 + updated + added の合計上限 -----
  // 残存 = existing - deleted - ユーザー操作済(accepted/rejected/edited は派生 ES に反映済 or
  // ユーザー判断で固定されており、LLM が触る対象ではない。表示上のメインリストには出ない
  // が「全 suggestion 集合」のサイズとして 15 件以下を守るべき)。
  // ただし、ユーザー操作済の id を schema 上 15 件中にどうカウントするかは微妙。dispatch §3-3
  // は「残存 + updated + added」と表現しており、ユーザー操作済も「残存」に含めるのが自然。
  const deletedSet = new Set(data.deleted);
  const updatedIdSet = new Set(data.updated.map((s) => s.id));
  let remaining = 0;
  for (const ex of input.existing_suggestions) {
    if (deletedSet.has(ex.id)) continue;
    if (updatedIdSet.has(ex.id)) continue; // updated に含まれるなら updated 側でカウント
    remaining++;
  }
  const total = remaining + data.updated.length + data.added.length;
  if (total > 15) {
    issues.push({ kind: "partial_total_over_limit", total });
  }

  return issues;
}

// ValidationIssue[] からリトライメッセージを組み立てる。
// research_helpers の buildRetryMessage と同じ精神: 何が違反だったかを具体的に列挙し、
// 修正を1回だけ依頼する。違反の言い回しは丁寧に(LLM が萎縮しないトーン)。
// mode に依存しないので initial / refresh 共通で使える(キックオフ判断 D-6 で確認済み)。
export function buildAnalysisRetryMessage(
  issues: ValidationIssue[],
  input: AnalyzeInputBundle,
): string {
  const approvedIds = getApprovedEvidenceIds(input);
  const modeLabel =
    input.mode === "initial"
      ? "analyze_es"
      : input.mode === "refresh"
        ? "analyze_es_refresh_only"
        : "analyze_es_partial_refresh";
  const lines: string[] = [
    `前回の ${modeLabel} 出力に以下の問題がありました。修正して ${modeLabel} ツールを再度呼んでください。`,
    "",
  ];

  let n = 1;
  for (const issue of issues) {
    switch (issue.kind) {
      case "schema_format":
        lines.push(`${n}. スキーマ違反: ${issue.message}`);
        for (const i of issue.issues.slice(0, 6)) {
          lines.push(`   - ${i.path}: ${i.message}`);
        }
        break;
      case "original_not_in_es":
        lines.push(
          `${n}. suggestion[${issue.suggestionId}].original = "${truncate(issue.original)}" が ES 本体に存在しません。ES 本体と完全一致する文字列を指定してください(部分書き換え・改変は禁止)。`,
        );
        break;
      case "evidence_id_not_approved":
        lines.push(
          `${n}. suggestion[${issue.suggestionId}].rationale_source.evidence_id = "${issue.evidenceId}" は承認 evidence リストに存在しません。`,
        );
        lines.push(
          `   承認済み evidence は ${approvedIds.length === 0 ? "(なし)" : approvedIds.join(", ")} です。company_value 以外の type を選ぶか、上記の ID から選んでください。`,
        );
        break;
      case "url_not_in_company_summary":
        lines.push(
          `${n}. suggestion[${issue.suggestionId}].rationale_source.url = "${issue.url}" は企業要約の evidence の source_url と一致しません。承認済み evidence の source_url のみ使用可能です。`,
        );
        break;
      case "suggestions_over_limit":
        lines.push(
          `${n}. suggestions.length = ${issue.count}(上限15)。優先度の低い指摘を削除して15個以下に絞ってください。`,
        );
        break;
      case "numeric_score_in_summary":
        lines.push(
          `${n}. overall_assessment.summary に数値スコアらしき表現 "${issue.matched}" が混入しています。数値スコア(点・★・ランク・分数)は禁止です。自然語の評価で書き直してください。`,
        );
        break;
      case "interview_questions_count":
        lines.push(
          `${n}. interview_questions.questions.length = ${issue.count}(必須範囲3〜5)。3〜5問に収まるよう調整してください。`,
        );
        break;
      case "alternative_without_alternatives":
        lines.push(
          `${n}. suggestion[${issue.suggestionId}] の category が 'alternative' なのに alternatives 配列が空です。1〜3個の代替表現を追加してください(原文のトーンを保つ案を1つ含めることが望ましい)。`,
        );
        break;
      case "original_overlap_detected":
        lines.push(
          `${n}. suggestion[${issue.suggestionAId}] と suggestion[${issue.suggestionBId}] の original 領域が ${Math.round(
            issue.overlapRatio * 100,
          )}% 以上重なっています。同領域への複数指摘は禁止です。以下のいずれかで修正してください:`,
        );
        lines.push(
          `   (a) 1 つの suggestion に統合する: 多角的観点が必要なら rationale に 2-4 文でまとめて書く`,
        );
        lines.push(
          `   (b) 別 suggestion のまま残す場合は、両者の related_suggestion_ids に互いを **必ず** 含める(片方向のみは不可)`,
        );
        lines.push(
          `   - sug ${issue.suggestionAId} の original: "${truncate(issue.originalA)}"`,
        );
        lines.push(
          `   - sug ${issue.suggestionBId} の original: "${truncate(issue.originalB)}"`,
        );
        break;
      // ---- Phase G Step 3b-2: partial mode 専用 ----
      case "partial_updated_id_unknown":
        lines.push(
          `${n}. updated[].id = "${issue.suggestionId}" は既存 suggestions に存在しません。既存 ID を維持して内容を更新するか、added[] に新規 ID で追加してください。`,
        );
        break;
      case "partial_updated_category_mismatch":
        lines.push(
          `${n}. updated[].id = "${issue.suggestionId}" の category を "${issue.originalCategory}" から "${issue.newCategory}" に変更しています。partial update では category 変更は許可されません(元の category を維持してください)。`,
        );
        break;
      case "partial_updated_user_handled":
        lines.push(
          `${n}. updated[].id = "${issue.suggestionId}" は既にユーザーが ${issue.userAction === "accepted" ? "採用" : issue.userAction === "rejected" ? "却下" : "編集"} 済の suggestion です。ユーザー判断を尊重し、updated に含めないでください。`,
        );
        break;
      case "partial_deleted_id_unknown":
        lines.push(
          `${n}. deleted[] = "${issue.suggestionId}" は既存 suggestions に存在しません(削除対象がない)。`,
        );
        break;
      case "partial_deleted_user_handled":
        lines.push(
          `${n}. deleted[] = "${issue.suggestionId}" は既にユーザーが ${issue.userAction === "accepted" ? "採用" : issue.userAction === "rejected" ? "却下" : "編集"} 済の suggestion です。deleted に含めないでください(ユーザー判断を尊重)。`,
        );
        break;
      case "partial_added_id_conflict":
        lines.push(
          `${n}. added[].id = "${issue.suggestionId}" は既存 suggestions に既に存在します。新規 ID(既存と重複しない sug_NNN)で added してください。`,
        );
        break;
      case "partial_updated_original_drift":
        lines.push(
          `${n}. updated[].id = "${issue.suggestionId}" の original が元 "${truncate(issue.originalOriginal)}" から "${truncate(issue.newOriginal)}" に大きく変わっています。partial update では同箇所の指摘の改良のみを許容し、別箇所への指摘変更は禁止です(必要なら deleted で消して added で新規追加してください)。`,
        );
        break;
      case "partial_total_over_limit":
        lines.push(
          `${n}. 残存 + updated + added の合計 = ${issue.total}(上限15)。優先度の低い指摘を deleted に移すか、added を絞り込んでください。`,
        );
        break;
    }
    n++;
  }

  lines.push(
    "",
    `承認済み evidence ID リスト(再掲): ${approvedIds.length === 0 ? "(なし)" : approvedIds.join(", ")}`,
    "",
    "それ以外の指摘は維持して構いません。",
    "これはリトライの最後のチャンスです。同じ理由で再度失敗すると 502 で終了します。",
  );

  return lines.join("\n");
}

function truncate(s: string, n = 60): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

// 型再エクスポート(呼び出し側が AISuggestion をここから取れるように)
export type { AISuggestion };
