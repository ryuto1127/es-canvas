// 統合改修パッケージ (2026-05-25): 動的 HITL の意味的差分判定 helper
//
// 編集して採用 / 直接編集 OFF の差分が「意味的に同じ」か「異なる」かを GPT-5.4 mini
// で判定する。判定結果に応じて Canvas が partial refresh を発火するか skip するかを
// 制御する(DECISIONS.md `[2026-05-25] 統合改修パッケージ訂正` の最終モデル配置に従う)。
//
// 設計判断:
//  - **GPT-5.4 mini** を採用(短い 2 文比較に full は overkill、mini で十分高精度)
//  - 入力: 編集前の文字列 `before` + ユーザーが採用 / 編集した最終文字列 `after`
//  - 出力: `{ semantically_same: boolean, reason: string }` の極小 JSON
//  - tool use 仕様で構造化出力を強制
//  - **fail-safe**: API error / 検証失敗時は `semantically_same: false` を返す
//    (refresh を走らせる安全側、ユーザーの編集を AI に再評価させる選択)
//  - レイテンシ目標: < 1 秒 / 判定
//  - コスト目標: < $0.001 / 判定(GPT-5.4 mini 単価、2 文の極小入出力)
//
// 詳細根拠は DECISIONS.md `[2026-05-25] 統合改修パッケージ訂正 — provider 完全統一
// (OpenAI)+ refresh / interview も GPT-5.4 full + 軽量判定 GPT-5.4 mini` を参照。

import OpenAI from "openai";
import { MODEL_SEMANTIC_DIFF } from "./openai";
import { resolveOpenAIKey } from "./openai_key";
// 提出後改善 #3 準備 (2026-06-09): 受動計測メタ(usage / レイテンシ)。LLM call が
// 実際に完了したときのみ onMeta で通知する(early return / API error 経路では通知しない)。
import {
  accumulateCaptureUsage,
  buildCaptureMeta,
  type CaptureMeta,
} from "./capture_meta";

// 意味的差分判定の結果型。
export interface SemanticDiffResult {
  /** 2 つの文が意味的に同じか */
  semantically_same: boolean;
  /** 判定理由(自然語、UI 表示は任意、log 用) */
  reason: string;
}

// tool name は judge_semantic_diff(LLM への意図表明として明示的に)
const JUDGE_TOOL_NAME = "judge_semantic_diff" as const;

const JUDGE_TOOL: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: JUDGE_TOOL_NAME,
  description:
    "2 つの日本語の文 / 句が意味的に同じか異なるかを判定する。同じ = 言い回し・時系列・語彙の差。異なる = 主張・論理・視点・新規情報の追加 / 削除の差。",
  parameters: {
    type: "object",
    properties: {
      semantically_same: {
        type: "boolean",
        description:
          "2 文が意味的に同じなら true、異なるなら false。判定境界は『主張・論理・視点・事実の差があるか』。",
      },
      reason: {
        type: "string",
        description:
          "判定理由を 1-2 文の日本語で。例: 『語尾の調整のみで主張は同じ』『新規情報「実装フェーズ」が追加されている』。",
      },
    },
    required: ["semantically_same", "reason"],
  },
  strict: false,
};

const SYSTEM_PROMPT = `あなたは日本語の文 / 句の意味的差分を判定する専門家です。

ユーザーから 2 つの文字列(before / after)を受け取ります。これらが意味的に同じか異なるかを judge_semantic_diff ツールで返してください。

# 判定基準

- **意味的に同じ(semantically_same: true)**:
  - 言い回しの違い(語順、語尾、漢字 / かなの選択、語感のバリエーション)
  - 助詞や接続詞の差(意味を変えない範囲で)
  - 改行 / 句読点 / 空白の差
  - 微少な語彙置換(類義語、同等の専門用語)

- **意味的に異なる(semantically_same: false)**:
  - 主張 / 結論が変わっている
  - 論理関係 / 因果が変わっている
  - 視点 / 主語 / 焦点が変わっている
  - 新規情報の追加 / 既存情報の削除がある
  - 事実(数値、固有名詞、時系列)が変わっている
  - 評価のトーン(肯定 / 否定 / 中立)が変わっている

# 出力

judge_semantic_diff ツールだけを呼び、ツール呼び出し以外の自然語(前置き、後置き、説明)は出力しないでください。
reason は 1-2 文で簡潔に書いてください。
`;

const MAX_OUTPUT_TOKENS = 256; // 極小出力(boolean + 1-2 文)

// OpenAI client の解決。
//
// BYOK (2026-05-29): per-request の鍵(apiKey)を受け取り、ヘッダ→env→throw の順で
// 解決する(`resolveOpenAIKey`)。BYOK では利用者ごとに鍵が異なりうるため、
//  - per-request 鍵が来たときは「都度 new」(キャッシュしない)
//  - 鍵が来ず env fallback のときだけ env キーで 1 度だけ instantiate してキャッシュ
// とすることで、異なるユーザーの鍵が混ざる事故を防ぐ。鍵そのものはログに出さない。
let cachedEnvClient: OpenAI | null = null;
function getClient(apiKey?: string): OpenAI {
  // resolveOpenAIKey は header(=apiKey)→ env → throw。throw 時は呼び出し側が
  // fail-safe(semantically_same: false)に倒す。
  const key = resolveOpenAIKey(apiKey);

  // per-request 鍵が明示されたケースはキャッシュせず都度 new(鍵の混在防止)。
  const trimmedHeader = typeof apiKey === "string" ? apiKey.trim() : "";
  if (trimmedHeader.length > 0) {
    return new OpenAI({ apiKey: key });
  }

  // env fallback のときだけ単一インスタンスを再利用(従来の挙動を維持)。
  if (cachedEnvClient) return cachedEnvClient;
  cachedEnvClient = new OpenAI({ apiKey: key });
  return cachedEnvClient;
}

