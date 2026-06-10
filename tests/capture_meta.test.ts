/**
 * 受動計測メタ(capture_meta)のユニットテスト — 提出後改善 #3 準備 (2026-06-09)。
 *
 * 対象:
 *  1. lib/llm/capture_meta.ts の純関数(accumulateCaptureUsage / buildCaptureMeta)
 *  2. OpenAI provider の streaming 経路(refresh)が completed event に capture_meta を
 *     同梱すること(OpenAI SDK をネットワークなしでスタブ、API 費用ゼロ)
 *
 * 検証する不変条件:
 *  - usage は OpenAI 応答の raw セマンティクス(input_tokens は cached 込み)で累計される
 *  - usage が一度も取れない経路では null(「0 トークン」と「計測不能」を区別)
 *  - リトライ発火時は usage / latency が両 attempt の合計、retry_count = 1
 *  - latency_ms / retry_count は非負整数に正規化(NaN / 負値は 0 に clamp)
 *  - 入力(prev usage)を mutate しない(immutable)
 *
 * 実行方法: `tsx tests/capture_meta.test.ts`(net 呼び出しなし、ローカル即時実行)
 *
 * SSOT: lib/llm/capture_meta.ts(純関数)/ lib/llm/openai.ts(generator 配線)
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  accumulateCaptureUsage,
  buildCaptureMeta,
  type CaptureMeta,
  type CaptureUsage,
} from "@/lib/llm/capture_meta";
import { OpenAIProvider } from "@/lib/llm/openai";
import { ANALYZE_ES_REFRESH_ONLY_TOOL_NAME_OAI } from "@/lib/tools/analyze_es_refresh_only_openai";
import {
  AnalyzeInputBundleSchema,
  type AnalyzeInputBundle,
} from "@/lib/schema/input";

const __dirname = dirname(fileURLToPath(import.meta.url));

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

async function test(
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> {
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

// 検証を通過する最小の refresh 出力(suggestions 空は schema / 意味検証とも合法)。
// summary は数値スコア検出パターンを踏まない平文にする。
const VALID_REFRESH_ARGS = {
  overall_assessment: {
    summary: "全体として構成は明瞭で、主張の流れも追いやすい。",
    strengths: ["主張が明瞭"],
    weaknesses: ["具体例が少ない"],
    preserved_voice_note: "語り口は維持されている。",
  },
  suggestions: [],
};

// OpenAI Responses API の最小 Response 形(generator が読むのは output / usage / status)。
function makeStubResponse(args: unknown, usage: unknown) {
  return {
    output: [
      {
        type: "function_call",
        name: ANALYZE_ES_REFRESH_ONLY_TOOL_NAME_OAI,
        call_id: "call_capture_meta_test",
        arguments: JSON.stringify(args),
      },
    ],
    usage,
    status: "completed",
  };
}

// provider の private client.responses.stream を「呼び出し順に queue を返す」スタブに
// 差し替える(abort_propagation.test.ts と同じ private アクセスパターン、テスト専用)。
function stubProviderStreamQueue(
  provider: OpenAIProvider,
  queue: Array<ReturnType<typeof makeStubResponse>>,
): { callCount: () => number } {
  let calls = 0;
  const client = (provider as unknown as { client: { responses: unknown } })
    .client;
  (client.responses as { stream: unknown }).stream = () => {
    const response = queue[Math.min(calls, queue.length - 1)];
    calls += 1;
    return {
      async finalResponse() {
        return response;
      },
    };
  };
  return { callCount: () => calls };
}

async function drain(
  gen: AsyncGenerator<unknown, void, void>,
): Promise<Array<{ type?: string; capture_meta?: CaptureMeta }>> {
  const events: Array<{ type?: string; capture_meta?: CaptureMeta }> = [];
  for await (const ev of gen) {
    events.push(ev as { type?: string; capture_meta?: CaptureMeta });
  }
  return events;
}

const FAKE_KEY = "sk-test-fake-key-not-used";

// -----------------------------------------------------------------------------
// tests
// -----------------------------------------------------------------------------
// tsx の CJS transform は top-level await 未対応のため、async main() に包む。
async function main(): Promise<void> {
  // ---------------------------------------------------------------------------
  // accumulateCaptureUsage(純関数)
  // ---------------------------------------------------------------------------
  await test("accumulate: prev=null + raw なし(undefined / null)→ null のまま", () => {
    assert.equal(accumulateCaptureUsage(null, undefined), null);
    assert.equal(accumulateCaptureUsage(null, null), null);
  });

  await test("accumulate: 初回の usage を raw セマンティクスで取り込む(cached 込み input)", () => {
    const got = accumulateCaptureUsage(null, {
      input_tokens: 1200,
      output_tokens: 300,
      input_tokens_details: { cached_tokens: 1000 },
    });
    assert.deepEqual(got, {
      input_tokens: 1200,
      output_tokens: 300,
      cached_tokens: 1000,
    });
  });

  await test("accumulate: input_tokens_details 欠落時は cached_tokens 0", () => {
    const got = accumulateCaptureUsage(null, {
      input_tokens: 100,
      output_tokens: 50,
    });
    assert.deepEqual(got, {
      input_tokens: 100,
      output_tokens: 50,
      cached_tokens: 0,
    });
  });

  await test("accumulate: 2 回目の応答を加算する(リトライ跨ぎの累計)", () => {
    const first = accumulateCaptureUsage(null, {
      input_tokens: 1000,
      output_tokens: 200,
      input_tokens_details: { cached_tokens: 800 },
    });
    const second = accumulateCaptureUsage(first, {
      input_tokens: 1100,
      output_tokens: 150,
      input_tokens_details: { cached_tokens: 1000 },
    });
    assert.deepEqual(second, {
      input_tokens: 2100,
      output_tokens: 350,
      cached_tokens: 1800,
    });
  });

  await test("accumulate: prev あり + raw なし → prev を参照そのまま返す(累計を壊さない)", () => {
    const prev: CaptureUsage = {
      input_tokens: 10,
      output_tokens: 5,
      cached_tokens: 0,
    };
    assert.equal(accumulateCaptureUsage(prev, undefined), prev);
    assert.equal(accumulateCaptureUsage(prev, null), prev);
  });

  await test("accumulate: input / output とも読めない raw(非 number / NaN / 負値)は無視", () => {
    const prev: CaptureUsage = {
      input_tokens: 10,
      output_tokens: 5,
      cached_tokens: 1,
    };
    assert.equal(
      accumulateCaptureUsage(prev, {
        input_tokens: Number.NaN,
        output_tokens: -3,
      }),
      prev,
    );
    assert.equal(
      accumulateCaptureUsage(null, {
        input_tokens: undefined,
        output_tokens: null,
      }),
      null,
    );
  });

  await test("accumulate: 片方だけ読める raw は読める方のみ加算(欠落側は 0 扱い)", () => {
    const got = accumulateCaptureUsage(null, {
      input_tokens: Number.NaN,
      output_tokens: 70,
    });
    assert.deepEqual(got, {
      input_tokens: 0,
      output_tokens: 70,
      cached_tokens: 0,
    });
  });

  await test("accumulate: cached_tokens が読めない(NaN / 負値)場合は 0 として加算", () => {
    const got = accumulateCaptureUsage(null, {
      input_tokens: 100,
      output_tokens: 10,
      input_tokens_details: { cached_tokens: -5 },
    });
    assert.deepEqual(got, {
      input_tokens: 100,
      output_tokens: 10,
      cached_tokens: 0,
    });
  });

  await test("accumulate: 入力(prev)を mutate しない(immutable)", () => {
    const prev: CaptureUsage = {
      input_tokens: 10,
      output_tokens: 5,
      cached_tokens: 2,
    };
    const snapshot = { ...prev };
    accumulateCaptureUsage(prev, {
      input_tokens: 1,
      output_tokens: 1,
      input_tokens_details: { cached_tokens: 1 },
    });
    assert.deepEqual(prev, snapshot);
  });

  // ---------------------------------------------------------------------------
  // buildCaptureMeta(純関数)
  // ---------------------------------------------------------------------------
  await test("build: フィールドをそのまま組み立てる(usage null も透過)", () => {
    const meta = buildCaptureMeta({
      mode: "partial",
      model: "gpt-5.4",
      latencyMs: 1234,
      usage: null,
      retryCount: 0,
    });
    assert.deepEqual(meta, {
      mode: "partial",
      model: "gpt-5.4",
      latency_ms: 1234,
      usage: null,
      retry_count: 0,
    });
  });

  await test("build: latency は整数へ丸め、負値 / NaN は 0 に clamp", () => {
    assert.equal(
      buildCaptureMeta({
        mode: "initial",
        model: "m",
        latencyMs: 12.6,
        usage: null,
        retryCount: 0,
      }).latency_ms,
      13,
    );
    assert.equal(
      buildCaptureMeta({
        mode: "initial",
        model: "m",
        latencyMs: -5,
        usage: null,
        retryCount: 0,
      }).latency_ms,
      0,
    );
    assert.equal(
      buildCaptureMeta({
        mode: "initial",
        model: "m",
        latencyMs: Number.NaN,
        usage: null,
        retryCount: 0,
      }).latency_ms,
      0,
    );
  });

  await test("build: retry_count は整数へ切り捨て、負値 / NaN は 0 に clamp", () => {
    assert.equal(
      buildCaptureMeta({
        mode: "refresh",
        model: "m",
        latencyMs: 0,
        usage: null,
        retryCount: 1.9,
      }).retry_count,
      1,
    );
    assert.equal(
      buildCaptureMeta({
        mode: "refresh",
        model: "m",
        latencyMs: 0,
        usage: null,
        retryCount: -1,
      }).retry_count,
      0,
    );
    assert.equal(
      buildCaptureMeta({
        mode: "refresh",
        model: "m",
        latencyMs: 0,
        usage: null,
        retryCount: Number.NaN,
      }).retry_count,
      0,
    );
  });

  await test("build: usage オブジェクトは参照透過(コピーせずそのまま保持)", () => {
    const usage: CaptureUsage = {
      input_tokens: 1,
      output_tokens: 2,
      cached_tokens: 0,
    };
    const meta = buildCaptureMeta({
      mode: "semantic_diff",
      model: "gpt-5.4-mini",
      latencyMs: 1,
      usage,
      retryCount: 0,
    });
    assert.equal(meta.usage, usage);
  });

  // ---------------------------------------------------------------------------
  // OpenAI streaming generator 配線(スタブ、ネットワークなし)
  // ---------------------------------------------------------------------------
  await test("refresh stream: completed event に capture_meta が同梱される(retry 0)", async () => {
    const provider = new OpenAIProvider(FAKE_KEY);
    stubProviderStreamQueue(provider, [
      makeStubResponse(VALID_REFRESH_ARGS, {
        input_tokens: 1200,
        output_tokens: 300,
        input_tokens_details: { cached_tokens: 1000 },
      }),
    ]);
    const input = loadRefreshFixture();
    const events = await drain(provider.analyzeRefreshStream(input));
    const completed = events.find((e) => e.type === "completed");
    assert.ok(completed, `completed event が無い: ${JSON.stringify(events.map((e) => e.type))}`);
    const meta = completed!.capture_meta;
    assert.ok(meta, "completed.capture_meta が undefined");
    assert.equal(meta!.mode, "refresh");
    assert.equal(meta!.model, "gpt-5.4");
    assert.equal(meta!.retry_count, 0);
    assert.ok(
      Number.isInteger(meta!.latency_ms) && meta!.latency_ms >= 0,
      `latency_ms が非負整数でない: ${meta!.latency_ms}`,
    );
    assert.deepEqual(meta!.usage, {
      input_tokens: 1200,
      output_tokens: 300,
      cached_tokens: 1000,
    });
  });

  await test("refresh stream: 検証リトライ発火時は usage 累計 + retry_count 1", async () => {
    const provider = new OpenAIProvider(FAKE_KEY);
    const { callCount } = stubProviderStreamQueue(provider, [
      // 1 回目: schema 検証に落ちる出力(空 object)→ retry へ
      makeStubResponse(
        {},
        {
          input_tokens: 1000,
          output_tokens: 200,
          input_tokens_details: { cached_tokens: 900 },
        },
      ),
      // 2 回目: 合法な出力 → completed
      makeStubResponse(VALID_REFRESH_ARGS, {
        input_tokens: 1500,
        output_tokens: 250,
        input_tokens_details: { cached_tokens: 1400 },
      }),
    ]);
    const input = loadRefreshFixture();
    const events = await drain(provider.analyzeRefreshStream(input));
    assert.equal(callCount(), 2, "LLM call が 2 回(初回 + リトライ)であること");
    assert.ok(
      events.some((e) => e.type === "retry"),
      "retry event が流れること",
    );
    const completed = events.find((e) => e.type === "completed");
    assert.ok(completed, `completed event が無い: ${JSON.stringify(events.map((e) => e.type))}`);
    const meta = completed!.capture_meta;
    assert.ok(meta, "completed.capture_meta が undefined");
    assert.equal(meta!.retry_count, 1);
    assert.deepEqual(meta!.usage, {
      input_tokens: 2500,
      output_tokens: 450,
      cached_tokens: 2300,
    });
  });

  await test("refresh stream: usage が一度も取れない応答では capture_meta.usage = null", async () => {
    const provider = new OpenAIProvider(FAKE_KEY);
    stubProviderStreamQueue(provider, [
      makeStubResponse(VALID_REFRESH_ARGS, undefined),
    ]);
    const input = loadRefreshFixture();
    const events = await drain(provider.analyzeRefreshStream(input));
    const completed = events.find((e) => e.type === "completed");
    assert.ok(completed, "completed event が無い");
    assert.ok(completed!.capture_meta, "capture_meta が undefined");
    assert.equal(completed!.capture_meta!.usage, null);
  });
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
