import { z } from "zod";

// Phase B-2: 「カテゴリ別の証拠プール」中心のスキーマ。
// セッション1 の 1URL→単発抽出から、複数ソース横断のエージェント型リサーチに拡張。
//
// 設計の中心: evidence[]
// - 各 evidence は category + claim + source_url + source_quote(原文引用)で構成
// - Phase C の分析で rationale_source.evidence_id として参照されることを想定
// - claim は AI が整理した1文、source_quote はそれを裏付ける原文(verbatim)
// 合成ビュー(values / ideal_candidate / hiring_criteria)は evidence から派生する
// UI 簡易表示用のフィールド。後方互換のため残す。

export const EvidenceCategorySchema = z.enum([
  "official_value", // MVV、行動指針、コーポレートサイトの価値観
  "hiring_signal", // 求める人物像、選考方針、採用ページ
  "culture_signal", // 技術ブログ、社員インタビュー、開発文化
  "founder_thinking", // CEO note、講演、経営陣のインタビュー
  "recent_move", // 直近6ヶ月の主要ニュース、プロダクト発表、資金調達
  "industry_context", // 業界ポジション、競合との比較
]);
export type EvidenceCategory = z.infer<typeof EvidenceCategorySchema>;

// 1件の証拠
// DECISION: 制約は LLM 出力のばらつきを吸収できる幅で設定。狭すぎると
// 「ev_01」「8000字の verbatim」のような軽微な逸脱で submit_summary 全体が
// 落ちる(評価軸の品質損失)。広すぎると捏造防止の構造が弱まる。妥協点として:
//  - id: ev_<英数字>(連番は強制せず、ユニーク性のみ LLM 任せ)
//  - claim: 10〜600(日本語は1文でも長くなりがち)
//  - source_quote: 20〜800(コーポレートサイトの段落をそのまま掬うため)
//  - fetched_at: ISO 8601 ゆるめ(タイムゾーン不問)
//  - source_url: 緩い文字列(URL でも、フリーテキスト経路の特殊 placeholder "user-input" でも可)。
//    URL 形式の強制は research_helpers.ts の validateSummaryWithSources / validateFreetextSummary
//    で経路別に行う(URL モードでは承認 URL リスト照合、freetext モードでは "user-input" 厳格一致)。
export const EVIDENCE_SOURCE_USER_INPUT = "user-input" as const;

export const EvidenceSchema = z.object({
  id: z.string().regex(/^ev_[A-Za-z0-9_-]+$/),
  category: EvidenceCategorySchema,
  claim: z.string().min(10).max(600),
  source_url: z.string().min(1),
  source_quote: z.string().min(10).max(800),
  fetched_at: z.string().min(10), // ISO 8601 を期待するが厳格 datetime() は LLM 出力で頻繁に失敗するため緩める
});
export type Evidence = z.infer<typeof EvidenceSchema>;

// プロセスログ: 透明性 UI(Phase H)で「AIが何を見たか」を提示するためのトレース
export const ResearchLogEntrySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("search"),
    query: z.string(),
    results_count: z.number().int().min(0),
    timestamp: z.string().datetime(),
  }),
  z.object({
    type: z.literal("fetch"),
    url: z.string().url(),
    status: z.enum(["ok", "blocked", "not_found", "timeout", "error"]),
    extracted_chars: z.number().int().nullable(),
    ms: z.number().int(),
    timestamp: z.string().datetime(),
  }),
  z.object({
    type: z.literal("synthesize"),
    iteration: z.number().int(),
    timestamp: z.string().datetime(),
  }),
]);
export type ResearchLogEntry = z.infer<typeof ResearchLogEntrySchema>;

// 入力ソース(URL のみ / 会社名のみ / 両方 / 自由テキスト)
// Phase E 拡張(2026-05-23): freetext バリアントを追加。ユーザーが自分でリサーチした
// 企業情報メモ(行動指針・採用方針など)を LLM が読み、CompanySummary 形式に整形する経路。
// freetext の場合、evidence[].source_url は EVIDENCE_SOURCE_USER_INPUT を使う(URL が無いため)。
export const ResearchInputSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("url"), value: z.string().url() }),
  z.object({ type: z.literal("name"), value: z.string().min(1) }),
  z.object({
    type: z.literal("both"),
    url: z.string().url(),
    name: z.string().min(1),
  }),
  // freetext: 学生が自分でまとめた企業情報メモ(20〜4000字)。20字未満では LLM が
  // 整形不能、4000字超ではコスト爆発するため幅を取った範囲で制限。
  z.object({ type: z.literal("freetext"), value: z.string().min(20).max(4000) }),
]);
export type ResearchInputSource = z.infer<typeof ResearchInputSourceSchema>;

// CompanySummary 本体
export const CompanySummarySchema = z.object({
  // identity
  company_name: z.string().min(1),
  business_summary: z.string().min(20).max(500),

  // 証拠プール(コア)
  evidence: z.array(EvidenceSchema).min(0).max(20),

  // 合成ビュー(category=official_value 等から抽出。UI 簡易表示 + 後方互換)
  values: z.array(z.string()).max(5),
  ideal_candidate: z.string().nullable(),
  hiring_criteria: z.array(z.string()).max(5),

  // 透明性ログ
  research_log: z.array(ResearchLogEntrySchema),

  // メタ情報
  source_input: ResearchInputSourceSchema,
  research_started_at: z.string().datetime(),
  research_finished_at: z.string().datetime(),
  total_iterations: z.number().int().min(0),
});
export type CompanySummary = z.infer<typeof CompanySummarySchema>;
