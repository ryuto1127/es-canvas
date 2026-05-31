import { z } from "zod";

export const InterviewQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  rationale: z.string(),
  answer_hint: z.string(),
  purpose_hint: z.string(),
});
export type InterviewQuestion = z.infer<typeof InterviewQuestionSchema>;

export const InterviewQuestionsSchema = z.object({
  generated_at_es_version: z.number().int(),
  is_stale: z.boolean(),
  // 3〜5問 — design_v1 Section 7 制約
  questions: z.array(InterviewQuestionSchema).min(3).max(5),
});
export type InterviewQuestions = z.infer<typeof InterviewQuestionsSchema>;
