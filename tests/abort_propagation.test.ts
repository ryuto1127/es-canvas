/**
 * abort 伝搬の単体検証 — 提出後改善 #2 (2026-06-09)。
 *
 * 破棄された refresh/partial の OpenAI 生成を停止する(課金停止)ため、route → provider →
 * `responses.stream(body, { signal })` の末端まで AbortSignal が届くことを担保する。
 *
 * 本テストは OpenAI SDK を **ネットワークなしでスタブ** し、provider の streaming メソッドに
 * 渡した signal が末端の `responses.stream` の RequestOptions.signal にそのまま forward される
 * ことを検証する。実際の OpenAI 呼び出しはしない(API 費用ゼロ、ライブ LLM テスト不実施方針)。
 *
 * 検証ポイント:
 *  1. provider.analyzeRefreshStream(input, signal) → client.responses.stream の
 *     options.signal === 渡した signal(参照一致)
 *  2. provider.analyzePartialStream(input, signal) でも同様(同じ runResponseStream 経路)
 *  3. signal === undefined(initial / 将来 caller)でも stream は呼ばれる(options.signal
 *     は undefined、streaming 自体は機能)
 *  4. signal が既に aborted のとき、generator は error frame を流さず静かに return する
 *
 * 実行方法: `tsx tests/abort_propagation.test.ts`(net 呼び出しなし、ローカル即時実行)
 *
 * SSOT: lib/llm/openai.ts:runResponseStream / analyze{Refresh,Partial}StreamingOpenAI
 *       app/api/analyze/route.ts(req.signal / cancel() → upstreamAbort → generator)
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { OpenAIProvider } from "@/lib/llm/openai";
import {
  AnalyzeInputBundleSchema,
  type AnalyzeInputBundle,
} from "@/lib/schema/input";
import type { Suggestion } from "@/lib/schema/suggestion";

const __dirname = dirname(fileURLToPath(import.meta.url));

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passCount += 1;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (e) {
    failCount += 1;
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`  FAIL  ${name}\n        ${msg}`);
    process.stdout.write(`  FAIL ${name}\n        ${msg}\n`);
  }
}

// -----------------------------------------------------------------------------
// fixtures / helpers
// -----------------------------------------------------------------------------
function loadRefreshFixture(): AnalyzeInputBundle {
  const raw = JSON.parse(
    readFileSync(join(__dirname, "fixtures", "es1_refresh_input.json"), "utf-8"),
  );
  const parsed = AnalyzeInputBundleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `refresh fixture が AnalyzeInputBundle に整合しない:\n${JSON.stringify(parsed.error.flatten(), null, 2)}`,
    );
  }
  return parsed.data;
}

// partial input を refresh fixture から最小構成で派生(existing_suggestions を 1 件供給)。
// span 解決済の Suggestion を 1 件だけ作り、partial モードに必要な追加フィールドを足す。
function derivePartialInput(refresh: AnalyzeInputBundle): AnalyzeInputBundle {
  if (refresh.mode !== "refresh") throw new Error("expected refresh fixture");
  const esBody = refresh.es_body;
  const original = esBody.slice(0, 12);
  const sample: Suggestion = {
    id: "sug_001",
    category: "convention",
    original,
    proposed: `${original}(より具体的に)`,
    alternatives: [],
    rationale: "抽象的なので具体化の余地がある",
    rationale_source: { type: "convention", reference: "一般的な ES 添削の慣行" },
    related_suggestion_ids: [],
    original_span: { start: 0, end: original.length },
  };
  const partial = {
    mode: "partial" as const,
    es_body: esBody,
    question: refresh.question,
    company_summary: refresh.company_summary,
    edit_conditions: refresh.edit_conditions,
    user_context: refresh.user_context,
    current_es_version: refresh.current_es_version,
    action_history: refresh.action_history,
    existing_suggestions: [sample],
    overall_assessment: {
      summary: "全体としては良い構成。",
      strengths: ["具体性がある"],
      weaknesses: ["抽象度がやや高い"],
      preserved_voice_note: "語り口は維持されている。",
    },
    accepted_suggestion_ids: [],
    rejected_suggestion_ids: [],
    edited_suggestion_ids: [],
    seed_suggestion_ids: ["sug_001"],
    seed_action_type: "reject" as const,
  };
  const parsed = AnalyzeInputBundleSchema.safeParse(partial);
  if (!parsed.success) {
    throw new Error(
      `派生 partial input が schema に整合しない:\n${JSON.stringify(parsed.error.flatten(), null, 2)}`,
    );
  }
  return parsed.data;
}

// OpenAIProvider の private client.responses.stream を差し替え、options.signal を捕捉する。
// 返す擬似 stream の finalResponse() は「tool call 無し」の最小 Response を返す
// (generator はその後 error を yield するが、本テストは signal 捕捉のみを検証する)。
function stubProviderStream(provider: OpenAIProvider): {
  capturedSignals: Array<AbortSignal | null | undefined>;
  callCount: () => number;
} {
  const capturedSignals: Array<AbortSignal | null | undefined> = [];
  // private field へアクセスするため unknown 経由で cast(テスト専用)。
  const client = (provider as unknown as { client: { responses: unknown } })
    .client;
  (client.responses as { stream: unknown }).stream = (
    _body: unknown,
    options?: { signal?: AbortSignal | null },
  ) => {
    capturedSignals.push(options ? options.signal : undefined);
    return {
      // generator は finalResponse() を await して Response を得る。
      async finalResponse() {
        return {
          output: [],
          usage: { input_tokens: 0, output_tokens: 0 },
          status: "completed",
        };
      },
    };
  };
  return { capturedSignals, callCount: () => capturedSignals.length };
}

// generator を最後まで drain(error frame を含む全 event を消費)。
async function drain(
  gen: AsyncGenerator<unknown, void, void>,
): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const ev of gen) {
    events.push(ev);
  }
  return events;
}

const FAKE_KEY = "sk-test-fake-key-not-used";

// -----------------------------------------------------------------------------
// tests
// -----------------------------------------------------------------------------
// tsx の CJS transform は top-level await 未対応のため、async main() に包む
// (refresh.test.ts と同じパターン)。
async function main(): Promise<void> {
  await test(
  "analyzeRefreshStream: 渡した signal が responses.stream の options.signal に forward される",
  async () => {
    const provider = new OpenAIProvider(FAKE_KEY);
    const { capturedSignals } = stubProviderStream(provider);
    const input = loadRefreshFixture();
    const controller = new AbortController();
    await drain(provider.analyzeRefreshStream(input, controller.signal));
    assert.ok(
      capturedSignals.length >= 1,
      "responses.stream が少なくとも 1 回呼ばれること",
    );
    assert.equal(
      capturedSignals[0],
      controller.signal,
      "末端 options.signal === provider に渡した signal(参照一致)",
    );
  },
);

await test(
  "analyzePartialStream: 渡した signal が responses.stream の options.signal に forward される",
  async () => {
    const provider = new OpenAIProvider(FAKE_KEY);
    const { capturedSignals } = stubProviderStream(provider);
    const input = derivePartialInput(loadRefreshFixture());
    const controller = new AbortController();
    await drain(provider.analyzePartialStream(input, controller.signal));
    assert.ok(capturedSignals.length >= 1);
    assert.equal(capturedSignals[0], controller.signal);
  },
);

await test(
  "signal 省略時でも stream は呼ばれる(options.signal は undefined)",
  async () => {
    const provider = new OpenAIProvider(FAKE_KEY);
    const { capturedSignals } = stubProviderStream(provider);
    const input = loadRefreshFixture();
    await drain(provider.analyzeRefreshStream(input));
    assert.ok(capturedSignals.length >= 1, "stream は signal なしでも呼ばれる");
    assert.equal(
      capturedSignals[0],
      undefined,
      "signal 省略時は options 自体を渡さないため undefined",
    );
  },
);

await test(
  "既に aborted な signal: generator は error frame を流さず静かに終了する",
  async () => {
    const provider = new OpenAIProvider(FAKE_KEY);
    // stream を「abort されたら reject する」スタブに差し替える。
    const client = (provider as unknown as { client: { responses: unknown } })
      .client;
    (client.responses as { stream: unknown }).stream = (
      _body: unknown,
      options?: { signal?: AbortSignal | null },
    ) => ({
      async finalResponse() {
        if (options?.signal?.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        return { output: [], usage: {}, status: "completed" };
      },
    });
    const input = loadRefreshFixture();
    const controller = new AbortController();
    controller.abort(); // 呼び出し前に abort 済
    const events = (await drain(
      provider.analyzeRefreshStream(input, controller.signal),
    )) as Array<{ type?: string }>;
    // abort 経路では error event を流さない(client は既に離脱、route が静かに閉じる)。
    const errorEvents = events.filter((e) => e.type === "error");
    assert.equal(
      errorEvents.length,
      0,
      `abort 時に error frame を流さないこと(流れた: ${JSON.stringify(errorEvents)})`,
    );
  },
  );
}

// --- 実行 + 結果出力 ---
main()
  .then(() => {
    process.stdout.write(`\n${passCount} passed, ${failCount} failed\n`);
    if (failCount > 0) {
      process.stdout.write(`\n${failures.join("\n")}\n`);
      process.exit(1);
    }
  })
  .catch((e) => {
    process.stderr.write(`\nテストランナー自体が例外で停止: ${String(e)}\n`);
    process.exit(1);
  });
