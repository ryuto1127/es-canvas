/**
 * Phase D スモークテスト(refresh モード)。/api/analyze の refresh 経路に対して以下を確認する:
 *
 *   1) Zod 検証を通過する(AnalysisResultSchema)
 *   2) interview_questions が含まれない(ツール analyze_es_refresh_only の構造的保証の実機確認)
 *   3) es_state_version === current_es_version + 1(サーバ側で +1 付与)
 *   4) metadata.trigger ∈ {"user_action_refresh", "user_typed_refresh"}
 *   5) suggestions.length <= 15
 *   6) 全 suggestion.original が現在の ES 本体に存在(resolveOriginalSpans 経路)
 *   7) overall_assessment.summary に数値スコアが混入していない
 *   8) レイテンシを記録(Sonnet 4.6 で 20〜40 秒目安、Phase C より速いことを観察)
 *
 * 取り上げる fixture(キックオフ判断 D-6 に従い Phase C fixture に action_history を後付け):
 *   - es1_refresh (メルカリ, バランス) — ACCEPTED + REJECTED + DIRECT_EDIT の混合 → trigger=user_typed_refresh
 *   - es4_mitsubishi_refresh (三菱商事, 個性保護) — 複数 REJECTED の alternative パターン → trigger=user_action_refresh
 *
 * 実行方法:
 *   1. .env.local に ANTHROPIC_API_KEY を入れる
 *   2. 別ターミナルで `pnpm dev`
 *   3. このターミナルで `pnpm test:refresh`
 *
 * Phase G Step 2 (2026-05-23): refresh 経路を SSE 化したため、本テストも
 * `consumeAnalyzeResponse` で SSE を受信する形に更新。AnalysisResult は SSE の
 * completed payload から取り出す(analyze.test.ts と同じパターン)。
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
// Phase D: Sonnet 4.6 で 20〜40 秒目安、超過は WARN。Phase C (87〜102s) より速いはず。
const LATENCY_TARGET_MS = 60_000;
// route maxDuration=300 + 30秒バッファ(Phase C と同じテンプレ、キックオフ判断 D-7 AbortSignal)
// Phase G 再修正 (2026-05-24): 副次的な候補プール構造の撤去後も、retry を含めた余裕として
// 600 秒のまま維持。
const FETCH_TIMEOUT_MS = 600_000;

// --save-output: tests/output/{fixture}_{timestamp}.json に生 AnalysisResult を保存。
// Session 7 (議題 #3) で「集計値だけ README に転記、本文 JSON が消失」問題が露見したため追加。
// Day 6 評価セッションで質的レビュー(意味論的整合)を行う際に活用する。
const SAVE_OUTPUT = process.argv.includes("--save-output");
const OUTPUT_DIR = resolve(process.cwd(), "tests/output");

const FIXTURES = [
  {
    label: "es1_refresh (メルカリ, バランス, ACCEPTED+REJECTED+DIRECT_EDIT)",
    file: "es1_refresh_input.json",
    // DIRECT_EDIT を含むので trigger は user_typed_refresh が期待値
    expectedTrigger: "user_typed_refresh" as const,
  },
  {
    label: "es4_mitsubishi_refresh (三菱商事, 個性保護, 複数REJECTED alternative)",
    file: "es4_mitsubishi_refresh_input.json",
    expectedTrigger: "user_action_refresh" as const,
  },
] as const;

type AnalyzeResponse =
  | { data: AnalysisResult }
  | { error: { kind: string; message: string; stage?: string; retryable?: boolean } };

// Phase G Step 2 (2026-05-23): SSE payload 型(server の AnalyzeStreamEvent と同形、
// テスト独立宣言)。started.mode は "initial" | "refresh" の union。
type AnalyzeStreamPayload =
  | {
      type: "started";
      mode: "initial" | "refresh";
      model: string;
      attempt: number;
    }
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
      // AbortSignal.timeout: undici デフォルト挙動より明示的にコントロール(キックオフ D-7)
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const ms = Date.now() - t0;
    const body = await consumeAnalyzeResponse(res);
    return { res, body, ms };
  } catch (err) {
    const ms = Date.now() - t0;
    const causeInfo = renderFetchCause(err);
    const enriched = new Error(
      `fetch ${BASE_URL}/api/analyze failed after ${ms}ms: ${causeInfo}`,
    );
    (enriched as Error & { cause?: unknown }).cause = err;
    throw enriched;
  }
}

// Phase G Step 2: SSE 経路と JSON 経路の両方を扱う(analyze.test.ts と同じパターン)。
//  - refresh も SSE(text/event-stream)を返す → completed/error payload を抽出
//  - JSON エラー(invalid_input 等)が返ったケース → 旧来の AnalyzeResponse そのまま返す
async function consumeAnalyzeResponse(res: Response): Promise<AnalyzeResponse> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
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

// fetch エラーの cause を1行に整形する(analyze.test.ts と同じテンプレ)
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

async function runOne(
  label: string,
  fixtureFile: string,
  expectedTrigger: "user_action_refresh" | "user_typed_refresh",
): Promise<void> {
  console.log(`\n=== ${label} ===`);

  const input = loadFixture(fixtureFile);
  if (input.mode !== "refresh") {
    fail(label, `fixture が refresh モードでない (mode=${input.mode})`);
    return;
  }
  const expectedNewVersion = input.current_es_version + 1;

  const result = await callAnalyze(input);
  console.log(
    `  status=${result.res.status}  ${result.ms}ms  es_body_len=${input.es_body.length}  action_history=${input.action_history.length}`,
  );

  if (isErrorBody(result.body)) {
    fail(label, "analyze refresh returned error", result.body.error);
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
    `  suggestions=${analysis.suggestions.length}, has_iq=${analysis.interview_questions ? "yes" : "no"}, ` +
      `version=${analysis.es_state_version} (expected ${expectedNewVersion}), ` +
      `trigger=${analysis.metadata?.trigger ?? "?"} (expected ${expectedTrigger}), ` +
      `model=${analysis.metadata?.model ?? "?"}`,
  );
  console.log(
    `  tokens=in:${analysis.metadata?.token_usage?.input ?? 0}/out:${analysis.metadata?.token_usage?.output ?? 0}` +
      ` cache_read:${analysis.metadata?.token_usage?.cache_read ?? 0}/cache_creation:${analysis.metadata?.token_usage?.cache_creation ?? 0}`,
  );
  console.log(`  categories: ${describeCategoryCounts(analysis)}`);
  console.log(`  rationale_sources: ${describeRationaleSources(analysis)}`);
  console.log(
    `  preserved_voice_note: "${analysis.overall_assessment.preserved_voice_note}"`,
  );

  // 2. interview_questions が含まれない(構造的保証の実機確認 — キックオフ判断1)
  if (analysis.interview_questions !== undefined) {
    fail(
      label,
      "refresh の出力に interview_questions が含まれている(ツール分割の構造保証が破れた)",
      analysis.interview_questions,
    );
  }

  // 3. es_state_version === current_es_version + 1(キックオフ判断4 のサーバ強制)
  if (analysis.es_state_version !== expectedNewVersion) {
    fail(
      label,
      `es_state_version=${analysis.es_state_version} (期待値 ${expectedNewVersion})`,
    );
  }

  // 4. metadata.trigger の期待値(action_history の特徴から推測)
  if (analysis.metadata?.trigger !== expectedTrigger) {
    fail(
      label,
      `metadata.trigger=${analysis.metadata?.trigger ?? "(none)"} (期待値 ${expectedTrigger})`,
    );
  }

  // 5. 指摘上限
  if (analysis.suggestions.length > 15) {
    fail(label, `suggestions.length=${analysis.suggestions.length} (上限15)`);
  }

  // 6. 全 suggestion.original が現在の ES 本体に存在 + original_span が整合する
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

  // 7. company_value の evidence_id 整合(Phase C と同じ規範を refresh でも適用)
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

  // 8. 数値スコア混入
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

  // 9. レイテンシ
  if (result.ms > LATENCY_TARGET_MS) {
    console.warn(
      `  WARN: latency ${result.ms}ms > ${LATENCY_TARGET_MS}ms target. Sonnet 4.6 で thinking 無しなのに遅い可能性`,
    );
  }
}

async function main() {
  console.log(`Smoke test target: ${BASE_URL}/api/analyze (refresh mode)`);

  // dev server ヘルスチェック
  try {
    await fetch(BASE_URL, { method: "GET" });
  } catch (err) {
    console.error(`\nFAIL: cannot reach ${BASE_URL}. Is \`pnpm dev\` running?\n`, err);
    process.exit(2);
  }

  for (const { label, file, expectedTrigger } of FIXTURES) {
    try {
      await runOne(label, file, expectedTrigger);
    } catch (err) {
      const detail =
        err instanceof Error
          ? `${err.message}${(err as Error & { cause?: unknown }).cause ? "\n      cause=" + renderFetchCause((err as Error & { cause?: unknown }).cause) : ""}`
          : String(err);
      fail(label, "EXCEPTION during test", detail);
    }
  }

  if (failures > 0) {
    console.log(`\n=== Result: FAIL (${failures} failure${failures === 1 ? "" : "s"}) ===`);
  } else {
    console.log("\n=== Result: OK ===");
  }
}

main();
