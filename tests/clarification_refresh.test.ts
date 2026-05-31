/**
 * 2026-05-28 dogfood round 3 bug fix:「この回答で再分析」(逆質問の回答のみフロー)で
 * 早期 return してボタンが無反応になる不具合の回帰テスト。
 *
 * 不具合の構造:
 *   triggerReanalysisWithClarifications は actionLog にだけ push し、actionHistory には
 *   push しない(store: actionLog ≠ actionHistory)。よって採用/却下/編集を一度もしていない
 *   「回答のみ」フローでは:
 *     (a) actionHistory.length === 0 のまま partialRefreshTrigger が +1 される
 *     (b) Canvas の観測 effect → handleRefresh("balanced") に来るが、両方の
 *         `actionHistory.length === 0` early-return で弾かれて何も起きなかった(ボタン無反応)
 *     (c) 仮に early-return を通しても、partial bundle の action_history は min(1) を要求するため
 *         空 actionHistory のままだと /api/analyze の Zod 検証が 400 を返す
 *
 * 修正(components/canvas/Canvas.tsx、本テストはそのロジックを純粋に再現して検証):
 *   1. 有効な clarification 回答(空白でない answer_text)が 1 件でもあれば early-return を通す
 *      (handleRefresh 内 + 観測 effect の両方)
 *   2. 空 actionHistory + clarification 駆動のとき synthetic な DIRECT_EDIT 1 件を供給し、
 *      partial bundle の action_history min(1) を充足する(clarification 回答の LLM 伝達は
 *      clarificationEnrichedIntent が担うため、synthetic action_history は schema 充足 +
 *      最小文脈に留め提案内容を歪めない)
 *
 * 本テストが守るもの:
 *   - 回答のみフロー後の store 事実(actionHistory 空 + 有効回答 1 件以上)= 不具合の前提が
 *     回帰していないこと
 *   - Canvas の early-return 判定式が「有効回答あり → 通す / なし → 弾く」になること
 *   - synthetic 供給後の actionHistory を buildPartialBundle に渡すと実 schema
 *     (AnalyzeInputBundleSchema)を通ること。空のまま渡すと弾かれること(= 修正の本丸)
 *   - 既存 balanced / reduce_length / 非空 actionHistory 経路を変えないこと(非干渉)
 *
 * 実行方法: `pnpm test:clarification-refresh`(net 呼び出しなし、ローカル即時実行)
 *
 * SSOT:
 *   - components/canvas/Canvas.tsx(handleRefresh の early-return + effectiveActionHistory)
 *   - lib/state/analyze_store.ts(triggerReanalysisWithClarifications / buildPartialBundle)
 *   - lib/schema/input.ts(ActionHistoryEntrySchema / AnalyzeInputBundleSchema、action_history min(1))
 */

import { strict as assert } from "node:assert";
import {
  ActionHistoryEntrySchema,
  AnalyzeInputBundleSchema,
  type ActionHistoryEntry,
} from "@/lib/schema/input";
import type { AnalysisResult } from "@/lib/schema/analysis";
import type { Suggestion } from "@/lib/schema/suggestion";
import type { OverallAssessment } from "@/lib/schema/analysis";
import { CLARIFICATION_ENRICHED_INTENT_HEADER } from "@/lib/schema/clarification";
import {
  buildPartialBundle,
  buildRefreshBundle,
  buildClarificationEnrichedIntent,
  useAnalyzeStore,
  type ClarificationAnswer,
} from "@/lib/state/analyze_store";
import type { FormState } from "@/lib/state/analyze_store";
import { buildPartialVariableBlock } from "@/lib/prompts/partial_refresh";
import { buildRefreshUserMessage } from "@/lib/prompts/refresh";

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passCount += 1;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (e) {
    failCount += 1;
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`  FAIL  ${name}\n        ${msg}`);
    process.stdout.write(`  FAIL ${name}\n        ${msg}\n`);
  }
}

function resetStore() {
  useAnalyzeStore.getState().resetSession();
}

