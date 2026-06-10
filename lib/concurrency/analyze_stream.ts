"use client";

// =============================================================================
// Phase G Step 2 (2026-05-23): /api/analyze SSE 共通 client helper
// =============================================================================
//
// 責務:
//  - SSE エンベロープ(`data: <json>\n\n`)の parsing と event 分配
//  - initial / refresh 両モードで同じ AnalyzeStreamPayload を発行
//  - AbortSignal による中断対応(refresh の楽観的並行制御で前の fetch を切るため)
//
// 設計判断:
//  - InputForm の `callAnalyzeStream` を共通化、Canvas からも呼べる単独 helper に。
//    両 caller(initial の InputForm、refresh の Canvas)が同じ parser を踏むことで、
//    SSE エンベロープの細部(separator 検出、data line 結合)が一箇所に集約される。
//  - 進行 event のうち本 helper が直接購読する store 更新は **無い**。代わりに
//    onStage コールバックで stage 文字列を渡し、caller 側で `setStreamingStage` /
//    `setRefreshStreamingStage` を選択する(initial / refresh で別 state のため)。
//  - AbortSignal は fetch 内部と reader.read() の両方を中断する。abort されたら
//    関数は `{ ok: false, error: { kind: "aborted" } }` を返す(throw しない、
//    caller が握りつぶせる)。
//  - Phase G Step 1 で確立した HTTP status 200 固定 + payload type で分岐の規律を
//    継承。content-type が text/event-stream でない応答(invalid_input 等)は
//    JSON エラー fallback として吸収。
//
// SSOT:
//  - AnalyzeStreamPayload 型は lib/llm/anthropic.ts:AnalyzeStreamEvent と同形
//    (本ファイルでは独立宣言で client / server を結合する、Step 1 と同じ規律)
//  - InputForm.tsx の callAnalyzeStream はこれを使うように更新予定(後続 commit)
//    だが、Step 2 では本 helper を新規追加するだけで InputForm は触らない
//    (initial 経路の動作維持を優先)。

import type {
  AnalysisResult,
  PartialAnalysisResult,
} from "@/lib/schema/analysis";
import type { AnalyzeInputBundle } from "@/lib/schema/input";
// 提出後改善 #3 準備 (2026-06-09): completed event の optional 受動計測メタ。
import type { CaptureMeta } from "@/lib/llm/capture_meta";
import type { ServerError, StreamingStage } from "@/lib/state/analyze_store";
import { openAIKeyHeader } from "@/lib/byok";

// SSE payload(server の AnalyzeStreamEvent と同形)
// started.mode は "initial" | "refresh" | "partial" の union
// (Phase G Step 2 で refresh、Step 3b-2 で partial を追加)
// completed event は kind で full / partial を判別(Step 3b-2)
// 提出後改善 #3 準備 (2026-06-09): completed に optional capture_meta(additive、
// サーバが付けない場合 / 旧サーバでも parse は壊れない)。
export type AnalyzeStreamPayload =
  | {
      type: "started";
      mode: "initial" | "refresh" | "partial";
      model: string;
      attempt: number;
    }
  | { type: "thinking"; delta: string }
  | { type: "tool_progress"; cumulativeChars: number }
  | { type: "retry"; issueKinds: string[] }
  | {
      type: "completed";
      kind: "full";
      result: AnalysisResult;
      capture_meta?: CaptureMeta;
    }
  | {
      type: "completed";
      kind: "partial";
      result: PartialAnalysisResult;
      capture_meta?: CaptureMeta;
    }
  | {
      type: "error";
      kind: string;
      message: string;
      stage?: string;
      retryable?: boolean;
    };

// 既存の InputForm.tsx と同じデフォルト timeout(330秒、route maxDuration 300秒 + 30秒)
const DEFAULT_FETCH_TIMEOUT_MS = 330_000;

export interface CallAnalyzeStreamOptions {
  /** SSE 進行 stage の更新コールバック(caller が初期 / refresh の state を選んで書き込む)。 */
  onStage?: (stage: StreamingStage) => void;
  /** 中断のための AbortSignal(refresh の楽観的並行制御で必須)。 */
  signal?: AbortSignal;
  /** fetch のクライアント側 timeout。default = 330_000ms。 */
  timeoutMs?: number;
}

