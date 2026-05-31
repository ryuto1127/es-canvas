import { AnthropicProvider } from "./anthropic";
import { OpenAIProvider } from "./openai";
import { GoogleProvider } from "./google";
import { LLMError, type LLMProvider } from "./types";

export type ProviderName = "anthropic" | "openai" | "google";

// Capability ベースのプロバイダ選択。
//
// 統合改修パッケージ (2026-05-25): 全 capability の default provider を **OpenAI に完全統一**。
// DECISIONS.md `[2026-05-25] 統合改修パッケージ訂正 — provider 完全統一(OpenAI)+ refresh /
// interview も GPT-5.4 full + 軽量判定 GPT-5.4 mini` を参照。
//
// モデル配置(訂正後の最終形):
//  - research:                       OpenAI GPT-5.4 full
//  - analyze (initial / refresh / partial): OpenAI GPT-5.4 full
//  - interview:                       OpenAI GPT-5.4 full
//  - 意味的差分判定(動的 HITL):     OpenAI GPT-5.4 mini(別 helper、router 経由ではない)
//
// 採用理由(要約、詳細は上記 DECISIONS):
//  - Day 6 ベンチ実測で GPT-5.4 が Sonnet 4.6 同水準の質 + 安いコスト + 低レイテンシ + retry 0
//  - provider 統一の運用合理性(SDK 1 つ、API key 1 つ、エラーハンドリング 1 系統)
//  - 実測ベースでベンダーロックインを避け、特定モデルに固執しないという設計姿勢
//
// Anthropic / Google provider は default では選ばれないが、以下の経路で残置:
//  - `LLM_PROVIDER_OVERRIDE` 環境変数で全 capability を強制切替(ベンチ / デバッグ用途)
//  - 引数 `name` で個別リクエスト単位で切替(将来の v2 比較 / fallback 用途)
//  - `tests/analyze-bench.test.ts` の 3 系統比較は維持(provider を直接 instantiation)
export type Capability = "research" | "analyze" | "interview";

// 明示指定があればそちらを優先。なければ LLM_PROVIDER_OVERRIDE → capability デフォルトの順。
//   - 引数 name: route handler が body.provider を直に渡す経路(個別リクエスト単位の上書き)
//   - LLM_PROVIDER_OVERRIDE: 環境変数。全 capability を強制上書き(LLM 比較やデバッグ用途)
// DECISION [2026-05-22 セッション3]: Capability 単位でデフォルトを分けるアーキテクチャに移行。
// 旧 router.ts は単純な name → Provider 1対1マップで、capability 切替の余地が無かった。
// 統合改修パッケージ (2026-05-25): 全 capability の default を OpenAI に統一。
//
// BYOK (2026-05-29): 第 2 引数 openaiApiKey で per-request の OpenAI 鍵を受ける。
// OpenAI provider にのみ渡す(Anthropic / Google は env ベースのまま、fallback / bench を
// 壊さない)。省略時は従来通り OpenAIProvider 内で process.env.OPENAI_API_KEY に解決。
// 鍵そのものはここでログ出力しない(throw / return のみ)。
export function getProvider(
  arg?: Capability | ProviderName | string | null,
  openaiApiKey?: string,
): LLMProvider {
  // ① 引数で provider 名が明示されたら最優先
  const explicit = normalizeProviderName(arg);
  if (explicit) return instantiate(explicit, openaiApiKey);

  // ② 環境変数で全 capability を強制
  const override = normalizeProviderName(process.env.LLM_PROVIDER_OVERRIDE);
  if (override) return instantiate(override, openaiApiKey);

  // ③ capability デフォルト — 全 capability で OpenAI に統一(統合改修パッケージ 2026-05-25)
  const capability = normalizeCapability(arg) ?? "research";
  switch (capability) {
    case "research":
    case "analyze":
    case "interview":
      return new OpenAIProvider(openaiApiKey);
  }
}

function normalizeProviderName(
  value: unknown,
): ProviderName | null {
  if (typeof value !== "string") return null;
  const v = value.toLowerCase().trim();
  if (v === "anthropic" || v === "openai" || v === "google") return v;
  return null;
}

function normalizeCapability(value: unknown): Capability | null {
  if (typeof value !== "string") return null;
  const v = value.toLowerCase().trim();
  if (v === "research" || v === "analyze" || v === "interview") return v;
  return null;
}

function instantiate(name: ProviderName, openaiApiKey?: string): LLMProvider {
  switch (name) {
    case "anthropic":
      // BYOK は OpenAI 主経路のみ。Anthropic は env ベース(v2 切戻し / 障害時 fallback)。
      return new AnthropicProvider();
    case "openai":
      return new OpenAIProvider(openaiApiKey);
    case "google":
      return new GoogleProvider();
    default:
      throw new LLMError("api_error", `Unknown LLM provider: ${name as string}`);
  }
}
