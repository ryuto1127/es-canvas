/**
 * dogfood round 3 ②③④ のユニットテスト(2026-05-28)。
 *
 * 3 つの改修を構造で担保する:
 *
 *  ③ 上から順(ES の出現順):
 *     `pickNextPendingSuggestionId` が、次の未処理 suggestion を **original_span.start
 *     昇順**(= ES 本文の出現順)で選ぶこと。display_priority が high でも、ES 上で後ろに
 *     ある指摘より先には選ばれない(priority は順序計算から外れ、色タグとしてのみ残る)。
 *     span が同一の稀ケースは id 昇順で決定性を担保する。
 *
 *  ② 再評価中スキップ:
 *     `pickNextPendingSuggestionId` の `excludeIds` に渡した id が次の自動選択から外れること。
 *     全 pending が exclude(= 全て再評価中)なら null を返すこと。
 *     `computeReEvaluatingIds` が「seed 群 + 各 seed の related_suggestion_ids」の union を
 *     返すこと(② が次選択から外す対象 / ④ が badge を出す対象)。
 *
 *  ④ 再評価中 badge の前提 state:
 *     accept(関連あり時のみ)/ reject(常に)/ edit が `reEvaluatingSuggestionIds` を set し、
 *     refresh が終わる全経路(commitPartialRefreshCleanup / setRefreshError / clearReEvaluating)
 *     とセッションが変わる経路(resetSession)で clear すること。badge 自体の `&&
 *     partialRefreshInProgress` gate は SuggestionCard.tsx の責務でここでは検証しない
 *     (set/clear の lifecycle のみを store level で担保する)。
 *
 * 実行方法: `pnpm test:ordering`(net 呼び出しなし、ローカル即時実行)
 *
 * SSOT:
 *  - lib/state/analyze_store.ts:pickNextPendingSuggestionId / computeReEvaluatingIds /
 *    acceptSuggestion / rejectSuggestion / editSuggestion / commitPartialRefreshCleanup /
 *    setRefreshError / clearReEvaluating / resetSession
 *  - docs/dispatch/2026-05-28-suggestion-flow-reeval-visibility.md(設計 = SSOT、「テスト」section)
 *  - DECISIONS.md [2026-05-28] dogfood round 3 ②③④ 実装設計確定 / 実装結果
 *
 * -----------------------------------------------------------------------------
 * G3 undo/履歴バグ修正(2026-05-28、Codex 独立レビュー確定の C3/C6/C7)を追加検証:
 *
 *  C3 direct-edit 中の Undo/Redo ツールバー disable:
 *     `canUndoFromToolbar` / `canRedoFromToolbar`(純粋関数)が directEditMode 中は
 *     両方 false(押せない)、それ以外は履歴 / redo スタックの有無で判定すること。
 *     Canvas.tsx のツールバーボタンと同一規則を共有し、構造で不変条件を担保する。
 *
 *  C6 revert(「この操作を取り消す」= pending 戻し)後の Undo:
 *     採用 → revert で PENDING entry が積まれた後、undo(1) で **元の採用状態に復元**
 *     されること(旧実装は no-op だった)。reject / edit の revert 復元、redo 対称も検証。
 *
 *  C7 「全て元に戻す」(自動修正一括取り消し)の Undo:
 *     undoAllAutoCorrections が同一 groupId で複数 REJECTED entry を積み、undo(1) が
 *     **1 回で全件復元**(group 境界まで pop を拡張)すること。redo 対称も検証。
 *     `expandPopCountToGroupBoundary`(純粋関数)の境界拡張ロジックも単体検証。
 *
 * SSOT(G3 追加分):
 *  - lib/state/analyze_store.ts:canUndoFromToolbar / canRedoFromToolbar /
 *    expandPopCountToGroupBoundary / undo / redo / revertSuggestionAction /
 *    undoAllAutoCorrections
 *  - 既存 undo/redo(単体 accept/reject/edit/DIRECT_EDIT/structural)の非干渉も併せて確認。
 */

import { strict as assert } from "node:assert";
import {
  pickNextPendingSuggestionId,
  computeReEvaluatingIds,
  canUndoFromToolbar,
  canRedoFromToolbar,
  expandPopCountToGroupBoundary,
  useAnalyzeStore,
} from "@/lib/state/analyze_store";
import type { AnalysisResult } from "@/lib/schema/analysis";
import type { Suggestion } from "@/lib/schema/suggestion";

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

// -----------------------------------------------------------------------------
// fixtures
// -----------------------------------------------------------------------------
// SuggestionSchema の必須 field を埋めるフル factory。本テストで関心がある field は
// `id` / `original_span` / `display_priority` / `related_suggestion_ids` のみ。他は
// default placeholder(category は明示しない限り convention = 明示採用 / 拒否が必要)。
function makeSuggestion(
  overrides: Pick<Suggestion, "id" | "original_span"> & Partial<Suggestion>,
): Suggestion {
  return {
    category: "convention",
    original: "原文",
    proposed: "提案テキスト",
    alternatives: [],
    rationale: "理由テキスト",
    rationale_source: { type: "convention", reference: "ES 慣習" },
    related_suggestion_ids: [],
    ...overrides,
  };
}

// pickNextPendingSuggestionId の args を、空の処理済リストで作るデフォルトビルダー。
// (個別テストで accepted / excludeIds 等を上書きする)
function pickArgs(
  suggestions: Suggestion[],
  overrides: Partial<Parameters<typeof pickNextPendingSuggestionId>[0]> = {},
): Parameters<typeof pickNextPendingSuggestionId>[0] {
  return {
    suggestions,
    acceptedSuggestionIds: [],
    rejectedSuggestionIds: [],
    editedSuggestions: {},
    autoCorrectedSuggestionIds: [],
    showAlternatives: false,
    excludeIds: [],
    ...overrides,
  };
}

function makeResult(suggestions: Suggestion[]): AnalysisResult {
  return {
    es_state_version: 0,
    overall_assessment: {
      summary: "総評",
      strengths: ["強み"],
      weaknesses: ["弱み"],
      preserved_voice_note: "個性メモ",
    },
    suggestions,
  };
}