// =============================================================================
// Canvas.tsx の handleRefresh / 観測 effect のロジックを純粋に再現するヘルパー。
// handleRefresh は Canvas component 内の useCallback クロージャで直接呼べないため、
// 「判定式」と「synthetic 供給」を同形に切り出してユニット検証する。
// 判定式は buildClarificationEnrichedIntent / triggerReanalysisWithClarifications の
// filter(answer_text.trim().length > 0)と一致させる(ドリフト防止のため同条件)。
// =============================================================================

/** Canvas: const hasValidClarificationAnswers = clarificationAnswers.some(...) */
function hasValidClarificationAnswers(
  answers: ReadonlyArray<ClarificationAnswer>,
): boolean {
  return answers.some((a) => a.answer_text.trim().length > 0);
}

/**
 * Canvas: handleRefresh 冒頭 + 観測 effect の early-return。
 * @returns true なら「早期 return する(= 何もしない)」
 */
function shouldEarlyReturn(
  goal: "balanced" | "reduce_length",
  actionHistory: ActionHistoryEntry[],
  answers: ReadonlyArray<ClarificationAnswer>,
): boolean {
  return (
    goal === "balanced" &&
    actionHistory.length === 0 &&
    !hasValidClarificationAnswers(answers)
  );
}

/**
 * Canvas: effectiveActionHistory。
 * 「空 かつ (reduce_length または 有効な clarification 回答あり)」のときだけ synthetic 1 件。
 */
function computeEffectiveActionHistory(
  goal: "balanced" | "reduce_length",
  actionHistory: ActionHistoryEntry[],
  answers: ReadonlyArray<ClarificationAnswer>,
): ActionHistoryEntry[] {
  const needsSynthetic =
    actionHistory.length === 0 &&
    (goal === "reduce_length" || hasValidClarificationAnswers(answers));
  if (!needsSynthetic) return actionHistory;
  return [
    goal === "reduce_length"
      ? {
          verb: "DIRECT_EDIT",
          description:
            "(操作履歴なし — 初回状態の ES が設問の上限を超過しているため、文字数削減を要求)",
        }
      : {
          verb: "DIRECT_EDIT",
          description: "(逆質問への回答に基づく再分析)",
        },
  ];
}

// =============================================================================
// fixtures
// =============================================================================

function makeValidQ(id: string) {
  return {
    id,
    question: `テスト質問本文 ${id}(5 字以上 200 字以下)`,
    rationale: "テスト理由テキスト(10 字以上 300 字以下です)",
  };
}

function makeSuggestion(id: string): Suggestion {
  return {
    id,
    category: "convention",
    original: "原文テキスト",
    proposed: "提案テキスト",
    alternatives: [],
    rationale: "理由",
    rationale_source: { type: "convention", reference: "ES 慣習" },
    related_suggestion_ids: [],
    original_span: { start: 0, end: 4 },
  };
}

function makeOverallAssessment(): OverallAssessment {
  return {
    summary: "総評",
    strengths: ["強み"],
    weaknesses: ["弱み"],
    preserved_voice_note: "個性メモ",
  };
}

function makeResultWithGlobalQ(qId: string): AnalysisResult {
  return {
    es_state_version: 1,
    overall_assessment: makeOverallAssessment(),
    suggestions: [makeSuggestion("sug_001")],
    global_clarification_questions: [makeValidQ(qId)],
  };
}

function makeForm(): FormState {
  return {
    es_body: "私が学生時代に力を入れたのは、テニスサークルの活動です。",
    question_text: "学生時代に力を入れたことを教えてください。",
    char_limit: "400",
    company_input_type: "name",
    company_url: "",
    company_name: "テスト株式会社",
    company_freetext: "",
    preset: "バランス",
    free_text: "",
    user_context: "",
  };
}

const ans = (question_id: string, answer_text: string): ClarificationAnswer => ({
  question_id,
  answer_text,
  answered_at: Date.now(),
  scope: "global",
});

// =============================================================================
// (1) 不具合の前提 — 回答のみフロー後の store 事実
// =============================================================================
process.stdout.write(
  "[不具合の前提: triggerReanalysisWithClarifications 後の actionHistory / 回答]\n",
);

