import { z } from "zod";
// 2026-05-27 エージェント的対話(AI 逆質問): suggestion-bound 質問の schema を別 file から import。
// AGENTS.md「Load-bearing field names」追加: `clarification_questions`(本 file で SuggestionSchema
// に optional 追加)、`id` / `question` / `rationale`(ClarificationQuestionSchema 内部)。
import { ClarificationQuestionSchema } from "./clarification";

// 3層分類 — design_v1 Section 4.4
// v2 Phase B1 (2026-05-26): structural カテゴリ追加。明示的な構造変更操作
// (段落削除 / 順番変更 / 統合 / 文移動 / 段落追加)を suggestion として表現する。
// 既存 enum 値「error / convention / alternative」は load-bearing(few-shot 学習構造に
// 依存)のためリネーム禁止、structural は **追加のみ**。
// AGENTS.md Inviolable constraints L33「ES の全面書き換え禁止」は structural 例外を
// 同 line に明記済(各 structural 操作 = 部分指摘の延長、HITL 維持)。
// 詳細根拠は DECISIONS.md [2026-05-26] v2 — structural カテゴリ導入。
export const CategorySchema = z.enum([
  "error",
  "convention",
  "alternative",
  "structural",
]);
export type Category = z.infer<typeof CategorySchema>;

// v2 Phase B1 (2026-05-26): structural 操作の params(discriminated union)。
// 5 operations を type-safe に表現する。各 operation の必須フィールドは branch ごと:
//  - delete_paragraph: target_paragraph_index(0-indexed)
//  - reorder_paragraphs: new_order(2 段落以上の置換配列)
//  - merge_paragraphs: target_paragraph_indices(2 段落以上、連続/非連続不問は B3 判断)
//  - move_sentence: source/target の段落 index + sentence index + 挿入位置 before/after
//  - add_paragraph: 挿入位置 + 追加する内容の outline / 方向性(5〜50 字、本文ではない)
//
// 2026-05-27 prompt 設計批判 #4 への対応(Task b-1): add_paragraph.new_content は
// 「AI が ES に挿入する段落本文」ではなく「追加すべき内容の outline / 方向性」を 50 字以内
// で書くフィールドに変更。ES 本文の確定は人間が握る(採用 → 編集して採用)。
// 旧仕様(1〜500 字、AI が本文生成)は HITL 維持と衝突するため deprecated。
//   - 上限 50: outline 1 行に収まる長さ、AI が本文を書き始めるのを構造で抑止
//   - 下限 5: 「Action 追加」のような最短 outline を許容、空文字や記号 1 文字は弾く
// Load-bearing field(`structural_params`、AGENTS.md L65 に追加済)。リネーム禁止。
export const StructuralOperationParamsSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("delete_paragraph"),
    target_paragraph_index: z.number().int().min(0),
  }),
  z.object({
    operation: z.literal("reorder_paragraphs"),
    new_order: z.array(z.number().int().min(0)).min(2),
  }),
  z.object({
    operation: z.literal("merge_paragraphs"),
    target_paragraph_indices: z.array(z.number().int().min(0)).min(2),
  }),
  z.object({
    operation: z.literal("move_sentence"),
    source_paragraph_index: z.number().int().min(0),
    source_sentence_index: z.number().int().min(0),
    target_paragraph_index: z.number().int().min(0),
    target_position: z.enum(["before", "after"]),
  }),
  z.object({
    operation: z.literal("add_paragraph"),
    target_paragraph_index: z.number().int().min(0),
    target_position: z.enum(["before", "after"]),
    // 2026-05-27 prompt 設計批判 #4: outline / 方向性のみ(本文は人間が書く)
    new_content: z.string().min(5).max(50),
  }),
]);
export type StructuralOperationParams = z.infer<
  typeof StructuralOperationParamsSchema
>;

// 根拠ソース — design_v1 Section 4.5
// DECISION: discriminatedUnion で「company_value のときのみ url 必須」をスキーマレベルで強制
// セッション5 (Phase C) で company_value に evidence_id を optional 追加 — Phase F 二方向ハイライト
// のためのデータ基盤。CompanySummary.evidence[].id を AI が引用する経路を構造で表現する。
// Phase E 拡張(2026-05-23): url を URL 形式必須から min(1) に緩和。自由テキスト経路の企業要約
// に対応する company_value 指摘では、企業要約 evidence.source_url = "user-input" を引用するため
// URL 検証を schema レベルで強制すると弾かれる。実質的な制約(承認 URL リスト照合)は
// analyze_helpers.ts:getApprovedCompanyUrls で経路に依らず維持される。
const CompanyValueSourceSchema = z.object({
  type: z.literal("company_value"),
  reference: z.string().min(1),
  url: z.string().min(1),
  evidence_id: z.string().min(1).optional(),
});

