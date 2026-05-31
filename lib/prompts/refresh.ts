// Phase D: refresh モードのユーザーメッセージ構築。
//
// 重要な設計判断:
//  - 新しい system プロンプトを追加しない(Phase C の system.ts を流用)
//  - refresh 固有指示は user メッセージの先頭にまとめる
//  - Anthropic prompt cache の prefix は initial と完全に共有する
//    → fewshot_user / fewshot_assistant_tool_use / 初回 tool_result までは
//      initial と一字一句同じ(provider 側で組み立てる)
//  - es_state_version は LLM に出させない(ツール構造で除外、サーバ側で +1)

import type {
  ActionHistoryEntry,
  AnalyzeInputBundleRefresh,
} from "../schema/input";
import type { CompanySummary, Evidence } from "../schema/company";
import { CLARIFICATION_ENRICHED_INTENT_HEADER } from "../schema/clarification";
import { renderQuestionBlock } from "./question_block";

// 「[これはリフレッシュ要求です]」マーカー + 重要指示セクション(静的)。
const REFRESH_HEADER_AND_INSTRUCTIONS = `[これはリフレッシュ要求です]

ユーザーが前回の指摘に対して以下の操作を行いました。現在のES状態に対して新しい分析を行ってください。

# 重要な指示

- **interview_questions は今回は出力しないでください**(面接質問の更新はユーザートリガーで別途行います。ツール analyze_es_refresh_only には interview_questions プロパティが存在しません)
- 各指摘は、現在のES状態に対して**独立に評価**してください。「他の指摘が採用されている前提」を持たないでください
  - **ただし、\`related_suggestion_ids\` で相互参照される高優先度 suggestion 同士は、採用後の重複や冗長を予測して \`proposed\` を作成してください**(system プロンプト「提案間の重複予測」セクション参照)。完全独立評価は削減モード(reduce_length)等の特殊文脈に限定し、通常のリフレッシュでは「他の高優先度 suggestion 採用時の文脈」を意識してください
- 前回の指摘のうち、現在のES状態でも有効なものは新しいIDで再度含めて構いません(IDの安定性は保証不要)
- 前回提案して、現在のES状態ではもはや該当しない指摘は省いてください
- 新たに浮上した課題があれば追加してください
- **\`structural\` カテゴリの suggestion も refresh 対象**(他カテゴリと同じ規律で関連 ID 整合性 + 重複予測を適用)。ただし structural 同士の「related = 同じ段落 group を扱う」判定は AI に委ねます — 構造変更同士が衝突しないか(例: 同じ段落に対する delete と reorder の同時提案、reorder の new_order が既に削除予定の段落 index を含む等)を確認し、衝突するなら片方を削除するか \`related_suggestion_ids\` で結んでユーザーに「これらは一緒に判断してね」と伝えてください
- ユーザーの過去の操作パターンから書き手の好みを読み取り、提案に反映してください
  - 例: 複数のalternativeを却下している → 元の表現を好む → alternativeを控えめに
  - 例: 「具体性追加」型の指摘を採用している → 具体化を歓迎する → convention系を厚めに
- es_state_version は出力しないでください(サーバ側で付与します)`;

