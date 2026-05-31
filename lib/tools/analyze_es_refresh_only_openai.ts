import type OpenAI from "openai";

// 統合改修パッケージ (2026-05-25): OpenAI Responses API 用の refresh-only ツール定義。
//
// `lib/tools/analyze_es_refresh_only.ts`(Anthropic 版)と意味的に同一の JSON Schema を、
// `OpenAI.Responses.FunctionTool` の型に合わせて宣言する。
//
// 設計判断:
//  - tool name は Anthropic 版と同じ `analyze_es_refresh_only` を使う(prompt 側で参照する
//    ツール名を両 provider で揃えるため、prompt 共通化の前提条件)
//  - strict は false(maxItems / 業務制約と両立しないため、`analyze_es_openai.ts` と同じ判断)
//  - Anthropic 版を更新するときは本ファイルも同期する

export const ANALYZE_ES_REFRESH_ONLY_TOOL_NAME_OAI =
  "analyze_es_refresh_only" as const;

const RATIONALE_SOURCE_TYPES = [
  "company_value",
  "convention",
  "rubric",
  "linguistic",
  "consistency",
  "user_intent",
] as const;

const SUGGESTION_CATEGORIES = ["error", "convention", "alternative"] as const;

// 2026-05-27 エージェント的対話(AI 逆質問): clarification_questions の item schema(Anthropic 版と完全同形)。
const CLARIFICATION_QUESTION_ITEM_SCHEMA = {
  type: "object" as const,
  properties: {
    id: {
      type: "string",
      description:
        "質問の一意 id(`q_001` のような短い識別子、再分析時の回答紐付け用)。suggestion 内 + global で重複しないこと。",
    },
    question: {
      type: "string",
      minLength: 5,
      maxLength: 200,
      description: "質問本文(5〜200 字)。簡潔に「何を聞きたいか」を一文で。",
    },
    rationale: {
      type: "string",
      minLength: 10,
      maxLength: 300,
      description:
        "なぜこの質問を出すか(10〜300 字)。質問の意図を明示することで、AI が形骸化質問を量産するのを防ぐ。",
    },
  },
  required: ["id", "question", "rationale"],
};

// suggestion item schema(Anthropic refresh-only 版と完全同形)
const SUGGESTION_ITEM_SCHEMA = {
  type: "object" as const,
  properties: {
    id: {
      type: "string",
      description:
        "セッション内ユニーク ID(例: sug_001)。前回 refresh の ID 安定性は保証不要。",
    },
    category: {
      type: "string",
      enum: SUGGESTION_CATEGORIES as unknown as string[],
      description:
        "error=客観的誤り / convention=ES慣習に基づく推奨 / alternative=代替案(原文を否定しない)",
    },
    original: {
      type: "string",
      description:
        "現在の ES 本体に完全一致する文字列。日本語の文節境界を守った単位で切り出す(助詞・名詞・動詞活用の途中で切らない)。サーバが indexOf で位置解決する。",
    },
    proposed: {
      type: "string",
      description:
        "主な提案文。必ず original と異なる文字列であること(何も変えない指摘は出力しない)。",
    },
    alternatives: {
      type: "array",
      description:
        "alternative カテゴリでは1個以上、他カテゴリでは空配列を許容。各 text は original と異なる文字列であること。",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "alt_xxx_n の形式" },
          text: {
            type: "string",
            description: "代替表現(original と異なる文字列であること)",
          },
          tone_hint: {
            type: "string",
            description: "トーン傾向の短いメモ",
          },
        },
        required: ["id", "text", "tone_hint"],
      },
    },
    rationale: {
      type: "string",
      description: "1〜3文の理由。簡潔に。",
    },
    rationale_source: {
      type: "object",
      description:
        "company_value のときは url 必須、evidence_id は承認済みリスト内の ID のみ optional 指定可。",
      properties: {
        type: {
          type: "string",
          enum: RATIONALE_SOURCE_TYPES as unknown as string[],
          description: "根拠ソース種別",
        },
        reference: {
          type: "string",
          description: "参照元の短い説明",
        },
        url: {
          type: "string",
          description:
            "company_value のときのみ必須。承認済み evidence の source_url と完全一致させる。",
        },
        evidence_id: {
          type: "string",
          description:
            "company_value のとき optional。承認済み evidence リスト内の ID のみ。",
        },
      },
      required: ["type", "reference"],
    },
    related_suggestion_ids: {
      type: "array",
      items: { type: "string" },
      description:
        "関連する他の suggestion.id を自己宣言。なければ空配列。",
    },
    // 2026-05-27 エージェント的対話(AI 逆質問): suggestion-bound 質問(0 or 1 個)。
    clarification_questions: {
      type: "array",
      maxItems: 1,
      description:
        "この suggestion について情報不足を感じた時に出す逆質問(最大 1 件、省略可)。情報不足を感じなければ出力しない。質問の id は suggestion 内 + global で重複させないこと。",
      items: CLARIFICATION_QUESTION_ITEM_SCHEMA,
    },
  },
  required: [
    "id",
    "category",
    "original",
    "proposed",
    "alternatives",
    "rationale",
    "rationale_source",
    "related_suggestion_ids",
  ],
};

export const ANALYZE_ES_REFRESH_ONLY_TOOL_OAI: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: ANALYZE_ES_REFRESH_ONLY_TOOL_NAME_OAI,
  description:
    "リフレッシュ用の ES 添削ツール。面接質問は出力しない(別ツール generate_interview_questions で扱う)。es_state_version も出力しない(サーバ側で付与)。現在の ES 本体に対して、ユーザー操作履歴を踏まえた新しい指摘を最大15個生成する。指摘の original は現在の ES 本体と完全一致する文字列でなければならず、日本語の文節境界を守って切り出す。proposed は必ず original と異なる文字列であること。rationale_source.type === 'company_value' のときは url 必須、evidence_id は承認済み evidence リスト内の ID のみ。",
  parameters: {
    type: "object",
    properties: {
      overall_assessment: {
        type: "object",
        description:
          "総評。数値スコアを含めない。preserved_voice_note は書き手の個性を自然語で記録する。",
        properties: {
          summary: {
            type: "string",
            description: "1〜3文の自然語サマリ。数値スコアは出さない。",
          },
          strengths: {
            type: "array",
            items: { type: "string" },
            description: "強みの短いリスト",
          },
          weaknesses: {
            type: "array",
            items: { type: "string" },
            description: "改善余地の短いリスト",
          },
          preserved_voice_note: {
            type: "string",
            description:
              "書き手の個性を表す自然語のメモ。alternative 提案はこのメモと整合させる。",
          },
        },
        required: ["summary", "strengths", "weaknesses", "preserved_voice_note"],
      },
      suggestions: {
        type: "array",
        maxItems: 15,
        description:
          "指摘カードの配列(最大15個)。original は現在の ES 本体と完全一致する文字列のみ。category=alternative のときは alternatives を1個以上含める。",
        items: SUGGESTION_ITEM_SCHEMA,
      },
      // 2026-05-27 エージェント的対話(AI 逆質問): refresh の global 質問。suggestion-bound と合算で最大 3 件。
      global_clarification_questions: {
        type: "array",
        maxItems: 3,
        description:
          "refresh で ES 全体に対する逆質問(最大 3 件、省略可)。suggestion-bound と合算して最大 3 件。情報不足を感じなければ出さない。",
        items: CLARIFICATION_QUESTION_ITEM_SCHEMA,
      },
    },
    required: ["overall_assessment", "suggestions"],
  },
  strict: false,
};
