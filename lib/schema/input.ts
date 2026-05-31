import { z } from "zod";
import { CompanySummarySchema } from "./company";
import { OverallAssessmentSchema } from "./analysis";
import { SuggestionSchema } from "./suggestion";

// 添削条件プリセット — design_v1 Section 4.1
// DECISION: プロンプトに直接挿入されるため日本語の値を採用(変換せず流す)
export const EditingPresetSchema = z.enum([
  "バランス",
  "厳しめ",
  "個性保護",
  "短時間モード",
  "外資寄り",
  "日系寄り",
]);
export type EditingPreset = z.infer<typeof EditingPresetSchema>;

export const EditingConditionSchema = z.object({
  preset: EditingPresetSchema,
  // 自由入力は空文字許容(未入力 = 空文字、null とは区別しない)
  free_text: z.string().default(""),
});
export type EditingCondition = z.infer<typeof EditingConditionSchema>;

// 旧 InputBundle: Phase E の入力フォーム用に残す(社内 URL → /api/research 解決前の生フォーム形)。
// Phase C の /api/analyze は AnalyzeInputBundle(下記、CompanySummary 解決後)を直接受ける。
export const InputBundleSchema = z.object({
  es_text: z.string().min(1),
  question: z.string().min(1),
  // 文字数制限は任意(2026-05-29): 制限のない設問もあるため optional。
  // 指定する場合は正の整数。下限・上限ゲートは撤廃(UI 側で正整数性を担保)。
  char_limit: z.number().int().positive().optional(),
  // 企業URL未入力時は null。design_v1 Section 4.1
  company_url: z.string().url().nullable(),
  editing_condition: EditingConditionSchema,
  // ユーザー文脈は任意
  user_context: z.string().nullable(),
});
export type InputBundle = z.infer<typeof InputBundleSchema>;

// -----------------------------------------------------------------------------
// Phase D: HITL アクション履歴(refresh モード入力に同梱)
// -----------------------------------------------------------------------------
// lib/prompts/refresh.ts の action_history フォーマットに準拠した
// 判別ユニオン。LLM はこの履歴から「ユーザーが何を採用し、何を却下したか」を読む。
//
// 動詞ごとに必要なフィールドが異なる:
//  - ACCEPTED / REJECTED / PENDING: suggestion_id + suggestion_summary(1行表現)
//  - EDITED:                       上記 + edited_text(ユーザーが編集した最終テキスト)
//  - DIRECT_EDIT:                  description のみ(指摘とは無関係な直接編集)
const ActionHistoryAcceptedRejectedSchema = z.object({
  verb: z.enum(["ACCEPTED", "REJECTED", "PENDING"]),
  suggestion_id: z.string().min(1),
  suggestion_summary: z.string().min(1),
});

const ActionHistoryEditedSchema = z.object({
  verb: z.literal("EDITED"),
  suggestion_id: z.string().min(1),
  suggestion_summary: z.string().min(1),
  edited_text: z.string().min(1),
});

const ActionHistoryDirectEditSchema = z.object({
  verb: z.literal("DIRECT_EDIT"),
  description: z.string().min(1),
});

// 判別キーが verb と suggestion_id/description で分かれるため discriminatedUnion ではなく
// z.union を使う(ACCEPTED/REJECTED/PENDING は同じ shape を共有するため一括 schema)。
export const ActionHistoryEntrySchema = z.union([
  ActionHistoryAcceptedRejectedSchema,
  ActionHistoryEditedSchema,
  ActionHistoryDirectEditSchema,
]);
export type ActionHistoryEntry = z.infer<typeof ActionHistoryEntrySchema>;

