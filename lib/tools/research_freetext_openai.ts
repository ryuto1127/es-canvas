import type OpenAI from "openai";
import { EVIDENCE_SOURCE_USER_INPUT } from "../schema/company";

// Phase E 拡張(2026-05-23): OpenAI Responses API 用の自由テキスト submit_summary 定義。
// Anthropic 版(research_freetext.ts:SUBMIT_FREETEXT_SUMMARY_TOOL)と意味的に同一。
// SDK の型差異(FunctionTool)に合わせて別ファイルに分けている。
//
// strict は false。strict=true は maxItems / minItems / minLength 等の業務制約と両立しない。
// 業務制約は Zod 側(CompanySummarySchema)+ validateFreetextSummary に集約。

export const SUBMIT_FREETEXT_SUMMARY_TOOL_NAME_OAI = "submit_summary" as const;

export const SUBMIT_FREETEXT_SUMMARY_TOOL_OAI: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: SUBMIT_FREETEXT_SUMMARY_TOOL_NAME_OAI,
  description:
    "ユーザーが自分でまとめた企業情報メモを CompanySummary 形式に整形して返す。このツールを 1 回だけ呼び出してリサーチを終了する。web_search / fetch_page は使わない。evidence の source_quote は入力された自由テキスト内に verbatim で存在する文字列のみを抽出すること(改変・要約禁止)。source_url は必ず文字列 \"" +
    EVIDENCE_SOURCE_USER_INPUT +
    "\" を使うこと(URL ではなくユーザー入力由来であることを構造で表現する placeholder)。",
  parameters: {
    type: "object",
    properties: {
      company_name: {
        type: "string",
        description:
          "自由テキストから抽出した企業の正式名称。明示が無く推測も困難なら \"(企業名不明)\" を入れる。",
      },
      business_summary: {
        type: "string",
        description:
          "自由テキストから整理した事業概要を 1〜2文(20〜500字)。書かれていない情報を捏造しない。",
      },
      evidence: {
        type: "array",
        description:
          "自由テキスト内の verbatim 引用を裏付けとした証拠の配列(1件以上、最大20件)。各要素は category + claim + source_url + source_quote + fetched_at で構成。source_quote は入力された自由テキスト内に文字列として存在する連続区間のみ使用可能。",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description:
                "証拠の通番ID。'ev_001', 'ev_002', ... の形式で、整形セッション内でユニーク",
            },
            category: {
              type: "string",
              enum: [
                "official_value",
                "hiring_signal",
                "culture_signal",
                "founder_thinking",
                "recent_move",
                "industry_context",
              ],
              description:
                "証拠のカテゴリ。official_value=MVV/行動指針、hiring_signal=求める人物像/採用ページ、culture_signal=技術ブログ/社員インタビュー、founder_thinking=CEO note/講演、recent_move=直近6ヶ月のニュース、industry_context=業界ポジション。自由テキストの記述に最も近い category を選ぶ。",
            },
            claim: {
              type: "string",
              description:
                "自由テキストの該当箇所から整理した 1 文(10〜600字)。必ず source_quote が裏付ける主張であること(自由テキストにない主張を claim に書かない)。",
            },
            source_url: {
              type: "string",
              description:
                "自由テキスト経路では文字列 \"" +
                EVIDENCE_SOURCE_USER_INPUT +
                "\" を使用すること(これ以外、特に推測 URL は禁止)。ユーザー入力由来であることを構造で表現する placeholder。",
            },
            source_quote: {
              type: "string",
              description:
                "入力された自由テキストに **そのまま存在する** 文字列の連続区間(20〜800字、verbatim)。改変・要約・意訳・繋ぎ合わせは禁止。原文をそのままコピーすること。",
            },
            fetched_at: {
              type: "string",
              description:
                "この証拠の整形時刻(ISO 8601 datetime、UTC)。自由テキスト経路では「取得時刻」というより「整形時刻」だが、schema 整合のため埋める。",
            },
          },
          required: [
            "id",
            "category",
            "claim",
            "source_url",
            "source_quote",
            "fetched_at",
          ],
          additionalProperties: false,
        },
        minItems: 1,
        maxItems: 20,
      },
      values: {
        type: "array",
        description:
          "自由テキストから読み取れる行動指針/価値観の名前(最大5個、原文表現を尊重)。読み取れなければ空配列。",
        items: { type: "string" },
        maxItems: 5,
      },
      ideal_candidate: {
        type: ["string", "null"],
        description:
          "自由テキストに「求める人物像」「採用方針」が明示されていれば 1〜3文に整理。無ければ null。",
      },
      hiring_criteria: {
        type: "array",
        description:
          "自由テキストに明示された評価軸(最大5個)。無ければ空配列。",
        items: { type: "string" },
        maxItems: 5,
      },
    },
    required: [
      "company_name",
      "business_summary",
      "evidence",
      "values",
      "ideal_candidate",
      "hiring_criteria",
    ],
    additionalProperties: false,
  },
  strict: false,
};