test("回答のみフロー: 採用/却下/編集なしで再分析トリガー → actionHistory は空のまま", () => {
  resetStore();
  useAnalyzeStore.setState({ analysisResult: makeResultWithGlobalQ("q_001") });
  const s = useAnalyzeStore.getState();
  s.updateClarificationAnswer({
    question_id: "q_001",
    scope: "global",
    answer_text: "週3回の朝練を1年続けました。",
  });
  s.triggerReanalysisWithClarifications();
  const after = useAnalyzeStore.getState();
  // actionLog には積まれるが actionHistory(LLM 用)は空 = 不具合の根本原因
  assert.equal(after.actionHistory.length, 0, "actionHistory は空であるべき(前提)");
  assert.ok(after.actionLog.length >= 1, "actionLog には clarification entry が積まれる");
  assert.ok(after.partialRefreshTrigger >= 1, "trigger は立つ");
  // 有効回答は 1 件以上残っている
  assert.equal(
    hasValidClarificationAnswers(after.clarificationAnswers),
    true,
    "有効な clarification 回答が残っている",
  );
});

// =============================================================================
// (2) early-return 判定 — 有効回答ありで通す / なしで弾く
// =============================================================================
process.stdout.write("\n[early-return 判定(handleRefresh + 観測 effect)]\n");

test("balanced + actionHistory 空 + 有効回答あり → 早期 return しない(修正の核)", () => {
  const result = shouldEarlyReturn("balanced", [], [ans("q_001", "有効な回答")]);
  assert.equal(result, false, "回答ありなら handleRefresh に進むべき");
});

test("balanced + actionHistory 空 + 回答なし → 早期 return する(従来挙動維持)", () => {
  const result = shouldEarlyReturn("balanced", [], []);
  assert.equal(result, true, "回答が無ければ従来どおり no-op");
});

test("balanced + actionHistory 空 + 空白のみ回答 → 早期 return する(trim 後 0 字)", () => {
  const result = shouldEarlyReturn("balanced", [], [ans("q_001", "   \n  ")]);
  assert.equal(result, true, "空白のみは有効回答ではない");
});

test("balanced + actionHistory 非空 → 回答有無に関わらず早期 return しない(通常フロー)", () => {
  const history: ActionHistoryEntry[] = [
    { verb: "REJECTED", suggestion_id: "sug_001", suggestion_summary: "却下した指摘" },
  ];
  assert.equal(shouldEarlyReturn("balanced", history, []), false);
  assert.equal(
    shouldEarlyReturn("balanced", history, [ans("q_001", "回答")]),
    false,
  );
});

test("reduce_length は actionHistory / 回答に関わらず早期 return しない(⑦ 既存挙動)", () => {
  assert.equal(shouldEarlyReturn("reduce_length", [], []), false);
  assert.equal(shouldEarlyReturn("reduce_length", [], [ans("q_001", "回答")]), false);
});

// =============================================================================
// (3) effectiveActionHistory — synthetic 供給の条件
// =============================================================================
process.stdout.write("\n[effectiveActionHistory: synthetic 供給条件]\n");

test("空 actionHistory + clarification 駆動 → synthetic DIRECT_EDIT 1 件を供給", () => {
  const eff = computeEffectiveActionHistory(
    "balanced",
    [],
    [ans("q_001", "有効な回答")],
  );
  assert.equal(eff.length, 1, "synthetic 1 件");
  assert.equal(eff[0].verb, "DIRECT_EDIT");
  assert.ok(
    eff[0].verb === "DIRECT_EDIT" && eff[0].description.includes("逆質問"),
    "clarification 駆動の synthetic 文言であるべき",
  );
});

test("空 actionHistory + reduce_length → 既存の削減 synthetic 1 件(⑦、文言は別)", () => {
  const eff = computeEffectiveActionHistory("reduce_length", [], []);
  assert.equal(eff.length, 1);
  assert.equal(eff[0].verb, "DIRECT_EDIT");
  assert.ok(
    eff[0].verb === "DIRECT_EDIT" && eff[0].description.includes("削減"),
    "reduce_length の synthetic 文言であるべき",
  );
});