// UX 改修 3b (2026-05-23): 文字数削減モード(goal === "reduce_length")固有の追加指示。
// 通常の refresh(goal === "balanced")ではこのセクションを出さず、削減モード時のみ
// REFRESH_HEADER_AND_INSTRUCTIONS の直後に挿入する。
//
// 設計判断:
//  - 「ES の全面書き換え禁止」を維持しつつ、個別 suggestion の集合として削減提案を出す
//  - 既に採用 / 編集された箇所は触らず、まだ採用されていない箇所や、新規に「短く
//    できる箇所」を見つけて提案する(既存の HITL 判断を覆さない)
//  - proposed は必ず original より短くする(文字数削減が目的のため)
//  - 「指摘間の独立性」原則は維持(他指摘の採用前提を持たない)
function renderReduceLengthInstructions(args: {
  currentLength: number;
  charLimit: number;
}): string {
  const overBy = Math.max(0, args.currentLength - args.charLimit);
  return `# 文字数削減モード(goal = reduce_length)

**最優先目的**: 現在の派生 ES(${args.currentLength}字)を設問の上限(${args.charLimit}字)以内に収める削減提案を出してください(現在 ${overBy} 字超過)。

**新規 suggestion を追加で生成する**:
- 既にユーザーが採用 / 編集した箇所は触らないでください(ユーザーの HITL 判断を尊重)
- まだ採用されていない箇所、または新規に「短くできる箇所」を見つけて提案する
- 削減モードでも各 suggestion は**独立に評価**してください(他の suggestion の採用を前提にしない)

**proposed の規律(削減モード特有)**:
- proposed は必ず original より短くする(文字数を増やす提案は出さない)
- 既存の \`proposed !== original\` 規律はそのまま遵守
- ごく小さな短縮(語尾調整、冗長な助詞・接続詞の削除)も歓迎

**優先的に削る対象**:
- 冗長表現(「〜することができる」「〜という形で」「〜の点について」等)
- 装飾語・修飾語の過剰な重ね(「非常に大きく」「強く深く」等)
- 同じ意味の繰り返し / 重複説明
- 控えめな alternative カテゴリの削減提案も可(原文を否定しない記述で)
- **\`structural\` カテゴリの \`delete_paragraph\` / \`merge_paragraphs\` を積極的に活用**(字数削減の最も効率的な手段。重複段落の削除 / 冗長な段落分割の統合は、文単位の書き換えよりも削減効果が大きい)
- ただし structural の \`delete_paragraph\` / \`merge_paragraphs\` を提案する場合は、\`lost_content\` で「削除 / 統合で失う情報」を必ず明示してください(ユーザーが採用判断する材料を提供。本筋に関わる情報が失われる場合は、文単位の書き換えの方が無難であることもユーザーに見えるようにする)

**保持すべき情報(削ってはいけない)**:
- 数値・固有名詞(企業名、製品名、人名)
- 主述構造(主語と述語の対応)
- 採用済 suggestion の結果(該当箇所の現在のテキスト)
- preserved_voice_note で記録した書き手の個性

**指摘数の目安**: 上限超過分(${overBy} 字)の +50% 字程度を削れる量の提案数を目安とし、最大 15 個以内。`;
}

// =============================================================================
// 2026-05-28 dogfood: 逆質問の回答が存在する refresh での「回答取り込み」専用指示。
// =============================================================================
//
// 「この回答で再分析」は通常 partial 経路(buildPartialBundle)を通るが、analysisResult が
// null 等で refresh stream 経路(buildRefreshBundle)に落ちる理論可能性に備え、refresh 側
// でも回答取り込みを明示する。回答は buildClarificationEnrichedIntent(store)で
// `[逆質問への回答]` ブロックにまとめられ user_context に append される。本ブロックは
// user_context にヘッダが含まれる時 **だけ** header の直後に挿入する(回答が無い通常
// refresh は完全に不変)。捏造防止(回答に書かれた事実のみ使用)は維持する。
const CLARIFICATION_ANSWER_INSTRUCTIONS = `# 逆質問の回答あり — 回答を取り込んだ提案を必ず出す

ユーザーが AI の逆質問に回答しました(回答本文は後述の [ユーザー文脈] 内「${CLARIFICATION_ENRICHED_INTENT_HEADER}」ブロックに Q/A 形式で記載)。これは「この回答で再分析」要求です。今回はこの回答を ES に活かすことが最優先です。

- 回答内容を使って ES の該当箇所を改善する提案を **必ず 1 件以上** 出してください(回答が指す箇所をカバーする指摘を含める)。
- **回答があるのに指摘ゼロ件(=「変更なし」)で返すことは禁止です。**
- 提案には **回答に実際に書かれた事実のみ** を使ってください。回答に書かれていない具体値・数値・固有名詞・エピソードを創作してはいけません。回答が抽象的なら、趣旨に沿って ES を整える範囲に留めます。
- \`rationale\` には「ユーザーの回答(○○)を反映して」と、回答を根拠にしたことが分かる説明を書いてください。
- 回答の見出しが \`sug_XXX\` なら当該箇所、「全体」なら ES 全体 / 結末 / 企業接続など回答が示す論点の該当箇所に使ってください。`;

// user_context 内に逆質問の回答ブロックが含まれるか(= 「この回答で再分析」フロー)を検知。
// producer(buildClarificationEnrichedIntent)が付与する SSOT ヘッダの有無で判定する。
function hasClarificationAnswers(input: AnalyzeInputBundleRefresh): boolean {
  return input.user_context.includes(CLARIFICATION_ENRICHED_INTENT_HEADER);
}