// store を初期化し、form.es_body + analysisResult を seed する。
// setAnalysisResult は currentEsBody = es_body にし、error カテゴリを自動採用する
// (本テストの reEvaluating 検証は convention のみ使い、自動採用を避ける)。
function seedStore(esBody: string, suggestions: Suggestion[]): void {
  useAnalyzeStore.getState().resetSession();
  useAnalyzeStore.getState().setField("es_body", esBody);
  useAnalyzeStore.getState().setAnalysisResult(makeResult(suggestions));
}

// =============================================================================
// ③ pickNextPendingSuggestionId: 上から順(original_span.start 昇順)
// =============================================================================
process.stdout.write(
  "[③ pickNextPendingSuggestionId: 上から順(span 昇順、priority は順序に使わない)]\n",
);

test("span 昇順で選ぶ(配列順が逆でも span が小さい方を先に返す)", () => {
  // 配列の並びは sug_b(span 20) → sug_a(span 5) だが、span 昇順なので sug_a が先。
  const suggestions = [
    makeSuggestion({ id: "sug_b", original_span: { start: 20, end: 25 } }),
    makeSuggestion({ id: "sug_a", original_span: { start: 5, end: 10 } }),
  ];
  const next = pickNextPendingSuggestionId(pickArgs(suggestions));
  assert.equal(next, "sug_a", "span が小さい方(ES 上で前)を先に選ぶ");
});

test("priority が high でも span が後ろなら後回し(priority は順序に使わない)", () => {
  // sug_late は display_priority=high だが span=30、sug_early は low だが span=2。
  // ③ では priority を順序計算から外したので、span 昇順で sug_early が先。
  const suggestions = [
    makeSuggestion({
      id: "sug_late",
      original_span: { start: 30, end: 35 },
      display_priority: "high",
    }),
    makeSuggestion({
      id: "sug_early",
      original_span: { start: 2, end: 6 },
      display_priority: "low",
    }),
  ];
  const next = pickNextPendingSuggestionId(pickArgs(suggestions));
  assert.equal(
    next,
    "sug_early",
    "priority(high)ではなく span(小)で選ぶ — 上から順",
  );
});

test("display_priority 未付与でも span 昇順で選ぶ(priority weight に依存しない)", () => {
  const suggestions = [
    makeSuggestion({ id: "sug_z", original_span: { start: 50, end: 55 } }),
    makeSuggestion({ id: "sug_y", original_span: { start: 10, end: 14 } }),
  ];
  const next = pickNextPendingSuggestionId(pickArgs(suggestions));
  assert.equal(next, "sug_y", "未付与でも span 昇順(medium 扱いの tiebreak に依存しない)");
});

test("span 同一なら id 昇順 tiebreak(決定性)", () => {
  // 同じ span の 2 件。配列は sug_2 → sug_1 の順だが id 昇順で sug_1 を返す。
  const suggestions = [
    makeSuggestion({ id: "sug_2", original_span: { start: 8, end: 12 } }),
    makeSuggestion({ id: "sug_1", original_span: { start: 8, end: 12 } }),
  ];
  const next = pickNextPendingSuggestionId(pickArgs(suggestions));
  assert.equal(next, "sug_1", "span 同一は id 昇順で決定性を担保");
});

test("処理済(accepted / rejected / edited / autoCorrected)は pending から除外される", () => {
  // span 最小の sug_a は accepted、次に小さい sug_b は rejected、sug_c は edited、
  // sug_d は autoCorrected → 残る pending は sug_e のみ。
  const suggestions = [
    makeSuggestion({ id: "sug_a", original_span: { start: 1, end: 3 } }),
    makeSuggestion({ id: "sug_b", original_span: { start: 5, end: 7 } }),
    makeSuggestion({ id: "sug_c", original_span: { start: 9, end: 11 } }),
    makeSuggestion({ id: "sug_d", original_span: { start: 13, end: 15 } }),
    makeSuggestion({ id: "sug_e", original_span: { start: 17, end: 19 } }),
  ];
  const next = pickNextPendingSuggestionId(
    pickArgs(suggestions, {
      acceptedSuggestionIds: ["sug_a"],
      rejectedSuggestionIds: ["sug_b"],
      editedSuggestions: { sug_c: "編集済" },
      autoCorrectedSuggestionIds: ["sug_d"],
    }),
  );
  assert.equal(next, "sug_e", "処理済を全て除外して残る pending を返す");
});

test("alternative は showAlternatives=false なら候補から外れる", () => {
  // span 最小は alternative の sug_alt だが、showAlternatives=false なので除外され
  // 次の convention sug_main が選ばれる。
  const suggestions = [
    makeSuggestion({
      id: "sug_alt",
      category: "alternative",
      original_span: { start: 1, end: 3 },
    }),
    makeSuggestion({ id: "sug_main", original_span: { start: 5, end: 7 } }),
  ];
  const next = pickNextPendingSuggestionId(
    pickArgs(suggestions, { showAlternatives: false }),
  );
  assert.equal(next, "sug_main", "alternative は OFF 時に候補外(span 最小でも飛ばす)");
});

test("全件処理済なら null", () => {
  const suggestions = [
    makeSuggestion({ id: "sug_a", original_span: { start: 1, end: 3 } }),
  ];
  const next = pickNextPendingSuggestionId(
    pickArgs(suggestions, { acceptedSuggestionIds: ["sug_a"] }),
  );
  assert.equal(next, null, "pending が無ければ null");
});

// =============================================================================
// ② pickNextPendingSuggestionId: excludeIds(再評価中スキップ)
// =============================================================================
process.stdout.write("[② pickNextPendingSuggestionId: excludeIds で再評価中をスキップ]\n");

test("excludeIds の id は次選択から飛ばす(次の span の pending を選ぶ)", () => {
  // span 最小 sug_a を excludeIds で外す → 次に小さい sug_b が選ばれる。
  const suggestions = [
    makeSuggestion({ id: "sug_a", original_span: { start: 1, end: 3 } }),
    makeSuggestion({ id: "sug_b", original_span: { start: 5, end: 7 } }),
  ];
  const next = pickNextPendingSuggestionId(
    pickArgs(suggestions, { excludeIds: ["sug_a"] }),
  );
  assert.equal(next, "sug_b", "exclude された span 最小を飛ばして次の pending を選ぶ");
});