// -----------------------------------------------------------------------------
// AnalyzeInputBundle: initial + refresh の判別ユニオン(Phase D)
// -----------------------------------------------------------------------------
// Phase C は単一の z.object("initial" 固定)だったが、Phase D で refresh を導入するに
// あたり判別ユニオンに昇格。共通フィールド(es_body, question, edit_conditions 等)は
// initial 側を base にして refresh 側で extend する。
//
// DECISION (Phase D セッション6):
//  - current_es_version は両モードで non-negative integer、default 0。
//    initial では「Phase C と同形」の保証のため default 0。
//    refresh では実値を明示的に投げる前提だが、未指定でも 400 を返さない方を選ぶ
//    (default 0 で受けて assembleResult が +1 して 1 を返す)。
//  - action_history は refresh で min(1)(空配列は initial と区別できなくなる)。
const AnalyzeInputBundleInitialSchema = z.object({
  mode: z.literal("initial"),
  // ES 本体: 8000字超は LLM 入力コスト爆発 + Vercel タイムアウトのリスク。
  es_body: z.string().min(1).max(8000),
  question: z.object({
    text: z.string().min(1),
    // 文字数制限は任意(2026-05-29): 制限のない設問もあるため optional。
    // 空欄 = 制限なし(プロンプトに上限の記述を注入しない)。指定する場合は正の整数。
    // 下限・上限ゲート(旧 50〜2000)は撤廃(UI 側で正整数性を担保)。
    char_limit: z.number().int().positive().optional(),
  }),
  // 企業URLが入力されなかったケースでは省略。company_value 系の根拠が出ないことを LLM が認識する。
  company_summary: CompanySummarySchema.optional(),
  edit_conditions: EditingConditionSchema,
  user_context: z.string().default(""),
  // 楽観的並行制御の鍵(Phase G で本格活用)。initial では 0 が典型値。
  current_es_version: z.number().int().nonnegative().default(0),
});

// UX 改修 3b (2026-05-23): `goal` フィールドを追加。
//   - "balanced":     既存挙動。通常の再分析(指摘の精度・網羅性を重視)
//   - "reduce_length": 派生 ES が設問上限を超過した際の文字数削減モード
//     (採用済 / 編集済の判断を覆さず、新規 suggestion を「削る目的」で追加生成)
//
// 設計判断:
//  - `optional().default("balanced")` で既存リクエストとの後方互換を保つ
//    (既存 client は goal を送らない → default 適用 → 挙動変化なし)
//  - `AnalyzeInputBundleInitial` には追加しない(initial では文字数削減は不要、
//    入力時の文字数チェックは別経路。reduce_length は採用 / 編集を経て派生 ES の
//    文字数が膨らんだケース固有の機能のため refresh だけに乗せる)
//  - schema レベルで「reduce_length のとき current_es_body > char_limit を保証」は
//    `current_es_body` を持たない bundle 構造のため不可。実機の起動条件は UI 側で
//    `isOverCharLimit()` を check することで担保(server 側はトレラントに受ける)。
const AnalyzeInputBundleRefreshSchema = AnalyzeInputBundleInitialSchema.extend({
  mode: z.literal("refresh"),
  // refresh では少なくとも 1 件のアクションが必要(空履歴の refresh は無意味)。
  action_history: z.array(ActionHistoryEntrySchema).min(1),
  goal: z.enum(["balanced", "reduce_length"]).optional().default("balanced"),
});