// 出力前の自己チェックリスト(末尾、静的)。docs Section 2 の5項目をそのまま埋め込む。
const REFRESH_SELF_CHECK_LIST = `# 出力前に必ず確認する5項目

1. 指摘が15個を超えていないか
2. 各指摘の rationale_source が実在の根拠に紐づいているか(特に company_value の捏造に注意、evidence_id は承認リスト内のみ)
3. alternative カテゴリで原文を否定するトーンになっていないか / alternatives 配列が1個以上あるか
4. ユーザー添削条件 + 今回のユーザー操作パターンを反映できているか
5. 数値スコアを出していないか + interview_questions を出していないか`;

// action_history を docs Section 3 のフォーマットに変換する。
// LLM が parser として学習しているフォーマットなので、見た目を docs と完全一致させる。
export function formatActionHistory(entries: ActionHistoryEntry[]): string {
  if (entries.length === 0) {
    // 通常は AnalyzeInputBundleRefresh.action_history の min(1) で弾けるが、
    // 万一空が来たら明示的に「(なし)」と書いて LLM が誤解しないようにする。
    return "(操作履歴なし)";
  }
  return entries.map(formatOne).join("\n");
}

function formatOne(entry: ActionHistoryEntry): string {
  if (entry.verb === "DIRECT_EDIT") {
    return `- DIRECT_EDIT: ${entry.description}`;
  }
  if (entry.verb === "EDITED") {
    return `- ${entry.suggestion_id} 「${entry.suggestion_summary}」: EDITED → "${entry.edited_text}"`;
  }
  // ACCEPTED / REJECTED / PENDING
  return `- ${entry.suggestion_id} 「${entry.suggestion_summary}」: ${entry.verb}`;
}

// 動的セクション群: 操作履歴 / 現在のES / 企業要約 / 添削条件 / ユーザー文脈 / 承認済み evidence。
// 初回 (initial.ts) と同じ render 群を、refresh モード固有のメッセージ構造に組み込む。

function renderActionHistoryBlock(entries: ActionHistoryEntry[]): string {
  return ["[ユーザー操作履歴(前回分析以降)]", formatActionHistory(entries)].join(
    "\n",
  );
}

function renderCurrentEsBlock(esBody: string, newVersion: number): string {
  return [`[現在のES状態 v${newVersion}]`, esBody].join("\n");
}

function renderCompanySummaryBlock(summary: CompanySummary | undefined): string {
  if (!summary) {
    return [
      "[企業要約]",
      "(企業URLが未指定のため、企業要約はありません。company_value 系の根拠は使用できません)",
    ].join("\n");
  }
  const lines: string[] = [
    "[企業要約]",
    `企業名: ${summary.company_name}`,
    `事業概要: ${summary.business_summary}`,
  ];
  if (summary.values.length > 0) {
    lines.push(`価値観: ${summary.values.join(", ")}`);
  }
  if (summary.ideal_candidate) {
    lines.push(`求める人物像: ${summary.ideal_candidate}`);
  }
  if (summary.hiring_criteria.length > 0) {
    lines.push(`採用基準: ${summary.hiring_criteria.join(" / ")}`);
  }
  return lines.join("\n");
}

function renderEditConditionsBlock(input: AnalyzeInputBundleRefresh): string {
  const free = input.edit_conditions.free_text.trim();
  return [
    "[添削条件]",
    `プリセット: ${input.edit_conditions.preset}`,
    `自由入力: ${free.length === 0 ? "(なし)" : free}`,
  ].join("\n");
}

function renderUserContextBlock(userContext: string): string {
  const trimmed = userContext.trim();
  return ["[ユーザー文脈]", trimmed.length === 0 ? "(なし)" : trimmed].join("\n");
}

function renderApprovedEvidenceBlock(summary: CompanySummary | undefined): string {
  if (!summary || summary.evidence.length === 0) {
    return [
      "[承認済み evidence]",
      "(なし — 企業要約に evidence が含まれません。rationale_source.evidence_id は出力しないでください)",
    ].join("\n");
  }
  const lines: string[] = ["[承認済み evidence]"];
  lines.push(
    "rationale_source.type === \"company_value\" を出すときは、以下のリストの ID のみを evidence_id に使用してください。リスト外の ID を使うとサーバ側で拒否されます。",
    "",
  );
  for (const ev of summary.evidence) {
    lines.push(renderEvidenceLine(ev));
  }
  return lines.join("\n");
}

