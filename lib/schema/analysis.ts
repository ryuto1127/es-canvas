import { z } from "zod";
import { AISuggestionSchema, SuggestionSchema } from "./suggestion";
import { InterviewQuestionsSchema, InterviewQuestionSchema } from "./interview";
import { ClarificationQuestionSchema } from "./clarification";

// 2026-05-27 エージェント的対話(AI 逆質問): suggestion-bound + global の合計上限 3 を refine で担保。
// 「指摘最大 15 個」と同じ「LLM 出力上限」哲学の踏襲。3 個に絞ることで「本当に聞きたいこと」を
// LLM 自身が選別する圧力を構造化する(質より量 → 質優先の動的 HITL)。
// 詳細根拠は DECISIONS.md `[2026-05-27] エージェント的対話` 確定仕様 #5。
const CLARIFICATION_TOTAL_MAX = 3;
const CLARIFICATION_TOTAL_MESSAGE =
  "suggestion-bound と global の clarification_questions の合計は最大 3 個までです(本当に聞きたいこと 3 つに絞ること)";

// 合計件数チェック: suggestions[].clarification_questions の合計 + global_clarification_questions の合計
// 内部 helper。AIInitialAnalysisOutputSchema / AnalysisResultSchema / partial 経路で再利用。
function clarificationTotalIsValid(data: {
  suggestions: ReadonlyArray<{ clarification_questions?: ReadonlyArray<unknown> }>;
  global_clarification_questions?: ReadonlyArray<unknown>;
}): boolean {
  const suggestionBound = data.suggestions.reduce(
    (sum, s) => sum + (s.clarification_questions?.length ?? 0),
    0,
  );
  const global = data.global_clarification_questions?.length ?? 0;
  return suggestionBound + global <= CLARIFICATION_TOTAL_MAX;
}

export const OverallAssessmentSchema = z.object({
  summary: z.string().min(1),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  preserved_voice_note: z.string().min(1),
});
export type OverallAssessment = z.infer<typeof OverallAssessmentSchema>;