test("空 actionHistory + balanced + 回答なし → synthetic なし(空のまま、通常フロー非干渉)", () => {
  const eff = computeEffectiveActionHistory("balanced", [], []);
  assert.equal(eff.length, 0, "通常 balanced は合成しない");
});

test("非空 actionHistory → そのまま(合成しない、いずれの goal でも)", () => {
  const history: ActionHistoryEntry[] = [
    { verb: "ACCEPTED", suggestion_id: "sug_001", suggestion_summary: "採用した指摘" },
  ];
  assert.deepEqual(
    computeEffectiveActionHistory("balanced", history, [ans("q_001", "回答")]),
    history,
  );
  assert.deepEqual(computeEffectiveActionHistory("reduce_length", history, []), history);
});

test("synthetic entry は ActionHistoryEntrySchema を満たす(clarification / reduce 両方)", () => {
  const clar = computeEffectiveActionHistory("balanced", [], [ans("q_001", "回答")]);
  const reduce = computeEffectiveActionHistory("reduce_length", [], []);
  assert.equal(ActionHistoryEntrySchema.safeParse(clar[0]).success, true);
  assert.equal(ActionHistoryEntrySchema.safeParse(reduce[0]).success, true);
});

// =============================================================================
// (4) buildPartialBundle が実 schema を通る — 修正の本丸
//     回答のみフローで生 actionHistory(空)を渡すと action_history min(1) で弾かれ、
//     effectiveActionHistory(合成 1 件)を渡すと通る。
// =============================================================================
process.stdout.write(
  "\n[buildPartialBundle: action_history min(1) を effectiveActionHistory で充足]\n",
);

function buildPartialFor(actionHistory: ActionHistoryEntry[]) {
  const result = makeResultWithGlobalQ("q_001");
  const answers = [ans("q_001", "週3回の朝練を1年続けました。")];
  const enriched = buildClarificationEnrichedIntent(answers, result);
  return buildPartialBundle({
    form: makeForm(),
    companySummary: undefined,
    esBody: makeForm().es_body,
    actionHistory,
    baseVersion: 1,
    existingSuggestions: result.suggestions,
    overallAssessment: result.overall_assessment,
    acceptedSuggestionIds: [],
    rejectedSuggestionIds: [],
    editedSuggestionIds: [],
    seedSuggestionIds: [],
    seedActionType: "manual",
    clarificationEnrichedIntent: enriched,
  });
}

test("生 actionHistory(空)を渡した partial bundle は Zod 検証で弾かれる(= バグ再現)", () => {
  const bundle = buildPartialFor([]); // 修正前の Canvas line 739 が渡していた値
  const parsed = AnalyzeInputBundleSchema.safeParse(bundle);
  assert.equal(parsed.success, false, "空 action_history は min(1) で弾かれるべき");
});

test("effectiveActionHistory(合成 1 件)を渡した partial bundle は Zod 検証を通る(= 修正後)", () => {
  const eff = computeEffectiveActionHistory(
    "balanced",
    [],
    [ans("q_001", "週3回の朝練を1年続けました。")],
  );
  const bundle = buildPartialFor(eff); // 修正後の Canvas が渡す値
  const parsed = AnalyzeInputBundleSchema.safeParse(bundle);
  assert.equal(
    parsed.success,
    true,
    parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2),
  );
  if (parsed.success && parsed.data.mode === "partial") {
    assert.ok(
      parsed.data.action_history.length >= 1,
      "bundle の action_history は 1 件以上",
    );
  }
});

test("partial bundle の user_context に逆質問への回答が enrich されている(LLM 伝達経路)", () => {
  const eff = computeEffectiveActionHistory(
    "balanced",
    [],
    [ans("q_001", "週3回の朝練を1年続けました。")],
  );
  const bundle = buildPartialFor(eff);
  assert.ok(
    bundle.user_context.includes("[逆質問への回答]"),
    "回答は user_context 経由で LLM に渡る(synthetic action_history ではなく)",
  );
  assert.ok(
    bundle.user_context.includes("週3回の朝練を1年続けました。"),
    "回答本文が含まれる",
  );
});