// 意味的差分判定。fail-safe で「異なる」(false)を返す経路を保つ。
//  - before: 編集前の文字列(suggestion.proposed / 直接編集前の本文 等)
//  - after:  ユーザーが採用 / 編集した最終文字列
//  - apiKey: BYOK の per-request 鍵(省略時は env fallback)
//  - onMeta: 受動計測メタの callback(提出後改善 #3 準備 2026-06-09、optional)。
//            LLM call が完了した(応答を受け取った)ときのみ呼ばれる。before === after の
//            早期判定や API error 経路では呼ばれない(計測対象の LLM call が無い / 不完全)。
export async function judgeSemanticDiff(
  before: string,
  after: string,
  apiKey?: string,
  onMeta?: (meta: CaptureMeta) => void,
): Promise<SemanticDiffResult> {
  // 自明な早期決定: before === after なら確実に同じ(API を呼ぶ必要なし)
  if (before === after) {
    return {
      semantically_same: true,
      reason: "before と after が文字列として完全一致",
    };
  }
  // 空文字 or 極端に短い文字列の判定は LLM の精度が不安定なので安全側で「異なる」と返す
  if (after.trim().length === 0 || before.trim().length === 0) {
    return {
      semantically_same: false,
      reason: "空文字は安全側で『異なる』と判定(refresh を走らせる)",
    };
  }

  const userMessage = `[before]\n${before}\n\n[after]\n${after}\n\nこの 2 文が意味的に同じか異なるかを judge_semantic_diff で判定してください。`;

  let client: OpenAI;
  try {
    client = getClient(apiKey);
  } catch (err) {
    // OPENAI_API_KEY 不在等 — fail-safe(鍵が無ければ refresh を走らせる安全側)
    console.warn(
      "[semantic_diff] getClient failed, returning fail-safe (different)",
      err,
    );
    return {
      semantically_same: false,
      reason: "OpenAI client init failed (fail-safe: 異なるとして refresh を走らせる)",
    };
  }

  try {
    // 提出後改善 #3 準備 (2026-06-09): LLM call の実測レイテンシ。
    const llmCallStartedAt = Date.now();
    const response = await client.responses.create({
      model: MODEL_SEMANTIC_DIFF,
      input: [{ role: "user", content: userMessage }],
      instructions: SYSTEM_PROMPT,
      tools: [JUDGE_TOOL],
      tool_choice: { type: "function", name: JUDGE_TOOL_NAME },
      max_output_tokens: MAX_OUTPUT_TOKENS,
      // reasoning model でも mini は effort low で十分(2 文比較は楽勝)
      reasoning: { effort: "low" },
    });
    // 応答を受け取った時点で計測メタを通知(parse 失敗 / tool 未呼び出しの fail-safe
    // 経路でもトークンは消費されているため、ここで通知するのが実コストに忠実)。
    // 本経路はリトライ無し(1 リクエスト = 1 LLM call)なので retry_count は常に 0。
    onMeta?.(
      buildCaptureMeta({
        mode: "semantic_diff",
        model: MODEL_SEMANTIC_DIFF,
        latencyMs: Date.now() - llmCallStartedAt,
        usage: accumulateCaptureUsage(null, response.usage),
        retryCount: 0,
      }),
    );

    for (const item of response.output) {
      if (item.type === "function_call" && item.name === JUDGE_TOOL_NAME) {
        try {
          const parsed = JSON.parse(item.arguments) as Partial<SemanticDiffResult>;
          if (typeof parsed.semantically_same === "boolean") {
            return {
              semantically_same: parsed.semantically_same,
              reason:
                typeof parsed.reason === "string" && parsed.reason.length > 0
                  ? parsed.reason
                  : "理由情報なし",
            };
          }
        } catch (parseErr) {
          console.warn(
            "[semantic_diff] tool arguments JSON parse failed (fail-safe: 異なる)",
            parseErr,
          );
          return {
            semantically_same: false,
            reason:
              "judge_semantic_diff 出力が valid JSON でない(fail-safe: 異なるとして refresh)",
          };
        }
      }
    }

    // tool 呼び出しが見つからない / boolean フィールドが無い → fail-safe
    console.warn("[semantic_diff] judge_semantic_diff tool was not called");
    return {
      semantically_same: false,
      reason:
        "judge_semantic_diff ツールが呼ばれなかった(fail-safe: 異なるとして refresh)",
    };
  } catch (err) {
    // API error 全般 — fail-safe
    console.warn("[semantic_diff] API call failed (fail-safe: 異なる)", err);
    return {
      semantically_same: false,
      reason:
        err instanceof Error
          ? `OpenAI API error: ${err.message} (fail-safe: 異なるとして refresh)`
          : "Unknown OpenAI SDK error (fail-safe: 異なるとして refresh)",
    };
  }
}
