import { NextRequest, NextResponse } from "next/server";
import { getProvider } from "@/lib/llm/router";
import { LLMError } from "@/lib/llm/types";
import { AnthropicProvider, type AnalyzeStreamEvent } from "@/lib/llm/anthropic";
import { OpenAIProvider } from "@/lib/llm/openai";
import {
  OPENAI_KEY_HEADER,
  tryResolveOpenAIKey,
} from "@/lib/llm/openai_key";
import {
  AnalyzeInputBundleSchema,
  type AnalyzeInputBundle,
} from "@/lib/schema/input";
import {
  AnalysisResultSchema,
  PartialAnalysisResultSchema,
} from "@/lib/schema/analysis";

export const runtime = "nodejs";

// DECISION [Phase C セッション5]: maxDuration = 300 を route segment config で明示。
// Phase D セッション6(2026-05-25 統合改修で GPT-5.4 に統一): refresh は GPT-5.4 で
// 20〜40秒目安だが、リトライ発火時のために initial と同じ 300秒バッファを共有する
// (route 単位の設定なので mode 別では分けない)。
// Phase G Step 1 (2026-05-23): initial は SSE で同時間枠内に streaming する。
// Phase G Step 2 (2026-05-23): refresh も SSE 化、同じ 300秒バッファを共有。
export const maxDuration = 300;

// DECISION [Phase C セッション5]: /api/analyze は session キャッシュを持たない。
// LLM provider 側の prompt caching に任せる方針(2026-05-25 統合改修で OpenAI GPT-5.4
// の自動 prompt cache を主経路、Anthropic SDK は v2 切戻し / 障害時 fallback 用に残置)。
// Phase D セッション6: refresh も同じスタンス。