// =============================================================================
// (5) prompt 注入 — 逆質問の回答ありの時だけ「回答取り込み」専用指示が入る
//     2026-05-28 dogfood:「逆質問に答えても変更なしで何も提案が出ない」の修正の本丸。
//     回答が user_context に含まれる時だけ partial/refresh prompt に「回答を使って
//     必ず提案を出す / 全空で返すの禁止」指示が注入され、回答が無い通常再分析では
//     一切注入されない(非干渉)ことを prompt 文字列レベルで検証する。
// =============================================================================
process.stdout.write(
  "\n[prompt 注入: 回答ありの時だけ「回答取り込み」専用指示が入る(partial / refresh)]\n",
);

// 回答ありの partial bundle(synthetic action_history 1 件込み = 回答のみフロー実態)
function partialBundleWithClarification() {
  const eff = computeEffectiveActionHistory(
    "balanced",
    [],
    [ans("q_001", "週3回の朝練を1年続けました。")],
  );
  return buildPartialFor(eff);
}

// 回答なしの partial bundle(通常 balanced 再分析、操作 1 件あり)
function partialBundleWithoutClarification() {
  const result = makeResultWithGlobalQ("q_001");
  return buildPartialBundle({
    form: makeForm(),
    companySummary: undefined,
    esBody: makeForm().es_body,
    actionHistory: [
      { verb: "REJECTED", suggestion_id: "sug_001", suggestion_summary: "却下した指摘" },
    ],
    baseVersion: 1,
    existingSuggestions: result.suggestions,
    overallAssessment: result.overall_assessment,
    acceptedSuggestionIds: [],
    rejectedSuggestionIds: ["sug_001"],
    editedSuggestionIds: [],
    seedSuggestionIds: ["sug_001"],
    seedActionType: "reject",
    // clarificationEnrichedIntent を渡さない = 回答なし
  });
}

test("partial: 回答ありのとき variable block に「回答取り込み」専用指示が入る", () => {
  const text = buildPartialVariableBlock(partialBundleWithClarification());
  assert.ok(
    text.includes("逆質問の回答あり"),
    "回答取り込み専用指示の見出しが含まれるべき",
  );
  assert.ok(
    text.includes("必ず 1 件以上"),
    "「必ず 1 件以上出す」の指示が含まれるべき",
  );
  assert.ok(
    text.includes("禁止"),
    "「全空で返すのは禁止」の指示が含まれるべき",
  );
  // added の例外明示(通常 partial の「added は副次的 / added: []」枠組みを回答時に上書き)
  assert.ok(text.includes("added"), "added 経路への言及が含まれるべき");
  // 捏造防止が回答取り込みでも維持されていること
  assert.ok(
    text.includes("回答に実際に書かれた事実のみ"),
    "捏造防止(回答の事実のみ使用)が明記されるべき",
  );
  // 自己チェックリストに回答取り込み確認項目が追加されていること
  assert.ok(
    text.includes("全空で返していないか"),
    "自己チェックに「全空で返していないか」が追加されるべき",
  );
});

test("partial: 回答なしの通常再分析では「回答取り込み」専用指示が入らない(非干渉)", () => {
  const text = buildPartialVariableBlock(partialBundleWithoutClarification());
  assert.ok(
    !text.includes("逆質問の回答あり"),
    "回答が無ければ専用指示は注入されないべき",
  );
  assert.ok(
    !text.includes(CLARIFICATION_ENRICHED_INTENT_HEADER),
    "回答が無ければ user_context にヘッダも無い",
  );
  // 既存の partial 主軸指示(updated/deleted)は変わらず存在する
  assert.ok(
    text.includes("[影響範囲の判断(AI 主導)]"),
    "通常 partial の影響範囲ブロックは従来どおり存在する",
  );
});