test("複数 id を excludeIds で同時に飛ばす", () => {
  const suggestions = [
    makeSuggestion({ id: "sug_a", original_span: { start: 1, end: 3 } }),
    makeSuggestion({ id: "sug_b", original_span: { start: 5, end: 7 } }),
    makeSuggestion({ id: "sug_c", original_span: { start: 9, end: 11 } }),
  ];
  const next = pickNextPendingSuggestionId(
    pickArgs(suggestions, { excludeIds: ["sug_a", "sug_b"] }),
  );
  assert.equal(next, "sug_c", "exclude された 2 件を飛ばして 3 件目を選ぶ");
});

test("全 pending が excludeIds なら null(= 全て再評価中、強制選択しない)", () => {
  // dispatch の edge: 残り pending が全て再評価中なら強制選択せず null。
  // UI 側(SuggestionDetailPanel)はこの null を受けて「再評価中、お待ちください」を出す。
  const suggestions = [
    makeSuggestion({ id: "sug_a", original_span: { start: 1, end: 3 } }),
    makeSuggestion({ id: "sug_b", original_span: { start: 5, end: 7 } }),
  ];
  const next = pickNextPendingSuggestionId(
    pickArgs(suggestions, { excludeIds: ["sug_a", "sug_b"] }),
  );
  assert.equal(next, null, "全 pending が exclude(全再評価中)なら null");
});

test("excludeIds は default 空 = 従来挙動(全 pending が候補)", () => {
  const suggestions = [
    makeSuggestion({ id: "sug_a", original_span: { start: 1, end: 3 } }),
  ];
  // excludeIds を省略しても span 最小が選ばれる(後方互換)。
  const next = pickNextPendingSuggestionId({
    suggestions,
    acceptedSuggestionIds: [],
    rejectedSuggestionIds: [],
    editedSuggestions: {},
    autoCorrectedSuggestionIds: [],
    showAlternatives: false,
    // excludeIds 省略
  });
  assert.equal(next, "sug_a", "excludeIds 省略時は全 pending が候補(default [])");
});

// =============================================================================
// ②④ computeReEvaluatingIds: seed + related の union
// =============================================================================
process.stdout.write("[②④ computeReEvaluatingIds: seed + related_suggestion_ids の union]\n");

test("seed 自身 + その related_suggestion_ids を返す", () => {
  const suggestions = [
    makeSuggestion({
      id: "sug_seed",
      original_span: { start: 1, end: 3 },
      related_suggestion_ids: ["sug_rel1", "sug_rel2"],
    }),
    makeSuggestion({ id: "sug_rel1", original_span: { start: 5, end: 7 } }),
    makeSuggestion({ id: "sug_rel2", original_span: { start: 9, end: 11 } }),
  ];
  const result = computeReEvaluatingIds(["sug_seed"], suggestions);
  assert.deepEqual(
    [...result].sort(),
    ["sug_rel1", "sug_rel2", "sug_seed"],
    "seed + その related を union(seed 自身も含む)",
  );
});

test("related が空なら seed のみ", () => {
  const suggestions = [
    makeSuggestion({
      id: "sug_seed",
      original_span: { start: 1, end: 3 },
      related_suggestion_ids: [],
    }),
  ];
  const result = computeReEvaluatingIds(["sug_seed"], suggestions);
  assert.deepEqual(result, ["sug_seed"], "related 空なら seed 自身のみ");
});

test("複数 seed の related を重複なく union", () => {
  // sug_s1 と sug_s2 が共通の related sug_shared を持つ → 重複除去で 1 回だけ。
  const suggestions = [
    makeSuggestion({
      id: "sug_s1",
      original_span: { start: 1, end: 3 },
      related_suggestion_ids: ["sug_shared"],
    }),
    makeSuggestion({
      id: "sug_s2",
      original_span: { start: 5, end: 7 },
      related_suggestion_ids: ["sug_shared", "sug_other"],
    }),
    makeSuggestion({ id: "sug_shared", original_span: { start: 9, end: 11 } }),
    makeSuggestion({ id: "sug_other", original_span: { start: 13, end: 15 } }),
  ];
  const result = computeReEvaluatingIds(["sug_s1", "sug_s2"], suggestions);
  assert.deepEqual(
    [...result].sort(),
    ["sug_other", "sug_s1", "sug_s2", "sug_shared"],
    "複数 seed + 共通 related を重複なく union",
  );
});

test("suggestions に存在しない seed は related lookup を skip(seed 自身は残す)", () => {
  // seed が現 analysisResult に居ない(refresh で消えた等)稀ケース。lookup は skip
  // するが、seed id 自身は Set 初期値として残る(membership test には無害)。
  const suggestions = [
    makeSuggestion({ id: "sug_other", original_span: { start: 1, end: 3 } }),
  ];
  const result = computeReEvaluatingIds(["sug_missing"], suggestions);
  assert.deepEqual(result, ["sug_missing"], "不在 seed は related skip、seed id は残す");
});

// =============================================================================
// ④ store lifecycle: reEvaluatingSuggestionIds の set / clear
// =============================================================================
process.stdout.write(
  "[④ store lifecycle: reEvaluatingSuggestionIds の set(reject/accept/edit)/ clear]\n",
);

test("初期 state は空配列", () => {
  useAnalyzeStore.getState().resetSession();
  assert.deepEqual(
    useAnalyzeStore.getState().reEvaluatingSuggestionIds,
    [],
    "resetSession 後は reEvaluating が空",
  );
});

test("rejectSuggestion: reEvaluating = 拒否 id + その related に set", () => {
  // convention 2 件。sug_r は sug_rel を related に持つ。reject すると常に scoped
  // refresh が走り、reEvaluating = [sug_r, sug_rel] が立つ。
  seedStore("あいうえお。かきくけこ。", [
    makeSuggestion({
      id: "sug_r",
      category: "convention",
      original: "あいうえお",
      original_span: { start: 0, end: 5 },
      related_suggestion_ids: ["sug_rel"],
    }),
    makeSuggestion({
      id: "sug_rel",
      category: "convention",
      original: "かきくけこ",
      original_span: { start: 6, end: 11 },
    }),
  ]);
  useAnalyzeStore
    .getState()
    .rejectSuggestion({ suggestion_id: "sug_r", suggestion_summary: "拒否" });
  const after = useAnalyzeStore.getState();
  assert.deepEqual(
    [...after.reEvaluatingSuggestionIds].sort(),
    ["sug_r", "sug_rel"],
    "reject で reEvaluating = 拒否 id + related の union",
  );
});

