import { LLMError, type AnalyzeInput, type AnalyzeMode, type InterviewInput, type LLMProvider } from "./types";
import type { CompanySummary, ResearchInputSource } from "../schema/company";
import type { AnalysisResult } from "../schema/analysis";
import type { InterviewQuestions } from "../schema/interview";

// Day 6 で本実装。Gemini の function calling 経由予定
export class GoogleProvider implements LLMProvider {
  readonly name = "google" as const;

  async researchCompany(_input: ResearchInputSource): Promise<CompanySummary> {
    throw new LLMError("not_implemented", "GoogleProvider.researchCompany is a stub (Day 6)");
  }

  async analyze(_input: AnalyzeInput, _mode: AnalyzeMode): Promise<AnalysisResult> {
    throw new LLMError("not_implemented", "GoogleProvider.analyze is a stub (Day 6)");
  }

  async generateInterview(_input: InterviewInput): Promise<InterviewQuestions> {
    throw new LLMError("not_implemented", "GoogleProvider.generateInterview is a stub (Day 6)");
  }
}
