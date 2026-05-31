import { extractFromUrl, type ExtractErrorKind } from "../utils/url_extract";
import {
  CompanySummarySchema,
  EVIDENCE_SOURCE_USER_INPUT,
  type CompanySummary,
  type ResearchInputSource,
  type ResearchLogEntry,
} from "../schema/company";

// Phase B-2 リファクタ: URL 入力時の初手 fetch をサーバー側で済ませて、
// 初期コンテキストとして user メッセージに埋め込むためのヘルパ。
// OpenAI / Anthropic 両プロバイダで共有する。
//
// DECISION [2026-05-22 セッション3]:
// セッション2 では入力された URL でも LLM が自発的に fetch_page を呼ぶまで
// 待っていた。これだと最初の LLM ラウンドトリップ(数秒)と fetch ラウンドトリップ
// (2〜10秒)が合算され、結果が出るまでに 1〜2 反復(10〜30秒)余計にかかる。
// URL が既に手元にある状況では、サーバー側で先に extractFromUrl を叩いて
// 結果を初期 user メッセージに埋め込むことで、その分の反復を節約できる。

// url_extract のエラー種別を CompanySummary.research_log.fetch.status に変換。
// non_ok_status は HTTP コードを message からパースして 404→not_found / 他 4xx→blocked にマップ。
// 旧 anthropic.ts のローカル関数を共通化したもの。
export function mapFetchErrorStatus(error: {
  kind: ExtractErrorKind;
  message: string;
}): "blocked" | "not_found" | "timeout" | "error" {
  switch (error.kind) {
    case "timeout":
      return "timeout";
    case "non_ok_status": {
      const m = error.message.match(/HTTP (\d{3})/);
      const code = m ? parseInt(m[1], 10) : 0;
      if (code === 404) return "not_found";
      if (code >= 400 && code < 500) return "blocked";
      return "error";
    }
    case "invalid_url":
    case "parse_failed":
    case "empty_content":
    case "fetch_failed":
      return "error";
    default:
      return "error";
  }
}

export type InitialContext = {
  // 取得できたページ本文(8000字以内、url_extract.ts で正規化済み)。なければ null
  content: string | null;
  // 取得した URL(初期 user メッセージで「再 fetch しないで」と明示するために使う)
  url: string | null;
  // 取得したページのタイトル(初期コンテキスト表示用)
  title: string | null;
};

// URL が入力に含まれているとき、サーバー側で先に extractFromUrl を実行し、
// research_log に fetch エントリを積み、本文を InitialContext として返す。
// name 入力のときは何もせず空のコンテキストを返す(エージェントが web_search から始める)。
// 失敗時は研究ログに失敗エントリを残し、content=null で返す(エージェントが
// 別経路で取りにいけるよう、致命的失敗にしない)。
export async function buildInitialContext(
  input: ResearchInputSource,
  researchLog: ResearchLogEntry[],
): Promise<InitialContext> {
  const url =
    input.type === "url"
      ? input.value
      : input.type === "both"
        ? input.url
        : null;

  if (url === null) {
    return { content: null, url: null, title: null };
  }

  const t0 = Date.now();
  const result = await extractFromUrl(url);
  const ms = Date.now() - t0;

  researchLog.push({
    type: "fetch",
    url,
    status: result.ok ? "ok" : mapFetchErrorStatus(result.error),
    extracted_chars: result.ok ? result.data.text.length : null,
    ms,
    timestamp: new Date().toISOString(),
  });

  if (!result.ok) {
    return { content: null, url, title: null };
  }
  return { content: result.data.text, url, title: result.data.title };
}

// 初期 user プロンプトに「先に取った本文」を埋め込む補助テキストを生成。
// content が null なら空文字列を返すので呼び出し側で常にこのヘルパを噛ませて良い。
export function renderInitialContextBlock(ctx: InitialContext): string {
  if (ctx.content === null) {
    return "";
  }
  const titleLine = ctx.title ? `タイトル: ${ctx.title}\n` : "";
  return [
    "",
    "[サーバー側で先に取得した初期コンテキスト]",
    `URL: ${ctx.url}`,
    titleLine + `--- 本文(8000字以内に切り詰め済み) ---`,
    ctx.content,
    "--- 本文ここまで ---",
    "",
    `この URL は既に research_log に記録済みです。同じ URL を再 fetch しないでください。`,
    "追加で必要なページ(採用、技術ブログ、note、直近ニュース等)があれば web_search または fetch_page を使ってください。",
  ].join("\n");
}

