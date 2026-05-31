// Phase C: initial モードのユーザーメッセージ構築。
// セクション順:[ES本体] / [設問] / [企業要約] / [添削条件] / [ユーザー文脈] / [承認済み evidence]
//
// 承認済み evidence セクションは Phase B-2 セッション4 で /api/research に確立した
// 「承認済み URL リストの動的注入」と完全に対称な防衛機構(Phase C 防衛三段の Part 2)。
//
// 動的注入セクションは user メッセージ側に置く。system / fewshot は完全静的でキャッシュ対象。

import type { AnalyzeInputBundle } from "../schema/input";
import type { CompanySummary, Evidence } from "../schema/company";
import { renderQuestionBlock } from "./question_block";

// 承認済み evidence のテキスト表現(LLM に渡す user メッセージ末尾セクション用)
function renderApprovedEvidenceBlock(summary: CompanySummary | undefined): string {
  if (!summary || summary.evidence.length === 0) {
    return [
      "[承認済み evidence]",
      "(なし — 企業要約に evidence が含まれません。rationale_source.evidence_id は出力しないでください)",
    ].join("\n");
  }
  const lines: string[] = ["[承認済み evidence]"];
  lines.push(
    "rationale_source.type === \"company_value\" を出すときは、以下のリストの ID のみを evidence_id に使用してください。リスト外の ID を使うとサーバ側で拒否されます。",
    "",
  );
  for (const ev of summary.evidence) {
    lines.push(renderEvidenceLine(ev));
  }
  return lines.join("\n");
}

function renderEvidenceLine(ev: Evidence): string {
  // claim は LLM が原文から整理した1文。snippet として 80 字に丸めて視認性を確保
  const claimSnippet = ev.claim.length > 80 ? ev.claim.slice(0, 80) + "…" : ev.claim;
  return `- ${ev.id} [${ev.category}] ${ev.source_url} — ${claimSnippet}`;
}

function renderCompanySummaryBlock(summary: CompanySummary | undefined): string {
  if (!summary) {
    return [
      "[企業要約]",
      "(企業URLが未指定のため、企業要約はありません。company_value 系の根拠は使用できません)",
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

function renderEditConditionsBlock(input: AnalyzeInputBundle): string {
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

// dogfood round 3 ⑦ (2026-05-28): 上限超過時のみ注入する「削減優先ブロック」。
//
// 背景: 初回分析の static system.ts / few-shot は char_limit を「設問の上限」として渡すだけで、
// 「ES が上限を超過している事実」も「超過時は削減を優先せよ」という指示も持たない。よって
// 初回提案に結論先出し等の **長さを増やす** 提案が混じり、全採用しても上限を超過する
// (es5 dogfood 観察)。削減ロジックは refresh.ts の reduce_length モードにしか無かった。
//
// 設計判断(B、load-bearing 慎重):
//  - **動的注入**で実現する。static system.ts / fewshot は触らない(prompt cache prefix を維持)。
//    承認済み evidence / 承認済み URL と同じ「user メッセージへの条件付き注入」パターン。
//  - 文言は refresh.ts:renderReduceLengthInstructions の精神を初回用に流用するが、初回分析の
//    本来の質評価(三層構造・12 類型・企業接合)は維持する。「削減**だけ**しろ」ではなく
//    「削減を**優先**しつつ質も見る」バランス(refresh の削減モードは「採用済を覆さず新規に
//    削る提案を足す」専用文脈なので、初回には初回固有の表現に直す)。
//  - 新規 required field の追加ではなく user メッセージへの条件付き指示注入のため、few-shot
//    example の suggestion 構造(必須フィールド)は変わらず、fewshot.ts 変更は不要
//    (AGENTS.md「Load-bearing few-shot structure」確認済 — DECISIONS ⑦ 実装結果に根拠)。
function renderOverLimitReductionBlock(args: {
  esLength: number;
  charLimit: number;
}): string {
  const overBy = Math.max(0, args.esLength - args.charLimit);
  return `[文字数の制約 — 重要]

この ES は現在 ${args.esLength} 字で、設問の上限 ${args.charLimit} 字を ${overBy} 字超過しています。

- 提案は**全体として上限に近づける方向**で出してください。個々の提案を採用していくと、最終的な ES が上限に収まる(または上限超過が大きく緩和される)ことを目指します。
- \`structural\` の \`delete_paragraph\` / \`merge_paragraphs\`(重複・冗長な段落の削除 / 統合)や、冗長な記述・装飾過多の短縮を**優先**してください。字数削減の効率が高い手段です。
  - ただし \`delete_paragraph\` / \`merge_paragraphs\` を出すときは \`lost_content\` で「削除 / 統合で失う情報」を必ず明示し、ユーザーが採用判断できるようにしてください。
- **長さを net で増やす提案(冗長な追記・既出情報の繰り返し・結論の重複先出し等)は避けてください**。書き換え系の提案でも \`proposed\` は原則 \`original\` と同程度かより短くしてください。
- ただし**削減だけが目的ではありません**。初回分析の本来の観点(三層構造・経験の具体性・企業との接合など)による質の指摘は維持してください。質を保ちながら、同時に上限に収める方向に寄せる、という両立を意識してください。
- 数値・固有名詞(企業名・製品名・人名)、主述構造、書き手の個性は削らないでください。`;
}

// initial モードの user メッセージ全体を構築する。
// セクション順は冒頭コメントを参照(load-bearing: system プロンプトの「入力フォーマット」と一致)。
// Phase G 再修正 (2026-05-24): 副次的な候補プール構造を撤去し、末尾の追加指示も削除。
// dogfood round 3 ⑦ (2026-05-28): es_body.length > char_limit の時のみ、[設問] の直後に
//   削減優先ブロックを動的注入(LLM が注目しやすい冒頭寄り)。非超過時は従来どおり注入しない。
export function buildInitialUserMessage(input: AnalyzeInputBundle): string {
  // 2026-05-29 char_limit 任意化: char_limit が未指定なら超過判定は成立しない
  // (制限が無いので「超過」が定義できない)。typeof number でガードして、
  // 制限がある場合のみ削減優先ブロックを注入する(従来挙動を完全維持)。
  const charLimit = input.question.char_limit;
  const isOverLimit =
    typeof charLimit === "number" && input.es_body.length > charLimit;
  const sections = [
    `[ES本体]\n${input.es_body}`,
    renderQuestionBlock(input.question.text, charLimit),
    ...(isOverLimit
      ? [
          renderOverLimitReductionBlock({
            esLength: input.es_body.length,
            charLimit,
          }),
        ]
      : []),
    renderCompanySummaryBlock(input.company_summary),
    renderEditConditionsBlock(input),
    renderUserContextBlock(input.user_context),
    renderApprovedEvidenceBlock(input.company_summary),
  ];
  return sections.join("\n\n");
}