test("acceptSuggestion(関連あり): reEvaluating を set", () => {
  // convention sug_a が sug_rel を related に持つ → accept は関連あり時のみ scoped
  // refresh を発火し、reEvaluating が立つ。
  seedStore("あいうえお。かきくけこ。", [
    makeSuggestion({
      id: "sug_a",
      category: "convention",
      original: "あいうえお",
      original_span: { start: 0, end: 5 },
      related_suggestion_ids: ["sug_rel"],
    }),
    makeSuggestion({
      id: "sug_rel",
      category: "convention",
      original: "かきくけこ",
      original_span: { start: 6, end: 11 },
    }),
  ]);
  useAnalyzeStore
    .getState()
    .acceptSuggestion({ suggestion_id: "sug_a", suggestion_summary: "採用" });
  const after = useAnalyzeStore.getState();
  assert.deepEqual(
    [...after.reEvaluatingSuggestionIds].sort(),
    ["sug_a", "sug_rel"],
    "accept(関連あり)で reEvaluating が立つ",
  );
});

test("acceptSuggestion(関連なし): scoped refresh skip = reEvaluating は空のまま", () => {
  // related が空の convention を accept → scoped refresh skip(AI コスト 0)。
  // 何も再評価されないため reEvaluating は空のまま。
  seedStore("あいうえお。", [
    makeSuggestion({
      id: "sug_solo",
      category: "convention",
      original: "あいうえお",
      original_span: { start: 0, end: 5 },
      related_suggestion_ids: [],
    }),
  ]);
  useAnalyzeStore
    .getState()
    .acceptSuggestion({ suggestion_id: "sug_solo", suggestion_summary: "採用" });
  const after = useAnalyzeStore.getState();
  assert.deepEqual(
    after.reEvaluatingSuggestionIds,
    [],
    "accept(関連なし)は refresh skip = reEvaluating 空のまま",
  );
});

test("editSuggestion: reEvaluating = 編集 id + その related に set", () => {
  seedStore("あいうえお。かきくけこ。", [
    makeSuggestion({
      id: "sug_e",
      category: "convention",
      original: "あいうえお",
      original_span: { start: 0, end: 5 },
      related_suggestion_ids: ["sug_rel"],
    }),
    makeSuggestion({
      id: "sug_rel",
      category: "convention",
      original: "かきくけこ",
      original_span: { start: 6, end: 11 },
    }),
  ]);
  useAnalyzeStore.getState().editSuggestion({
    suggestion_id: "sug_e",
    suggestion_summary: "編集して採用",
    edited_text: "編集後テキスト",
  });
  const after = useAnalyzeStore.getState();
  assert.deepEqual(
    [...after.reEvaluatingSuggestionIds].sort(),
    ["sug_e", "sug_rel"],
    "edit で reEvaluating = 編集 id + related の union",
  );
});

test("clearReEvaluating: 立っている reEvaluating を空に戻す(semantic-diff skip 経路)", () => {
  // edit で reEvaluating を立てた後、semantic-diff が「同じ」と判定して refresh skip した
  // とき Canvas が clearReEvaluating() を呼ぶ経路を再現。
  seedStore("あいうえお。", [
    makeSuggestion({
      id: "sug_e",
      category: "convention",
      original: "あいうえお",
      original_span: { start: 0, end: 5 },
      related_suggestion_ids: ["sug_rel"],
    }),
    makeSuggestion({ id: "sug_rel", original_span: { start: 6, end: 11 } }),
  ]);
  useAnalyzeStore.getState().editSuggestion({
    suggestion_id: "sug_e",
    suggestion_summary: "編集して採用",
    edited_text: "編集後",
  });
  assert.ok(
    useAnalyzeStore.getState().reEvaluatingSuggestionIds.length > 0,
    "前提: edit で reEvaluating が立っている",
  );
  useAnalyzeStore.getState().clearReEvaluating();
  assert.deepEqual(
    useAnalyzeStore.getState().reEvaluatingSuggestionIds,
    [],
    "clearReEvaluating で空に戻る",
  );
});

test("setRefreshError: reEvaluating を clear(refresh エラー時)", () => {
  seedStore("あいうえお。かきくけこ。", [
    makeSuggestion({
      id: "sug_r",
      category: "convention",
      original: "あいうえお",
      original_span: { start: 0, end: 5 },
      related_suggestion_ids: ["sug_rel"],
    }),
    makeSuggestion({ id: "sug_rel", original_span: { start: 6, end: 11 } }),
  ]);
  useAnalyzeStore
    .getState()
    .rejectSuggestion({ suggestion_id: "sug_r", suggestion_summary: "拒否" });
  assert.ok(
    useAnalyzeStore.getState().reEvaluatingSuggestionIds.length > 0,
    "前提: reject で reEvaluating が立っている",
  );
  useAnalyzeStore.getState().setRefreshError({
    kind: "unknown",
    message: "テスト用 refresh エラー",
  });
  assert.deepEqual(
    useAnalyzeStore.getState().reEvaluatingSuggestionIds,
    [],
    "setRefreshError で reEvaluating clear",
  );
});

test("commitPartialRefreshCleanup: reEvaluating を clear(refresh 完了)", () => {
  // reject → reEvaluating set → refresh 完了 cleanup で clear、を store level で再現。
  seedStore("あいうえお。かきくけこ。", [
    makeSuggestion({
      id: "sug_r",
      category: "convention",
      original: "あいうえお",
      original_span: { start: 0, end: 5 },
      related_suggestion_ids: ["sug_rel"],
    }),
    makeSuggestion({ id: "sug_rel", original_span: { start: 6, end: 11 } }),
  ]);
  useAnalyzeStore
    .getState()
    .rejectSuggestion({ suggestion_id: "sug_r", suggestion_summary: "拒否" });
  assert.ok(
    useAnalyzeStore.getState().reEvaluatingSuggestionIds.length > 0,
    "前提: reject で reEvaluating が立っている",
  );
  // 2026-05-28 並行性 fix C8: commitPartialRefreshCleanup は generation 引数を取るように変更。
  //   本テストは beginRefresh を経由しないため現在の generation(初期 0)を渡す = 世代一致で
  //   従来どおり実行される(reEvaluating clear の検証内容は不変)。
  const cleanupGen = useAnalyzeStore.getState().partialRefreshGeneration;
  useAnalyzeStore.getState().commitPartialRefreshCleanup(cleanupGen);
  assert.deepEqual(
    useAnalyzeStore.getState().reEvaluatingSuggestionIds,
    [],
    "commitPartialRefreshCleanup で reEvaluating clear",
  );
});