// -----------------------------------------------------------------------------
// Phase B-2 ハードニング(セッション4): 承認済み URL リストの動的注入
// -----------------------------------------------------------------------------
// DECISION [2026-05-22 セッション4]:
// セッション3 のスモークテストで「fetch していない URL を source_url として捏造する」
// 事例が 4ターゲット中 2件で観測された。Zod の構造検証で弾けてはいるが、ユーザー視点
// では「失敗」に見える。これを「そもそも起こさせない」ために、毎ターン LLM 側へ
// 「現時点で承認済みの引用元 URL リスト」を明示的に渡し、source_url の選択肢を構造で
// 縛る三段防衛の中核(Part B)を導入。
//
// approvedUrls の典型サイズは 1〜5 件(MAX_FETCHES=5 + 初期 fetch)。トークン消費は
// 数十〜100程度で、自動キャッシングを破壊しない範囲。

// research_log から「承認済み URL = fetch_page で取得に成功した URL」を抽出する。
// 順序は記録順(insertion order)を維持、重複は除去。
// LLM がこの順序で URL を見ることになるので、初期 fetch → 派生 fetch の自然な並びになる。
export function getApprovedUrls(researchLog: ResearchLogEntry[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const entry of researchLog) {
    if (entry.type === "fetch" && entry.status === "ok" && !seen.has(entry.url)) {
      seen.add(entry.url);
      urls.push(entry.url);
    }
  }
  return urls;
}

// 毎ターン LLM に渡す「承認済み引用元 URL リスト」テキスト。
// approvedUrls が空のときは fetch_page を促す文言にする(典型: name 入力で初手未 fetch)。
// 末尾に「規律」セクションを置くことで、AI が submit_summary を呼ぶ直前にこの規律を目にする。
export function buildApprovedListMessage(approvedUrls: string[]): string {
  if (approvedUrls.length === 0) {
    return [
      "[承認済み引用元 URL]",
      "現時点で fetch_page で取得に成功した URL はありません。",
      "submit_summary を呼ぶ前に、引用したい情報を含むページを fetch_page で取得してください。",
      "fetch せずに evidence の source_url を埋めると、その submit は構造検証で拒否されます。",
    ].join("\n");
  }

  return [
    `[現時点で承認済みの引用元 URL(${approvedUrls.length}件)]`,
    "",
    ...approvedUrls.map((u, i) => `${i + 1}. ${u}`),
    "",
    "重要な規律:",
    "- evidence[].source_url は上記リストの URL のみ使用可能です",
    "- 上記に含まれない URL を引用源として記載すると、submit_summary は構造検証で拒否されます",
    "- web_search の結果だけでは引用できません。引用したい URL は必ず fetch_page で取得してください",
    "- 既に取得済みのページから引用する場合、source_url はそのページの URL と完全一致させてください(末尾スラッシュ等の表記揺れも不可)",
  ].join("\n");
}

// -----------------------------------------------------------------------------
// Phase B-2 ハードニング(セッション4): 検証ヘルパ + リトライメッセージ
// -----------------------------------------------------------------------------
// 旧 anthropic.ts / openai.ts に重複していた「enrich + Zod safeParse + 捏造検証」を
// 1関数に集約。失敗時は ValidationError(判別ユニオン)で原因をエージェントへ伝える。

export type ValidationError =
  | {
      kind: "schema_format";
      message: string;
      issues: Array<{ path: string; code: string; message: string }>;
    }
  | {
      kind: "fabricated_source";
      evidenceId: string;
      url: string;
      message: string;
    };

export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ValidationError };