// 生成メタ — design_v1 Section 4.3 e。サーバ側で組み立てるため AI 出力には含まれない。
export const AnalysisMetadataSchema = z.object({
  generated_at: z.string().datetime(),
  model: z.string(),
  trigger: z.enum(["initial", "user_action_refresh", "user_typed_refresh", "manual"]),
  token_usage: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      cache_read: z.number().int().nonnegative().optional(),
      cache_creation: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type AnalysisMetadata = z.infer<typeof AnalysisMetadataSchema>;

// AI 出力版 (analyze_es ツールが返す形)。original_span / metadata はサーバが付与するので含めない。
// initial モードでは interview_questions は必須。
//
// Phase G 再修正 (2026-05-24): 副次的な候補プール構造を撤去。
// Opus が「必要な数だけ」suggestions を出す素直な構造に戻す。各 suggestion に
// internal_priority(1-10)は維持(UI 表示禁止、サーバ側で display_priority タグへ変換)。
// 詳細根拠は DECISIONS.md 2026-05-24 「Phase G 再修正: AI prompt の特定企業名排除 + 深さ軸(A+D)+ 量制約緩和」参照。
// 2026-05-27 エージェント的対話: refine 前の base schema(.omit() / .extend() で再利用するため
// 分離)。AIInitialAnalysisOutputSchema / AIRefreshAnalysisOutputSchema は本 base を起点に
// それぞれ refine を後付けして整合性を担保する。
const AIInitialAnalysisOutputBaseSchema = z.object({
  es_state_version: z.number().int().nonnegative(),
  overall_assessment: OverallAssessmentSchema,
  suggestions: z.array(AISuggestionSchema).max(15),
  interview_questions: InterviewQuestionsSchema,
  // 2026-05-27 エージェント的対話(AI 逆質問): ES 全体 / 個性 / 企業 fit 等に紐づく global 質問。
  // suggestion-bound 質問は各 suggestion の clarification_questions に、global 質問は本 field に格納。
  // 合計上限 3 は下記 refine で担保。AGENTS.md「Load-bearing field names」追加対象、リネーム禁止。
  global_clarification_questions: z
    .array(ClarificationQuestionSchema)
    .max(CLARIFICATION_TOTAL_MAX)
    .optional(),
});

export const AIInitialAnalysisOutputSchema = AIInitialAnalysisOutputBaseSchema.refine(
  clarificationTotalIsValid,
  {
    message: CLARIFICATION_TOTAL_MESSAGE,
    path: ["global_clarification_questions"],
  },
);
export type AIInitialAnalysisOutput = z.infer<typeof AIInitialAnalysisOutputSchema>;

// AI 出力版 (refresh モード、Phase D 新設)。
// lib/prompts/refresh.ts: interview_questions はツール側で構造的に除外。
// es_state_version も「LLM ではなくサーバが付与」(キックオフ判断4)するため除外。
// 2026-05-27: clarification refine も同様に refresh モードで担保(global_clarification_questions
// は AIInitialAnalysisOutputBaseSchema 由来で同じ field を持ち続ける)。
export const AIRefreshAnalysisOutputSchema = AIInitialAnalysisOutputBaseSchema.omit({
  interview_questions: true,
  es_state_version: true,
}).refine(clarificationTotalIsValid, {
  message: CLARIFICATION_TOTAL_MESSAGE,
  path: ["global_clarification_questions"],
});
export type AIRefreshAnalysisOutput = z.infer<typeof AIRefreshAnalysisOutputSchema>;

// AI 出力版 (interview モード、Phase D 新設)。
// lib/prompts/interview.ts: 出力は questions 配列だけに絞る。
// is_stale / generated_at_es_version はサーバ側で付与(判断4 と同じ精神)。
// このスキーマは「LLM が generate_interview_questions ツールに渡すべき構造」と完全に一致。
export const AIInterviewOutputSchema = z.object({
  questions: z.array(InterviewQuestionSchema).min(3).max(5),
});
export type AIInterviewOutput = z.infer<typeof AIInterviewOutputSchema>;

// 内部 / 最終 AnalysisResult。original_span 解決済みの Suggestion を含み、metadata を付与する。
// refresh モード (Phase D) では interview_questions が省略されるため optional のまま。
//
// Phase G 再修正 (2026-05-24): 副次的な候補プール構造を撤去。Sonnet partial は
// updated/deleted を主軸とした既存 suggestion の maintenance に役割を戻し、added は
// 新規問題発生時の副次的経路(最大 1 件)として扱う。
export const AnalysisResultSchema = z
  .object({
    es_state_version: z.number().int().nonnegative(),
    overall_assessment: OverallAssessmentSchema,
    // DECISION: 1分析あたり指摘最大15個 — design_v1 Section 7 制約
    suggestions: z.array(SuggestionSchema).max(15),
    interview_questions: InterviewQuestionsSchema.optional(),
    metadata: AnalysisMetadataSchema.optional(),
    // 2026-05-27 エージェント的対話(AI 逆質問): 内部表現にも global 質問を持たせる。
    // 合計上限 3 は refine で担保(suggestion-bound と global の合計、CLARIFICATION_TOTAL_MAX)。
    global_clarification_questions: z
      .array(ClarificationQuestionSchema)
      .max(CLARIFICATION_TOTAL_MAX)
      .optional(),
  })
  .refine(clarificationTotalIsValid, {
    message: CLARIFICATION_TOTAL_MESSAGE,
    path: ["global_clarification_questions"],
  });
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

// =============================================================================
// Phase G Step 3b-2 (2026-05-23): partial update 用スキーマ
// =============================================================================
// 派生 ES に対する suggestion の partial update。Sonnet 4.6 が「変更が必要な分のみ」
// を返す経路。Opus の overall_assessment を引き継いで(prompt cache 経由)再計算
// 不要な分を最大限残す HITL 設計の核心実装。
//
// 設計判断:
//  - AI 出力版(PartialAISuggestionUpdateSchema)では `id` が既存 suggestion の id と
//    一致する必要がある(updated 経路)/ 新規 id である必要がある(added 経路)。
//    server 側 context(既存 IDs / acceptedIds / 等)と照合する refine は本 schema
//    では持たず、analyze_helpers.ts:validateAnalysisAgainstInput に委譲する
//    (input bundle を見ないと判定できないため、schema 単体では構造制約のみ守る)。
//  - overall_assessment は LLM が partial update で必要なら更新できるが、原則は
//    Opus の評価軸を維持する(optional)。
//  - metadata.trigger は "user_action_refresh" / "manual" を期待(provider 側で付与)。
//
// refine 群(構造的防衛、dispatch §3-1):
//  refine 1: updated と deleted の id が重複していない
//  refine 2: added の id が updated / deleted と重複していない(自身の集合内ユニーク)
//  refine 3: updated + added の合計が **15 件以下**(dispatch §3-3 は「残存 + updated + added」
//           だが残存は server context 側、本 schema では LLM 出力分だけで 15 以下に抑える)
//  refine 4: updated[i].category は category 自体が変更不可ではなく schema 上は受け入れる
//           が、server 検証(validateAnalysisAgainstInput)で元の category と一致するか確認
//  refine 5: updated[i].original_span.start は schema 上は受けない(AI 出力には span が無い)
//           実際の位置検証は server で resolveOriginalSpans 後に元 span との距離をチェック
//  refine 6: ユーザー採用済/編集済/却下済の id 検証は server context が必要、本 schema で
//           はやらない(analyze_helpers.ts に委譲)
//  refine 7: proposed !== original は既存 AISuggestionSchema の refine で担保
//  refine 8: category === "error" の length 比 0.5-1.5 は既存 refine で担保
//
// 結論: 本 schema レベルで担保する refine は 1, 2, 3 のみ。残りは context 必須のため
// analyze_helpers.ts:validateAnalysisAgainstInput の partial 分岐で行う。
export const AIPartialAnalysisOutputSchema = z
  .object({
    updated: z.array(AISuggestionSchema).max(15),
    deleted: z.array(z.string().regex(/^sug_\d{3}$/)).max(15),
    // Phase G 修正 (2026-05-23) / 再修正 (2026-05-24): max(1)。逐次 1 件追加の HITL リズム
    // を保持しつつ、pool 概念は撤去。Sonnet は updated/deleted を主軸とし、added は新規
    // 問題が生じた時のみ 1 件追加(無ければ空配列)。
    added: z.array(AISuggestionSchema).max(1),
    overall_assessment: OverallAssessmentSchema.optional(),
    // 2026-05-27 エージェント的対話(AI 逆質問): partial refresh でも global 質問を出してよい。
    // 上限 3 は本 refine で「updated + added の suggestion-bound + global の合計」として担保。
    // partial 経路では「既存の deleted suggestion に紐づいていた質問」は merge 経路でクリアされる。
    global_clarification_questions: z
      .array(ClarificationQuestionSchema)
      .max(CLARIFICATION_TOTAL_MAX)
      .optional(),
  })
  // refine 1: updated と deleted の id が重複していない(LLM が「更新する id を削除もする」
  //   矛盾出力を構造で弾く)
  .refine(
    (data) => {
      const updatedIds = new Set(data.updated.map((s) => s.id));
      return data.deleted.every((id) => !updatedIds.has(id));
    },
    {
      message: "updated と deleted で同じ id を指定することはできない",
      path: ["deleted"],
    },
  )
  // refine 2: added の id が updated / deleted と重複していない(自身の集合内ユニーク)
  .refine(
    (data) => {
      const knownIds = new Set([
        ...data.updated.map((s) => s.id),
        ...data.deleted,
      ]);
      return data.added.every((s) => !knownIds.has(s.id));
    },
    {
      message: "added の id は updated / deleted と重複してはならない",
      path: ["added"],
    },
  )
  // refine 3: updated + added の合計が 15 件以下(残存は server context、本 schema は
  //   出力分のみで上限抑制)
  .refine(
    (data) => data.updated.length + data.added.length <= 15,
    {
      message:
        "updated + added の合計が 15 件を超えています。partial update の出力規模を抑えてください",
      path: ["added"],
    },
  )
  // Phase G 修正 (2026-05-23) / 再修正 (2026-05-24): refine 4 = added.length <= 1
  // (逐次 1 件追加の HITL リズム保持)。schema 上の max(1) で既に弾けるが、refine で
  // 明示的に「複数件追加禁止」のエラーメッセージを出すことで retry message のフィードバック
  // 品質を上げる。pool 概念は撤去済(本 refine と直接の関係なし)。
  .refine((data) => data.added.length <= 1, {
    message:
      "added は最大 1 件のみ(逐次 1 件追加の HITL リズム)。複数件を一度に追加してはいけません。新規問題が無ければ added: [] を返してください。",
    path: ["added"],
  })
  // 2026-05-27 エージェント的対話(AI 逆質問): updated / added の suggestion-bound 質問と
  // global 質問の合計上限 3。clarificationTotalIsValid は `suggestions` 引数を期待するため、
  // partial 経路では updated + added を 1 配列に concat して渡す(deleted 経路は質問を持たない、
  // server 側 merge で既存の質問を引き継ぐ)。
  .refine(
    (data) =>
      clarificationTotalIsValid({
        suggestions: [...data.updated, ...data.added],
        global_clarification_questions: data.global_clarification_questions,
      }),
    {
      message: CLARIFICATION_TOTAL_MESSAGE,
      path: ["global_clarification_questions"],
    },
  );
export type AIPartialAnalysisOutput = z.infer<
  typeof AIPartialAnalysisOutputSchema
>;

// 内部 / 最終 PartialAnalysisResult。サーバが original_span を resolveOriginalSpans で
// 付与し、display_priority をヒューリスティック計算で付与した形。
// updated / added の各 suggestion は SuggestionSchema(span 解決済)になる。
export const PartialAnalysisResultSchema = z
  .object({
    es_state_version: z.number().int().nonnegative(),
    updated: z.array(SuggestionSchema).max(15),
    deleted: z.array(z.string().regex(/^sug_\d{3}$/)).max(15),
    // Phase G 修正 (2026-05-23) / 再修正 (2026-05-24): max(1)。逐次 1 件追加の HITL リズム保持。
    added: z.array(SuggestionSchema).max(1),
    overall_assessment: OverallAssessmentSchema.optional(),
    // 2026-05-27 エージェント的対話(AI 逆質問): partial 経路の内部表現も global 質問を持たせる。
    // 上限 3 は本 schema 末尾 refine で「updated + added の suggestion-bound + global」として担保。
    global_clarification_questions: z
      .array(ClarificationQuestionSchema)
      .max(CLARIFICATION_TOTAL_MAX)
      .optional(),
    metadata: AnalysisMetadataSchema.optional(),
  })
  .refine(
    (data) => {
      const updatedIds = new Set(data.updated.map((s) => s.id));
      return data.deleted.every((id) => !updatedIds.has(id));
    },
    {
      message: "updated と deleted で同じ id を指定することはできない",
      path: ["deleted"],
    },
  )
  .refine(
    (data) => {
      const knownIds = new Set([
        ...data.updated.map((s) => s.id),
        ...data.deleted,
      ]);
      return data.added.every((s) => !knownIds.has(s.id));
    },
    {
      message: "added の id は updated / deleted と重複してはならない",
      path: ["added"],
    },
  )
  .refine(
    (data) => data.updated.length + data.added.length <= 15,
    {
      message: "updated + added の合計が 15 件を超えています",
      path: ["added"],
    },
  )
  // Phase G 修正 (2026-05-23) / 再修正 (2026-05-24): refine 4 = added.length <= 1
  // (逐次 1 件追加の HITL リズム)
  .refine((data) => data.added.length <= 1, {
    message: "added は最大 1 件のみ(逐次 1 件追加の HITL リズム)",
    path: ["added"],
  })
  // 2026-05-27 エージェント的対話(AI 逆質問): updated / added の suggestion-bound 質問 +
  // global 質問の合計上限 3。AI 出力時(AIPartialAnalysisOutputSchema)と同じ規律を内部表現
  // にも二重化する(別経路で生成された PartialAnalysisResult で抜ける可能性を防ぐ)。
  .refine(
    (data) =>
      clarificationTotalIsValid({
        suggestions: [...data.updated, ...data.added],
        global_clarification_questions: data.global_clarification_questions,
      }),
    {
      message: CLARIFICATION_TOTAL_MESSAGE,
      path: ["global_clarification_questions"],
    },
  );
export type PartialAnalysisResult = z.infer<typeof PartialAnalysisResultSchema>;
