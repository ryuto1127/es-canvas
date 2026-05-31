import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getProvider } from "@/lib/llm/router";
import { LLMError } from "@/lib/llm/types";
import {
  OPENAI_KEY_HEADER,
  tryResolveOpenAIKey,
} from "@/lib/llm/openai_key";
import {
  CompanySummarySchema,
  type CompanySummary,
  type ResearchInputSource,
} from "@/lib/schema/company";

export const runtime = "nodejs";

// DECISION [Phase B-2]: maxDuration = 120 を route segment config で明示。
// - エージェントループの想定平均は 30〜60秒(search 1〜3回 + fetch 3〜7回 + 合成)
// - Vercel の Hobby/Pro はデフォルト 300/800 秒なので 120秒は安全側の打ち切り
// - 120 を超える場合は agent_max_iterations 例外で 504 に丸まる前にここで時間切れ
//
// Phase E 拡張(2026-05-23): freetext 経路はエージェントループ無しで LLM 1 回呼び出し
// (5〜15秒目安)。同 maxDuration = 120 で大きく余裕がある(変更なし)。
export const maxDuration = 120;

// Phase B-2: 入力は URL のみ / 会社名のみ / 両方 のいずれか
// Phase E 拡張(2026-05-23): freetext バリアントを追加(ユーザーが自分でまとめた企業情報メモ)
const ResearchRequestSchema = z.discriminatedUnion("input_type", [
  z.object({
    input_type: z.literal("url"),
    url: z.string().url(),
    provider: z.enum(["anthropic", "openai", "google"]).optional(),
  }),
  z.object({
    input_type: z.literal("name"),
    name: z.string().min(1).max(100),
    provider: z.enum(["anthropic", "openai", "google"]).optional(),
  }),
  z.object({
    input_type: z.literal("both"),
    url: z.string().url(),
    name: z.string().min(1).max(100),
    provider: z.enum(["anthropic", "openai", "google"]).optional(),
  }),
  z.object({
    input_type: z.literal("freetext"),
    // value の min/max は ResearchInputSourceSchema(freetext)と一致。
    // 20字未満: LLM が整形不能、4000字超: コスト爆発防止。
    value: z.string().min(20).max(4000),
    provider: z.enum(["anthropic", "openai", "google"]).optional(),
  }),
]);

type CacheEntry = { value: CompanySummary; cached_at: number };
const COMPANY_CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    if (u.pathname.endsWith("/") && u.pathname !== "/") {
      u.pathname = u.pathname.slice(0, -1);
    }
    u.host = u.host.toLowerCase();
    return u.toString();
  } catch {
    return raw;
  }
}

// 会社名の正規化: NFKC 正規化(全角→半角)+ トリム + 連続空白の単一化。
// 「(株)」「株式会社」のような法人格表記は別キー扱い(命名揺れを吸収しすぎると別会社を統合する事故が起きる)
function normalizeName(raw: string): string {
  return raw.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function makeCacheKey(input: ResearchInputSource): string {
  switch (input.type) {
    case "url":
      return `url:${normalizeUrl(input.value)}`;
    case "name":
      return `name:${normalizeName(input.value)}`;
    case "both":
      return `both:${normalizeUrl(input.url)}|${normalizeName(input.name)}`;
    case "freetext": {
      // 自由テキストはハッシュでキャッシュキーを構築。NFKC + trim + 連続空白圧縮で
      // 表記揺れ(全角/半角空白の差など)を吸収してからハッシュ化。
      const normalized = input.value
        .normalize("NFKC")
        .trim()
        .replace(/\s+/g, " ");
      const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 32);
      return `freetext:${hash}`;
    }
  }
}

function toResearchInput(
  body: z.infer<typeof ResearchRequestSchema>,
): ResearchInputSource {
  switch (body.input_type) {
    case "url":
      return { type: "url", value: body.url };
    case "name":
      return { type: "name", value: body.name };
    case "both":
      return { type: "both", url: body.url, name: body.name };
    case "freetext":
      return { type: "freetext", value: body.value };
  }
}