// submit_summary の生出力 + メタ情報を統合した CompanySummary を Zod 検証 + 捏造検証。
// 成功時は完全な CompanySummary を返す。失敗時は ValidationError を返す(throw しない)
// → 呼び出し側でリトライ機構と組み合わせるため。
export function validateSummaryWithSources(
  submittedInput: unknown,
  researchLog: ResearchLogEntry[],
  sourceInput: ResearchInputSource,
  startedAt: string,
  finishedAt: string,
  totalIterations: number,
): ValidationResult<CompanySummary> {
  const enriched = {
    ...(typeof submittedInput === "object" && submittedInput !== null
      ? submittedInput
      : {}),
    research_log: researchLog,
    source_input: sourceInput,
    research_started_at: startedAt,
    research_finished_at: finishedAt,
    total_iterations: totalIterations,
  };

  const parsed = CompanySummarySchema.safeParse(enriched);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 12).map((i) => ({
      path: i.path.join(".") || "(root)",
      code: i.code,
      message: i.message,
    }));
    return {
      ok: false,
      error: {
        kind: "schema_format",
        message: parsed.error.message,
        issues,
      },
    };
  }

  // 捏造禁止の構造検証: 各 evidence.source_url は research_log の status=ok な
  // fetch エントリに完全一致で存在しなければならない。
  const okFetchedUrls = new Set(
    researchLog
      .filter(
        (e): e is Extract<ResearchLogEntry, { type: "fetch" }> =>
          e.type === "fetch" && e.status === "ok",
      )
      .map((e) => e.url),
  );

  for (const ev of parsed.data.evidence) {
    if (!okFetchedUrls.has(ev.source_url)) {
      return {
        ok: false,
        error: {
          kind: "fabricated_source",
          evidenceId: ev.id,
          url: ev.source_url,
          message: `evidence ${ev.id} cites ${ev.source_url} which was not successfully fetched in this session`,
        },
      };
    }
  }

  return { ok: true, data: parsed.data };
}

// Phase E 拡張(2026-05-23): 自由テキスト経路用の検証ヘルパ。
// validateSummaryWithSources は research_log に依存して承認 URL 集合を作るが、自由テキスト
// 経路では research_log は synthesize 1 件のみで承認 URL リストの概念が無い。代わりに以下を検証:
//   1) Zod 構造検証(CompanySummarySchema、緩和後の source_url は min(1) のみ)
//   2) 全 evidence の source_url が EVIDENCE_SOURCE_USER_INPUT と一致
//   3) 全 evidence の source_quote が入力された freetext 内に substring として存在(verbatim)
export function validateFreetextSummary(
  submittedInput: unknown,
  freetext: string,
  researchLog: ResearchLogEntry[],
  sourceInput: ResearchInputSource,
  startedAt: string,
  finishedAt: string,
  totalIterations: number,
): ValidationResult<CompanySummary> {
  const enriched = {
    ...(typeof submittedInput === "object" && submittedInput !== null
      ? submittedInput
      : {}),
    research_log: researchLog,
    source_input: sourceInput,
    research_started_at: startedAt,
    research_finished_at: finishedAt,
    total_iterations: totalIterations,
  };

  const parsed = CompanySummarySchema.safeParse(enriched);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 12).map((i) => ({
      path: i.path.join(".") || "(root)",
      code: i.code,
      message: i.message,
    }));
    return {
      ok: false,
      error: {
        kind: "schema_format",
        message: parsed.error.message,
        issues,
      },
    };
  }

  for (const ev of parsed.data.evidence) {
    // source_url は user-input 固定。LLM が URL を捏造していたら弾く。
    if (ev.source_url !== EVIDENCE_SOURCE_USER_INPUT) {
      return {
        ok: false,
        error: {
          kind: "fabricated_source",
          evidenceId: ev.id,
          url: ev.source_url,
          message: `evidence ${ev.id} の source_url "${ev.source_url}" は自由テキスト経路では使用できません。"${EVIDENCE_SOURCE_USER_INPUT}" を使ってください。`,
        },
      };
    }
    // source_quote は freetext 内に verbatim 存在しなければならない(自由テキスト版の捏造検出)。
    if (!freetext.includes(ev.source_quote)) {
      return {
        ok: false,
        error: {
          kind: "fabricated_source",
          evidenceId: ev.id,
          url: ev.source_url,
          message: `evidence ${ev.id} の source_quote はユーザー入力の自由テキストに verbatim で存在しません(要約・言い換えされている可能性)。原文をそのままコピーした連続区間を使ってください。`,
        },
      };
    }
  }

  return { ok: true, data: parsed.data };
}