test("resetSession: reEvaluating を clear(セッション変更)", () => {
  seedStore("あいうえお。かきくけこ。", [
    makeSuggestion({
      id: "sug_r",
      category: "convention",
      original: "あいうえお",
      original_span: { start: 0, end: 5 },
      related_suggestion_ids: ["sug_rel"],
    }),
    makeSuggestion({ id: "sug_rel", original_span: { start: 6, end: 11 } }),
  ]);
  useAnalyzeStore
    .getState()
    .rejectSuggestion({ suggestion_id: "sug_r", suggestion_summary: "拒否" });
  assert.ok(
    useAnalyzeStore.getState().reEvaluatingSuggestionIds.length > 0,
    "前提: reject で reEvaluating が立っている",
  );
  useAnalyzeStore.getState().resetSession();
  assert.deepEqual(
    useAnalyzeStore.getState().reEvaluatingSuggestionIds,
    [],
    "resetSession で reEvaluating clear",
  );
});

// =============================================================================
// G3 C3: direct-edit 中の Undo/Redo ツールバー disable(純粋関数)
// =============================================================================
process.stdout.write(
  "[G3 C3 canUndoFromToolbar / canRedoFromToolbar: direct-edit 中は disable]\n",
);

test("canUndoFromToolbar: directEditMode 中は履歴があっても false", () => {
  assert.equal(
    canUndoFromToolbar({ directEditMode: true, actionHistoryLength: 3 }),
    false,
    "直接編集中は Undo 不可(キーボードガードと同基準)",
  );
});

test("canUndoFromToolbar: 非 direct-edit + 履歴ありで true", () => {
  assert.equal(
    canUndoFromToolbar({ directEditMode: false, actionHistoryLength: 1 }),
    true,
    "直接編集 OFF + 履歴ありで Undo 可",
  );
});

test("canUndoFromToolbar: 非 direct-edit + 履歴なしで false", () => {
  assert.equal(
    canUndoFromToolbar({ directEditMode: false, actionHistoryLength: 0 }),
    false,
    "履歴が無ければ Undo 不可(従来挙動)",
  );
});

test("canRedoFromToolbar: directEditMode 中は redo stack があっても false", () => {
  assert.equal(
    canRedoFromToolbar({ directEditMode: true, redoStackLength: 2 }),
    false,
    "直接編集中は Redo 不可(キーボードガードと同基準)",
  );
});

test("canRedoFromToolbar: 非 direct-edit + redo stack ありで true", () => {
  assert.equal(
    canRedoFromToolbar({ directEditMode: false, redoStackLength: 1 }),
    true,
    "直接編集 OFF + redo stack ありで Redo 可",
  );
});

test("canRedoFromToolbar: 非 direct-edit + redo stack なしで false", () => {
  assert.equal(
    canRedoFromToolbar({ directEditMode: false, redoStackLength: 0 }),
    false,
    "redo stack が無ければ Redo 不可(従来挙動)",
  );
});

// =============================================================================
// G3 C7: expandPopCountToGroupBoundary(純粋関数)— group 境界拡張
// =============================================================================
process.stdout.write(
  "[G3 C7 expandPopCountToGroupBoundary: bulk group を 1 単位に拡張]\n",
);

test("group なしは requestedPop をそのまま返す(単体操作不変)", () => {
  const log = [{}, {}, {}]; // groupId なし
  assert.equal(expandPopCountToGroupBoundary(log, 1), 1, "通常 entry は拡張しない");
});

test("末尾の bulk group(3 件)を Undo 1 で全件に拡張", () => {
  // [単体, g, g, g] を pop=1 要求 → 末尾 group 3 件に拡張。
  const log = [{}, { groupId: "g1" }, { groupId: "g1" }, { groupId: "g1" }];
  assert.equal(
    expandPopCountToGroupBoundary(log, 1),
    3,
    "末尾 group の連続 3 件をまとめて pop",
  );
});

test("group の前に別操作があっても境界で止まる(過剰拡張しない)", () => {
  // [単体A, g, g, 単体B] を pop=1 → 末尾は単体B(group 外)なので 1 のまま。
  const log = [{}, { groupId: "g1" }, { groupId: "g1" }, {}];
  assert.equal(
    expandPopCountToGroupBoundary(log, 1),
    1,
    "末尾が group 外なら拡張しない",
  );
});

test("requestedPop が group 途中に入る場合は group 先頭まで拡張", () => {
  // [単体, g, g, g] を pop=2 要求 → 境界 index=2(group 途中)→ 先頭 index=1 まで拡張 = 3。
  const log = [{}, { groupId: "g1" }, { groupId: "g1" }, { groupId: "g1" }];
  assert.equal(
    expandPopCountToGroupBoundary(log, 2),
    3,
    "group を分断しないよう先頭まで拡張",
  );
});

test("異なる group は混ざらない(隣接 group を巻き込まない)", () => {
  // [g1, g1, g2, g2] を pop=1 → 末尾 g2 群のみ 2 件に拡張(g1 は巻き込まない)。
  const log = [
    { groupId: "g1" },
    { groupId: "g1" },
    { groupId: "g2" },
    { groupId: "g2" },
  ];
  assert.equal(
    expandPopCountToGroupBoundary(log, 1),
    2,
    "末尾 group(g2)のみ拡張、隣接 group(g1)は別単位",
  );
});

test("全件 pop 要求は length をそのまま返す", () => {
  const log = [{ groupId: "g1" }, { groupId: "g1" }];
  assert.equal(expandPopCountToGroupBoundary(log, 2), 2, "全件 pop は不変");
});

// =============================================================================
// G3 C6: revert(pending 戻し)後の Undo / Redo(store level)
// =============================================================================
process.stdout.write("[G3 C6 revert → undo で元 status 復元 / redo 対称]\n");

// convention カテゴリの suggestion を 1 件用意するヘルパ(error は自動採用で挙動が変わるため
// C6 では明示採用が必要な convention を使う)。
function seedSingleConvention(): void {
  seedStore("あいうえお。かきくけこ。", [
    makeSuggestion({
      id: "sug_c6",
      category: "convention",
      original: "あいうえお",
      proposed: "アイウエオ",
      original_span: { start: 0, end: 5 },
    }),
  ]);
}

