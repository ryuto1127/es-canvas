// Phase G Step 3b-2 (2026-05-23): partial update モードのユーザーメッセージ構築。
// 統合改修パッケージ訂正 (2026-05-25): 構造的な影響範囲計算を撤去し、AI 判断方式に変更。
//
// 設計判断:
//  - 既存 system プロンプト(system.ts:ANALYZE_SYSTEM_PROMPT)を流用、partial 専用は
//    user メッセージ側で表現(キャッシュ境界を共有するため)
//  - **prompt cache 戦略**: user メッセージ内に **不変ブロック**(初回 assessment +
//    existing suggestions 静的サマリ)と **可変ブロック**(派生 ES + action_history +
//    動的状態)を分離。不変ブロックに cache_control を立てる。本 module は文字列
//    レベルでブロックを返すだけで、cache_control の付与は provider 側(anthropic.ts)で行う。
//  - refresh.ts のセクション renderer (renderActionHistoryBlock, renderCompanySummaryBlock 等)
//    は再利用したいが、partial 専用の指示と初回引き継ぎブロックは別関数として独立。
//  - interview_questions / es_state_version / refresh_only と同じく出力させない指示を明示。
//  - 影響範囲は LLM 自身に意味的に判断させる(従来の構造計算 `refresh_scope.ts:computeRefreshScope`
//    は撤去)。サーバから渡すのは「直近で拒否/編集された seed id」と「編集前後テキスト」のみ。

import type {
  ActionHistoryEntry,
  AnalyzeInputBundlePartial,
} from "../schema/input";
import type { CompanySummary, Evidence } from "../schema/company";
import type { Suggestion } from "../schema/suggestion";
import type { OverallAssessment } from "../schema/analysis";
import { CLARIFICATION_ENRICHED_INTENT_HEADER } from "../schema/clarification";
import { renderQuestionBlock } from "./question_block";

// 不変ブロックヘッダ(LLM に「partial update を行う」ことを最初に明示)
// Phase G 再修正 (2026-05-24): updated / deleted を主軸、added は副次的、最大 1 件)に書き換え。
// 統合改修パッケージ訂正 (2026-05-25): 構造計算による影響範囲指定を撤去し、
// 「AI 自身が意味的に影響範囲を判断する」方式に変更(数値根拠が無い経験的閾値の廃止)。
const PARTIAL_HEADER_AND_INSTRUCTIONS = `[これは partial update 要求です]

ユーザーが前回の指摘に対して以下の操作を行いました。現在の派生 ES に対して、評価が変わった分だけを差分で返してください。

# 重要な指示(構造的な前提)

- **interview_questions は今回も出力しないでください**(ツール analyze_es_partial_refresh には interview_questions プロパティが存在しません)
- **es_state_version は出力しないでください**(サーバ側で付与します)

# 主軸は updated / deleted(既存 suggestion の maintenance)

本ツールの本質的な仕事は、ユーザー操作で陳腐化した既存 suggestions の修正・削除です。added は副次的で、本当に新規問題が生じた時のみ 1 件追加します。

## 出力規律

- **updated**: 以下のいずれかに該当する既存 suggestion を最新本文に合わせて調整
  - ユーザーが ES を編集して original の文字列が変わった(本文内に既存 original が見つからない / 周辺の文脈が変わった)
  - ユーザーが採用 / 編集 / 却下した別 suggestion の影響で、この suggestion の rationale が時代遅れになった
  - 採用された変更により、proposed が現状の本文と整合しなくなった

- **deleted**: 以下のいずれかに該当する既存 suggestion を削除
  - 採用 / 編集により original が ES 本文から消えた
  - 別 suggestion が同じ問題を解決したため陳腐化した
  - ES の文脈変化により、指摘自体が無意味になった

- **added(副次的、最大 1 件)**: 以下の条件を全て満たす時のみ 1 件追加
  - ユーザー操作によって新たな問題が生じている(採用した変更が別の場所に矛盾を生んだ等)
  - その問題は既存 suggestion の updated では表現できない別軸の問題
  - 「埋めるための追加」「気を利かせた追加」は禁止
  - 該当する新規問題が無ければ \`added: []\` を返すこと

## 順序の規律

1. まず updated / deleted を全件レビュー
2. その後で added を検討
3. added は 0 件または 1 件

# その他の規律

- 既存採用済 / 編集済 / 却下済の suggestion は **\`updated\` / \`deleted\` に含めてはいけない**(ユーザーの判断を尊重、後述のリストで明示)
- error カテゴリは出力しない(自動修正経路、ここでは扱わない)
- 各 suggestion(updated / added)に \`internal_priority: 1-10\` を付与(重要度、UI には数値として表示されません)
  - 1 = 軽微(語尾の調整、語感のバリエーション)
  - 5 = 標準(冗長表現の改善、構造補強)
  - 10 = 最重要(企業価値観との直接接続、説得力に直結する改善)
- 全体合計(\`updated.length + added.length\`)が 15 件を超えないこと(added は 1 以下なので updated.length が 14 以下なら自動的に成立)
- \`updated[i].category\` は元の category と一致させること(error/convention/alternative の category 変更は禁止)
- \`updated[i].original\` は現在の派生 ES 本体に完全一致する文字列にすること(元の original_span から大きくズレないこと)

# 初回評価軸の踏襲

以下は初回分析の \`overall_assessment\` です。**この評価軸を踏襲して** partial update を行ってください。書き手の個性(preserved_voice_note)と整合する提案を維持してください。`;

