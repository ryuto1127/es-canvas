import type Anthropic from "@anthropic-ai/sdk";

// Phase B-2 エージェント型ディープリサーチで使う3ツールの定義。
//   1) fetch_page (カスタム実装) — URL の本文を取得して LLM に返す。実体は url_extract.ts
//   2) submit_summary (終端ツール) — リサーチ完了時に CompanySummary 構造を返す
//   3) web_search (Anthropic ネイティブ) — 検索結果は Anthropic 側で完結。実行は SDK が担う
//
// 3) は別途 messages.create の tools 配列に { type: "web_search_20260209", name: "web_search" } を渡す。
// このファイルでは 1) と 2) のみ定義し、3) はバージョン定数だけエクスポート(import 先の関心を集約)。

// Anthropic web_search ツールの最新バージョン(2026-02-09)。
// 過去バージョン web_search_20250305 もある(messages.d.ts 参照)が、現行最新を採用。
export const WEB_SEARCH_TOOL_TYPE = "web_search_20260209" as const;
export const WEB_SEARCH_TOOL_NAME = "web_search" as const;

// --- Tool 1: fetch_page -----------------------------------------------------

export const FETCH_PAGE_TOOL_NAME = "fetch_page" as const;

export const FETCH_PAGE_TOOL: Anthropic.Messages.Tool = {
  name: FETCH_PAGE_TOOL_NAME,
  description:
    "指定された URL の本文を取得して読みやすいテキストに変換します。コーポレートサイトの個別ページ、技術ブログ記事、note、Wantedly の社員紹介ページなど、企業に関する情報を含む任意の Web ページを取得できます。失敗時はエラー詳細(404/blocked/timeout 等)を返します。同じドメイン内で派生先(/about, /careers, /tech 等)を読むときに使ってください。",
  input_schema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "取得したいページの URL(http または https で始まる完全URL)。検索結果に出ただけで未取得の URL を渡してよいのはこのツール経由のみ。",
      },
    },
    required: ["url"],
  },
};

// --- Tool 2: submit_summary -------------------------------------------------

export const SUBMIT_SUMMARY_TOOL_NAME = "submit_summary" as const;

// CompanySummarySchema の生成バージョンを JSON Schema に手で起こす。
// - サーバー側で付与するメタ情報(source_input / research_started_at /
//   research_finished_at / total_iterations / research_log)は LLM 出力からは
//   除外し、AnthropicProvider 側で埋める。これで LLM が「内省的に嘘の log」を
//   書くリスクを構造で排除する。
// - evidence[].fetched_at は LLM が記録(ツール呼び出し時刻に最も近い)
export const SUBMIT_SUMMARY_TOOL: Anthropic.Messages.Tool = {
  name: SUBMIT_SUMMARY_TOOL_NAME,
  // DECISION: strict: true は採用しない。strict は additionalProperties:false の他、
  // maxItems / minLength / format などの JSON Schema 検証語彙を禁止し、
  // 結果として「最大20件」「20〜500字」のような業務制約をスキーマで表現できなくなる。
  // 代わりに Zod 側で範囲検証し、max_tokens=8192 を確保して LLM 出力切り詰めを防ぐ。
  description:
    "リサーチが完了したときに呼び出して、最終的な CompanySummary を返す。このツールを呼ぶとリサーチセッションが終了する。証拠は fetch_page で実際に取得したページ本文に存在する文字列のみを source_quote として渡すこと(verbatim、改変・要約禁止)。",
  input_schema: {
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
                "fetch_page で実際に取得した URL のみ。検索結果に出ただけで未取得の URL を引用してはならない。",
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
          "category=official_value の evidence から抽出した、企業の価値観/行動指針の名前(最大5個、原文表現を尊重)。証拠が無ければ空配列。例: ['Think Deep', '誠実', 'Open Hands']",
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
};
