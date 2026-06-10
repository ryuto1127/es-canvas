import type OpenAI from "openai";

// Day 6 (2026-05-24): OpenAI Responses API 用の analyze_es ツール定義。
// `lib/tools/analyze_es.ts` の Anthropic 版と意味的に同一の JSON Schema を、
// `OpenAI.Responses.FunctionTool` の型に合わせて宣言する。
//
// 設計判断(2026-05-24 Day 6 比較ベンチ):
//  - Anthropic 版 (analyze_es.ts) と JSON Schema の中身を **完全に同一** に保つ
//    こと(機能制約: enum 値、required、description、maxItems 等)。3 系統で
//    「prompt + tool 同じ、モデルだけ違う」を実現するため、ここを変えると比較が
//    壊れる。Anthropic 版の更新時は本ファイルも同期する。
//  - strict は false。Anthropic 版と同じ理由(maxItems / minItems 等の業務制約と
//    strict mode は両立しない、 lib/tools/research_agent_openai.ts L33-34 と同じ判断)。
//  - tool name は同じ `analyze_es` を使う。route 側で provider を切り替えても、
//    tool_choice / response parsing が同じロジックで動く。

export const ANALYZE_ES_TOOL_NAME_OAI = "analyze_es" as const;

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

// suggestion item schema (internal_priority を含む、Anthropic 版と完全同形)
const SUGGESTION_ITEM_SCHEMA = {
  type: "object" as const,
  properties: {
    id: {
      type: "string",
      description: "セッション内ユニーク ID(例: sug_001)",
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
        "ES 本体に完全一致する文字列(部分書き換え・要約・改変は禁止)。日本語の文節境界を守った単位で切り出す(助詞の途中・名詞の途中・動詞の活用語尾の途中で切らない)。サーバが indexOf で位置解決する。",
    },
    proposed: {
      type: "string",
      description:
        "主な提案文。必ず original と異なる文字列であること(何も変えない指摘は出力しない)。",
    },
    alternatives: {
      type: "array",
      description:
        "alternative カテゴリでは1個以上、他カテゴリでは空配列を許容。元のトーンを保つ案を1つは含めることが望ましい。各 text は original と異なる文字列であること。",
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
            description: "トーン傾向の短いメモ(例: 「原文のトーンを維持」)",
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
        "type ごとに必須フィールドが異なる: company_value のときは url 必須、evidence_id は承認済みリスト内の ID のみ optional 指定可。他の type では url / evidence_id を指定しない。",
      properties: {
        type: {
          type: "string",
          enum: RATIONALE_SOURCE_TYPES as unknown as string[],
          description: "根拠ソース種別",
        },
        reference: {
          type: "string",
          description:
            "参照元の短い説明(例: 「STAR構造のSituation補強」「Think Deep」)",
        },
        url: {
          type: "string",
          description:
            "company_value のときのみ必須。承認済み evidence の source_url または企業要約のソースURLと完全一致させる。",
        },
        evidence_id: {
          type: "string",
          description:
            "company_value のとき optional。指定する場合は承認済み evidence リスト(ユーザーメッセージ末尾)に含まれる ID(例: ev_001)のみ。他 type では出力しない。",
        },
      },
      required: ["type", "reference"],
    },
    related_suggestion_ids: {
      type: "array",
      items: { type: "string" },
      description:
        "関連する他の suggestion.id を自己宣言(ハード依存ではないヒント)。なければ空配列。",
    },
    internal_priority: {
      type: "integer",
      minimum: 1,
      maximum: 10,
      description:
        "**サーバ内部用の重要度**。1=軽微、5=標準、10=最重要。**ユーザーに数値が見えることはなく**、サーバが文字列タグ(high/medium/low)に変換します。",
    },
    // 2026-05-27 エージェント的対話(AI 逆質問): suggestion-bound 質問(0 or 1 個)。
    // 情報不足を感じなければ省略。load-bearing field name、リネーム禁止。
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

export const ANALYZE_ES_TOOL_OAI: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: ANALYZE_ES_TOOL_NAME_OAI,
  description:
    "ES添削の構造化された分析結果を返す。総評(数値スコアなし)、最大15個の指摘カード、3〜5問の面接質問を含む。指摘の original は ES 本体と完全一致する文字列でなければならず、日本語の文節境界を守って切り出す(助詞・名詞・動詞活用の途中で切らない)。proposed は必ず original と異なる文字列であること(何も変えない指摘は出力しない)。rationale_source.type === 'company_value' のときは url 必須、evidence_id は承認済み evidence リスト内の ID のみ。",
  parameters: {
    type: "object",
    properties: {
      es_state_version: {
        type: "integer",
        minimum: 0,
        description:
          "この分析が対象とする ES のバージョン番号。initial では入力 current_es_version をそのまま採用する。",
      },
      overall_assessment: {
        type: "object",
        description:
          "総評。数値スコア(点・%・ランクなど)を含めない。preserved_voice_note は書き手の個性を自然語で記録する。",
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
              "書き手の個性を表す自然語のメモ(例: 「短文を畳みかけるリズム」「データドリブンな論理展開」)。alternative 提案はこのメモと整合させる。",
          },
        },
        required: [
          "summary",
          "strengths",
          "weaknesses",
          "preserved_voice_note",
        ],
      },
      suggestions: {
        type: "array",
        maxItems: 15,
        description:
          "指摘カード(最大 15)。original は ES 本体と完全一致する文字列のみ。category=alternative のときは alternatives を1個以上含める。各 suggestion には internal_priority(1-10)を付与すること。**件数を埋めることを目的にせず、本当に必要な指摘だけを出すこと**(簡素な ES では 3-5 件、複雑な ES では 10-15 件が現実的)。",
        items: SUGGESTION_ITEM_SCHEMA,
      },
      interview_questions: {
        type: "object",
        description:
          "面接質問パネル。initial モードでは必須。questions は3〜5問。",
        properties: {
          generated_at_es_version: {
            type: "integer",
            minimum: 0,
            description: "この面接質問群が生成された時の es_state_version",
          },
          is_stale: {
            type: "boolean",
            description:
              "initial では false 固定。Phase D の refresh で stale 判定を入れる。",
          },
          questions: {
            type: "array",
            minItems: 3,
            maxItems: 5,
            description: "3〜5問。ES内の弱点を深掘りされそうな箇所を選ぶ。",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "iq_xxx の形式" },
                question: {
                  type: "string",
                  description: "面接で出される想定の質問文",
                },
                rationale: {
                  type: "string",
                  description: "なぜこの質問が出るか(リクルーター視点)",
                },
                answer_hint: {
                  type: "string",
                  description: "模範回答のヒント。書き手が準備しやすい粒度で。",
                },
                purpose_hint: {
                  type: "string",
                  description: "リクルーターがこの質問で測りたい資質",
                },
              },
              required: [
                "id",
                "question",
                "rationale",
                "answer_hint",
                "purpose_hint",
              ],
            },
          },
        },
        required: ["generated_at_es_version", "is_stale", "questions"],
      },
      // 2026-05-27 エージェント的対話(AI 逆質問): global 質問。suggestion-bound と合算で最大 3 件。
      // load-bearing field name、リネーム禁止。
      global_clarification_questions: {
        type: "array",
        maxItems: 3,
        description:
          "ES 全体 / 個性 / 企業 fit 等に紐づく逆質問(最大 3 件、省略可)。suggestion-bound と合算して最大 3 件。情報不足を感じなければ出さない。各質問の id は suggestion-bound の id と重複しないこと。",
        items: CLARIFICATION_QUESTION_ITEM_SCHEMA,
      },
    },
    required: [
      "es_state_version",
      "overall_assessment",
      "suggestions",
      "interview_questions",
    ],
  },
  strict: false,
};