// 統合改修パッケージ訂正 (2026-05-25): 影響範囲を「AI 判断方式」で扱う指示セクション。
//
// 設計判断:
//  - 従来は `focus_target_ids` / `focus_es_excerpt` を `refresh_scope.ts:computeRefreshScope`
//    で「related の再帰深さ 2」「物理近接 ±60 文字」と数値計算していたが、深さ・近接量の
//    数値根拠が実測で出せず経験的だった。
//  - 統合改修パッケージ訂正 (2026-05-25) のユーザー対話で、LLM 自身に意味的判断を任せる
//    方針に変更。サーバから渡すのは「直近で拒否/編集された seed id 群」と「編集前後のテキスト」
//    のみで、影響を受けるかどうかの判断は LLM の意味理解に任せる。
//  - 件数上限は設けない(HITL の本質を保つ、AI の判断を狭めない)
//  - 過剰な再評価の抑制は prompt 文言で実現(「ユーザーの操作の影響を受ける指摘 だけ」
//    を強調、「AI 主導の『全部見直し』をしない」を明示)。
//  - サーバ側の検証(analyze_helpers.ts:validateAnalysisAgainstInput の partial 検証)は
//    既存通り(ユーザー操作済の id を updated/deleted に含めない等)。
//  - 影響を受ける例 / 受けない例 を文中で示し、LLM の判断ガイドにする(few-shot 的)。
function renderFocusInstructionsBlock(args: {
  seedIds: ReadonlyArray<string>;
  seedActionType:
    | "reject"
    | "edit"
    | "direct_edit"
    | "undo"
    | "redo"
    | "manual";
  editBefore: string | undefined;
  editAfter: string | undefined;
}): string {
  const lines: string[] = ["[影響範囲の判断(AI 主導)]"];

  // ユーザー操作の起点を明示
  const actionLabel = renderActionTypeLabel(args.seedActionType);
  lines.push(`今回のトリガー: ${actionLabel}`);

  if (args.seedIds.length > 0) {
    lines.push(`直接起点となった指摘 id: ${args.seedIds.join(", ")}`);
  } else {
    lines.push(
      "直接起点となった指摘はありません(直接編集 / Undo / Redo / 再分析の経路)。",
    );
  }

  // 編集の前後テキスト(edit / direct_edit のみ)
  if (
    (args.seedActionType === "edit" || args.seedActionType === "direct_edit") &&
    (args.editBefore !== undefined || args.editAfter !== undefined)
  ) {
    lines.push("", "[編集差分]");
    if (args.editBefore !== undefined) {
      lines.push(`編集前: ${args.editBefore}`);
    }
    if (args.editAfter !== undefined) {
      lines.push(`編集後: ${args.editAfter}`);
    }
  }

  // AI への指示本体
  lines.push(
    "",
    "## 影響範囲の判断規律",
    "- **ユーザーの操作の影響を受ける指摘 だけ** を再評価してください。",
    "- 影響を受けない指摘は updated / deleted / added に含めないでください(サーバ側で前回値が温存されます)。",
    "- AI 主導の『全体見直し』をしないでください。今回のユーザー操作の影響範囲に絞ることが重要です。",
    "- 件数の上限は設けませんが、**本当に影響を受ける指摘だけに絞ってください**(過剰な再評価をしない)。",
    "",
    "## 影響を「受ける」例(updated / deleted の対象に含めて良い)",
    "- 同じ ES 領域や周辺の文を指摘していた他の suggestion",
    "- ユーザーが拒否/編集した指摘と論理依存があり、その判断によって他の指摘の rationale が陳腐化したもの",
    "- 編集の前後で proposed が ES 本文の現状と整合しなくなった指摘",
    "",
    "## 影響を「受けない」例(updated / deleted の対象に含めない)",
    "- ユーザー操作と無関係な ES 領域に対する指摘",
    "- 論理依存が無く、操作の前後で評価が変わらない指摘",
    "- 別観点(語感 vs 構造 vs 企業価値接続 等)で独立している指摘",
    "",
    "ES 本文と全 suggestions は別ブロックで提供されています。影響範囲の判断材料として使ってください。",
  );

  return lines.join("\n");
}