const NonCompanySourceSchema = z.object({
  type: z.enum(["convention", "rubric", "linguistic", "consistency", "user_intent"]),
  reference: z.string().min(1),
});

export const RationaleSourceSchema = z.discriminatedUnion("type", [
  CompanyValueSourceSchema,
  NonCompanySourceSchema,
]);
export type RationaleSource = z.infer<typeof RationaleSourceSchema>;

export const AlternativeSchema = z.object({
  id: z.string(),
  text: z.string(),
  tone_hint: z.string(),
});
export type Alternative = z.infer<typeof AlternativeSchema>;

// 文中位置 — design_v1 Section 4.3。
// セッション5 (Phase C): LLM ではなくサーバが解決する(LLM はインデックス計算が苦手)。
// 旧 anchor_before / anchor_after は Phase A の推測。本セッションでは未使用とし、
// Phase F で必要になれば前後コンテキスト文字列として再導入する。
export const OriginalSpanSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
});
export type OriginalSpan = z.infer<typeof OriginalSpanSchema>;

// alternative カテゴリのときは alternatives 配列が非空でなければならない(few-shot Section 2.2 規範)。
// zod v4 は ZodEffects 型を export していないので、refine を schema 末尾に直接付けて
//   `typeof XxxSchema` の型推論を生かす。共通関数化は型推論を壊すため避ける。
const ALTERNATIVE_REFINE_MESSAGE =
  "category === 'alternative' のとき alternatives は 1 個以上必要";

// UX 改修 2 (2026-05-23): proposed !== original の構造強制。
// 「何も変えない指摘」「LLM が proposed を埋め忘れて original をコピペした出力」を schema 段階で弾く。
// 防衛三段の Part 3(Zod 検証 + 1 回リトライ)強化、buildAnalysisRetryMessage の schema_format 経由で
// LLM に違反詳細をフィードバックして再提出を求める。
const PROPOSED_DIFFERENT_FROM_ORIGINAL_MESSAGE =
  "proposed は original と異なる文字列でなければならない(何も変えない指摘は出力しない)";

// UX 改修 2 (2026-05-23): alternatives[*].text !== original も同様に強制。
// alternatives で original と同じ文字列を提示しても提案として意味がないため。
const ALTERNATIVE_TEXT_DIFFERENT_FROM_ORIGINAL_MESSAGE =
  "alternatives[*].text は original と異なる文字列でなければならない";

// Phase G Step 3b-1 (2026-05-23): error カテゴリの自動修正を安全に行うため、
// proposed の長さを original の 50%〜150% 以内に制約する。
// 「error と称した全面書き換え」を schema 段階で弾き、ユーザーが「自動修正された」
// と知らないうちに大規模な改変が入る事故を構造で防ぐ。比率の上下限はモデル品質の
// 揺れを許容しつつ、過度に大きな乖離を弾く実用ラインとして 0.5-1.5 を採用。
// 大規模変更が必要な指摘は convention / alternative に分類する誘導(system prompt の
// 「error カテゴリの客観的判定基準」と組合せ)。
const ERROR_PROPOSED_LENGTH_MESSAGE =
  "category === 'error' のとき proposed.length / original.length は 0.5〜1.5 の範囲でなければならない(全面書き換えは convention/alternative に分類すること)";

const ERROR_PROPOSED_RATIO_MIN = 0.5;
const ERROR_PROPOSED_RATIO_MAX = 1.5;

function isErrorProposedLengthValid(s: {
  // v2 Phase B1 (2026-05-26): "structural" 追加。structural は構造変更で proposed の
  // 意味自体が変わる(段落削除なら proposed = "" 等)ため、本 refine は早期通過させる。
  category: "error" | "convention" | "alternative" | "structural";
  original: string;
  proposed: string;
}): boolean {
  if (s.category !== "error") return true;
  // original 長 0 は他の min(1) で弾かれるが、防御的に分母 0 を回避
  if (s.original.length === 0) return false;
  const ratio = s.proposed.length / s.original.length;
  return ratio >= ERROR_PROPOSED_RATIO_MIN && ratio <= ERROR_PROPOSED_RATIO_MAX;
}

// v2 Phase B1 (2026-05-26): structural カテゴリのとき `structural_params` 必須。
// 他カテゴリ(error / convention / alternative)では structural_params は未指定であるべき。
// 「structural 宣言だけして params 無し」 / 「structural_params だけ付けて category 別物」を
// schema 段階で構造的に弾く。
// 単一 message で双方向違反(structural なのに params 無し / params だけ付けて category 別物)
// を表現する。エラー path は ["structural_params"] に固定し、UI 側で違反内容を判別する。
const STRUCTURAL_PARAMS_REQUIRED_MESSAGE =
  "category === 'structural' のとき structural_params 必須(operation + params を discriminated union で指定)。他カテゴリでは structural_params を付与しないこと。";