test("partial: 回答ありと回答なしの差分は「回答取り込み」専用指示の有無だけ(枠組み非破壊)", () => {
  const withC = buildPartialVariableBlock(partialBundleWithClarification());
  const withoutC = buildPartialVariableBlock(partialBundleWithoutClarification());
  // 回答なし版は専用見出しを含まない、回答あり版は含む(確実な差分)
  assert.equal(withoutC.includes("逆質問の回答あり"), false);
  assert.equal(withC.includes("逆質問の回答あり"), true);
  // 両者とも既存の影響範囲ブロック / 現在の派生 ES ブロックを保持(共通骨格は不変)
  for (const t of [withC, withoutC]) {
    assert.ok(t.includes("[影響範囲の判断(AI 主導)]"));
    assert.ok(t.includes("[現在の派生 ES"));
  }
});

// refresh stream 経路(analysisResult が null 等で partial に乗らない理論ケースの保険)
function refreshBundleWithClarification() {
  const result = makeResultWithGlobalQ("q_001");
  const answers = [ans("q_001", "週3回の朝練を1年続けました。")];
  const enriched = buildClarificationEnrichedIntent(answers, result);
  return buildRefreshBundle({
    form: makeForm(),
    companySummary: undefined,
    esBody: makeForm().es_body,
    actionHistory: [{ verb: "DIRECT_EDIT", description: "(逆質問への回答に基づく再分析)" }],
    baseVersion: 1,
    goal: "balanced",
    clarificationEnrichedIntent: enriched,
  });
}

function refreshBundleWithoutClarification() {
  return buildRefreshBundle({
    form: makeForm(),
    companySummary: undefined,
    esBody: makeForm().es_body,
    actionHistory: [
      { verb: "REJECTED", suggestion_id: "sug_001", suggestion_summary: "却下した指摘" },
    ],
    baseVersion: 1,
    goal: "balanced",
    // clarificationEnrichedIntent を渡さない = 回答なし
  });
}

test("refresh: 回答ありのとき user message に「回答取り込み」専用指示が入る", () => {
  const text = buildRefreshUserMessage(refreshBundleWithClarification());
  assert.ok(text.includes("逆質問の回答あり"), "専用指示の見出しが含まれるべき");
  assert.ok(text.includes("必ず 1 件以上"), "「必ず 1 件以上出す」が含まれるべき");
  assert.ok(text.includes("禁止"), "「ゼロ件で返すのは禁止」が含まれるべき");
  assert.ok(
    text.includes("回答に実際に書かれた事実のみ"),
    "捏造防止が明記されるべき",
  );
});

test("refresh: 回答なしの通常 refresh では「回答取り込み」専用指示が入らない(非干渉)", () => {
  const text = buildRefreshUserMessage(refreshBundleWithoutClarification());
  assert.ok(
    !text.includes("逆質問の回答あり"),
    "回答が無ければ専用指示は注入されないべき",
  );
  // 既存の refresh header は従来どおり存在する
  assert.ok(
    text.includes("[これはリフレッシュ要求です]"),
    "通常 refresh の header は従来どおり存在する",
  );
});

// =============================================================================
// (6) drift ガード — producer(store)と consumer(prompt)のヘッダ定数同期
// =============================================================================
process.stdout.write(
  "\n[drift ガード: enriched_intent ヘッダ定数が producer / consumer で同期]\n",
);

test("buildClarificationEnrichedIntent の出力が SSOT ヘッダ定数で始まる", () => {
  const result = makeResultWithGlobalQ("q_001");
  const enriched = buildClarificationEnrichedIntent(
    [ans("q_001", "週3回の朝練を1年続けました。")],
    result,
  );
  assert.ok(
    enriched.startsWith(CLARIFICATION_ENRICHED_INTENT_HEADER),
    `producer は SSOT 定数 "${CLARIFICATION_ENRICHED_INTENT_HEADER}" で始まるべき`,
  );
});

// =============================================================================
// 結果出力
// =============================================================================
process.stdout.write(`\nResults: ${passCount} pass / ${failCount} fail\n`);
if (failCount > 0) {
  process.stdout.write("\nFailures:\n");
  for (const f of failures) process.stdout.write(f + "\n");
  process.exit(1);
}