// =============================================================================
// 2026-05-28 dogfood: 逆質問の回答が存在する再分析での「回答取り込み」専用指示。
// =============================================================================
//
// 背景(root cause):
//  - 逆質問の回答は buildClarificationEnrichedIntent(store)で `[逆質問への回答]` ブロックに
//    まとめられ、appendClarificationToUserContext で user_context 末尾に append される。
//    partial 経路では user_context は renderUserContextBlock([ユーザー文脈])として
//    低優先の文脈ブロックに置かれるだけで、専用の取り込み指示が無かった。
//  - 一方 PARTIAL_HEADER_AND_INSTRUCTIONS / renderFocusInstructionsBlock は「主軸は
//    updated/deleted の maintenance」「added は副次的、新規問題が無ければ added: []」
//    「ユーザー操作の影響を受ける指摘だけ再評価、全体見直しをしない」という枠組みを
//    強く張っている。回答が付いていた suggestion が却下済(= updated 対象の既存提案が無い)
//    だと、AI は「評価が変わる既存指摘は無い」と正しく結論して updated/added/deleted 全空
//    (=「変更なし」)を返してしまう。逆質問は本プロダクトの目玉機能のため、
//    「答えても何も起きない」は致命的。
//
// 修正方針:
//  - user_context に `[逆質問への回答]` ヘッダが含まれる時 **だけ** 本ブロックを注入する
//    (回答が無い通常 partial は完全に不変)。
//  - 「回答を使って ES 該当箇所を改善する提案を必ず 1 件以上出す。該当する既存提案が
//    あれば updated、無ければ added。全空で返してはならない」を明示し、
//    上の「added は副次的 / added: []」枠組みを **回答がある時に限って** 上書きする。
//  - 捏造防止は維持: 「回答に書かれた事実のみを使う、回答に無い具体値・固有名詞・数値を
//    創作しない」を明記(防衛三段と整合)。
//  - seed は変更しない(triggerReanalysisWithClarifications は seedIds: [] のまま)。
//    本ブロックで「回答が指す ES 箇所を AI が意味的に特定して改善する」よう指示し、
//    回答取り込みは prompt 指示のみで担保する(seed 配線変更は全 clarification フローの
//    挙動を変え、通常 partial 非干渉の保証を複雑にするため不採用)。
const CLARIFICATION_ANSWER_INSTRUCTIONS = `[逆質問の回答あり — 回答を取り込んだ提案を必ず出す]

ユーザーが AI の逆質問に回答しました(回答本文は後述の [ユーザー文脈] 内「${CLARIFICATION_ENRICHED_INTENT_HEADER}」ブロックに Q/A 形式で記載)。これは「この回答で再分析」要求です。今回はこの回答を ES に活かすことが最優先タスクです。

## 必須(この再分析でのみ適用、回答に対する応答義務)

- 回答内容を使って ES の該当箇所を改善する提案を **必ず 1 件以上** 出してください。
  - 回答が指す ES 箇所をカバーする既存 suggestion があれば、その suggestion を \`updated\` で回答内容を反映した \`proposed\` / \`rationale\` に更新してください。
  - カバーする既存 suggestion が無ければ(例: 回答が付いていた指摘を既にユーザーが却下済 / 採用済の場合)、回答内容を反映した提案を \`added\` で **新規追加** してください。
- **回答があるのに \`updated\` / \`added\` / \`deleted\` をすべて空(=「変更なし」)で返すことは禁止です。** 「影響を受ける既存指摘が無い」を理由に空で返さず、回答を起点に \`added\` を 1 件作ってください。
- この回答取り込みの \`added\` は、上記「added は副次的・最大 1 件・新規問題が無ければ added: []」の通常規律の **例外** です(回答への応答は「埋めるための追加」ではなく、ユーザーが明示的に提供した新情報の反映)。ただし回答取り込みで増やす \`added\` も最小限(原則 1 件、多くても回答で扱う論点ごとに 1 件)に留めてください。

## 捏造防止(回答取り込みでも厳守)

- 提案には **回答に実際に書かれた事実のみ** を使ってください。回答に書かれていない具体値・数値・固有名詞・エピソードを創作して \`proposed\` に入れてはいけません。
- 回答が抽象的で具体化できない場合は、回答の趣旨に沿って ES 本文を整える範囲に留め、無理に具体を捏造しないでください。
- \`rationale\` には「ユーザーの回答(○○)を反映して」と、回答を根拠にしたことが分かる説明を書いてください。

## 回答が指す箇所の特定

- suggestion-bound の回答(Q の見出しが \`sug_XXX\`)は、その suggestion が指していた ES 領域の改善に使ってください。
- global の回答(Q の見出しが「全体」)は、ES 全体 / 結末 / 企業接続など回答が示す論点の該当箇所に使ってください。`;

