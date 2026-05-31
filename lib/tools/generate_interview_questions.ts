import type Anthropic from "@anthropic-ai/sdk";

// Phase D: 面接質問生成専用ツール。
// lib/prompts/interview.ts 推奨に従い独立ツールとして定義し、
// 出力スキーマを面接質問配列のみに絞る。
//
// 構造的に除外しているもの:
//   - generated_at_es_version: サーバ側で body.current_es_version を付与(判断4)
//   - is_stale:               /api/interview 直後は常に false、サーバ側で付与
//   - 総評 / suggestions:      analyze_es 系の責務、ここでは出さない
//
// これにより LLM は「質問配列を作る」ことだけに集中できる(認知負荷を構造で減らす)。

export const GENERATE_INTERVIEW_QUESTIONS_TOOL_NAME =
  "generate_interview_questions" as const;

export const GENERATE_INTERVIEW_QUESTIONS_TOOL: Anthropic.Messages.Tool = {
  name: GENERATE_INTERVIEW_QUESTIONS_TOOL_NAME,
  description:
    "ES と企業情報、採用された指摘の方向性を踏まえ、ES の弱点を深掘りされそうな面接質問を3〜5問生成する。is_stale / generated_at_es_version はサーバ側で付与するため出力しない。各質問は ES の具体箇所か企業価値観への接続を意識して作る。",
  input_schema: {
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
          required: ["id", "question", "rationale", "answer_hint", "purpose_hint"],
        },
      },
    },
    required: ["questions"],
  },
};
