/**
 * Phase C スモークテスト。/api/analyze の initial モードに対して以下を確認する:
 *
 *   1) Zod 検証を通過する(AnalysisResultSchema)
 *   2) suggestions.length <= 15
 *   3) すべての suggestion.original が ES 本体に存在し、original_span が解決されている
 *   4) rationale_source.type === "company_value" の指摘で evidence_id が指定されている場合、
 *      承認済み evidence リストに存在する
 *   5) interview_questions.questions.length が 3〜5
 *   6) overall_assessment.summary に数値スコアが混入していない
 *   7) レイテンシを記録(目標 90秒以内、Sonnet 4.6 で 30〜180秒見込み、2026-05-24 Opus → Sonnet 切替)
 *   8) cache_read / cache_creation トークン数を記録
 *
 * 取り上げる ES は test_es_v1.md の 5本のうち 2本:
 *   - es1_high_quality (メルカリ, バランス) — AI の自制(指摘5個前後、alternative 中心)を見る
 *   - es4_strong_voice (三菱商事, 個性保護) — preserved_voice_note 認識と alternative 控えめを見る
 *
 * 実行方法:
 *   1. .env.local に ANTHROPIC_API_KEY を入れる
 *   2. 別ターミナルで `pnpm dev`
 *   3. このターミナルで `pnpm test:analyze`
 *
 * 防衛三段の発火検証は同ファイル末尾の SKIP_RETRY_TEST(env で有効化、コミットには含めるが通常実行はスキップ)。
 */

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AnalysisResultSchema,
  type AnalysisResult,
} from "@/lib/schema/analysis";
import {
  AnalyzeInputBundleSchema,
  type AnalyzeInputBundle,
} from "@/lib/schema/input";

const BASE_URL = process.env.ANALYZE_BASE_URL ?? "http://localhost:3000";
const LATENCY_TARGET_MS = 90_000; // 60〜90秒目標、超過は WARN
// fetch のクライアント側タイムアウト。Node の undici デフォルト(headers 待ち 300s)を上書きして
// 明示的に長めの上限を設ける。
// Phase G 再修正 (2026-05-24): 副次的な候補プール構造の撤去後は出力 token が減るが、
// retry 込みの安全マージンとして 600 秒は維持(Opus の初回 retry 余裕)。
const FETCH_TIMEOUT_MS = 600_000;

// --save-output: tests/output/{fixture}_{timestamp}.json に生 AnalysisResult を保存。
// Session 7 (議題 #3) で「集計値だけ README に転記、本文 JSON が消失」問題が露見したため追加。
// Day 6 評価セッションで質的レビュー(意味論的整合)を行う際に活用する。
const SAVE_OUTPUT = process.argv.includes("--save-output");
const OUTPUT_DIR = resolve(process.cwd(), "tests/output");
const FIXTURES = [
  {
    label: "es1 (メルカリ, バランス, 完成度高)",
    file: "es1_high_quality_input.json",
  },
  {
    label: "es4 (三菱商事, 個性保護, 強い個人トーン)",
    file: "es4_strong_voice_input.json",
  },
] as const;

type AnalyzeResponse =
  | { data: AnalysisResult }
  | { error: { kind: string; message: string; stage?: string; retryable?: boolean } };

// Phase G Step 1 (2026-05-23): initial 経路は SSE。test 側も SSE を消費して
// completed payload から AnalysisResult を取り出す。refresh 経路(tests/refresh.test.ts)
// は既存 JSON のまま(Step 2 で SSE 化される際に refresh.test.ts も同様の更新)。
//
// SSE payload 型(本 dispatch の anthropic.ts:AnalyzeStreamEvent と同形、テスト独立宣言)
type AnalyzeStreamPayload =
  | { type: "started"; mode: "initial"; model: string; attempt: number }
  | { type: "thinking"; delta: string }
  | { type: "tool_progress"; cumulativeChars: number }
  | { type: "retry"; issueKinds: string[] }
  | { type: "completed"; result: AnalysisResult }
  | {
      type: "error";
      kind: string;
      message: string;
      stage?: string;
      retryable?: boolean;
    };

