import type OpenAI from "openai";

// Phase B-2 リファクタ: OpenAI Responses API 用のツール定義。Anthropic 版
// (`research_agent.ts`) と意味的に同一だが、SDK の型差異(FunctionTool /
// WebSearchTool)に合わせて別ファイルに分けている。submit_summary の JSON Schema
// は Anthropic 版と同じ業務制約(maxItems 等)を含むため strict は false。

// fetch_page と submit_summary は Anthropic 版と同じ名前を使う。
// プロンプト側で言及するツール名(`web_search` / `fetch_page` / `submit_summary`)
// が両プロバイダで揃っていることがプロンプト共通化の前提条件。
export const FETCH_PAGE_TOOL_NAME_OAI = "fetch_page" as const;
export const SUBMIT_SUMMARY_TOOL_NAME_OAI = "submit_summary" as const;

// --- Tool: fetch_page (function tool) ---------------------------------------
export const FETCH_PAGE_TOOL_OAI: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: FETCH_PAGE_TOOL_NAME_OAI,
  description:
    "指定された URL の本文を取得して読みやすいテキストに変換します。コーポレートサイトの個別ページ、技術ブログ記事、note、Wantedly の社員紹介ページなど、企業に関する情報を含む任意の Web ページを取得できます。失敗時はエラー詳細(404/blocked/timeout 等)を返します。同じドメイン内で派生先(/about, /careers, /tech 等)を読むときに使ってください。",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "取得したいページの URL(http または https で始まる完全URL)。web_search 結果に出ただけで未取得の URL を渡してよいのはこのツール経由のみ。",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  // DECISION: strict は false。strict=true は maxItems / minLength 等の業務制約と両立しない。
  // 業務制約は Zod 側に集約(セッション2 [2026-05-22] の判断を継承)。
  strict: false,
};

// --- Tool: submit_summary (function tool, 終端) -----------------------------
// JSON Schema は Anthropic 版 SUBMIT_SUMMARY_TOOL と意味的に同一。
// サーバー側で付与するメタ情報(research_log / source_input / *_at / total_iterations)
// は LLM 出力からは除外し、Provider 側で埋める。
export const SUBMIT_SUMMARY_TOOL_OAI: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: SUBMIT_SUMMARY_TOOL_NAME_OAI,
  description:
    "リサーチが完了したときに呼び出して、最終的な CompanySummary を返す。このツールを呼ぶとリサーチセッションが終了する。証拠は fetch_page で実際に取得したページ本文に存在する文字列のみを source_quote として渡すこと(verbatim、改変・要約禁止)。",
  parameters: {
    type: "object",
    properties: {
      company_name: {
        type: "string",
        description:
          "会社の正式名称(略称や愛称ではなく、コーポレートサイト/登記/求人ページに記載された正式表記)",
      },
      business_summary: {
        type: "string",
        description:
          "事業概要を1〜2文(20〜500字)で簡潔に。事実ベース、推測語彙(『〜と思われる』等)は使わない。",
      },
      evidence: {
        type: "array",
        description:
          "リサーチで集めた証拠の配列(最大20件)。各要素は category + claim + source_url + source_quote + fetched_at で構成。捏造は許されない: source_quote は fetch_page で実際に取得したページ本文に含まれる文字列のみ。",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description:
                "証拠の通番ID。'ev_001', 'ev_002', ... の形式で、リサーチセッション内でユニーク",
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
                "証拠のカテゴリ。official_value=MVV/行動指針、hiring_signal=求める人物像/採用ページ、culture_signal=技術ブログ/社員インタビュー、founder_thinking=CEO note/講演、recent_move=直近6ヶ月のニュース、industry_context=業界ポジション",
            },
            claim: {
              type: "string",
              description:
                "あなたが原文から整理した1文(10〜600字)。必ず source_quote が裏付ける主張であること。",
            },
            source_url: {
              type: "string",
              description:
                "fetch_page で実際に取得した URL のみ。web_search 結果に出ただけで未取得の URL を引用してはならない。",
            },
            source_quote: {
              type: "string",
              description:
                "source_url の fetch_page 結果に **そのまま存在する** 原文の引用(20〜800字、verbatim)。改変・要約・意訳は禁止。引用箇所が長い場合は連続した1区間のみ。",
            },
            fetched_at: {
              type: "string",
              description:
                "この証拠の元となるページを fetch_page で取得した時刻(ISO 8601 datetime、UTC)",
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
        },
        maxItems: 20,
      },
      values: {
        type: "array",
        description:
          "category=official_value の evidence から抽出した、企業の価値観/行動指針の名前(最大5個、原文表現を尊重)。証拠が無ければ空配列。例: ['Bet Technology', '徳', 'Trustful Team']",
        items: { type: "string" },
        maxItems: 5,
      },
      ideal_candidate: {
        type: ["string", "null"],
        description:
          "category=hiring_signal の evidence から要約した『求める人物像』(1〜3文)。該当する evidence が無ければ null。",
      },
      hiring_criteria: {
        type: "array",
        description:
          "category=hiring_signal の evidence から抽出した、明示された評価軸(最大5個)。なければ空配列。",
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
  },
  strict: false,
};

// --- Tool: web_search (built-in) --------------------------------------------
// OpenAI 組み込みの web_search はサーバー側で検索を実行し、結果を会話に組み込む
// ところまで自動。クライアント側で tool_result を返す必要は無い(Anthropic と
// 同じ挙動)。search_context_size は medium がデフォルトで充分。
export const WEB_SEARCH_TOOL_OAI: OpenAI.Responses.WebSearchTool = {
  type: "web_search",
  search_context_size: "medium",
};
