/**
 * Phase D スモークテスト(/api/interview)。以下を確認する:
 *
 *   1) Zod 検証を通過する(InterviewQuestionsSchema)
 *   2) questions.length が 3〜5 の範囲
 *   3) 全 question.id がユニーク
 *   4) is_stale === false(サーバ側で付与、キックオフ判断4)
 *   5) generated_at_es_version === current_es_version(サーバ側で付与)
 *   6) question 本文に数値スコアが混入していない
 *   7) (目視) 企業要約がある場合、少なくとも 1 問は企業価値観に言及している
 *   8) (目視) 採用された指摘の方向性が反映されているか
 *   9) レイテンシを記録(Sonnet 4.6 で 20〜40 秒目安)
 *
 * 取り上げる fixture:
 *   - es1_interview (メルカリ, バランス, 2件採用)
 *   - es4_mitsubishi_interview (三菱商事, 個性保護, 1件採用)
 *
 * 実行方法:
 *   1. .env.local に ANTHROPIC_API_KEY を入れる
 *   2. 別ターミナルで `pnpm dev`
 *   3. このターミナルで `pnpm test:interview`
 */

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  InterviewQuestionsSchema,
  type InterviewQuestions,
} from "@/lib/schema/interview";
import {
  InterviewInputBundleSchema,
  type InterviewInputBundle,
} from "@/lib/schema/input";

const BASE_URL = process.env.ANALYZE_BASE_URL ?? "http://localhost:3000";
const LATENCY_TARGET_MS = 60_000;
// Phase G 修正 (2026-05-23): retry 経路を考慮した余裕。interview は影響小だが統一。
const FETCH_TIMEOUT_MS = 600_000;

// --save-output: tests/output/{fixture}_{timestamp}.json に生 InterviewQuestions を保存。
// Session 7 (議題 #3) で「集計値だけ README に転記、本文 JSON が消失」問題が露見したため追加。
const SAVE_OUTPUT = process.argv.includes("--save-output");
const OUTPUT_DIR = resolve(process.cwd(), "tests/output");

const FIXTURES = [
  {
    label: "es1_interview (メルカリ, バランス, 2件採用)",
    file: "es1_interview_input.json",
  },
  {
    label: "es4_mitsubishi_interview (三菱商事, 個性保護, 1件採用)",
    file: "es4_mitsubishi_interview_input.json",
  },
] as const;

type InterviewResponse =
  | { data: InterviewQuestions }
  | { error: { kind: string; message: string; stage?: string; retryable?: boolean } };

function loadFixture(file: string): InterviewInputBundle {
  const path = resolve(process.cwd(), "tests/fixtures", file);
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  const parsed = InterviewInputBundleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Fixture ${file} は InterviewInputBundle に整合しない:\n${JSON.stringify(parsed.error.flatten(), null, 2)}`,
    );
  }
  return parsed.data;
}

async function callInterview(input: InterviewInputBundle): Promise<{
  res: Response;
  body: InterviewResponse;
  ms: number;
}> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/api/interview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const ms = Date.now() - t0;
    const body = (await res.json()) as InterviewResponse;
    return { res, body, ms };
  } catch (err) {
    const ms = Date.now() - t0;
    const causeInfo = renderFetchCause(err);
    const enriched = new Error(
      `fetch ${BASE_URL}/api/interview failed after ${ms}ms: ${causeInfo}`,
    );
    (enriched as Error & { cause?: unknown }).cause = err;
    throw enriched;
  }
}

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
  b: InterviewResponse,
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

async function runOne(label: string, fixtureFile: string): Promise<void> {
  console.log(`\n=== ${label} ===`);

  const input = loadFixture(fixtureFile);
  const result = await callInterview(input);
  console.log(
    `  status=${result.res.status}  ${result.ms}ms  es_body_len=${input.es_body.length}  accepted_count=${input.accepted_suggestions_summary.length}`,
  );

  if (isErrorBody(result.body)) {
    fail(label, "interview returned error", result.body.error);
    return;
  }

  // 1. InterviewQuestions スキーマ検証
  const parsed = InterviewQuestionsSchema.safeParse(result.body.data);
  if (!parsed.success) {
    fail(label, "InterviewQuestions schema validation failed", parsed.error.flatten());
    return;
  }
  const iq = parsed.data;
  await saveOutput(fixtureFile, iq);

  console.log(
    `  questions=${iq.questions.length}, generated_at_es_version=${iq.generated_at_es_version} (expected ${input.current_es_version}), is_stale=${iq.is_stale}`,
  );

  // 2. questions.length 範囲(Zod でも弾けるが二重検出)
  if (iq.questions.length < 3 || iq.questions.length > 5) {
    fail(label, `questions.length=${iq.questions.length} (必須範囲 3〜5)`);
  }

  // 3. 全 question.id がユニーク
  const idCounts = new Map<string, number>();
  for (const q of iq.questions) {
    idCounts.set(q.id, (idCounts.get(q.id) ?? 0) + 1);
  }
  const duplicates = [...idCounts.entries()].filter(([, n]) => n >= 2).map(([id]) => id);
  if (duplicates.length > 0) {
    fail(label, `question.id の重複: ${duplicates.join(", ")}`);
  }

  // 4. is_stale === false(サーバ側で付与、キックオフ判断4)
  if (iq.is_stale !== false) {
    fail(label, `is_stale=${iq.is_stale} (期待値 false)`);
  }

  // 5. generated_at_es_version === current_es_version(サーバ側で付与)
  if (iq.generated_at_es_version !== input.current_es_version) {
    fail(
      label,
      `generated_at_es_version=${iq.generated_at_es_version} (期待値 ${input.current_es_version})`,
    );
  }

  // 6. question 本文に数値スコア混入が無いこと
  const NUMERIC_SCORE_PATTERNS = [
    /\d+\s*点/,
    /[★☆]\s*\d/,
    /\b[A-D][+\-]?\s*評価/,
    /\b\d+\s*\/\s*10\b/,
    /\b\d+\s*\/\s*100\b/,
  ];
  for (const q of iq.questions) {
    for (const pattern of NUMERIC_SCORE_PATTERNS) {
      const m = q.question.match(pattern);
      if (m) {
        fail(label, `question[${q.id}] に数値スコアらしき表現 "${m[0]}" が混入`);
        break;
      }
    }
  }

  // 7-8. 目視確認 — 企業価値観への接続 + 採用された方向性の反映
  // 警告レベル(WARN)で出すだけ。自動弾きはしない(false positive 回避)。
  if (input.company_summary !== undefined) {
    const values = input.company_summary.values.map((v) => v.toLowerCase());
    const companyName = input.company_summary.company_name.toLowerCase();
    const matched = iq.questions.find((q) => {
      const text = q.question.toLowerCase();
      return (
        text.includes(companyName) ||
        values.some((v) => v.length >= 2 && text.includes(v))
      );
    });
    if (!matched) {
      console.warn(
        `  WARN: 企業要約があるのに、企業価値観 / 社名に明示的に言及する質問が見当たりません(目視確認必要)`,
      );
    }
  }

  // 質問内容を全件ダンプ(目視確認用)
  for (const q of iq.questions) {
    console.log(`  - ${q.id}: ${q.question}`);
  }

  // 9. レイテンシ
  if (result.ms > LATENCY_TARGET_MS) {
    console.warn(
      `  WARN: latency ${result.ms}ms > ${LATENCY_TARGET_MS}ms target.`,
    );
  }
}

async function main() {
  console.log(`Smoke test target: ${BASE_URL}/api/interview`);

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
