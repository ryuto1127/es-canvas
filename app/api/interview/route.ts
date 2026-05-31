import { NextRequest, NextResponse } from "next/server";
import { getProvider } from "@/lib/llm/router";
import { LLMError } from "@/lib/llm/types";
import {
  OPENAI_KEY_HEADER,
  tryResolveOpenAIKey,
} from "@/lib/llm/openai_key";
import {
  InterviewInputBundleSchema,
  type InterviewInputBundle,
} from "@/lib/schema/input";
import {
  InterviewQuestionsSchema,
  type InterviewQuestions,
} from "@/lib/schema/interview";

// Phase D セッション6: /api/interview を独立エンドポイントとして新設。
// lib/prompts/interview.ts 推奨に従い、面接質問生成だけを担当する。
// /api/analyze (refresh) と分けることで、ツールスキーマを questions 配列だけに絞れる
// → 検証が単純化 + バックエンドの呼び分けロジックが明快になる。

export const runtime = "nodejs";

// 統合改修パッケージ (2026-05-25): OpenAI GPT-5.4 full に切替。
// Day 6 ベンチで GPT-5.4 が安定して低レイテンシ + retry 0 で完走することを実証済。
// リトライ余地 + reasoning model の余裕で 300秒バッファを維持。
export const maxDuration = 300;

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

  // 2. Zod 検証
  const parsed = InterviewInputBundleSchema.safeParse(body);
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
  const input: InterviewInputBundle = parsed.data;

  // BYOK (2026-05-29): per-request の OpenAI 鍵をヘッダから解決(ヘッダ→env→null)。
  // interview の default provider は OpenAI なので、鍵が無ければ 400 を返す。
  const openaiKey = tryResolveOpenAIKey(req.headers.get(OPENAI_KEY_HEADER));
  if (openaiKey === null) {
    return NextResponse.json(
      {
        error: {
          kind: "missing_api_key",
          message:
            "OpenAI API key is required (set it from the settings, or configure server env)",
          stage: "generate_interview",
        },
      },
      { status: 400 },
    );
  }

  // 3. provider 選択 — 統合改修パッケージ (2026-05-25): interview も OpenAI GPT-5.4 full に統一
  //    詳細は DECISIONS.md `[2026-05-25] 統合改修パッケージ訂正` 参照
  const provider = getProvider("interview", openaiKey);

  // 4. 面接質問生成(provider 内部で防衛三段 + 1回リトライ)
  let result: InterviewQuestions;
  try {
    result = await provider.generateInterview(input);
  } catch (err) {
    if (err instanceof LLMError) {
      if (err.kind === "schema_validation" || err.kind === "analysis_validation") {
        console.error("[/api/interview] validation failure", err.cause);
      }
      const status =
        err.kind === "rate_limit"
          ? 503
          : err.kind === "api_error"
            ? 503
            : err.kind === "timeout"
              ? 504
              : err.kind === "not_implemented"
                ? 501
                : err.kind === "analysis_validation"
                  ? 502
                  : err.kind === "schema_validation"
                    ? 502
                    : 502;
      const retryable =
        err.kind === "rate_limit" ||
        err.kind === "timeout" ||
        err.kind === "api_error";
      return NextResponse.json(
        {
          error: {
            kind: err.kind,
            message: err.message,
            stage: "generate_interview",
            retryable,
          },
        },
        { status },
      );
    }
    console.error("[/api/interview] unknown error", err);
    return NextResponse.json(
      {
        error: {
          kind: "unknown",
          message: "Unexpected server error",
          stage: "generate_interview",
        },
      },
      { status: 500 },
    );
  }

  // 5. 最終バリデーション(二重防御 — /api/analyze と同じパターン)
  const finalCheck = InterviewQuestionsSchema.safeParse(result);
  if (!finalCheck.success) {
    console.error(
      "[/api/interview] final validation failed",
      finalCheck.error.flatten(),
    );
    return NextResponse.json(
      {
        error: {
          kind: "schema_validation",
          message:
            "Provider returned an InterviewQuestions that failed final schema check",
          stage: "post_validation",
        },
      },
      { status: 502 },
    );
  }

  return NextResponse.json({ data: finalCheck.data }, { status: 200 });
}