// Phase G Step 3b-2: full / partial 両モードを表現する union 戻り値。
// 呼び出し側(Canvas)は kind を見て applyRefreshResult / applyPartialResult を分岐する。
// 提出後改善 #3 準備 (2026-06-09): captureMeta(optional)を pass-through。caller が
// dev capture ログに経路別で追記する(undefined なら何も記録しない)。
export type CallAnalyzeStreamResult =
  | {
      ok: true;
      kind: "full";
      result: AnalysisResult;
      captureMeta?: CaptureMeta;
    }
  | {
      ok: true;
      kind: "partial";
      result: PartialAnalysisResult;
      captureMeta?: CaptureMeta;
    }
  | { ok: false; error: ServerError };

// =============================================================================
// callAnalyzeStream — initial / refresh 両モードで使う SSE client
// =============================================================================
// fetch → content-type 判定 → SSE のときは parseSSE で受信、JSON のときは
// JSON エラーとして吸収。AbortSignal で中断可能(refresh の楽観的並行制御で必須)。
export async function callAnalyzeStream(
  input: AnalyzeInputBundle,
  options: CallAnalyzeStreamOptions = {},
): Promise<CallAnalyzeStreamResult> {
  const { onStage, signal, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = options;

  // 外部 AbortSignal と timeout AbortSignal の合成。
  // - 外部 abort または timeout のいずれかで fetch を中断したいため、内部で合成 signal を作る。
  // - AbortSignal.any([...]) が使える環境なら理想だが、Node.js 18 / 古いブラウザでは
  //   未サポートのため、内部 AbortController を 1 つ作り、両方の signal の abort を listen
  //   して合成する。
  const internal = new AbortController();
  let aborted = false;
  function abortInternal() {
    if (aborted) return;
    aborted = true;
    internal.abort();
  }
  let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(
    abortInternal,
    timeoutMs,
  );
  function clearTimeoutSafe() {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }
  let externalAbortListener: (() => void) | null = null;
  if (signal) {
    if (signal.aborted) {
      abortInternal();
    } else {
      externalAbortListener = () => abortInternal();
      signal.addEventListener("abort", externalAbortListener);
    }
  }

  let res: Response;
  try {
    res = await fetch("/api/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        // BYOK: localStorage の OpenAI 鍵を x-openai-key ヘッダで添える(あれば)。
        ...openAIKeyHeader(),
      },
      body: JSON.stringify(input),
      signal: internal.signal,
    });
  } catch (err) {
    clearTimeoutSafe();
    if (externalAbortListener && signal) {
      signal.removeEventListener("abort", externalAbortListener);
    }
    // abort された場合は専用の kind を返す(caller がこれを「破棄」として握りつぶす)
    const isAbort =
      (err instanceof DOMException && err.name === "AbortError") ||
      (signal?.aborted ?? false);
    if (isAbort) {
      return {
        ok: false,
        error: {
          kind: "aborted",
          message: "Refresh request was aborted by client",
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "network",
        message:
          err instanceof Error
            ? err.message
            : "ネットワークエラー(分析 SSE)",
      },
    };
  }

  // 有効な SSE ストリームでない応答(HTTP エラー or body 欠落 or content-type が
  // text/event-stream でない)は、まず JSON の {error}(server の error kind を保持)を
  // parse して返す。parse 不可なら bad_response にフォールバックする。
  // これにより非 2xx の JSON エラー(例 400 missing_api_key)が bad_response に
  // 潰れず、「設定からキーを入れて」の導線が出る。
  const contentType = res.headers.get("content-type") ?? "";
  const isEventStream = contentType.includes("text/event-stream");
  if (!res.ok || !res.body || !isEventStream) {
    clearTimeoutSafe();
    if (externalAbortListener && signal) {
      signal.removeEventListener("abort", externalAbortListener);
    }
    try {
      const body = (await res.json()) as { error?: ServerError };
      return {
        ok: false,
        error: body.error ?? {
          kind: "bad_response",
          message: `/api/analyze (${input.mode} stream) returned ${res.status} (content-type=${contentType})`,
          status: res.status,
        },
      };
    } catch {
      return {
        ok: false,
        error: {
          kind: "bad_response",
          message: `/api/analyze did not return SSE (status=${res.status}, content-type=${contentType})`,
          status: res.status,
        },
      };
    }
  }

  // SSE 受信ループ
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  // Step 3b-2: full / partial を kind で判別して保持。lastResult は最後の completed event。
  // 提出後改善 #3 準備 (2026-06-09): captureMeta も completed event から保持(optional)。
  let lastResult:
    | { kind: "full"; result: AnalysisResult; captureMeta?: CaptureMeta }
    | {
        kind: "partial";
        result: PartialAnalysisResult;
        captureMeta?: CaptureMeta;
      }
    | null = null;
  let lastError: ServerError | null = null;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex: number;
      while ((separatorIndex = findEventSeparator(buffer)) >= 0) {
        const rawEvent = buffer.slice(0, separatorIndex);
        const separatorLen = buffer
          .slice(separatorIndex, separatorIndex + 4)
          .startsWith("\r\n\r\n")
          ? 4
          : 2;
        buffer = buffer.slice(separatorIndex + separatorLen);

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
          // 壊れた event は無視
          continue;
        }

        switch (payload.type) {
          case "started":
            onStage?.("started");
            break;
          case "thinking":
            onStage?.("thinking");
            break;
          case "tool_progress":
            onStage?.("generating");
            break;
          case "retry":
            onStage?.("retrying");
            break;
          case "completed":
            onStage?.("finalizing");
            // Step 3b-2: kind で分岐(full / partial で別 result 型)
            // 提出後改善 #3 準備 (2026-06-09): capture_meta を pass-through(optional)。
            if (payload.kind === "partial") {
              lastResult = {
                kind: "partial",
                result: payload.result,
                captureMeta: payload.capture_meta,
              };
            } else {
              lastResult = {
                kind: "full",
                result: payload.result,
                captureMeta: payload.capture_meta,
              };
            }
            break;
          case "error":
            lastError = {
              kind: payload.kind,
              message: payload.message,
              stage: payload.stage,
              retryable: payload.retryable,
              status: res.status,
            };
            break;
        }
      }
    }
  } catch (err) {
    // reader 中の abort は AbortError として降ってくる
    const isAbort =
      (err instanceof DOMException && err.name === "AbortError") ||
      (signal?.aborted ?? false);
    if (isAbort) {
      clearTimeoutSafe();
      if (externalAbortListener && signal) {
        signal.removeEventListener("abort", externalAbortListener);
      }
      return {
        ok: false,
        error: {
          kind: "aborted",
          message: "Refresh stream was aborted by client",
        },
      };
    }
    clearTimeoutSafe();
    if (externalAbortListener && signal) {
      signal.removeEventListener("abort", externalAbortListener);
    }
    return {
      ok: false,
      error: {
        kind: "network",
        message:
          err instanceof Error
            ? err.message
            : "SSE 読み取り中にエラーが発生しました",
      },
    };
  } finally {
    clearTimeoutSafe();
    if (externalAbortListener && signal) {
      signal.removeEventListener("abort", externalAbortListener);
    }
  }

  if (lastError) return { ok: false, error: lastError };
  if (lastResult) {
    // Step 3b-2: kind を維持して返す(呼び出し側で full / partial を narrowing できる)
    if (lastResult.kind === "partial") {
      return {
        ok: true,
        kind: "partial",
        result: lastResult.result,
        captureMeta: lastResult.captureMeta,
      };
    }
    return {
      ok: true,
      kind: "full",
      result: lastResult.result,
      captureMeta: lastResult.captureMeta,
    };
  }
  return {
    ok: false,
    error: {
      kind: "bad_response",
      message: "SSE が completed / error を返さずに終了しました",
      status: res.status,
    },
  };
}

// SSE の event 境界(空行)を見つける。`\n\n` と `\r\n\r\n` の両方に対応。
function findEventSeparator(buffer: string): number {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf < 0) return lf;
  if (lf < 0) return crlf;
  return Math.min(crlf, lf);
}
