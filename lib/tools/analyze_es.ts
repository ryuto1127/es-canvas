import type Anthropic from "@anthropic-ai/sdk";

// Phase C: 初回深掘り分析(initial モード)で LLM に呼ばせる終端ツール。
// 出力スキーマは AIInitialAnalysisOutputSchema と意味的に1対1対応(JSON Schema 手書きで二重管理)。
//
// DECISION (セッション5):
//  - Zod スキーマからの自動変換(@anatine/zod-openapi 等)は採用しない。
//    Anthropic ツール定義は load-bearing で、Zod の変更で意図せず変わるのを避けるため。
//    手動同期の手間より変更の意図性を取る。Zod 側 (lib/schema/analysis.ts, suggestion.ts) と
//    本ファイルの両方を変更するときは「同期させたい意図がある」状態に限定される。
//
// - サーバ側で付与するフィールド(metadata, suggestions[].original_span)は LLM ツール定義に含めない。
//   suggestion.original はサーバが ES 本体に対して indexOf で位置解決する。
//
// - strict: true は使わない。Anthropic strict mode は additionalProperties / maxItems / minLength
//   等の業務制約を禁止し、業務制約をスキーマで表現できなくなる(セッション2 の研究ツールと同じ判断)。
//   Zod 側で max(15)、min(3)/max(5)、various refine による業務制約を維持。

export const ANALYZE_ES_TOOL_NAME = "analyze_es" as const;

// rationale_source の type 列挙 — design_v1 Section 4.5 と整合
const RATIONALE_SOURCE_TYPES = [
  "company_value",
  "convention",
  "rubric",
  "linguistic",
  "consistency",
  "user_intent",
] as const;

// suggestion カテゴリ — design_v1 Section 4.4
// v2 Phase B1 (2026-05-26): structural 追加。Zod 側 (lib/schema/suggestion.ts L11) と
// 意図的二重管理。load-bearing enum、既存値「error / convention / alternative」
// リネーム禁止。詳細根拠は DECISIONS.md [2026-05-26] v2 — structural カテゴリ導入。
const SUGGESTION_CATEGORIES = [
  "error",
  "convention",
  "alternative",
  "structural",
] as const;

// v2 Phase B1 (2026-05-26): structural_params の JSON schema(oneOf で 5 operations)。
// Zod 側 StructuralOperationParamsSchema(discriminated union)と意図的二重管理。
// 「structural の場合のみ structural_params 必須」は tool 層では optional で OK、
// Zod 側 refine `isStructuralParamsConsistent` で双方向整合を担保する。
// Anthropic strict mode は使わないため additionalProperties は明示しない(他箇所と一貫)。
const STRUCTURAL_PARAMS_SCHEMA = {
  type: "object" as const,
  description:
    "structural カテゴリのときのみ指定する操作 params(operation 別に必須 field 異なる)。category !== 'structural' のときは出力しない。",
  oneOf: [
    {
      properties: {
        operation: { const: "delete_paragraph" },
        target_paragraph_index: { type: "integer", minimum: 0 },
      },
      required: ["operation", "target_paragraph_index"],
    },
    {
      properties: {
        operation: { const: "reorder_paragraphs" },
        new_order: {
          type: "array",
          items: { type: "integer", minimum: 0 },
          minItems: 2,
        },
      },
      required: ["operation", "new_order"],
    },
    {
      properties: {
        operation: { const: "merge_paragraphs" },
        target_paragraph_indices: {
          type: "array",
          items: { type: "integer", minimum: 0 },
          minItems: 2,
        },
      },
      required: ["operation", "target_paragraph_indices"],
    },
    {
      properties: {
        operation: { const: "move_sentence" },
        source_paragraph_index: { type: "integer", minimum: 0 },
        source_sentence_index: { type: "integer", minimum: 0 },
        target_paragraph_index: { type: "integer", minimum: 0 },
        target_position: { enum: ["before", "after"] },
      },
      required: [
        "operation",
        "source_paragraph_index",
        "source_sentence_index",
        "target_paragraph_index",
        "target_position",
      ],
    },
    {
      properties: {
        operation: { const: "add_paragraph" },
        target_paragraph_index: { type: "integer", minimum: 0 },
        target_position: { enum: ["before", "after"] },
        // 2026-05-27 prompt 設計批判 #4(Task b-1): outline / 方向性のみ(5〜50 字)。
        // 旧仕様(1〜500 字、本文)は HITL 維持と衝突するため deprecated。AI は方向性だけ
        // 示し、ES 本文は採用 → 編集して採用で人間が書く設計に変更。
        new_content: {
          type: "string",
          minLength: 5,
          maxLength: 50,
          description:
            "追加すべき内容の outline / 方向性を 50 字以内で書く(段落本文ではない)。例: 「過去研究の動機を 1 行追加」「定量的な成果を 2-3 行追加」「冒頭に課題提起を 1 行追加」。実際の段落本文は採用後に書き手が自分の言葉で書く。",
        },
      },
      required: [
        "operation",
        "target_paragraph_index",
        "target_position",
        "new_content",
      ],
    },
  ],
};

// 2026-05-27 エージェント的対話(AI 逆質問): clarification_questions の item schema。
// Zod 側 ClarificationQuestionSchema(lib/schema/clarification.ts)と意図的二重管理。
// suggestion-bound と global 質問の両方で同じ item schema を共有する。
//  - id: 質問の一意 id(`q_001` のような短い識別子、re-analyze 時の回答紐付け用)
//  - question: 質問本文(5〜200 字)
//  - rationale: なぜこの質問を出すか(10〜300 字)、不適切な質問の量産を抑制
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
      description:
        "質問本文(5〜200 字)。簡潔に「何を聞きたいか」を一文で。",
    },
    rationale: {
      type: "string",
      minLength: 10,
      maxLength: 300,
      description:
        "なぜこの質問を出すか(10〜300 字)。質問の意図を明示することで、AI が「計画性を聞く」のような形骸化質問を量産するのを防ぐ。",
    },
  },
  required: ["id", "question", "rationale"],
};

