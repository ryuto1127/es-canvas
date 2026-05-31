import { z } from "zod";

// =============================================================================
// 2026-05-27: エージェント的対話(AI 逆質問)機能
// =============================================================================
//
// HITL 哲学の進化形「AI 単方向の指摘 → 双方向の対話」を schema 層で実現する。
// AI が ES の文脈情報が不足していると判断した時、ユーザーに **逆質問** を出してよい。
// ユーザーは任意で回答 (skip 可)、回答済みの内容を user_context に enrichment して
// partial refresh を再発火することで、文脈最適化された ES 添削が可能になる。
//
// 設計の核(DECISIONS.md `[2026-05-27] エージェント的対話` 参照):
//  - **質問のタイプ**:
//      * suggestion-bound: 特定の suggestion について情報不足を感じた時、
//        その suggestion の `clarification_questions` 配列に 0-1 個追加
//      * global: ES 全体 / 個性 / 企業 fit 等、特定 suggestion に紐づかない質問は
//        AnalyzeResult / RefreshResult の `global_clarification_questions` 配列に追加
//  - **上限**: suggestion-bound と global の合計が **最大 3 個まで**(refine で担保)
//  - **必須項目**:
//      * `id`: 質問の一意 id(`q_001` のような短い識別子、re-analyze 時の回答紐付け用)
//      * `question`: 質問本文(5〜200 字、簡潔に)
//      * `rationale`: なぜこの質問を出すか(10〜300 字)、不適切な質問の量産を抑制
//  - **捏造防止**: 質問は「事実主張」ではなく「情報要求」のため
//    `rationale_source`(URL / evidence_id)は不要。ただし `rationale`(なぜ聞くか)は必須。
//
// Load-bearing field names(AGENTS.md「Load-bearing field names」と整合、リネーム禁止):
//   `id`, `question`, `rationale`(質問内部)
//   `clarification_questions`(SuggestionSchema に optional 追加)
//   `global_clarification_questions`(AnalyzeResult / RefreshResult に optional 追加)
//
// SSOT: 本ファイル + lib/schema/suggestion.ts (SuggestionSchema 拡張)
//       lib/schema/analysis.ts (AIInitialAnalysisOutput / AnalysisResult etc. 拡張)
//       lib/tools/analyze_es.ts + 各 OpenAI 版 / partial / refresh_only 版で JSON Schema 同期
//       lib/prompts/system.ts §「逆質問の規律」+ lib/prompts/fewshot.ts(同期)

// =============================================================================
// 2026-05-28 dogfood: 逆質問の回答を user_context に enrichment する際の区切りヘッダ。
// =============================================================================
//
// `buildClarificationEnrichedIntent`(lib/state/analyze_store.ts、producer)が回答 Q/A を
// この行で開始する 1 ブロックにまとめ、`appendClarificationToUserContext` で user_context
// 末尾に append する。サーバ側の prompt builder(lib/prompts/partial_refresh.ts /
// refresh.ts、consumer)はこのヘッダの有無で「逆質問の回答が存在する再分析」を検知し、
// 「回答を必ず取り込んだ提案を 1 件以上出す」専用指示を条件付きで注入する。
//
// 以前は producer / consumer / tests の各所でリテラル文字列 "[逆質問への回答]" が
// 散在していた(magic string)。ヘッダ文言の変更で producer / consumer の検知が
// 静かにズレる drift を防ぐため、SSOT としてここに 1 定数化する(双方が import)。
// リネーム / 文言変更は producer・consumer・tests を同時に更新すること。
export const CLARIFICATION_ENRICHED_INTENT_HEADER = "[逆質問への回答]";

export const ClarificationQuestionSchema = z.object({
  // 質問の一意 id(re-analyze 時の回答紐付け、`q_001` のような短い識別子)
  // 注意: この id は **suggestion ごと** に振られ(LLM 出力契約)、集約リスト全体では
  // 一意でない。複数 suggestion が同じ `q_001` を持ちうる(es5 capture で実観測)。
  // よって回答の find / update / lookup / React key は id 単独ではなく
  // `clarificationIdentity`(scope + suggestion_id + question_id の複合キー)で行うこと。
  id: z.string().min(1),
  // 質問本文(5〜200 字、簡潔に)
  question: z.string().min(5).max(200),
  // なぜこの質問を出すか(10〜300 字)、不適切な質問の量産を抑制
  rationale: z.string().min(10).max(300),
});
export type ClarificationQuestion = z.infer<typeof ClarificationQuestionSchema>;

// =============================================================================
// 2026-05-29 dogfood(es5 capture): clarification question の複合キー(SSOT)
// =============================================================================
//
// 問題: `ClarificationQuestion.id`(`q_001` 等)は **suggestion 単位** で振られるため、
// 集約リスト(全 suggestion の clarification_questions + global_clarification_questions)
// 全体では一意でない。実データで `sug_003` と `sug_005` が両方 `q_001` を持つケースを観測。
// その結果:
//  - React key 衝突("同じ key q_001 が2つ")
//  - 回答ストア(clarificationAnswers)の find / update / lookup が question_id 単独で
//    照合していたため、片方の q_001 への回答がもう片方の q_001 にも表示される(混線)
//
// 修正方針(複合キー): clarification question の identity を
// `(scope, suggestion_id, question_id)` のタプルで一意化する。各回答(ClarificationAnswer)は
// 既に scope / suggestion_id を保持しているため、question_id 単独照合を本キー照合に置き換える
// だけで回答↔質問の対応が正しく保たれる(sug_003 の答えは sug_003 の質問だけに紐づく)。
//
// scope === "suggestion": `suggestion:<suggestion_id>:<question_id>`
// scope === "global":     `global:<question_id>`(suggestion_id を持たない)
//
// SSOT として本ファイルに 1 定義し、store(find/update/lookup/Map keying)と
// component(React key)双方が import する(照合ロジックの drift を防ぐ)。
//
// 注意: `ClarificationQuestion.id` は schema 上 load-bearing field(リネーム / 値の
// 振り直しはしない)。本複合キーは「照合用の派生キー」であって id 自体は不変。
export function clarificationIdentity(args: {
  scope: "suggestion" | "global";
  // scope === "suggestion" の時に渡す。global では undefined。
  suggestion_id?: string;
  question_id: string;
}): string {
  if (args.scope === "suggestion") {
    // suggestion_id が欠落しても question_id で区別を残す(防御的、通常は必ず set される)。
    return `suggestion:${args.suggestion_id ?? ""}:${args.question_id}`;
  }
  return `global:${args.question_id}`;
}