// user_context 内に逆質問の回答ブロックが含まれるか(= 「この回答で再分析」フロー)を検知。
// producer(buildClarificationEnrichedIntent)が付与する SSOT ヘッダの有無で判定する。
function hasClarificationAnswers(input: AnalyzeInputBundlePartial): boolean {
  return input.user_context.includes(CLARIFICATION_ENRICHED_INTENT_HEADER);
}

// seed_action_type を日本語ラベルに変換(prompt 内表示用)
function renderActionTypeLabel(
  actionType:
    | "reject"
    | "edit"
    | "direct_edit"
    | "undo"
    | "redo"
    | "manual",
): string {
  switch (actionType) {
    case "reject":
      return "ユーザーが指摘を拒否しました";
    case "edit":
      return "ユーザーが指摘を編集して採用しました";
    case "direct_edit":
      return "ユーザーが ES 本文を直接編集しました";
    case "undo":
      return "ユーザーが直前の操作を取り消しました(Undo)";
    case "redo":
      return "ユーザーが取り消した操作を再適用しました(Redo)";
    case "manual":
      return "ユーザーが手動で再分析を要求しました";
  }
}

// 不変ブロック末尾の自己チェックリスト(refresh.ts の REFRESH_SELF_CHECK_LIST と同精神)
// Phase G 再修正 (2026-05-24): Sonnet 主軸版に再構成(updated / deleted を先にレビューする
// 順序、added は新規問題が無ければ空配列を選ぶ規律を明示)。
const PARTIAL_SELF_CHECK_LIST = `出力前の最終確認:
1. updated / deleted のレビューを先に行ったか
2. added が 0 件または 1 件か(複数件は禁止)
3. added を出した場合、それは updated では表現できない新規問題か
4. ユーザーが採用 / 編集 / 却下した id を updated / deleted に含めていないか
5. updated + added の合計が 15 件を超えていないか / error カテゴリを出していないか
6. 各 suggestion(updated / added)に internal_priority が付与されているか`;

