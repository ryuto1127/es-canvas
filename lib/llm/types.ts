import type { CompanySummary, ResearchInputSource } from "../schema/company";
import type {
  AnalyzeInputBundle,
  InterviewInputBundle,
} from "../schema/input";
import type { AnalysisResult } from "../schema/analysis";
import type { InterviewQuestions } from "../schema/interview";

// Phase G Step 3b-2 (2026-05-23): partial を追加。同期 analyze() では未サポート、
// streaming(analyzePartialStream)経路のみ呼べる(route が input.mode で分岐)。
export type AnalyzeMode = "initial" | "refresh" | "partial";

// Phase C: initial モードのみ実装。AnalyzeInputBundle は API 境界と provider 境界で同形。
// Phase D: refresh モードを判別ユニオンに含めた AnalyzeInputBundle をそのまま流す。
//   mode 分岐は provider 側で input.mode を見て行う。
export type AnalyzeInput = AnalyzeInputBundle;

// HITL 操作の自己宣言(Phase D で精緻化)
// Phase D セッション6: action_history (input.ts) の方が「LLM に渡す形」として整備済み。
// この UserAction は将来的に「フロント Zustand store の actions」と整合させる予定。
export type UserAction =
  | { kind: "accept"; suggestion_id: string }
  | { kind: "edit"; suggestion_id: string; final_text: string }
  | { kind: "reject"; suggestion_id: string }
  | { kind: "direct_edit"; before: string; after: string };

// Phase D: InterviewInput は InterviewInputBundle に統一(/api/interview の API 境界と
// provider 境界で同形)。AnalyzeInput と対称な構造。
export type InterviewInput = InterviewInputBundle;

// プロバイダ共通インタフェース。
// Phase C: analyze は AnalyzeInputBundle を直接受ける(mode は bundle.mode に内包)。
// 引数の mode は呼び出し側の意図表明として残すが、AnalyzeInputBundle.mode と一致しなければエラー。
export interface LLMProvider {
  readonly name: "anthropic" | "openai" | "google";
  researchCompany(input: ResearchInputSource): Promise<CompanySummary>;
  analyze(input: AnalyzeInput, mode: AnalyzeMode): Promise<AnalysisResult>;
  generateInterview(input: InterviewInput): Promise<InterviewQuestions>;
}

// LLM レイヤーのエラー型。/api/* で HTTP ステータスにマッピング
export class LLMError extends Error {
  constructor(
    public readonly kind:
      | "schema_validation"
      | "api_error"
      | "rate_limit"
      | "timeout"
      | "not_implemented"
      | "agent_no_submission" // エージェントが submit_summary を呼ばずに end_turn
      | "agent_max_iterations" // 反復上限到達
      | "analysis_validation" // Phase C: analyze 出力が validateAnalysisAgainstInput を通過しない
      | "unknown",
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LLMError";
  }
}