function isStructuralParamsConsistent(s: {
  category: Category;
  structural_params?: StructuralOperationParams;
}): boolean {
  if (s.category === "structural") return s.structural_params !== undefined;
  return s.structural_params === undefined;
}

// Phase G Step 3b-2 (2026-05-23): LLM が出力する内部用重要度(1-10)。
// **UI に絶対表示しない**。サーバが受信後に文字列タグ(display_priority)に変換し、
// UI に渡る Suggestion からは消す経路で運用する(下記 DisplayPrioritySchema 参照)。
//
// 設計判断:
//  - `internal_` prefix で「UI 参照禁止」を命名で明示(grep で UI 違反検出可能)
//  - optional: initial 分析の既存 suggestion は持たない(後付け)、partial update で
//    LLM が新規付与する
//  - 1 = 軽微、5 = 標準、10 = 最重要
//  - error カテゴリは自動修正対象で SuggestionListPanel メインリストに出ないため、
//    重要度判断対象外(出力しても UI 側で使われない)
// 詳細根拠は DECISIONS.md G3B2.3(2026-05-23 Phase G Step 3b-2)。
const InternalPrioritySchema = z.number().int().min(1).max(10);

// Phase G Step 3b-2 (2026-05-23): UI 表示用の文字列タグ(3 段階)。
// サーバが internal_priority に対してヒューリスティック補正をかけて生成する。
// UI コンポーネント(SuggestionListPanel / SuggestionCard など)はこちらだけを参照する。
// 詳細根拠は DECISIONS.md G3B2.4(1-10 → low/medium/high 変換)。
export const DisplayPrioritySchema = z.enum(["high", "medium", "low"]);
export type DisplayPriority = z.infer<typeof DisplayPrioritySchema>;

// AI 出力版(analyze_es ツールから返ってくる形)。original_span はサーバで付与するため含めない。
//
// v2 Phase B1 (2026-05-26):
//  - `structural_params`(optional) — structural のとき必須、他カテゴリでは付与禁止
//    (refine `isStructuralParamsConsistent` で両方向の整合を担保)
//  - `lost_content`(optional) — structural で削除/移動の結果失われる原文の控え。
//    UI が「失う情報」を明示するための補助。schema 上は optional(全 operation で必須では
//    ない、例えば reorder_paragraphs では情報は失われない)
//  - 既存 refine「proposed !== original」「alternative の text !== original」は維持。
//    ただし structural のとき proposed = "" や全段落置換等で「proposed === original」が
//    成立するケースは存在するため、existing refine の前提との整合は B2/B3 で再評価。
//    B1 redesign では既存 refine をそのまま維持(structural example はまだ AI に出させない、
//    fewshot.ts は B2 で同期予定)。
export const AISuggestionSchema = z
  .object({
    id: z.string().min(1),
    category: CategorySchema,
    original: z.string().min(1),
    proposed: z.string().min(1),
    alternatives: z.array(AlternativeSchema),
    rationale: z.string().min(1),
    rationale_source: RationaleSourceSchema,
    related_suggestion_ids: z.array(z.string()),
    // Phase G Step 3b-2: 内部重要度(1-10)。LLM が partial update 経路で付与する。
    // UI 参照禁止、サーバが display_priority に変換してから UI に渡す。
    internal_priority: InternalPrioritySchema.optional(),
    // v2 Phase B1: structural 操作の params(load-bearing、AGENTS.md L65 追加済)
    structural_params: StructuralOperationParamsSchema.optional(),
    // v2 Phase B1: structural 操作で失われる原文の控え(load-bearing、AGENTS.md L65 追加済)
    lost_content: z.string().optional(),
    // 2026-05-27 エージェント的対話(AI 逆質問): suggestion-bound 質問(0 or 1 個)。
    // 上限 1 件は ES 1 個の suggestion について「本当に聞きたい一点」に絞る規律。
    // global 質問との合計上限 3 は AnalyzeResultSchema 側の refine で担保(本 schema 単体では
    // suggestion 単位の上限のみ守る)。AGENTS.md「Load-bearing field names」追加対象。
    clarification_questions: z.array(ClarificationQuestionSchema).max(1).optional(),
  })
  .refine(
    (s) => s.category !== "alternative" || s.alternatives.length >= 1,
    { message: ALTERNATIVE_REFINE_MESSAGE, path: ["alternatives"] },
  )
  .refine((s) => s.proposed !== s.original, {
    message: PROPOSED_DIFFERENT_FROM_ORIGINAL_MESSAGE,
    path: ["proposed"],
  })
  .refine((s) => s.alternatives.every((a) => a.text !== s.original), {
    message: ALTERNATIVE_TEXT_DIFFERENT_FROM_ORIGINAL_MESSAGE,
    path: ["alternatives"],
  })
  // Phase G Step 3b-1: error の自動修正は派生 ES に即時反映されるため、
  // proposed の長さ比を 0.5-1.5 に厳格化(全面書き換えを構造で弾く)。
  // v2 Phase B1: structural のとき本 refine は早期通過(isErrorProposedLengthValid 内部
  // で「category !== 'error'」分岐で structural も自動的に通過)。
  .refine(isErrorProposedLengthValid, {
    message: ERROR_PROPOSED_LENGTH_MESSAGE,
    path: ["proposed"],
  })
  // v2 Phase B1: structural と structural_params の双方向整合(両ケースを弾く)
  .refine(isStructuralParamsConsistent, {
    message: STRUCTURAL_PARAMS_REQUIRED_MESSAGE,
    path: ["structural_params"],
  });