// 自由テキスト経路用のリトライメッセージ。承認 URL リストの代わりに「source_url は
// EVIDENCE_SOURCE_USER_INPUT 固定」「source_quote は自由テキスト内 verbatim」の規律を再掲。
export function buildFreetextRetryMessage(error: ValidationError): string {
  const lines: string[] = [
    "あなたの直前の submit_summary は以下の理由で拒否されました:",
    "",
  ];

  switch (error.kind) {
    case "fabricated_source":
      lines.push(
        `evidence ${error.evidenceId}: ${error.message}`,
        "",
        "この evidence を以下のいずれかで修正してください:",
        "  (a) source_url を文字列 \"" + EVIDENCE_SOURCE_USER_INPUT + "\" に変更し、source_quote は自由テキスト内に verbatim で存在する連続区間に書き換える",
        "  (b) この evidence 自体を削除する",
      );
      break;
    case "schema_format":
      lines.push("スキーマ検証エラー:");
      for (const issue of error.issues) {
        lines.push(`- ${issue.path}: ${issue.message}`);
      }
      lines.push(
        "",
        "上記の制約に収まるよう調整して再提出してください。",
        "(参考: hiring_criteria・values は各最大5件、source_quote は20〜800字、claim は10〜600字、evidence は最大20件、business_summary は20〜500字)",
      );
      break;
  }

  lines.push(
    "",
    "自由テキスト経路の規律(再掲):",
    `- evidence[].source_url は文字列 "${EVIDENCE_SOURCE_USER_INPUT}" のみ使用可能`,
    "- evidence[].source_quote は入力された自由テキスト内に verbatim で存在する連続区間のみ使用可能",
    "- 外部知識・推測・要約・言い換えは禁止",
    "",
    "外部の検索や fetch は使えません。手持ちのユーザーメモのみで修正版を submit_summary で再提出してください。",
    "これはリトライの最後のチャンスです。同じ理由で再度失敗すると 503 で終了します。",
  );

  return lines.join("\n");
}

// 検証エラーをエージェントに伝えて再提出を求めるメッセージ。
// approvedUrls を末尾に再掲して「この中から選べ」と明示する(承認リストと矛盾するな)。
// 「新しい fetch は不要」と明記して、リトライで余計なコストを発生させない。
export function buildRetryMessage(
  error: ValidationError,
  approvedUrls: string[],
): string {
  const lines: string[] = [
    "あなたの直前の submit_summary は以下の理由で拒否されました:",
    "",
  ];

  switch (error.kind) {
    case "fabricated_source":
      lines.push(
        `evidence ${error.evidenceId} の source_url "${error.url}" は、本セッションで fetch_page により取得されていません。`,
        "",
        "この evidence を以下のいずれかで修正してください:",
        "  (a) source_url を下記の承認済みリストの URL のいずれかに変更し、その URL に実在する原文を source_quote として記載する",
        "  (b) この evidence 自体を削除する",
      );
      break;
    case "schema_format":
      lines.push("スキーマ検証エラー:");
      for (const issue of error.issues) {
        lines.push(`- ${issue.path}: ${issue.message}`);
      }
      lines.push(
        "",
        "上記の制約に収まるよう調整して再提出してください。",
        "(参考: hiring_criteria・values は各最大5件、source_quote は20〜800字、claim は10〜600字、evidence は最大20件、business_summary は20〜500字)",
      );
      break;
  }

  lines.push(
    "",
    `[現時点で承認済みの引用元 URL(${approvedUrls.length}件)]`,
    approvedUrls.length === 0
      ? "(なし — 引用源を持つ evidence はそもそも提出できません)"
      : approvedUrls.map((u, i) => `${i + 1}. ${u}`).join("\n"),
    "",
    "新しい fetch は不要です。手持ちの情報のみで修正版を submit_summary で再提出してください。",
    "これはリトライの最後のチャンスです。同じ理由で再度失敗すると 503 で終了します。",
  );

  return lines.join("\n");
}
