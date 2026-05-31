// LLM provider 別の token 単価(USD per million tokens)。
//
// Day 6 (2026-05-24) LLM 比較ベンチ実装に伴い新設。analyze 経路の 3 系統
// (Anthropic Sonnet 4.6 / Anthropic Opus 4.7 / OpenAI GPT-5.4)で発生する
// コストを後段で集計するための定数表。
//
// 値の出典:
//  - Anthropic Sonnet 4.6 / Opus 4.7: Anthropic 公式単価表(2026 年時点)
//      Sonnet 4.6: input $3 / output $15 / cache_read $0.30 / cache_creation $3.75
//      Opus   4.7: input $5 / output $25 / cache_read $0.50 / cache_creation $6.25
//  - OpenAI GPT-5.4: OpenAI 公式 docs を基準とした **暫定値**。実際の単価は
//      ベンチ実行直前に再確認すること。確認が取れない場合は本表を「要追加調査」
//      として DECISIONS に明記する(dispatch §D の指示)。本 dispatch では
//      Sonnet と Opus の中間レンジを想定値として置き、後段で再校正可能にする。
//
// 設計判断:
//  - cache_read / cache_creation を別レートで管理(Anthropic prompt caching 経由)。
//    OpenAI Responses API は previous_response_id 経由で自動 caching するが、
//    cache_read 単価は input の 50% で固定(2026 年時点の OpenAI 公式)、
//    cache_creation という概念は無いため undefined のまま許容する。
//  - すべて per-million tokens(USD)で揃え、cost() ヘルパーで掛け算する。
//  - UI には絶対に渡さない(本ファイルはサーバ専用、tests/ からのみ参照)。

export interface ModelPricing {
  /** input token 単価(USD / 1M tokens) */
  input: number;
  /** output token 単価(USD / 1M tokens) */
  output: number;
  /** prompt cache hit 時の input 単価(USD / 1M tokens)。なければ通常 input と同じ。 */
  cache_read?: number;
  /** prompt cache 書き込み時の input 単価(USD / 1M tokens、Anthropic のみ) */
  cache_creation?: number;
}

// model 名 → 単価マップ。anthropic.ts / openai.ts の MODEL_SONNET / MODEL_OPUS /
// MODEL_RESEARCH と一致させる(両者の SSOT として参照される)。
export const PRICING_PER_MILLION: Record<string, ModelPricing> = {
  "claude-sonnet-4-6": {
    input: 3,
    output: 15,
    cache_read: 0.3,
    cache_creation: 3.75,
  },
  "claude-opus-4-7": {
    input: 5,
    output: 25,
    cache_read: 0.5,
    cache_creation: 6.25,
  },
  // GPT-5.4(full)— OpenAI 公式の最新単価で校正されるまでの暫定値。
  // 2026-05-24 時点の調査では、GPT-5.4 系は GPT-4o 系後継として位置付けされており
  // Sonnet 4.6 と Opus 4.7 の中間レンジが妥当と判断。本表は将来更新前提。
  "gpt-5.4": {
    input: 4,
    output: 20,
    cache_read: 2,
  },
} as const;

// 1 回の analyze で消費した token usage からコストを計算する。
// cache_read / cache_creation が undefined のときは 0 として扱う。
export interface TokenUsage {
  input: number;
  output: number;
  cache_read?: number;
  cache_creation?: number;
}

export interface CostBreakdown {
  /** 通常 input token 分(cache_read を含まない、API が返す input_tokens) */
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheCreationUsd: number;
  /** すべての合計 */
  totalUsd: number;
}

// 設計判断:
//  - Anthropic SDK は input_tokens に「キャッシュヒット分を含まない通常 input」を返す
//    (cache_read_input_tokens / cache_creation_input_tokens は別カウント)。
//    そのため input 単純掛け算で OK。
//  - OpenAI Responses API は input_tokens にキャッシュヒット分も含めて返す可能性が
//    あるが、SDK の usage オブジェクトに `cached_tokens` 等で分離されていれば、
//    test bench 側で渡す `usage` を「通常分のみ」に整形する。本関数は受け取った値を
//    そのまま信じて計算する(整形責任は呼び出し側)。
export function calcCost(model: string, usage: TokenUsage): CostBreakdown {
  const pricing = PRICING_PER_MILLION[model];
  if (!pricing) {
    return {
      inputUsd: 0,
      outputUsd: 0,
      cacheReadUsd: 0,
      cacheCreationUsd: 0,
      totalUsd: 0,
    };
  }

  const inputUsd = (usage.input * pricing.input) / 1_000_000;
  const outputUsd = (usage.output * pricing.output) / 1_000_000;
  const cacheReadUsd =
    ((usage.cache_read ?? 0) * (pricing.cache_read ?? pricing.input)) /
    1_000_000;
  const cacheCreationUsd =
    ((usage.cache_creation ?? 0) *
      (pricing.cache_creation ?? pricing.input)) /
    1_000_000;
  const totalUsd = inputUsd + outputUsd + cacheReadUsd + cacheCreationUsd;

  return {
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheCreationUsd,
    totalUsd,
  };
}

// 表示用 helper: 0.001 未満は "$0.00X" のような短い書式、それ以上は 2 桁小数
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