export type AISuggestion = z.infer<typeof AISuggestionSchema>;

// サーバ側で original_span を解決した後の内部表現。AnalysisResult に含まれる最終形。
//
// Phase G Step 3b-2 (2026-05-23):
//  - `internal_priority` は **サーバ内部処理用**(LLM 出力 → ヒューリスティック補正計算
//    の引き渡し用)。Suggestion 型に持たせるが、**最終的に UI に渡る前のサーバ側変換層
//    で消す**運用とする(下記 applyPartialResult 経路)。
//  - `display_priority` は **UI に渡る文字列タグ**。サーバが internal_priority に
//    補正をかけて生成する。
//  - 既存 initial 分析の suggestion は両方 optional のため後方互換が保たれる
//    (display_priority が未付与の suggestion は UI 側で「優先度情報なし」として通常扱い)。
export const SuggestionSchema = z
  .object({
    id: z.string().min(1),
    category: CategorySchema,
    original: z.string().min(1),
    proposed: z.string().min(1),
    alternatives: z.array(AlternativeSchema),
    rationale: z.string().min(1),
    rationale_source: RationaleSourceSchema,
    related_suggestion_ids: z.array(z.string()),
    original_span: OriginalSpanSchema,
    // Phase G Step 3b-2: 内部重要度(サーバ受信時に持つ可能性、UI に渡る前に消去)
    internal_priority: InternalPrioritySchema.optional(),
    // Phase G Step 3b-2: 文字列タグ(UI 表示用、サーバが生成して付与)
    display_priority: DisplayPrioritySchema.optional(),
    // v2 Phase B1 (2026-05-26): structural 操作の params + 失う原文(load-bearing)
    // AISuggestionSchema と同じ field を SuggestionSchema にも持たせる。
    // 別経路で生成された Suggestion で抜ける可能性を防ぐ(refine も同様に二重化)。
    structural_params: StructuralOperationParamsSchema.optional(),
    lost_content: z.string().optional(),
    // 2026-05-27 エージェント的対話(AI 逆質問): suggestion-bound 質問(AISuggestionSchema と同じ optional 拡張)。
    // AGENTS.md「Load-bearing field names」追加対象、リネーム禁止。
    clarification_questions: z.array(ClarificationQuestionSchema).max(1).optional(),
  })
  .refine(
    (s) => s.category !== "alternative" || s.alternatives.length >= 1,
    { message: ALTERNATIVE_REFINE_MESSAGE, path: ["alternatives"] },
  )
  .refine((s) => s.proposed !== s.original, {
    message: PROPOSED_DIFFERENT_FROM_ORIGINAL_MESSAGE,
    path: ["proposed"],
  })
  .refine((s) => s.alternatives.every((a) => a.text !== s.original), {
    message: ALTERNATIVE_TEXT_DIFFERENT_FROM_ORIGINAL_MESSAGE,
    path: ["alternatives"],
  })
  // Phase G Step 3b-1: AISuggestionSchema と同じ refine を内部表現にも適用
  // (片方しか持っていないと別経路で生成された Suggestion で抜ける可能性がある)。
  .refine(isErrorProposedLengthValid, {
    message: ERROR_PROPOSED_LENGTH_MESSAGE,
    path: ["proposed"],
  })
  // v2 Phase B1: structural と structural_params の双方向整合(AISuggestion と同じ二重化)
  .refine(isStructuralParamsConsistent, {
    message: STRUCTURAL_PARAMS_REQUIRED_MESSAGE,
    path: ["structural_params"],
  });
export type Suggestion = z.infer<typeof SuggestionSchema>;
