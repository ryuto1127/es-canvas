import { NextRequest, NextResponse } from "next/server";
import { judgeSemanticDiff } from "@/lib/llm/semantic_diff";
import { OPENAI_KEY_HEADER } from "@/lib/llm/openai_key";
import { z } from "zod";
// 提出後改善 #3 準備 (2026-06-09): 受動計測メタ(JSON 応答の optional フィールドで伝搬)。
import type { CaptureMeta } from "@/lib/llm/capture_meta";

// 統合改修パッケージ (2026-05-25): 動的 HITL の意味的差分判定エンドポイント
//
// Canvas の編集系 action(editSuggestion / direct edit OFF など)が、partial refresh を
// 走らせる前にこのエンドポイントを呼ぶ。GPT-5.4 mini で 2 文の意味的差分を判定し、
// 「意味的に同じ」なら refresh を skip、「異なる」なら refresh を発火する HITL 設計
// (DECISIONS.md `[2026-05-25] 統合改修パッケージ訂正` 参照)。

export const runtime = "nodejs";

// 2 文比較なら 5 秒以内で完走見込み。リトライ余地 + reasoning model のオーバーヘッドで
// 60 秒バッファを取る(本実装は 1 リクエスト = 1 LLM call、retry なし)。
export const maxDuration = 60;

// 入力 schema(2 文の文字列を取る、長さの上限は十分大きく)
const RequestSchema = z.object({
  before: z.string().min(0).max(8000),
  after: z.string().min(0).max(8000),
});

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { kind: "bad_request", message: "Request body is not valid JSON" } },
      { status: 400 },
    );
  }

  const parsed = RequestSchema.safeParse(body);
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

  const { before, after } = parsed.data;

  // BYOK (2026-05-29): per-request の OpenAI 鍵は **生ヘッダのまま** judgeSemanticDiff に渡す。
  // 鍵解決(ヘッダ→env→throw)は judgeSemanticDiff / getClient 側が自己完結で行い、
  //  - 生ヘッダが non-empty なら都度 new(ユーザー鍵の混在防止)
  //  - 空 / 不在なら env fallback の単一クライアントを再利用(従来の cache 挙動を維持)
  // と最適化される。鍵が無ければ内部で fail-safe(semantically_same: false → refresh)
  // に倒れるため、ここでは 400 を返さない。
  const rawHeaderKey = req.headers.get(OPENAI_KEY_HEADER) ?? undefined;

  // judgeSemanticDiff は fail-safe(API error 時に semantically_same: false を返す)、
  // 例外を投げない設計。ここでは戻り値をそのまま JSON で返す。
  // 提出後改善 #3 準備 (2026-06-09): onMeta callback で受動計測メタを受け取り、
  // optional の additive フィールドとして同梱(早期判定 / API error 経路では undefined =
  // JSON serialization で落ちて従来の { data } 形のまま)。
  try {
    let captureMeta: CaptureMeta | undefined;
    const result = await judgeSemanticDiff(before, after, rawHeaderKey, (meta) => {
      captureMeta = meta;
    });
    return NextResponse.json(
      { data: result, capture_meta: captureMeta },
      { status: 200 },
    );
  } catch (err) {
    // judgeSemanticDiff は本来 throw しないが、防御的に処理する。
    console.error("[/api/semantic-diff] unexpected error", err);
    // fail-safe: 異常時は「異なる」と返して refresh を走らせる
    return NextResponse.json(
      {
        data: {
          semantically_same: false,
          reason:
            err instanceof Error
              ? `Unexpected server error: ${err.message} (fail-safe: 異なる)`
              : "Unexpected server error (fail-safe: 異なる)",
        },
      },
      { status: 200 },
    );
  }
}