function loadFixture(file: string): AnalyzeInputBundle {
  const path = resolve(process.cwd(), "tests/fixtures", file);
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  const parsed = AnalyzeInputBundleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Fixture ${file} は AnalyzeInputBundle に整合しない:\n${JSON.stringify(parsed.error.flatten(), null, 2)}`,
    );
  }
  return parsed.data;
}

async function callAnalyze(input: AnalyzeInputBundle): Promise<{
  res: Response;
  body: AnalyzeResponse;
  ms: number;
}> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/api/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(input),
      // AbortSignal.timeout: undici のデフォルト挙動より明示的にコントロール可能。
      // 330秒(route maxDuration 300秒 + 30秒のバッファ)。
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const ms = Date.now() - t0;
    const body = await consumeAnalyzeResponse(res);
    return { res, body, ms };
  } catch (err) {
    const ms = Date.now() - t0;
    // Node fetch (undici) のエラーは err.cause にネットワーク詳細を入れる。
    // "fetch failed" だけでは原因(ECONNREFUSED / ECONNRESET / timeout / TLS / DNS)が
    // 切り分けられないので、cause を解きほぐして再 throw する。
    const causeInfo = renderFetchCause(err);
    const enriched = new Error(
      `fetch ${BASE_URL}/api/analyze failed after ${ms}ms: ${causeInfo}`,
    );
    (enriched as Error & { cause?: unknown }).cause = err;
    throw enriched;
  }
}

// SSE 経路と JSON 経路の両方を扱う。
//  - initial: SSE(text/event-stream)を読んで completed/error payload から AnalyzeResponse 同形を返す
//  - JSON エラー(invalid_input 等)が返ったケース(content-type が application/json):
//    旧来の AnalyzeResponse そのままを返す
async function consumeAnalyzeResponse(res: Response): Promise<AnalyzeResponse> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    // 旧 JSON 応答(input validation エラー等)
    return (await res.json()) as AnalyzeResponse;
  }
  if (!res.body) {
    return {
      error: {
        kind: "bad_response",
        message: "SSE response has no body",
      },
    };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let lastResult: AnalysisResult | null = null;
  let lastError: AnalyzeStreamPayload | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator: number;
    while ((separator = findSeparator(buffer)) >= 0) {
      const rawEvent = buffer.slice(0, separator);
      const sepLen = buffer
        .slice(separator, separator + 4)
        .startsWith("\r\n\r\n")
        ? 4
        : 2;
      buffer = buffer.slice(separator + sepLen);

      const dataLines = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"));
      if (dataLines.length === 0) continue;
      const dataStr = dataLines
        .map((line) => line.slice("data:".length).replace(/^\s/, ""))
        .join("\n");
      if (dataStr.length === 0) continue;
      let payload: AnalyzeStreamPayload;
      try {
        payload = JSON.parse(dataStr) as AnalyzeStreamPayload;
      } catch {
        continue;
      }
      if (payload.type === "completed") {
        lastResult = payload.result;
      } else if (payload.type === "error") {
        lastError = payload;
      }
    }
  }
  if (lastResult) return { data: lastResult };
  if (lastError && lastError.type === "error") {
    return {
      error: {
        kind: lastError.kind,
        message: lastError.message,
        stage: lastError.stage,
        retryable: lastError.retryable,
      },
    };
  }
  return {
    error: {
      kind: "bad_response",
      message: "SSE が completed / error を返さずに終了",
    },
  };
}

function findSeparator(buffer: string): number {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf < 0) return lf;
  if (lf < 0) return crlf;
  return Math.min(crlf, lf);
}

// fetch エラーの cause を1行に整形する。
// 主な期待値:
//   - { code: "UND_ERR_HEADERS_TIMEOUT" }   undici の headers タイムアウト
//   - { code: "UND_ERR_BODY_TIMEOUT" }      undici の body タイムアウト
//   - { code: "ECONNRESET" }                サーバ側が接続を切った(dev HMR 再起動の典型)
//   - { code: "ECONNREFUSED" }              dev server 停止中
//   - DOMException name=AbortError          AbortSignal.timeout が発火(超過時)
function renderFetchCause(err: unknown): string {
  if (err instanceof Error) {
    const e = err as Error & { cause?: unknown; code?: string };
    const parts: string[] = [e.name];
    if (e.message) parts.push(e.message);
    if (e.cause) {
      const c = e.cause as { name?: string; code?: string; message?: string; errno?: number };
      const causeParts: string[] = [];
      if (c.name) causeParts.push(c.name);
      if (c.code) causeParts.push(`code=${c.code}`);
      if (typeof c.errno === "number") causeParts.push(`errno=${c.errno}`);
      if (c.message) causeParts.push(c.message);
      parts.push(`cause={${causeParts.join(" ")}}`);
    }
    if (e.code && !parts.some((p) => p.includes("code="))) parts.push(`code=${e.code}`);
    return parts.join(" / ");
  }
  return String(err);
}

function isErrorBody(
  b: AnalyzeResponse,
): b is { error: { kind: string; message: string; stage?: string; retryable?: boolean } } {
  return "error" in b;
}

async function saveOutput(fixtureName: string, payload: unknown): Promise<void> {
  if (!SAVE_OUTPUT) return;
  await mkdir(OUTPUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const base = fixtureName.replace(/\.json$/, "");
  const path = resolve(OUTPUT_DIR, `${base}_${ts}.json`);
  await writeFile(path, JSON.stringify(payload, null, 2));
  console.log(`  saved output -> ${path}`);
}

let failures = 0;
function fail(label: string, msg: string, extra?: unknown): void {
  console.error(`  FAIL [${label}]: ${msg}`);
  if (extra !== undefined) {
    console.error(
      "    extra:",
      typeof extra === "string" ? extra : JSON.stringify(extra, null, 2),
    );
  }
  failures++;
  process.exitCode = 1;
}

// suggestion カテゴリ別カウントを表示(Phase G で段階的レビューに使う想定の前準備)
function describeCategoryCounts(result: AnalysisResult): string {
  const counts: Record<string, number> = {};
  for (const s of result.suggestions) {
    counts[s.category] = (counts[s.category] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
}

function describeRationaleSources(result: AnalysisResult): string {
  const counts: Record<string, number> = {};
  for (const s of result.suggestions) {
    const t = s.rationale_source.type;
    counts[t] = (counts[t] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
}

async function runOne(label: string, fixtureFile: string): Promise<void> {
  console.log(`\n=== ${label} ===`);

  const input = loadFixture(fixtureFile);
  const result = await callAnalyze(input);
  console.log(
    `  status=${result.res.status}  ${result.ms}ms  es_body_len=${input.es_body.length}`,
  );

  if (isErrorBody(result.body)) {
    fail(label, "analyze returned error", result.body.error);
    return;
  }

  // 1. AnalysisResult スキーマ検証
  const parsed = AnalysisResultSchema.safeParse(result.body.data);
  if (!parsed.success) {
    fail(label, "AnalysisResult schema validation failed", parsed.error.flatten());
    return;
  }
  const analysis = parsed.data;
  await saveOutput(fixtureFile, analysis);

  console.log(
    `  suggestions=${analysis.suggestions.length}, questions=${analysis.interview_questions?.questions.length ?? 0}, ` +
      `model=${analysis.metadata?.model ?? "?"}, tokens=in:${analysis.metadata?.token_usage?.input ?? 0}/out:${analysis.metadata?.token_usage?.output ?? 0}` +
      ` cache_read:${analysis.metadata?.token_usage?.cache_read ?? 0}/cache_creation:${analysis.metadata?.token_usage?.cache_creation ?? 0}`,
  );
  console.log(`  categories: ${describeCategoryCounts(analysis)}`);
  console.log(`  rationale_sources: ${describeRationaleSources(analysis)}`);
  console.log(
    `  preserved_voice_note: "${analysis.overall_assessment.preserved_voice_note}"`,
  );

  // 2. 指摘上限
  if (analysis.suggestions.length > 15) {
    fail(label, `suggestions.length=${analysis.suggestions.length} (上限15)`);
  }

  // Phase G 再修正 (2026-05-24): 副次的な候補プール構造の検証は撤去。
  // suggestions 単一配列で「必要な数だけ」を出す設計。

  // 3. 全 suggestion.original が ES 本体に存在 + original_span が整合する
  for (const sug of analysis.suggestions) {
    const idx = input.es_body.indexOf(sug.original);
    if (idx < 0) {
      fail(label, `suggestion ${sug.id} の original が ES 本体に存在しない`, {
        original: sug.original,
      });
      continue;
    }
    if (sug.original_span.start < 0 || sug.original_span.end <= sug.original_span.start) {
      fail(label, `suggestion ${sug.id} の original_span が不整合`, sug.original_span);
      continue;
    }
    const slice = input.es_body.slice(sug.original_span.start, sug.original_span.end);
    if (slice !== sug.original) {
      fail(
        label,
        `suggestion ${sug.id} の original_span が original 文字列と不一致`,
        { original: sug.original, slice, span: sug.original_span },
      );
    }
  }

  // 4. company_value の evidence_id 整合
  const approvedIds = new Set(
    (input.company_summary?.evidence ?? []).map((ev) => ev.id),
  );
  const approvedUrls = new Set(
    (input.company_summary?.evidence ?? []).map((ev) => ev.source_url),
  );
  for (const sug of analysis.suggestions) {
    if (sug.rationale_source.type === "company_value") {
      const src = sug.rationale_source;
      if (src.evidence_id !== undefined && !approvedIds.has(src.evidence_id)) {
        fail(
          label,
          `suggestion ${sug.id} の evidence_id="${src.evidence_id}" が承認リストに無い`,
        );
      }
      if (!approvedUrls.has(src.url)) {
        fail(
          label,
          `suggestion ${sug.id} の url="${src.url}" が承認済み evidence の source_url に無い`,
        );
      }
    }
  }

  // 5. interview_questions の件数
  const qLen = analysis.interview_questions?.questions.length ?? 0;
  if (qLen < 3 || qLen > 5) {
    fail(label, `interview_questions.questions.length=${qLen} (必須範囲3〜5)`);
  }

  // 6. 数値スコア混入
  const NUMERIC_SCORE_PATTERNS = [
    /\d+\s*点/,
    /[★☆]\s*\d/,
    /\b[A-D][+\-]?\s*評価/,
    /\b\d+\s*\/\s*10\b/,
    /\b\d+\s*\/\s*100\b/,
  ];
  for (const pattern of NUMERIC_SCORE_PATTERNS) {
    const m = analysis.overall_assessment.summary.match(pattern);
    if (m) {
      fail(label, `summary に数値スコアらしき表現 "${m[0]}" が混入`);
      break;
    }
  }

  // 7. レイテンシ
  if (result.ms > LATENCY_TARGET_MS) {
    console.warn(
      `  WARN: latency ${result.ms}ms > ${LATENCY_TARGET_MS}ms target.` +
        ` adaptive thinking + 構造化出力で多重 LLM 思考が走っている可能性`,
    );
  }
}

// 防衛三段(リトライ)の発火検証。
// 通常実行ではスキップ(コスト・レイテンシ増を避ける)。env RUN_RETRY_TEST=1 で有効化。
async function runRetryFiringTest(): Promise<void> {
  if (process.env.RUN_RETRY_TEST !== "1") {
    console.log("\n=== retry firing test: SKIPPED (set RUN_RETRY_TEST=1 to run) ===");
    return;
  }
  console.log("\n=== retry firing test (intentional original corruption) ===");

  // es1 を読み込み、es_body を意図的に書き換えて「LLM が出すであろう original」が
  // ES 本体に存在しない状態を作る。LLM が few-shot の sug_001〜005 を踏襲して
  // 「頑張った」「達成感を感じました」等を original に書いた瞬間、validateAnalysisAgainstInput
  // の original_not_in_es が発火する想定。
  const base = loadFixture("es1_high_quality_input.json");
  const corrupted: AnalyzeInputBundle = {
    ...base,
    // 完全に別の話題に置き換え、few-shot 由来の動詞・表現が一切含まれない
    es_body:
      "私の研究はバイオインフォマティクスの領域で、ゲノム配列の比較解析を専門としています。系統樹構築の精度向上に貢献するアルゴリズムを開発し、国際学会で発表しました。",
  };
  const result = await callAnalyze(corrupted);
  console.log(
    `  status=${result.res.status}  ${result.ms}ms` +
      ` body_kind=${"data" in result.body ? "data" : `error:${result.body.error.kind}`}`,
  );
  // 期待: LLM がうまく適応して通過するケースもあれば、リトライ後 502 で落ちるケースもある。
  // ここでは「サーバが落ちず、データかエラーが返る」だけを確認(リトライ機構の存在の最低限の証跡)。
  if (result.res.status >= 500 && result.res.status !== 502) {
    fail("retry firing test", `unexpected 5xx status ${result.res.status}`);
  }
}

async function main() {
  console.log(`Smoke test target: ${BASE_URL}/api/analyze`);

  // dev server ヘルスチェック
  try {
    await fetch(BASE_URL, { method: "GET" });
  } catch (err) {
    console.error(`\nFAIL: cannot reach ${BASE_URL}. Is \`pnpm dev\` running?\n`, err);
    process.exit(2);
  }

  for (const { label, file } of FIXTURES) {
    try {
      await runOne(label, file);
    } catch (err) {
      // callAnalyze は cause を enriched Error として再 throw する。ここで cause も含めて吐く。
      const detail =
        err instanceof Error
          ? `${err.message}${(err as Error & { cause?: unknown }).cause ? "\n      cause=" + renderFetchCause((err as Error & { cause?: unknown }).cause) : ""}`
          : String(err);
      fail(label, "EXCEPTION during test", detail);
    }
  }

  await runRetryFiringTest();

  if (failures > 0) {
    console.log(`\n=== Result: FAIL (${failures} failure${failures === 1 ? "" : "s"}) ===`);
  } else {
    console.log("\n=== Result: OK ===");
  }
}

main();
