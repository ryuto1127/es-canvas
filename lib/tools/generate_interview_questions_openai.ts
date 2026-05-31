import type OpenAI from "openai";

// 統合改修パッケージ (2026-05-25): OpenAI Responses API 用の interview ツール定義。
//
// `lib/tools/generate_interview_questions.ts`(Anthropic 版)と意味的に同一の JSON Schema を、
// `OpenAI.Responses.FunctionTool` の型に合わせて宣言する。
//
// 設計判断:
//  - tool name は Anthropic 版と同じ `generate_interview_questions` を使う
//  - strict は false(minItems / maxItems の業務制約のため)
//  - 構造的に除外しているもの(generated_at_es_version / is_stale / suggestions / 総評)は
//    Anthropic 版と同じ規範
//  - Anthropic 版を更新するときは本ファイルも同期する

export const GENERATE_INTERVIEW_QUESTIONS_TOOL_NAME_OAI =
  "generate_interview_questions" as const;

export const GENERATE_INTERVIEW_QUESTIONS_TOOL_OAI: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: GENERATE_INTERVIEW_QUESTIONS_TOOL_NAME_OAI,
  description:
    "ES と企業情報、採用された指摘の方向性を踏まえ、ES の弱点を深掘りされそうな面接質問を3〜5問生成する。is_stale / generated_at_es_version はサーバ側で付与するため出力しない。各質問は ES の具体箇所か企業価値観への接続を意識して作る。",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 3,
        maxItems: 5,
        description:
          "面接質問の配列(3〜5問)。ES の弱点 / 企業価値観への接続 / 採用された指摘の方向性、のいずれかの軸を意識する。",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "iq_xxx の形式のユニーク ID(例: iq_001)",
            },
            question: {
              type: "string",
              description: "面接で出される想定の質問文。具体的に。",
            },
            rationale: {
              type: "string",
              description:
                "なぜこの質問が出るか(リクルーター視点)。1〜2文。",
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
    required: ["questions"],
  },
  strict: false,
};