test("採用 → revert → undo で元の採用状態に復元される", () => {
  seedSingleConvention();
  const store = useAnalyzeStore.getState();
  store.acceptSuggestion({ suggestion_id: "sug_c6", suggestion_summary: "採用" });
  assert.ok(
    useAnalyzeStore.getState().acceptedSuggestionIds.includes("sug_c6"),
    "前提: 採用済",
  );
  // 「この操作を取り消す」= pending 戻し
  store.revertSuggestionAction({
    suggestion_id: "sug_c6",
    suggestion_summary: "採用",
  });
  let s = useAnalyzeStore.getState();
  assert.ok(
    !s.acceptedSuggestionIds.includes("sug_c6") &&
      !s.rejectedSuggestionIds.includes("sug_c6") &&
      !("sug_c6" in s.editedSuggestions),
    "前提: revert で pending(どの集合にも属さない)",
  );
  assert.equal(
    s.actionHistory[s.actionHistory.length - 1]?.verb,
    "PENDING",
    "前提: PENDING entry が積まれている",
  );
  // ツールバー Undo 相当
  store.undo(1);
  s = useAnalyzeStore.getState();
  assert.ok(
    s.acceptedSuggestionIds.includes("sug_c6"),
    "C6: revert の undo で元の採用状態に復元される",
  );
  assert.ok(
    !s.rejectedSuggestionIds.includes("sug_c6"),
    "却下集合には入っていない",
  );
});

test("採用 → revert → undo → redo で再び pending に戻る(対称)", () => {
  seedSingleConvention();
  const store = useAnalyzeStore.getState();
  store.acceptSuggestion({ suggestion_id: "sug_c6", suggestion_summary: "採用" });
  store.revertSuggestionAction({
    suggestion_id: "sug_c6",
    suggestion_summary: "採用",
  });
  store.undo(1); // 採用に復元
  assert.ok(
    useAnalyzeStore.getState().acceptedSuggestionIds.includes("sug_c6"),
    "前提: undo で採用復元済",
  );
  store.redo(1); // 再び revert(pending)
  const s = useAnalyzeStore.getState();
  assert.ok(
    !s.acceptedSuggestionIds.includes("sug_c6") &&
      !s.rejectedSuggestionIds.includes("sug_c6") &&
      !("sug_c6" in s.editedSuggestions),
    "C6 redo 対称: 再び pending(どの集合にも属さない)に戻る",
  );
});

test("却下 → revert → undo で元の却下状態に復元される", () => {
  seedSingleConvention();
  const store = useAnalyzeStore.getState();
  store.rejectSuggestion({ suggestion_id: "sug_c6", suggestion_summary: "却下" });
  assert.ok(
    useAnalyzeStore.getState().rejectedSuggestionIds.includes("sug_c6"),
    "前提: 却下済",
  );
  store.revertSuggestionAction({
    suggestion_id: "sug_c6",
    suggestion_summary: "却下",
  });
  store.undo(1);
  const s = useAnalyzeStore.getState();
  assert.ok(
    s.rejectedSuggestionIds.includes("sug_c6"),
    "C6: revert の undo で元の却下状態に復元される",
  );
  assert.ok(
    !s.acceptedSuggestionIds.includes("sug_c6"),
    "採用集合には入っていない",
  );
});

test("編集して採用 → revert → undo で元の編集テキストに復元される", () => {
  seedSingleConvention();
  const store = useAnalyzeStore.getState();
  store.editSuggestion({
    suggestion_id: "sug_c6",
    suggestion_summary: "編集",
    edited_text: "編集後テキスト",
  });
  assert.equal(
    useAnalyzeStore.getState().editedSuggestions["sug_c6"],
    "編集後テキスト",
    "前提: 編集済",
  );
  store.revertSuggestionAction({
    suggestion_id: "sug_c6",
    suggestion_summary: "編集",
  });
  assert.ok(
    !("sug_c6" in useAnalyzeStore.getState().editedSuggestions),
    "前提: revert で編集集合から外れた",
  );
  store.undo(1);
  assert.equal(
    useAnalyzeStore.getState().editedSuggestions["sug_c6"],
    "編集後テキスト",
    "C6: revert の undo で元の編集テキストに復元される",
  );
});

test("自動修正(error)を revert → undo で accepted + autoCorrected の両方に復元(C6×自動修正)", () => {
  // error 1 件 = setAnalysisResult で accepted + autoCorrected の両方に自動展開される。
  seedStore("あいう。", [
    makeSuggestion({
      id: "err_c6",
      category: "error",
      original: "あいう",
      proposed: "アイウ",
      original_span: { start: 0, end: 3 },
    }),
  ]);
  const store = useAnalyzeStore.getState();
  let s = useAnalyzeStore.getState();
  assert.ok(
    s.acceptedSuggestionIds.includes("err_c6") &&
      s.autoCorrectedSuggestionIds.includes("err_c6"),
    "前提: error は accepted + autoCorrected の両方に展開",
  );
  store.revertSuggestionAction({
    suggestion_id: "err_c6",
    suggestion_summary: "自動修正",
  });
  s = useAnalyzeStore.getState();
  assert.ok(
    !s.acceptedSuggestionIds.includes("err_c6") &&
      !s.autoCorrectedSuggestionIds.includes("err_c6"),
    "前提: revert で両集合から外れる(pending)",
  );
  store.undo(1);
  s = useAnalyzeStore.getState();
  assert.ok(
    s.acceptedSuggestionIds.includes("err_c6"),
    "C6: undo で accepted 復元",
  );
  assert.ok(
    s.autoCorrectedSuggestionIds.includes("err_c6"),
    "C6: undo で autoCorrected も復元(自動修正バナー表示が戻る)",
  );
  // 二重追加が無いこと(idempotent)。
  assert.equal(
    s.acceptedSuggestionIds.filter((id) => id === "err_c6").length,
    1,
    "accepted に二重追加されない",
  );
  assert.equal(
    s.autoCorrectedSuggestionIds.filter((id) => id === "err_c6").length,
    1,
    "autoCorrected に二重追加されない",
  );
});

// =============================================================================
// G3 C7: 「全て元に戻す」(自動修正一括取り消し)の Undo を 1 回で全件(store level)
// =============================================================================
process.stdout.write("[G3 C7 一括取り消し → undo 1 回で全件復元 / redo 対称]\n");