// suggestions の item schema(internal_priority 付き)。
// Phase G 修正 (2026-05-23) で各 suggestion に internal_priority(1-10)を付与し、サーバ側で
// 文字列タグに変換(display_priority)してから UI に渡す経路を取る。Phase G 再修正
// (2026-05-24) で suggestions 単一配列に戻し、副次的な候補プール構造は撤去した。
const SUGGESTION_ITEM_SCHEMA_WITH_INTERNAL_PRIORITY = {
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
        "error=客観的誤り / convention=ES慣習に基づく推奨 / alternative=代替案(原文を否定しない) / structural=明示的な構造変更操作(段落削除 / 順番変更 / 統合 / 文移動 / 段落追加、structural_params 必須)。v2 Phase B1 で structural 追加、B2 で prompts/* が structural 出力を開始予定。",
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
            "参照元の短い説明(例: 「STAR構造のSituation補強」「Bet AI」)",
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
    // Phase G 修正 (2026-05-23): 内部用重要度(1-10)。UI に絶対表示されない。
    internal_priority: {
      type: "integer",
      minimum: 1,
      maximum: 10,
      description:
        "**サーバ内部用の重要度**。1=軽微、5=標準、10=最重要。**ユーザーに数値が見えることはなく**、サーバが文字列タグ(high/medium/low)に変換します。",
    },
    // v2 Phase B1 (2026-05-26): structural 操作の params(load-bearing)。
    // category === 'structural' のときのみ出力する。他カテゴリでは省略。
    // Zod 側 refine `isStructuralParamsConsistent` で双方向整合を検証(structural なら必須、
    // 他カテゴリでは禁止)。required に含めないことで「他カテゴリでは出力しない」を許容する。
    structural_params: STRUCTURAL_PARAMS_SCHEMA,
    // v2 Phase B1 (2026-05-26): structural 操作で削除/移動の結果失われる原文の控え。
    // load-bearing。schema 上 optional(reorder_paragraphs など情報が失われない operation
    // では未指定でよい)。UI が「失う情報」を明示するための補助。
    lost_content: {
      type: "string",
      description:
        "structural 操作で削除/移動の結果失われる原文の控え(例: delete_paragraph では削除対象段落の本文)。情報が失われない operation(reorder_paragraphs 等)では省略してよい。",
    },
    // 2026-05-27 エージェント的対話(AI 逆質問): suggestion-bound 質問(0 or 1 個)。
    // この suggestion について情報不足を感じた時に 1 件まで追加可。global 質問と合わせて
    // 合計 3 件まで(server 側 Zod refine で担保)。**情報不足を感じなければ省略**(無理に
    // 出さない)。load-bearing field name、リネーム禁止。
    clarification_questions: {
      type: "array",
      maxItems: 1,
      description:
        "この suggestion について情報不足を感じた時に出す逆質問(最大 1 件、省略可)。情報不足を感じなければ出力しない(出さなくてもよい)。質問の `id` は suggestion 内 + global で重複させないこと。",
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

export const ANALYZE_ES_TOOL: Anthropic.Messages.Tool = {
  name: ANALYZE_ES_TOOL_NAME,
  description:
    "ES添削の構造化された分析結果を返す。総評(数値スコアなし)、最大15個の指摘カード、3〜5問の面接質問を含む。指摘の original は ES 本体と完全一致する文字列でなければならず、日本語の文節境界を守って切り出す(助詞・名詞・動詞活用の途中で切らない)。proposed は必ず original と異なる文字列であること(何も変えない指摘は出力しない)。rationale_source.type === 'company_value' のときは url 必須、evidence_id は承認済み evidence リスト内の ID のみ。",
  input_schema: {
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
        required: ["summary", "strengths", "weaknesses", "preserved_voice_note"],
      },
      suggestions: {
        type: "array",
        maxItems: 15,
        description:
          "指摘カード(最大 15)。original は ES 本体と完全一致する文字列のみ。category=alternative のときは alternatives を1個以上含める。各 suggestion には internal_priority(1-10)を付与すること。**件数を埋めることを目的にせず、本当に必要な指摘だけを出すこと**(簡素な ES では 3-5 件、複雑な ES では 10-15 件が現実的)。",
        items: SUGGESTION_ITEM_SCHEMA_WITH_INTERNAL_PRIORITY,
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
            description: "initial では false 固定。Phase D の refresh で stale 判定を入れる。",
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
                question: { type: "string", description: "面接で出される想定の質問文" },
                rationale: { type: "string", description: "なぜこの質問が出るか(リクルーター視点)" },
                answer_hint: {
                  type: "string",
                  description: "模範回答のヒント。書き手が準備しやすい粒度で。",
                },
                purpose_hint: {
                  type: "string",
                  description: "リクルーターがこの質問で測りたい資質",
                },
              },
              required: ["id", "question", "rationale", "answer_hint", "purpose_hint"],
            },
          },
        },
        required: ["generated_at_es_version", "is_stale", "questions"],
      },
      // 2026-05-27 エージェント的対話(AI 逆質問): ES 全体 / 個性 / 企業 fit 等の global 質問。
      // 特定 suggestion に紐づかない質問を最大 3 件まで(suggestion-bound と合計で 3 件)。
      // **情報不足を感じなければ省略**(無理に出さない)。各質問の `id` は suggestion-bound と
      // 重複しないこと(再分析時に answer の紐付けが壊れる)。load-bearing field name、リネーム禁止。
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
};
