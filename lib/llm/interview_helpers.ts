import {
  AIInterviewOutputSchema,
  type AIInterviewOutput,
} from "../schema/analysis";
import type { InterviewInputBundle } from "../schema/input";

// Phase D: /api/interview の防衛三段 Part 3(軽量版)。
// lib/prompts/interview.ts から検証ルールを導出。
// analyze_helpers より軽い(出力スキーマが questions 配列だけに絞られているため)。
//
// 検証ルール:
//   1. questions.length が 3 以上 5 以下(Zod でも弾けるが、AI に教えるため別途検出)
//   2. 各 question.id がユニーク
//   3. 数値スコア混入(question 本文中に「85点」「★3」等)
//
// 「企業価値観に言及しているか」の自動検出は当面入れない。
//   - 価値観キーワードの正規表現マッチは false positive / negative が多い
//   - 「Think Deep」を完全一致で求めると言い換え(「データ駆動の判断」等)を不当に弾く
//   - Phase D セッション6 スコープ: 目視確認(tests/interview.test.ts)で十分

export type InterviewValidationIssue =
  | {
      kind: "schema_format";
      message: string;
      issues: Array<{ path: string; code: string; message: string }>;
    }
  | {
      kind: "questions_count";
      count: number;
    }
  | {
      kind: "duplicate_question_id";
      duplicateIds: string[];
    }
  | {
      kind: "numeric_score_in_question";
      questionId: string;
      matched: string;
    };

// 数値スコア検出パターン(analyze_helpers と同じセット)
const NUMERIC_SCORE_PATTERNS: RegExp[] = [
  /\d+\s*点/,
  /[★☆]\s*\d/,
  /\b[A-D][+\-]?\s*評価/,
  /\b\d+\s*\/\s*10\b/,
  /\b\d+\s*\/\s*100\b/,
];

export function validateInterviewOutput(
  rawOutput: unknown,
  _input: InterviewInputBundle,
):
  | { ok: true; data: AIInterviewOutput; issues: [] }
  | { ok: false; issues: InterviewValidationIssue[] } {
  // Stage 1: Zod 構造検証
  const parsed = AIInterviewOutputSchema.safeParse(rawOutput);
  if (!parsed.success) {
    return {
      ok: false,
      issues: [
        {
          kind: "schema_format",
          message: parsed.error.message,
          issues: parsed.error.issues.slice(0, 12).map((i) => ({
            path: i.path.join(".") || "(root)",
            code: i.code,
            message: i.message,
          })),
        },
      ],
    };
  }

  const data = parsed.data;
  const issues: InterviewValidationIssue[] = [];

  // Stage 2.1: questions 件数(Zod min(3)/max(5) でも弾けるが二重検出)
  const count = data.questions.length;
  if (count < 3 || count > 5) {
    issues.push({ kind: "questions_count", count });
  }

  // Stage 2.2: question.id のユニーク性
  const idSeen = new Map<string, number>();
  for (const q of data.questions) {
    idSeen.set(q.id, (idSeen.get(q.id) ?? 0) + 1);
  }
  const duplicateIds: string[] = [];
  for (const [id, n] of idSeen.entries()) {
    if (n >= 2) duplicateIds.push(id);
  }
  if (duplicateIds.length > 0) {
    issues.push({ kind: "duplicate_question_id", duplicateIds });
  }

  // Stage 2.3: 数値スコア混入(question 本文に対して走査)
  for (const q of data.questions) {
    for (const pattern of NUMERIC_SCORE_PATTERNS) {
      const m = q.question.match(pattern);
      if (m) {
        issues.push({
          kind: "numeric_score_in_question",
          questionId: q.id,
          matched: m[0],
        });
        break; // この question に対しては1件で十分
      }
    }
  }

  if (issues.length === 0) {
    return { ok: true, data, issues: [] };
  }
  return { ok: false, issues };
}

// リトライメッセージ(1回だけ修正依頼)。
// buildAnalysisRetryMessage と同じ精神。違反項目を列挙し、修正を促す。
export function buildInterviewRetryMessage(
  issues: InterviewValidationIssue[],
): string {
  const lines: string[] = [
    "前回の generate_interview_questions 出力に以下の問題がありました。修正して generate_interview_questions ツールを再度呼んでください。",
    "",
  ];

  let n = 1;
  for (const issue of issues) {
    switch (issue.kind) {
      case "schema_format":
        lines.push(`${n}. スキーマ違反: ${issue.message}`);
        for (const i of issue.issues.slice(0, 6)) {
          lines.push(`   - ${i.path}: ${i.message}`);
        }
        break;
      case "questions_count":
        lines.push(
          `${n}. questions.length = ${issue.count}(必須範囲3〜5)。3〜5問に収まるよう調整してください。`,
        );
        break;
      case "duplicate_question_id":
        lines.push(
          `${n}. question.id の重複: ${issue.duplicateIds.join(", ")}。各 id は配列内でユニークにしてください(例: iq_001, iq_002, iq_003)。`,
        );
        break;
      case "numeric_score_in_question":
        lines.push(
          `${n}. question[${issue.questionId}] に数値スコアらしき表現 "${issue.matched}" が含まれています。質問文に「N点」「★N」等の数値スコア表現は使わないでください。`,
        );
        break;
    }
    n++;
  }

  lines.push(
    "",
    "それ以外の質問は維持して構いません。",
    "これはリトライの最後のチャンスです。同じ理由で再度失敗すると 502 で終了します。",
  );

  return lines.join("\n");
}