function renderEvidenceLine(ev: Evidence): string {
  const claimSnippet = ev.claim.length > 80 ? ev.claim.slice(0, 80) + "…" : ev.claim;
  return `- ${ev.id} [${ev.category}] ${ev.source_url} — ${claimSnippet}`;
}

// refresh モードの user メッセージ全体を構築する。
// セクション順:
//   1. [これはリフレッシュ要求です] + 重要な指示
//   1b. (UX 改修 3b) goal === "reduce_length" 時のみ: 文字数削減モード指示
//   2. [ユーザー操作履歴]
//   3. [現在のES状態 vN+1]
//   4. [企業要約] / [添削条件] / [ユーザー文脈] / [承認済み evidence]
//      → Phase C の会話履歴は「few-shot 用に作った別の入力」なので、参照すべき値を
//        refresh メッセージ側にも明示する(LLM が想起しやすくなる)。
//   5. 出力前に必ず確認する5項目
//
// UX 改修 3b (2026-05-23): goal フィールドで分岐。
//  - "balanced":      従来通り(分岐セクションを挿入しない、既存挙動を維持)
//  - "reduce_length": header の直後に「文字数削減モード」セクションを挿入し、現在の
//    文字数と上限を埋め込む。input.es_body はサーバ受信時点の派生 ES なので、
//    `input.es_body.length` がそのまま「現在の派生 ES の文字数」になる。
export function buildRefreshUserMessage(input: AnalyzeInputBundleRefresh): string {
  const newVersion = input.current_es_version + 1;
  const goal = input.goal ?? "balanced";
  const sections: string[] = [REFRESH_HEADER_AND_INSTRUCTIONS];

  // 削減モードのみ追加指示を挿入(REFRESH_HEADER の直後 = LLM が最も注目する位置)。
  // 2026-05-29 char_limit 任意化: reduce_length は「上限超過の削減」専用モードなので、
  // char_limit が指定されている場合のみ意味を持つ。UI 上、削減ボタンは ES が上限を
  // 超過している(= char_limit がある)ときだけ到達可能だが、防御的に typeof number で
  // ガードする(char_limit 無しなら削減指示を注入しない)。
  if (goal === "reduce_length" && typeof input.question.char_limit === "number") {
    sections.push(
      renderReduceLengthInstructions({
        currentLength: input.es_body.length,
        charLimit: input.question.char_limit,
      }),
    );
  }

  // 2026-05-28 dogfood: 逆質問の回答が含まれる時だけ「回答取り込み」専用指示を header 直後に
  // 挿入(LLM が最も注目する位置)。回答が無い通常 refresh では一切挿入しない(完全不変)。
  const withClarification = hasClarificationAnswers(input);
  if (withClarification) {
    sections.push(CLARIFICATION_ANSWER_INSTRUCTIONS);
  }

  sections.push(
    renderActionHistoryBlock(input.action_history),
    renderCurrentEsBlock(input.es_body, newVersion),
    renderQuestionBlock(input.question.text, input.question.char_limit),
    renderCompanySummaryBlock(input.company_summary),
    renderEditConditionsBlock(input),
    renderUserContextBlock(input.user_context),
    renderApprovedEvidenceBlock(input.company_summary),
    // 回答あり時のみ、自己チェックリストに「回答を取り込んだか / 空で返していないか」を追加。
    withClarification
      ? `${REFRESH_SELF_CHECK_LIST}\n6. 逆質問の回答を取り込んだ指摘を 1 件以上出したか / 回答があるのに指摘ゼロ件で返していないか`
      : REFRESH_SELF_CHECK_LIST,
  );
  return sections.join("\n\n");
}

// action_history の DIRECT_EDIT 有無で trigger を推測する。
// キックオフ判断 D-4 step 7: action_history の特徴で trigger を自動推測。
//   - DIRECT_EDIT を含む → "user_typed_refresh"
//   - それ以外            → "user_action_refresh"
export function inferRefreshTrigger(
  entries: ActionHistoryEntry[],
): "user_action_refresh" | "user_typed_refresh" {
  const hasDirectEdit = entries.some((e) => e.verb === "DIRECT_EDIT");
  return hasDirectEdit ? "user_typed_refresh" : "user_action_refresh";
}