export async function POST(req: NextRequest) {
  // 1. body パース
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { kind: "bad_request", message: "Request body is not valid JSON" } },
      { status: 400 },
    );
  }

  // 2. Zod 検証(防衛三段 Part 1: 入力時点のバリデーション)
  // Phase D セッション6: AnalyzeInputBundle が判別ユニオン化したため、mode により
  // initial / refresh が安全に narrowing される。
  const parsed = AnalyzeInputBundleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          kind: "invalid_input",
          message: "Request schema validation failed",
          issues: parsed.error.flatten(),
        },
      },
      { status: 400 },
    );
  }
  const input: AnalyzeInputBundle = parsed.data;

  // BYOK (2026-05-29): per-request の OpenAI 鍵をヘッダから解決(ヘッダ→env→null)。
  // analyze の default provider は OpenAI なので、鍵が無ければ JSON 400 を返す。
  // SSE の前に返す JSON エラーは、client の content-type fallback(callAnalyzeStream)が
  // `body.error` として吸収する設計(HTTP status 200 固定の規律はここでは適用しない、
  // SSE ストリーム開始 *前* のため通常の JSON エラー応答)。
  const openaiKey = tryResolveOpenAIKey(req.headers.get(OPENAI_KEY_HEADER));
  if (openaiKey === null) {
    return NextResponse.json(
      {
        error: {
          kind: "missing_api_key",
          message:
            "OpenAI API key is required (set it from the settings, or configure server env)",
          stage: "analyze",
        },
      },
      { status: 400 },
    );
  }

  // 3. provider 選択 — 統合改修パッケージ (2026-05-25): analyze は OpenAI を capability default
  //    initial / refresh / partial 全て OpenAI GPT-5.4 full(provider 完全統一)
  //    詳細は DECISIONS.md `[2026-05-25] 統合改修パッケージ訂正` 参照
  //
  //    `tests/analyze-bench.test.ts` は今でも provider を直接 instantiation で叩く形で
  //    Anthropic / OpenAI / Google 比較を継続(SSE 化は不要、本 route の経路とは独立)。
  const provider = getProvider("analyze", openaiKey);

  // -------------------------------------------------------------------------
  // SSE streaming (initial / refresh / partial)
  // -------------------------------------------------------------------------
  // mode に応じて generator(analyzeInitialStream / analyzeRefreshStream /
  // analyzePartialStream)を切り替え、共通の SSE エンベロープで返す。
  //
  // SSE 設計判断(Step 1 と同じ規律、provider 完全統一後も変更なし):
  //  - HTTP status は **200 固定**(エラー時も)。エラーは payload の type: "error" で表現
  //    し、client は payload の type を見て分岐する。
  //  - event 種別は anthropic.ts の AnalyzeStreamEvent 型を SSE フレームに 1:1 で対応
  //    (data: <json>\n\n)。OpenAI provider も同じ型で yield する(統合改修 2026-05-25)。
  //  - completed event 内の result は最終 Zod 検証を route 側で再度通す(provider 内でも
  //    検証しているが二重防御)。
  //    - kind === "full"     → AnalysisResultSchema で検証
  //    - kind === "partial"  → PartialAnalysisResultSchema で検証
  //
  // 統合改修パッケージ (2026-05-25): OpenAI / Anthropic 両プロバイダで SSE 経路を実装。
  // 将来 Google プロバイダ等を SSE 経路に追加する場合は ↓ の instanceof 判定を拡張する。
  function stageLabelFor(mode: AnalyzeInputBundle["mode"]): string {
    return mode === "initial"
      ? "analyze_initial_stream"
      : mode === "refresh"
        ? "analyze_refresh_stream"
        : "analyze_partial_stream";
  }
  if (
    !(provider instanceof AnthropicProvider) &&
    !(provider instanceof OpenAIProvider)
  ) {
    return NextResponse.json(
      {
        error: {
          kind: "not_implemented",
          message:
            "SSE streaming は Anthropic / OpenAI provider のみ対応(Google 経由は未実装)",
          stage: stageLabelFor(input.mode),
        },
      },
      { status: 501 },
    );
  }

  const generator =
    input.mode === "initial"
      ? provider.analyzeInitialStream(input)
      : input.mode === "refresh"
        ? provider.analyzeRefreshStream(input)
        : provider.analyzePartialStream(input);

  // stage label は mode に応じて変える(error event の stage / log で使い分け)
  const stageLabel = stageLabelFor(input.mode);

  const encoder = new TextEncoder();

  // SSE フレーム作成 helper。1 event = "data: <json>\n\n"。
  function frame(payload: AnalyzeStreamEvent): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
  }

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of generator) {
          // completed event だけは route 側でも最終 Zod 検証を通す(二重防御)。
          // Step 3b-2: kind による分岐(full / partial で別 Schema)。
          if (event.type === "completed") {
            if (event.kind === "partial") {
              const finalCheck = PartialAnalysisResultSchema.safeParse(
                event.result,
              );
              if (!finalCheck.success) {
                console.error(
                  `[/api/analyze ${input.mode} stream] final partial validation failed`,
                  finalCheck.error.flatten(),
                );
                controller.enqueue(
                  frame({
                    type: "error",
                    kind: "schema_validation",
                    message:
                      "Provider returned a PartialAnalysisResult that failed final schema check",
                    stage: "post_validation_stream",
                    retryable: false,
                  }),
                );
                break;
              }
              controller.enqueue(
                frame({
                  type: "completed",
                  kind: "partial",
                  result: finalCheck.data,
                }),
              );
              break;
            }
            // kind === "full"(initial / refresh)
            const finalCheck = AnalysisResultSchema.safeParse(event.result);
            if (!finalCheck.success) {
              console.error(
                `[/api/analyze ${input.mode} stream] final validation failed`,
                finalCheck.error.flatten(),
              );
              controller.enqueue(
                frame({
                  type: "error",
                  kind: "schema_validation",
                  message:
                    "Provider returned an AnalysisResult that failed final schema check",
                  stage: "post_validation_stream",
                  retryable: false,
                }),
              );
              break;
            }
            controller.enqueue(
              frame({
                type: "completed",
                kind: "full",
                result: finalCheck.data,
              }),
            );
            break;
          }
          controller.enqueue(frame(event));
          // error event を流したら以降は流さない
          if (event.type === "error") break;
        }
      } catch (err) {
        // generator 内部の例外(LLMError 等)。SSE で error event を流して
        // 200 のまま閉じる。client は payload の type を見て分岐。
        console.error(`[/api/analyze ${input.mode} stream] generator error`, err);
        if (err instanceof LLMError) {
          controller.enqueue(
            frame({
              type: "error",
              kind: err.kind,
              message: err.message,
              stage: `${stageLabel}_generator`,
              // retryable な kind: 一過性 / 再試行で大抵直るもの。
              // analysis_validation は AI 出力のばらつき(例: original_overlap_detected)で
              // 発生し、再試行すれば大抵直るため retryable に含める。これで ErrorDisplay
              // (初回分析)でも「再試行」ボタンが出て、親切文言「もう一度『再試行』して
              // ください」と整合する(RefreshErrorBanner はボタン常時表示で元々整合)。
              retryable:
                err.kind === "rate_limit" ||
                err.kind === "timeout" ||
                err.kind === "api_error" ||
                err.kind === "analysis_validation",
            }),
          );
        } else {
          controller.enqueue(
            frame({
              type: "error",
              kind: "unknown",
              message:
                err instanceof Error ? err.message : "Unexpected stream error",
              stage: `${stageLabel}_generator`,
            }),
          );
        }
      } finally {
        controller.close();
      }
    },
    cancel() {
      // client がブラウザを閉じた / AbortController.abort() で stream を中断したケース。
      // Phase G Step 2 (2026-05-23): client 側の楽観的並行制御で前の refresh を中断する
      // ケースに該当する。Anthropic SDK の MessageStream は GC で解放される想定(SDK の
      // 内部 abort は connection を閉じるだけで応答コストは止まらないが、本実装では
      // それで充分 — client が結果を破棄するため)。厳密な server-side abort 伝搬は
      // 今後の最適化課題として残す。
    },
  });

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Next.js / proxy が buffer しないよう明示
      "X-Accel-Buffering": "no",
    },
  });
}
