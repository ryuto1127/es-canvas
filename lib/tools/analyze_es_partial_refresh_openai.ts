import type OpenAI from "openai";

// 統合改修パッケージ (2026-05-25): OpenAI Responses API 用の partial-refresh ツール定義。
//
// `lib/tools/analyze_es_partial_refresh.ts`(Anthropic 版)と意味的に同一の JSON Schema を、
// `OpenAI.Responses.FunctionTool` の型に合わせて宣言する。
//
// 設計判断:
//  - tool name は Anthropic 版と同じ `analyze_es_partial_refresh` を使う
//  - strict は false(maxItems / 業務制約のため)
//  - Phase G Step 3b-2 / Phase G 再修正 (2026-05-24) の規律(updated/deleted 主軸、
//    added 最大 1 件、internal_priority 1-10 必須)を維持
//  - Anthropic 版を更新するときは本ファイルも同期する

export const ANALYZE_ES_PARTIAL_REFRESH_TOOL_NAME_OAI =
  "analyze_es_partial_refresh" as const;

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

// suggestion item schema(Anthropic 版と完全同形、internal_priority を含む)
const SUGGESTION_ITEM_SCHEMA = {
  type: "object" as const,
  properties: {
    id: {
      type: "string",
      description:
        "セッション内ユニーク ID(例: sug_001)。updated では既存 ID を維持、added では新規 ID を採番(既存と重複しないこと)。",
    },
    category: {
      type: "string",
      enum: SUGGESTION_CATEGORIES as unknown as string[],
      description:
        "error=客観的誤り / convention=ES慣習に基づく推奨 / alternative=代替案(原文を否定しない)。updated では元の category と一致させること。",
    },
    original: {
      type: "string",
      description:
        "現在の派生 ES 本体に完全一致する文字列。日本語の文節境界を守った単位で切り出す。",
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
      description: "関連する他の suggestion.id を自己宣言。なければ空配列。",
    },
    internal_priority: {
      type: "integer",
      minimum: 1,
      maximum: 10,
      description:
        "**サーバ内部用の重要度**。1=軽微、5=標準、10=最重要。**ユーザーに数値が見えることはなく**、サーバが文字列タグ(high/medium/low)に変換します。",
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
    "internal_priority",
  ],
};

export const ANALYZE_ES_PARTIAL_REFRESH_TOOL_OAI: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: ANALYZE_ES_PARTIAL_REFRESH_TOOL_NAME_OAI,
  description:
    "派生 ES に対する suggestion の partial update を返す。Sonnet 同等の主軸は updated / deleted(既存 suggestion の maintenance)。**added は最大 1 件**(逐次 1 件追加の HITL リズム、新規問題が無ければ空配列)。既存の初回評価軸を維持し、変更が必要な suggestion のみを updated / deleted / added に分けて出力する。interview_questions と es_state_version は出力しない(別経路 / サーバ付与)。各 suggestion には internal_priority(1-10)を付与する(UI には絶対表示されず、サーバ側で文字列タグに変換される)。",
  parameters: {
    type: "object",
    properties: {
      updated: {
        type: "array",
        maxItems: 15,
        description:
          "評価が変わった既存 suggestion(既存 id を維持、内容を更新)。category は元と同一にすること。ユーザーが既に採用 / 編集 / 却下した id は含めないこと(ユーザー判断を尊重)。",
        items: SUGGESTION_ITEM_SCHEMA,
      },
      deleted: {
        type: "array",
        maxItems: 15,
        description:
          "もう該当しなくなった既存 suggestion の id 配列。ユーザーが採用 / 編集 / 却下した id は含めないこと。",
        items: {
          type: "string",
          pattern: "^sug_\\d{3}$",
          description: "削除対象の suggestion id(例: sug_002)",
        },
      },
      added: {
        type: "array",
        maxItems: 1,
        description:
          "**最大 1 件のみ**(逐次 1 件追加の HITL リズム)。ユーザー操作によって新たな問題が生じている場合に、新規 1 件を追加する。**新規問題が無ければ空配列 []**(無理に埋めるための追加は禁止)。**複数件を一度に追加してはいけない**。新規 id を採番し、既存 suggestions / updated と被らないこと。",
        items: SUGGESTION_ITEM_SCHEMA,
      },
      overall_assessment: {
        type: "object",
        description:
          "総評の更新(任意)。原則は初回の評価軸を維持し、大きく変わった場合のみ更新を返す。",
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
              "書き手の個性を表す自然語のメモ。初回の preserved_voice_note と整合させる。",
          },
        },
        required: [
          "summary",
          "strengths",
          "weaknesses",
          "preserved_voice_note",
        ],
      },
      // 2026-05-27 エージェント的対話(AI 逆質問): partial refresh の global 質問。
      // updated/added の suggestion-bound と合算で最大 3 件。情報不足を感じなければ省略。
      global_clarification_questions: {
        type: "array",
        maxItems: 3,
        description:
          "partial refresh で ES 全体に対する逆質問(最大 3 件、省略可)。updated/added の suggestion-bound と合算して最大 3 件。情報不足を感じなければ出さない。",
        items: CLARIFICATION_QUESTION_ITEM_SCHEMA,
      },
    },
    required: ["updated", "deleted", "added"],
  },
  strict: false,
};