// error カテゴリ複数 → setAnalysisResult が accepted + autoCorrected に自動展開する。
function seedThreeAutoCorrections(): void {
  seedStore("あいう。えお。かき。", [
    makeSuggestion({
      id: "err_1",
      category: "error",
      original: "あいう",
      proposed: "アイウ",
      original_span: { start: 0, end: 3 },
    }),
    makeSuggestion({
      id: "err_2",
      category: "error",
      original: "えお",
      proposed: "エオ",
      original_span: { start: 4, end: 6 },
    }),
    makeSuggestion({
      id: "err_3",
      category: "error",
      original: "かき",
      proposed: "カキ",
      original_span: { start: 7, end: 9 },
    }),
  ]);
}

test("前提: error 3 件は自動採用 + 自動修正される", () => {
  seedThreeAutoCorrections();
  const s = useAnalyzeStore.getState();
  assert.deepEqual(
    [...s.autoCorrectedSuggestionIds].sort(),
    ["err_1", "err_2", "err_3"],
    "error 3 件が autoCorrected に展開",
  );
  assert.deepEqual(
    [...s.acceptedSuggestionIds].sort(),
    ["err_1", "err_2", "err_3"],
    "error 3 件が accepted にも展開",
  );
});

test("一括取り消し → undo 1 回で 3 件すべて自動修正に復元(C7)", () => {
  seedThreeAutoCorrections();
  const store = useAnalyzeStore.getState();
  const inputs = useAnalyzeStore
    .getState()
    .autoCorrectedSuggestionIds.map((id) => ({
      suggestion_id: id,
      suggestion_summary: `auto ${id}`,
    }));
  store.undoAllAutoCorrections(inputs);
  let s = useAnalyzeStore.getState();
  // 一括取り消し後: 3 件すべて却下、autoCorrected/accepted から外れる。
  assert.deepEqual(
    [...s.rejectedSuggestionIds].sort(),
    ["err_1", "err_2", "err_3"],
    "前提: 一括取り消しで 3 件却下",
  );
  assert.equal(s.autoCorrectedSuggestionIds.length, 0, "前提: autoCorrected 空");
  // actionHistory には REJECTED entry が 3 件積まれている。
  const rejectedEntries = s.actionHistory.filter((e) => e.verb === "REJECTED");
  assert.equal(rejectedEntries.length, 3, "前提: REJECTED entry が 3 件");
  // ツールバー Undo 相当(undo(1))= group 拡張で 3 件まとめて戻る。
  store.undo(1);
  s = useAnalyzeStore.getState();
  assert.deepEqual(
    [...s.autoCorrectedSuggestionIds].sort(),
    ["err_1", "err_2", "err_3"],
    "C7: undo 1 回で 3 件すべて自動修正に復元",
  );
  assert.deepEqual(
    [...s.acceptedSuggestionIds].sort(),
    ["err_1", "err_2", "err_3"],
    "C7: 採用集合にも 3 件すべて復元",
  );
  assert.equal(
    s.rejectedSuggestionIds.length,
    0,
    "C7: 却下集合は空に戻る(全件復元)",
  );
});

test("一括取り消し → undo → redo で再び 3 件すべて却下(C7 対称)", () => {
  seedThreeAutoCorrections();
  const store = useAnalyzeStore.getState();
  const inputs = useAnalyzeStore
    .getState()
    .autoCorrectedSuggestionIds.map((id) => ({
      suggestion_id: id,
      suggestion_summary: `auto ${id}`,
    }));
  store.undoAllAutoCorrections(inputs);
  store.undo(1); // 全件復元
  assert.equal(
    useAnalyzeStore.getState().autoCorrectedSuggestionIds.length,
    3,
    "前提: undo で 3 件復元済",
  );
  store.redo(1); // group 拡張で 3 件まとめて再却下
  const s = useAnalyzeStore.getState();
  assert.deepEqual(
    [...s.rejectedSuggestionIds].sort(),
    ["err_1", "err_2", "err_3"],
    "C7 redo 対称: redo 1 回で 3 件すべて再び却下",
  );
  assert.equal(
    s.autoCorrectedSuggestionIds.length,
    0,
    "C7 redo 対称: autoCorrected は再び空",
  );
});

// =============================================================================
// G3 非干渉: 既存の単体 accept/reject/edit の undo/redo が壊れていないこと
// =============================================================================
process.stdout.write("[G3 非干渉: 単体 accept/reject/edit の undo/redo 不変]\n");

test("単体採用 → undo(1) で採用が外れる(group 拡張に巻き込まれない)", () => {
  seedSingleConvention();
  const store = useAnalyzeStore.getState();
  store.acceptSuggestion({ suggestion_id: "sug_c6", suggestion_summary: "採用" });
  store.undo(1);
  assert.ok(
    !useAnalyzeStore.getState().acceptedSuggestionIds.includes("sug_c6"),
    "単体採用の undo は従来どおり 1 件だけ戻す",
  );
});

test("単体採用 → undo → redo で採用が復活(従来対称)", () => {
  seedSingleConvention();
  const store = useAnalyzeStore.getState();
  store.acceptSuggestion({ suggestion_id: "sug_c6", suggestion_summary: "採用" });
  store.undo(1);
  store.redo(1);
  assert.ok(
    useAnalyzeStore.getState().acceptedSuggestionIds.includes("sug_c6"),
    "単体採用の redo は従来どおり採用を復活",
  );
});

test("複数単体操作 → undo(1) は最新 1 件だけ戻す(group なしは非拡張)", () => {
  // 2 件の convention を別々に採用 → undo(1) は最新の 1 件のみ戻すこと。
  seedStore("あいうえお。かきくけこ。", [
    makeSuggestion({
      id: "sug_p",
      category: "convention",
      original: "あいうえお",
      proposed: "アイウエオ",
      original_span: { start: 0, end: 5 },
    }),
    makeSuggestion({
      id: "sug_q",
      category: "convention",
      original: "かきくけこ",
      proposed: "カキクケコ",
      original_span: { start: 6, end: 11 },
    }),
  ]);
  const store = useAnalyzeStore.getState();
  store.acceptSuggestion({ suggestion_id: "sug_p", suggestion_summary: "p" });
  store.acceptSuggestion({ suggestion_id: "sug_q", suggestion_summary: "q" });
  store.undo(1);
  const s = useAnalyzeStore.getState();
  assert.ok(
    s.acceptedSuggestionIds.includes("sug_p"),
    "最初の採用(sug_p)は残る",
  );
  assert.ok(
    !s.acceptedSuggestionIds.includes("sug_q"),
    "最新の採用(sug_q)だけ戻る(group 拡張に巻き込まれない)",
  );
});