// -----------------------------------------------------------------------------
// Phase G Step 3b-2 (2026-05-23): partial update モード
// -----------------------------------------------------------------------------
// Sonnet 4.6 で「変更が必要な suggestion のみ」を返す経路。Opus の overall_assessment
// と既存 suggestions を引き継ぎ、prompt cache で Opus の評価軸を再利用する。
//
// refresh モードとの違い:
//  - existing_suggestions(現在の suggestion 全件)を入力に持つ — LLM が「どの suggestion
//    が既存か」を知るため必須
//  - overall_assessment(Opus の評価軸)を入力に持つ — LLM が同じ評価軸で再判定するため
//  - accepted/rejected/edited ID 集合を input に持つ — server 側で「ユーザー操作済 id を
//    updated に含めてはいけない」refine を行うため(analyze_helpers.ts に委譲)
//  - goal は **balanced のみ**(reduce_length は既存 refresh stream で fallback として
//    維持、partial は通常再分析専用)。schema 上は省略可能だが、partial 経路では
//    存在しないものとして扱う(冗長な設定を避ける)。
//
// 設計判断:
//  - 共通フィールド(es_body, question, edit_conditions, current_es_version, action_history,
//    user_context, company_summary)は refresh と同じ
//  - existing_suggestions は SuggestionSchema(span 解決済)を最大 15 件(分析結果と同じ上限)
//  - overall_assessment は OverallAssessmentSchema(Opus 結果を引き継ぐため必須)
//  - accepted/rejected/edited は user 操作の id 配列(string[] のシンプルな構造)
const AnalyzeInputBundlePartialSchema = AnalyzeInputBundleInitialSchema.extend({
  mode: z.literal("partial"),
  // refresh と同じく、空 history の partial は無意味
  action_history: z.array(ActionHistoryEntrySchema).min(1),
  // 既存 suggestions(直近の AnalysisResult.suggestions、span 解決済)
  // partial update は「既存に対する差分」を返すため必須
  existing_suggestions: z.array(SuggestionSchema).max(15),
  // Phase G 再修正 (2026-05-24): Sonnet は updated/deleted を主軸とした既存 suggestion の
  // maintenance に役割を戻し、added は新規問題発生時の副次的経路として扱う。
  // 初回の評価軸(必須)— prompt cache で引き継ぐ対象
  overall_assessment: OverallAssessmentSchema,
  // ユーザーが既に操作済の suggestion id(LLM は updated に含めてはいけない)
  accepted_suggestion_ids: z.array(z.string()),
  rejected_suggestion_ids: z.array(z.string()),
  edited_suggestion_ids: z.array(z.string()),
  // 統合改修パッケージ訂正 (2026-05-25): 動的 HITL の影響範囲を「AI 判断方式」に変更。
  //
  // 従来は `focus_target_ids` / `focus_es_excerpt` を構造的に計算してサーバから LLM へ
  // 渡していたが、深さ・近接量の数値根拠が実測で出せず経験的だった。
  // 統合改修 (2026-05-25) のユーザー対話で「AI 自身に意味的に判断させる」方針に変更。
  //  - サーバ → LLM に渡すのは「直近で拒否/編集された seed id 群」「編集前後のテキスト」
  //    「全 suggestions と ES」「企業情報」のみ
  //  - LLM が「ユーザー操作の影響を受ける指摘 だけを再評価する」と prompt で指示される
  //  - 影響範囲のフィルタは LLM の意味理解に任せる(`partial_refresh.ts` の prompt 参照)
  //  - サーバ側の構造制約は最小化(件数上限は設けない、HITL の本質を保つ)
  //
  // フィールド意味:
  //  - seed_suggestion_ids: 直前にユーザーが拒否/編集した指摘 ID(reject/edit 経路)
  //                         direct_edit / undo / redo / 「再分析」ボタン経路は空配列
  //  - seed_action_type: ユーザー操作の種類(prompt の文言調整に使う)
  //  - edit_before / edit_after: 編集の前後テキスト(reason="edit" / "direct_edit" のみ)
  seed_suggestion_ids: z.array(z.string()).default([]),
  seed_action_type: z
    .enum(["reject", "edit", "direct_edit", "undo", "redo", "manual"])
    .default("manual"),
  edit_before: z.string().optional(),
  edit_after: z.string().optional(),
});

export const AnalyzeInputBundleSchema = z.discriminatedUnion("mode", [
  AnalyzeInputBundleInitialSchema,
  AnalyzeInputBundleRefreshSchema,
  AnalyzeInputBundlePartialSchema,
]);
export type AnalyzeInputBundle = z.infer<typeof AnalyzeInputBundleSchema>;

// 個別 mode の型エクスポート(provider 側で type narrowing するときに使う)
export type AnalyzeInputBundleInitial = z.infer<typeof AnalyzeInputBundleInitialSchema>;
export type AnalyzeInputBundleRefresh = z.infer<typeof AnalyzeInputBundleRefreshSchema>;
export type AnalyzeInputBundlePartial = z.infer<typeof AnalyzeInputBundlePartialSchema>;

// -----------------------------------------------------------------------------
// InterviewInputBundle: /api/interview の API 入力形(Phase D 新設)
// -----------------------------------------------------------------------------
// lib/prompts/interview.ts の「ユーザーメッセージのテンプレート」が
// 期待する入力。accepted_suggestions_summary が「採用された指摘の方向性」の1行表現。
// generated_at_es_version は AI 出力に含めず、サーバ側で current_es_version をそのまま付与する。
const AcceptedSuggestionSummarySchema = z.object({
  suggestion_id: z.string().min(1),
  // "動詞の具体化を採用" のような短い方向性表現。LLM は ES 上の弱点と接続して質問を作る。
  direction: z.string().min(1),
});
export type AcceptedSuggestionSummary = z.infer<typeof AcceptedSuggestionSummarySchema>;

export const InterviewInputBundleSchema = z.object({
  es_body: z.string().min(1).max(8000),
  question: z.object({
    text: z.string().min(1),
    // 文字数制限は任意(2026-05-29): initial / refresh / partial と同じく optional。
    char_limit: z.number().int().positive().optional(),
  }),
  company_summary: CompanySummarySchema.optional(),
  edit_conditions: EditingConditionSchema,
  // 未採用の状態(初回直後など)では空配列。LLM は ES 弱点中心で質問を生成する。
  accepted_suggestions_summary: z.array(AcceptedSuggestionSummarySchema).default([]),
  user_context: z.string().default(""),
  current_es_version: z.number().int().nonnegative(),
});
export type InterviewInputBundle = z.infer<typeof InterviewInputBundleSchema>;
