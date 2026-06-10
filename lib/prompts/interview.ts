// Phase D: /api/interview の user メッセージ構築。
//
// 重要な設計判断:
//  - 独立エンドポイント /api/interview の専用 user メッセージ
//  - system は Phase C の system.ts をそのまま再利用(キャッシュ共有)
//  - few-shot prefix も refresh と同じく initial と同じものを共有する想定
//    (provider 側で組み立て)
//  - generated_at_es_version / is_stale はサーバ側で付与するため、LLM への
//    指示でも「これらは出力しない」と明示する

import type {
  AcceptedSuggestionSummary,
  InterviewInputBundle,
} from "../schema/input";
import type { CompanySummary, Evidence } from "../schema/company";
import { renderQuestionBlock } from "./question_block";

// マーカー + 重要指示セクション(静的)。docs Section 2 を改行込みで埋め込む。
const INTERVIEW_HEADER_AND_INSTRUCTIONS = `[これは面接質問更新要求です]

書き手が「面接質問を更新」ボタンを押しました。現在のES状態と採用された指摘の方向性を踏まえ、新しい面接質問を生成してください。

# 重要な指示

- **suggestions、overall_assessment は今回は出力しないでください**。面接質問のみが対象です(ツール generate_interview_questions には questions プロパティしか存在しません)
- 面接質問は3〜5問
- ES内の弱点(深掘りされそうな箇所)を狙う
- 企業要約があれば、企業価値観との接続を問う質問を1問は含める
- 採用された指摘の方向性が分かれば、それと整合する質問を作る
  - 例: 「具体的数値の追加」を多数採用 → その数値の妥当性や算出根拠を問う質問
  - 例: 「規模感の明示」を採用 → 規模を活かす場面の問い
- 既出の面接質問と重複しないこと(前回の質問は few-shot に出ているものを含む)
- generated_at_es_version / is_stale は出力しないでください(サーバ側で付与します)`;

// 採用された指摘のサマリを docs Section 3 のフォーマットに整形する。
// LLM が「方向性」を読み取れるように、direction を必ず明示する。
export function formatAcceptedSummary(items: AcceptedSuggestionSummary[]): string {
  if (items.length === 0) {
    // 初回直後で何も採用されていないケース。LLM は ES 弱点中心で質問を生成する。
    return "(採用された指摘はまだありません。ES内の弱点を中心に質問を組み立ててください)";
  }
  return items.map((it) => `- ${it.suggestion_id}: ${it.direction}`).join("\n");
}

function renderAcceptedSummaryBlock(items: AcceptedSuggestionSummary[]): string {
  return ["[採用された指摘のサマリ]", formatAcceptedSummary(items)].join("\n");
}

function renderCurrentEsBlock(esBody: string, currentVersion: number): string {
  return [`[現在のES状態 v${currentVersion}]`, esBody].join("\n");
}

function renderCompanySummaryBlock(summary: CompanySummary | undefined): string {
  if (!summary) {
    return [
      "[企業要約]",
      "(企業URLが未指定のため、企業要約はありません。企業価値観との接続を問う質問は省略してください)",
    ].join("\n");
  }
  const lines: string[] = [
    "[企業要約]",
    `企業名: ${summary.company_name}`,
    `事業概要: ${summary.business_summary}`,
  ];
  if (summary.values.length > 0) {
    lines.push(`価値観: ${summary.values.join(", ")}`);
  }
  if (summary.ideal_candidate) {
    lines.push(`求める人物像: ${summary.ideal_candidate}`);
  }
  if (summary.hiring_criteria.length > 0) {
    lines.push(`採用基準: ${summary.hiring_criteria.join(" / ")}`);
  }
  return lines.join("\n");
}

function renderEditConditionsBlock(input: InterviewInputBundle): string {
  const free = input.edit_conditions.free_text.trim();
  return [
    "[添削条件]",
    `プリセット: ${input.edit_conditions.preset}`,
    `自由入力: ${free.length === 0 ? "(なし)" : free}`,
  ].join("\n");
}

function renderUserContextBlock(userContext: string): string {
  const trimmed = userContext.trim();
  return ["[ユーザー文脈]", trimmed.length === 0 ? "(なし)" : trimmed].join("\n");
}

// 面接モードでは rationale_source の検証は無いが、企業要約の evidence を LLM の文脈に
// 残すことで「Think Deep への接続」のような具体的な質問が立てやすくなる。
// initial と同じ render を流用しつつ、ヘッダの文言だけ面接質問向けにする。
function renderEvidenceBlock(summary: CompanySummary | undefined): string {
  if (!summary || summary.evidence.length === 0) {
    return [
      "[企業要約 evidence]",
      "(なし — 企業要約に evidence が含まれません。企業価値観への接続を問う質問は省略可)",
    ].join("\n");
  }
  const lines: string[] = ["[企業要約 evidence]"];
  lines.push(
    "以下の evidence を参照し、価値観との接続を問う面接質問を1問以上含めることが望ましい。",
    "",
  );
  for (const ev of summary.evidence) {
    lines.push(renderEvidenceLine(ev));
  }
  return lines.join("\n");
}

function renderEvidenceLine(ev: Evidence): string {
  const claimSnippet = ev.claim.length > 80 ? ev.claim.slice(0, 80) + "…" : ev.claim;
  return `- ${ev.id} [${ev.category}] ${ev.source_url} — ${claimSnippet}`;
}

// /api/interview の user メッセージ全体を構築する。
// セクション順:
//   1. [これは面接質問更新要求です] + 重要な指示
//   2. [現在のES状態 vN]
//   3. [採用された指摘のサマリ]
//   4. [設問] / [企業要約] / [企業要約 evidence] / [添削条件] / [ユーザー文脈]
export function buildInterviewUserMessage(input: InterviewInputBundle): string {
  const sections = [
    INTERVIEW_HEADER_AND_INSTRUCTIONS,
    renderCurrentEsBlock(input.es_body, input.current_es_version),
    renderAcceptedSummaryBlock(input.accepted_suggestions_summary),
    renderQuestionBlock(input.question.text, input.question.char_limit),
    renderCompanySummaryBlock(input.company_summary),
    renderEvidenceBlock(input.company_summary),
    renderEditConditionsBlock(input),
    renderUserContextBlock(input.user_context),
  ];
  return sections.join("\n\n");
}