// =============================================================================
// N5 (2026-05-30): 却下の Undo が「却下時点の自動修正フラグ snapshot」で復元すること。
//   間に refresh が走って analysisResult が差し替わっても、復元状態がずれない。
// =============================================================================
process.stdout.write(
  "[N5 却下 undo: 却下時点 snapshot で復元(refresh で result 差替後も不変)]\n",
);

// refresh が analysisResult を「同 id だが別カテゴリ / 別原文」に差し替える状況を
// 直接 set で模す(actionHistory / rejectedSuggestionIds は据え置き = 実際の partial
// refresh の merge と同じ性質)。store の他フィールドは触らない。
function swapAnalysisResult(suggestions: Suggestion[]): void {
  useAnalyzeStore.setState({ analysisResult: makeResult(suggestions) });
}

test("自動修正(error)を reject → refresh で result 差替(error→convention)→ undo で自動修正に復元(N5)", () => {
  // error 1 件 = setAnalysisResult で accepted + autoCorrected に自動展開。
  seedStore("あいう。", [
    makeSuggestion({
      id: "err_n5",
      category: "error",
      original: "あいう",
      proposed: "アイウ",
      original_span: { start: 0, end: 3 },
    }),
  ]);
  const store = useAnalyzeStore.getState();
  // ユーザーが自動修正を却下(rejectSuggestion 経路)。却下時点で rejectedWasAutoError=true。
  store.rejectSuggestion({ suggestion_id: "err_n5", suggestion_summary: "却下" });
  let s = useAnalyzeStore.getState();
  assert.ok(
    s.rejectedSuggestionIds.includes("err_n5") &&
      !s.acceptedSuggestionIds.includes("err_n5") &&
      !s.autoCorrectedSuggestionIds.includes("err_n5"),
    "前提: 却下で rejected のみ",
  );
  // ここで refresh が走り、同 id の category が convention に変わったと仮定(error 消滅)。
  swapAnalysisResult([
    makeSuggestion({
      id: "err_n5",
      category: "convention",
      original: "あいう",
      proposed: "アイウ",
      original_span: { start: 0, end: 3 },
    }),
  ]);
  // undo: 旧実装は **現在の** result(convention)を見て自動修正と判定できず、pending の
  // ままになっていた。N5 では却下時点 snapshot(=error)を読み accepted + autoCorrected に復元。
  store.undo(1);
  s = useAnalyzeStore.getState();
  assert.ok(
    s.acceptedSuggestionIds.includes("err_n5"),
    "N5: result 差替後でも却下時点 snapshot で accepted 復元",
  );
  assert.ok(
    s.autoCorrectedSuggestionIds.includes("err_n5"),
    "N5: 同じく autoCorrected も復元(自動修正バナーが正しく戻る)",
  );
  assert.ok(
    !s.rejectedSuggestionIds.includes("err_n5"),
    "N5: rejected から外れる",
  );
});

test("自動修正(error)を reject → refresh で id 消滅 → undo で自動修正に復元(N5)", () => {
  seedStore("あいう。えお。", [
    makeSuggestion({
      id: "err_gone",
      category: "error",
      original: "あいう",
      proposed: "アイウ",
      original_span: { start: 0, end: 3 },
    }),
  ]);
  const store = useAnalyzeStore.getState();
  store.rejectSuggestion({
    suggestion_id: "err_gone",
    suggestion_summary: "却下",
  });
  // refresh が err_gone を削除し、無関係の suggestion だけ残ったと仮定。
  swapAnalysisResult([
    makeSuggestion({
      id: "other",
      category: "convention",
      original: "えお",
      proposed: "エオ",
      original_span: { start: 4, end: 6 },
    }),
  ]);
  store.undo(1);
  const s = useAnalyzeStore.getState();
  assert.ok(
    s.acceptedSuggestionIds.includes("err_gone") &&
      s.autoCorrectedSuggestionIds.includes("err_gone"),
    "N5: live result から消えても snapshot で自動修正に復元",
  );
});

test("手動却下した convention は refresh 差替後も自動修正に昇格しない(N5 false-positive 防止)", () => {
  // convention を手動却下 → rejectedWasAutoError=false が snapshot される。
  // その後 refresh で同 id が error に変わっても、却下の undo は **却下時点(convention)** を
  // 真として pending(rejected から外すだけ)に戻し、誤って autoCorrected に昇格させない。
  seedStore("あいうえお。", [
    makeSuggestion({
      id: "conv_n5",
      category: "convention",
      original: "あいうえお",
      proposed: "アイウエオ",
      original_span: { start: 0, end: 5 },
    }),
  ]);
  const store = useAnalyzeStore.getState();
  store.rejectSuggestion({ suggestion_id: "conv_n5", suggestion_summary: "却下" });
  // refresh が同 id を error に再分類(現在の result は error)。
  swapAnalysisResult([
    makeSuggestion({
      id: "conv_n5",
      category: "error",
      original: "あいうえお",
      proposed: "アイウエオ",
      original_span: { start: 0, end: 5 },
    }),
  ]);
  store.undo(1);
  const s = useAnalyzeStore.getState();
  assert.ok(
    !s.rejectedSuggestionIds.includes("conv_n5"),
    "N5: 却下の undo で rejected から外れる(pending に戻る)",
  );
  assert.ok(
    !s.autoCorrectedSuggestionIds.includes("conv_n5"),
    "N5: 却下時点は convention → 現在の error に釣られて autoCorrected 昇格しない",
  );
  assert.ok(
    !s.acceptedSuggestionIds.includes("conv_n5"),
    "N5: accepted にも入らない(手動却下の undo は素直に pending)",
  );
});

// テスト終了後に store を初期化(他テストへの汚染防止、念のため)。
useAnalyzeStore.getState().resetSession();

// =============================================================================
// summary
// =============================================================================
process.stdout.write(`\nResults: ${passCount} pass / ${failCount} fail\n`);
if (failCount > 0) {
  process.stdout.write("\nFailures:\n");
  for (const f of failures) {
    process.stdout.write(f + "\n");
  }
  process.exit(1);
}
process.exit(0);