export async function POST(req: NextRequest) {
  // 1. body パース + バリデーション
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { kind: "bad_request", message: "Request body is not valid JSON" } },
      { status: 400 },
    );
  }

  const parsed = ResearchRequestSchema.safeParse(body);
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

  const input = toResearchInput(parsed.data);

  // BYOK (2026-05-29): per-request の OpenAI 鍵をヘッダから解決(ヘッダ→env→null)。
  // default provider は OpenAI なので、鍵が無ければここで 400 を返す
  // (provider 明示が anthropic / google のときは env ベースで動くため鍵不要 →
  //  その場合だけ後続で例外的に通すが、本プロダクトの主経路は OpenAI)。
  const openaiKey = tryResolveOpenAIKey(req.headers.get(OPENAI_KEY_HEADER));
  const explicitProvider = parsed.data.provider;
  if (openaiKey === null && (explicitProvider === undefined || explicitProvider === "openai")) {
    return NextResponse.json(
      {
        error: {
          kind: "missing_api_key",
          message: "OpenAI API key is required (set it from the settings, or configure server env)",
          stage: "agent_research",
        },
      },
      { status: 400 },
    );
  }

  // DECISION [2026-05-22 セッション4]: キャッシュキーに provider 名を含める。
  // セッション2 では provider を含めずに `${input_type}:${正規化値}` だけで分離していたが、
  // Day 6 の LLM 比較で「同じ会社を OpenAI / Anthropic 両方で叩いて比べたい」要件があり、
  // provider 抜きのキーだと「先に走った provider の結果」を別 provider のリクエストでも返してしまう。
  // セッション4 のスモークテストで実際に観測(LLM_PROVIDER_OVERRIDE=anthropic で全件 OpenAI キャッシュヒット)。
  // provider を確定させてからキーを組み立てる流れに変更。
  const provider = getProvider(parsed.data.provider ?? "research", openaiKey ?? undefined);
  const cacheKey = `${provider.name}:${makeCacheKey(input)}`;

  // 2. キャッシュヒット判定
  const hit = COMPANY_CACHE.get(cacheKey);
  if (hit && Date.now() - hit.cached_at < CACHE_TTL_MS) {
    return NextResponse.json(
      { data: hit.value, cached: true },
      {
        status: 200,
        headers: { "X-Cache": "HIT" },
      },
    );
  }

  // 3. エージェント呼び出し(内部で web_search / fetch_page を回す)
  let summary: CompanySummary;
  try {
    summary = await provider.researchCompany(input);
  } catch (err) {
    if (err instanceof LLMError) {
      if (err.kind === "schema_validation") {
        console.error("[/api/research] schema_validation failure", err.cause);
      }
      // HTTP マッピング(セッション1のパターンを継承しつつ B-2 で agent_* を追加)
      const status =
        err.kind === "rate_limit"
          ? 503
          : err.kind === "api_error"
            ? 503
            : err.kind === "timeout"
              ? 504
              : err.kind === "agent_no_submission"
                ? 503
                : err.kind === "agent_max_iterations"
                  ? 504
                  : err.kind === "not_implemented"
                    ? 501
                    : 502;
      const retryable =
        err.kind === "rate_limit" ||
        err.kind === "timeout" ||
        err.kind === "api_error" ||
        err.kind === "agent_no_submission" ||
        err.kind === "agent_max_iterations";
      return NextResponse.json(
        {
          error: {
            kind: err.kind,
            message: err.message,
            stage: "agent_research",
            retryable,
          },
        },
        { status },
      );
    }
    console.error("[/api/research] unknown error", err);
    return NextResponse.json(
      {
        error: {
          kind: "unknown",
          message: "Unexpected server error",
          stage: "agent_research",
        },
      },
      { status: 500 },
    );
  }

  // 4. 最終バリデーション(provider 内でも検証しているが二重防御)
  const finalCheck = CompanySummarySchema.safeParse(summary);
  if (!finalCheck.success) {
    console.error("[/api/research] final validation failed", finalCheck.error.flatten());
    return NextResponse.json(
      {
        error: {
          kind: "schema_validation",
          message: "Provider returned a CompanySummary that failed final schema check",
          stage: "post_validation",
        },
      },
      { status: 502 },
    );
  }

  // 5. キャッシュ保存
  COMPANY_CACHE.set(cacheKey, { value: finalCheck.data, cached_at: Date.now() });

  return NextResponse.json(
    { data: finalCheck.data, cached: false },
    {
      status: 200,
      headers: { "X-Cache": "MISS" },
    },
  );
}
