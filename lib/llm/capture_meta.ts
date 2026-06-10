// =============================================================================
// 提出後改善 #3 準備 (2026-06-09): 経路別の受動計測メタ(usage / レイテンシ / リトライ回数)
// =============================================================================
//
// 目的: 専用の計測ベンチを張らず、通常利用のたびに経路別の実測データが自動で貯まる
// 状態を作る(dispatch: docs/dispatch/2026-06-09-postsubmit-04-passive-usage-capture.md、
// DECISIONS `[2026-06-09] 改善 #3 準備 dispatch 決定`)。蓄積データは partial 経路の
// 軽量化判断(改善 #3 本体)の根拠になる。追加の API 費用ゼロ。
//
// 設計判断:
//  1) **純関数モジュール**(副作用なし、import 依存なし)。server(provider / route)と
//     client(captureLog / SSE parser)の両方から型を共有するため、"use client" /
//     "server-only" 指定を持たない。
//  2) **additive な伝搬のみ**: 本メタは SSE `completed` event / JSON 応答の optional
//     フィールド(`capture_meta`)としてのみ流れる。既存フィールドのリネーム・構造変更は
//     しない(load-bearing field names に抵触しない新規 optional)。
//  3) **usage は OpenAI Responses API の raw セマンティクスを保持**:
//     - input_tokens: OpenAI が返す input_tokens の累計(**cached 分を含む raw 値**。
//       lib/llm/openai.ts の TotalUsage が cache を減算するのとは意図的に別管理 —
//       受動計測は「API が報告した生の値」を残し、後段の分析で自由に加工できるようにする)
//     - output_tokens: output_tokens の累計
//     - cached_tokens: input_tokens_details.cached_tokens の累計(取れないモデル /
//       API バージョンでは 0)
//     usage オブジェクト自体が一度も取れなかった場合は null(「0 トークン」と
//     「計測不能」を区別する)。
//  4) **リトライを跨いだ累計**: 防衛三段の 1 回リトライが発火した経路では、usage /
//     latency は両 attempt の合計、retry_count は 1 になる(実コストの実測が目的のため)。
//  5) **UI(非 dev)には一切出さない**: 本メタは dev ゲート内の captureLog にのみ
//     追記される(AGENTS.md「数値スコア非表示」と同根の規律)。`internal_` prefix
//     ではなく `capture_meta` 命名なのは、UI コンポーネントから参照される構造ではなく
//     dev capture 専用の観測層であるため(CaptureLogButton の dev gate が境界)。
//
// SSOT: 本ファイル(型 + 純関数)。配線は lib/llm/openai.ts / lib/llm/semantic_diff.ts /
//       app/api/{analyze,research,interview,semantic-diff}/route.ts /
//       lib/state/analyze_store.ts(captureLog)を参照。

// 計測対象の経路名。analyze 系 3 モード + 独立エンドポイント 3 経路。
export type CaptureMetaMode =
  | "initial"
  | "refresh"
  | "partial"
  | "interview"
  | "research"
  | "semantic_diff";

// OpenAI 応答 usage の累計(raw セマンティクス、設計判断 3 参照)。
export interface CaptureUsage {
  /** OpenAI 応答の input_tokens 累計(cached 分を含む raw 値) */
  input_tokens: number;
  /** OpenAI 応答の output_tokens 累計 */
  output_tokens: number;
  /** input_tokens_details.cached_tokens の累計(取れない場合 0) */
  cached_tokens: number;
}

// 1 回の LLM 経路呼び出し(リトライ込み)の計測メタ。
export interface CaptureMeta {
  mode: CaptureMetaMode;
  model: string;
  /** provider 呼び出し(LLM API call)の実測合計 ms(リトライ分を含む) */
  latency_ms: number;
  /** usage が一度も取れなかった経路では null */
  usage: CaptureUsage | null;
  /** 防衛三段の検証リトライ回数(0 or 1 が typical) */
  retry_count: number;
}

// OpenAI Responses API の usage の構造的サブセット。SDK の ResponseUsage は必須
// number だが、モデル / API バージョンで欠落が観測されているため optional で緩く受ける
// (lib/llm/openai.ts:accumulateUsage と同じ防御姿勢)。
export interface OpenAIUsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  input_tokens_details?: { cached_tokens?: number | null } | null;
}

// 有限の非負 number だけを採用する(NaN / Infinity / 負値 / 非 number は null)。
function readToken(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

// usage の累積。raw が無い / 読めない応答は prev をそのまま返す(null 含む)。
// input_tokens / output_tokens のどちらかが読めれば「計測あり」として累積する。
export function accumulateCaptureUsage(
  prev: CaptureUsage | null,
  raw: OpenAIUsageLike | null | undefined,
): CaptureUsage | null {
  if (raw == null) return prev;
  const input = readToken(raw.input_tokens);
  const output = readToken(raw.output_tokens);
  if (input === null && output === null) return prev;
  const cached = readToken(raw.input_tokens_details?.cached_tokens) ?? 0;
  const base = prev ?? { input_tokens: 0, output_tokens: 0, cached_tokens: 0 };
  return {
    input_tokens: base.input_tokens + (input ?? 0),
    output_tokens: base.output_tokens + (output ?? 0),
    cached_tokens: base.cached_tokens + cached,
  };
}

// 計測メタの最終組み立て。latency / retry を整数に正規化(負値 / 非有限は 0 に clamp)。
export function buildCaptureMeta(params: {
  mode: CaptureMetaMode;
  model: string;
  latencyMs: number;
  usage: CaptureUsage | null;
  retryCount: number;
}): CaptureMeta {
  const latency = Number.isFinite(params.latencyMs)
    ? Math.max(0, Math.round(params.latencyMs))
    : 0;
  const retry = Number.isFinite(params.retryCount)
    ? Math.max(0, Math.trunc(params.retryCount))
    : 0;
  return {
    mode: params.mode,
    model: params.model,
    latency_ms: latency,
    usage: params.usage,
    retry_count: retry,
  };
}