// Opus 評価軸を渡す不変ブロック
function renderOpusAssessmentBlock(assessment: OverallAssessment): string {
  const lines: string[] = [
    "[初回評価軸(これを踏襲して partial update を行うこと)]",
    `要約: ${assessment.summary}`,
  ];
  if (assessment.strengths.length > 0) {
    lines.push(`強み: ${assessment.strengths.join(" / ")}`);
  }
  if (assessment.weaknesses.length > 0) {
    lines.push(`改善余地: ${assessment.weaknesses.join(" / ")}`);
  }
  lines.push(`保たれた個性: ${assessment.preserved_voice_note}`);
  return lines.join("\n");
}

// 既存 suggestions の不変サマリ(各 suggestion を 1 行サマリで提示、id + category + original 冒頭)。
// 「採用済 / 編集済 / 却下済」status を明示することで LLM が触ってはいけない id を認知できる。
function renderExistingSuggestionsBlock(
  existing: ReadonlyArray<Suggestion>,
  acceptedIds: ReadonlyArray<string>,
  rejectedIds: ReadonlyArray<string>,
  editedIds: ReadonlyArray<string>,
): string {
  if (existing.length === 0) {
    return [
      "[既存 suggestions(参照用)]",
      "(なし — partial update でも既存に依らず追加生成可能)",
    ].join("\n");
  }
  const lines: string[] = [
    "[既存 suggestions(参照用、id + category + original 冒頭)]",
    "「採用済 / 編集済 / 却下済」とマークされた id は updated / deleted に含めないでください(ユーザー判断を尊重)。",
    "",
  ];
  const acceptedSet = new Set(acceptedIds);
  const rejectedSet = new Set(rejectedIds);
  const editedSet = new Set(editedIds);
  for (const s of existing) {
    const status =
      editedSet.has(s.id)
        ? "[編集済]"
        : acceptedSet.has(s.id)
          ? "[採用済]"
          : rejectedSet.has(s.id)
            ? "[却下済]"
            : "[未対応]";
    const snippet =
      s.original.length > 40 ? s.original.slice(0, 40) + "…" : s.original;
    lines.push(`- ${s.id} [${s.category}] ${status} 「${snippet}」`);
  }
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// 可変ブロック群(action_history / 派生 ES / 添削条件 等)。refresh.ts の renderer
// と同じ形式だが、partial 専用の文言調整あり。
// -----------------------------------------------------------------------------

// action_history を docs Section 3 のフォーマットに変換(refresh.ts と同一の formatActionHistory)
function formatActionHistory(entries: ReadonlyArray<ActionHistoryEntry>): string {
  if (entries.length === 0) {
    return "(操作履歴なし)";
  }
  return entries
    .map((entry) => {
      if (entry.verb === "DIRECT_EDIT") {
        return `- DIRECT_EDIT: ${entry.description}`;
      }
      if (entry.verb === "EDITED") {
        return `- ${entry.suggestion_id} 「${entry.suggestion_summary}」: EDITED → "${entry.edited_text}"`;
      }
      return `- ${entry.suggestion_id} 「${entry.suggestion_summary}」: ${entry.verb}`;
    })
    .join("\n");
}

function renderActionHistoryBlock(
  entries: ReadonlyArray<ActionHistoryEntry>,
): string {
  return ["[ユーザー操作履歴(直近)]", formatActionHistory(entries)].join("\n");
}

function renderCurrentEsBlock(esBody: string, newVersion: number): string {
  return [`[現在の派生 ES v${newVersion}]`, esBody].join("\n");
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

function renderEditConditionsBlock(input: AnalyzeInputBundlePartial): string {
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
  const claimSnippet = ev.claim.length > 80 ? ev.claim.slice(0, 80) + "…" : ev.claim;
  return `- ${ev.id} [${ev.category}] ${ev.source_url} — ${claimSnippet}`;
}

// =============================================================================
// 公開エクスポート
// =============================================================================

// partial 用 user メッセージのうち、**不変ブロック**(session 内で変わらない部分)。
// Opus 評価軸 + 既存 suggestions サマリ + 静的指示(冒頭ヘッダ + 末尾チェックリスト)。
// この戻り値文字列は anthropic.ts:analyzePartialStream で cache_control を立てて
// ephemeral cache する対象になる。
export function buildPartialInvariantBlock(input: AnalyzeInputBundlePartial): string {
  const sections = [
    PARTIAL_HEADER_AND_INSTRUCTIONS,
    renderOpusAssessmentBlock(input.overall_assessment),
    // Phase G 再修正 (2026-05-24): 副次的な候補プール構造を撤去。
    // 不変ブロックは Opus assessment + 既存 suggestions サマリ のみ。
    renderExistingSuggestionsBlock(
      input.existing_suggestions,
      input.accepted_suggestion_ids,
      input.rejected_suggestion_ids,
      input.edited_suggestion_ids,
    ),
  ];
  return sections.join("\n\n");
}

// partial 用 user メッセージのうち、**可変ブロック**(操作ごとに変わる部分)。
// 派生 ES + action_history + 企業要約 + 添削条件 + ユーザー文脈 + 承認済み evidence
// + 末尾の自己チェックリスト。
//
// 注意: 企業要約 / 添削条件 / ユーザー文脈 自体は session 内で不変だが、cache 境界を
// 単純化するため(不変ブロックは「Opus 評価軸 + 既存 suggestions のみ」に絞る)、
// これらも可変ブロック側にまとめる。実際の cache 効率は Opus 評価軸の引き継ぎ部分が
// 最も大きいため、この設計で十分効果が出る。
export function buildPartialVariableBlock(input: AnalyzeInputBundlePartial): string {
  const newVersion = input.current_es_version + 1;
  // 統合改修パッケージ訂正 (2026-05-25): AI 判断方式の影響範囲ブロックを action_history の
  // 直後に挿入。seed_suggestion_ids / seed_action_type / edit_before / edit_after を渡し、
  // LLM が意味的に影響範囲を判断する。
  const focusBlock = renderFocusInstructionsBlock({
    seedIds: input.seed_suggestion_ids,
    seedActionType: input.seed_action_type,
    editBefore: input.edit_before,
    editAfter: input.edit_after,
  });
  // 2026-05-28 dogfood: 逆質問の回答が含まれる再分析(= 「この回答で再分析」)のときだけ、
  // 「回答を取り込んだ提案を必ず出す」専用指示を可変ブロック冒頭に置く。回答が無い通常
  // partial では本ブロックを一切挿入しない(sections に push しない = 完全不変)。
  const withClarification = hasClarificationAnswers(input);
  const sections: string[] = [];
  if (withClarification) {
    sections.push(CLARIFICATION_ANSWER_INSTRUCTIONS);
  }
  sections.push(
    renderActionHistoryBlock(input.action_history),
    focusBlock,
    renderCurrentEsBlock(input.es_body, newVersion),
    renderQuestionBlock(input.question.text, input.question.char_limit),
    renderCompanySummaryBlock(input.company_summary),
    renderEditConditionsBlock(input),
    renderUserContextBlock(input.user_context),
    renderApprovedEvidenceBlock(input.company_summary),
    // 回答あり時のみ、自己チェックリストに「回答を取り込んだか / 空で返していないか」を追加。
    withClarification
      ? `${PARTIAL_SELF_CHECK_LIST}\n7. 逆質問の回答を取り込んだ提案(updated か added)を 1 件以上出したか / updated・added・deleted を全空で返していないか`
      : PARTIAL_SELF_CHECK_LIST,
  );
  return sections.join("\n\n");
}

// partial 経路の trigger 推測(action_history の DIRECT_EDIT 有無で判定)。
// refresh.ts:inferRefreshTrigger と同じ精神。
export function inferPartialTrigger(
  entries: ReadonlyArray<ActionHistoryEntry>,
): "user_action_refresh" | "user_typed_refresh" {
  const hasDirectEdit = entries.some((e) => e.verb === "DIRECT_EDIT");
  return hasDirectEdit ? "user_typed_refresh" : "user_action_refresh";
}
