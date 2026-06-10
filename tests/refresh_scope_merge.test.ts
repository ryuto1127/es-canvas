/**
 * mergeRefreshScope — pendingRefreshScope の union マージ純関数テスト。
 *
 * 提出後改善 #2 (2026-06-09): 楽観的並行制御で in-flight refresh を後続操作が abort する際、
 * 従来は `pendingRefreshScope` が上書きされ、先行操作の scoped 再評価が無言で消えていた。
 * mergeRefreshScope は上書きの代わりに union マージし、未消化 scope を引き継ぐ。
 *
 * 本テストが担保する不変条件(SSOT: lib/state/analyze_store.ts:mergeRefreshScope):
 *  - seedIds は和集合(上書きされない、重複除去、順序安定)
 *  - kind 優先則: full > scoped(どちらかが full なら full)
 *  - reason は最新(next)を採る
 *  - editBefore / editAfter は next 優先・無ければ prev 温存
 *  - prev === null は next をそのまま返す(初回操作 = 従来挙動)
 *  - 入力を mutate しない(immutable)
 *
 * 実行方法: `tsx tests/refresh_scope_merge.test.ts`(net 呼び出しなし、ローカル即時実行)
 */

import { strict as assert } from "node:assert";
import {
  mergeRefreshScope,
  mergeReEvaluatingIds,
  type PendingRefreshScope,
} from "@/lib/state/analyze_store";

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
// prev === null
// -----------------------------------------------------------------------------
test("prev が null なら next をそのまま返す(初回操作 = 従来挙動)", () => {
  const next: PendingRefreshScope = {
    kind: "scoped",
    seedIds: ["sug_001"],
    reason: "reject",
  };
  const merged = mergeRefreshScope(null, next);
  assert.deepEqual(merged, next);
});

// -----------------------------------------------------------------------------
// seedIds は和集合(上書きされない)
// -----------------------------------------------------------------------------
test("seedIds は union(先行 seed が上書きされず引き継がれる)", () => {
  const prev: PendingRefreshScope = {
    kind: "scoped",
    seedIds: ["sug_001", "sug_002"],
    reason: "reject",
  };
  const next: PendingRefreshScope = {
    kind: "scoped",
    seedIds: ["sug_003"],
    reason: "reject",
  };
  const merged = mergeRefreshScope(prev, next);
  assert.deepEqual(merged.seedIds, ["sug_001", "sug_002", "sug_003"]);
});

test("seedIds の重複は除去される(順序は prev → next の初出順)", () => {
  const prev: PendingRefreshScope = {
    kind: "scoped",
    seedIds: ["sug_001", "sug_002"],
    reason: "reject",
  };
  const next: PendingRefreshScope = {
    kind: "scoped",
    seedIds: ["sug_002", "sug_004"],
    reason: "undo",
  };
  const merged = mergeRefreshScope(prev, next);
  assert.deepEqual(merged.seedIds, ["sug_001", "sug_002", "sug_004"]);
});

test("空 seedIds 同士の union は空(manual 系の連続)", () => {
  const prev: PendingRefreshScope = {
    kind: "scoped",
    seedIds: [],
    reason: "manual",
  };
  const next: PendingRefreshScope = {
    kind: "scoped",
    seedIds: [],
    reason: "manual",
  };
  const merged = mergeRefreshScope(prev, next);
  assert.deepEqual(merged.seedIds, []);
});

test("prev に seed、next が空 seed でも prev の seed が消えない", () => {
  const prev: PendingRefreshScope = {
    kind: "scoped",
    seedIds: ["sug_009"],
    reason: "reject",
  };
  const next: PendingRefreshScope = {
    kind: "scoped",
    seedIds: [],
    reason: "manual",
  };
  const merged = mergeRefreshScope(prev, next);
  assert.deepEqual(merged.seedIds, ["sug_009"]);
});

// -----------------------------------------------------------------------------
// kind 優先則: full > scoped
// -----------------------------------------------------------------------------
test("kind: prev=scoped + next=full → full", () => {
  const prev: PendingRefreshScope = {
    kind: "scoped",
    seedIds: ["sug_001"],
    reason: "reject",
  };
  const next: PendingRefreshScope = {
    kind: "full",
    seedIds: [],
    reason: "manual",
  };
  const merged = mergeRefreshScope(prev, next);
  assert.equal(merged.kind, "full");
  // full に格上げされても先行 seed は union で残る(全体再分析が吸収する)
  assert.deepEqual(merged.seedIds, ["sug_001"]);
});

test("kind: prev=full + next=scoped → full(full が後続 scoped を包含)", () => {
  const prev: PendingRefreshScope = {
    kind: "full",
    seedIds: [],
    reason: "manual",
  };
  const next: PendingRefreshScope = {
    kind: "scoped",
    seedIds: ["sug_005"],
    reason: "reject",
  };
  const merged = mergeRefreshScope(prev, next);
  assert.equal(merged.kind, "full");
  assert.deepEqual(merged.seedIds, ["sug_005"]);
});

test("kind: scoped + scoped → scoped", () => {
  const prev: PendingRefreshScope = {
    kind: "scoped",
    seedIds: ["sug_001"],
    reason: "reject",
  };
  const next: PendingRefreshScope = {
    kind: "scoped",
    seedIds: ["sug_002"],
    reason: "edit",
  };
  const merged = mergeRefreshScope(prev, next);
  assert.equal(merged.kind, "scoped");
});

test("kind: full + full → full", () => {
  const prev: PendingRefreshScope = {
    kind: "full",
    seedIds: [],
    reason: "manual",
  };
  const next: PendingRefreshScope = {
    kind: "full",
    seedIds: [],
    reason: "manual",
  };
  assert.equal(mergeRefreshScope(prev, next).kind, "full");
});

// -----------------------------------------------------------------------------
// reason は最新(next)を採る
// -----------------------------------------------------------------------------
test("reason は next を代表値に採る(直近の操作意図)", () => {
  const prev: PendingRefreshScope = {
    kind: "scoped",
    seedIds: ["sug_001"],
    reason: "reject",
  };
  const next: PendingRefreshScope = {
    kind: "scoped",
    seedIds: ["sug_002"],
    reason: "undo",
  };
  assert.equal(mergeRefreshScope(prev, next).reason, "undo");
});

// -----------------------------------------------------------------------------
// editBefore / editAfter: next 優先・無ければ prev 温存
// -----------------------------------------------------------------------------
test("editBefore/editAfter: next が持っていれば next を採る", () => {
  const prev: PendingRefreshScope = {
    kind: "scoped",
    seedIds: ["sug_001"],
    reason: "edit",
    editBefore: "古い前",
    editAfter: "古い後",
  };
  const next: PendingRefreshScope = {
    kind: "scoped",
    seedIds: ["sug_002"],
    reason: "edit",
    editBefore: "新しい前",
    editAfter: "新しい後",
  };
  const merged = mergeRefreshScope(prev, next);
  assert.equal(merged.editBefore, "新しい前");
  assert.equal(merged.editAfter, "新しい後");
});

test("editBefore/editAfter: next に無ければ prev のものを温存", () => {
  const prev: PendingRefreshScope = {
    kind: "scoped",
    seedIds: ["sug_001"],
    reason: "edit",
    editBefore: "前テキスト",
    editAfter: "後テキスト",
  };
  const next: PendingRefreshScope = {
    kind: "scoped",
    seedIds: ["sug_002"],
    reason: "reject", // reject は edit 差分を持たない
  };
  const merged = mergeRefreshScope(prev, next);
  assert.equal(merged.editBefore, "前テキスト");
  assert.equal(merged.editAfter, "後テキスト");
});

test("editBefore/editAfter: 両方無ければ merged にキーが現れない", () => {
  const prev: PendingRefreshScope = {
    kind: "scoped",
    seedIds: ["sug_001"],
    reason: "reject",
  };
  const next: PendingRefreshScope = {
    kind: "scoped",
    seedIds: ["sug_002"],
    reason: "undo",
  };
  const merged = mergeRefreshScope(prev, next);
  assert.equal("editBefore" in merged, false);
  assert.equal("editAfter" in merged, false);
});

// -----------------------------------------------------------------------------
// immutability
// -----------------------------------------------------------------------------
test("入力を mutate しない(prev / next の seedIds は不変)", () => {
  const prev: PendingRefreshScope = {
    kind: "scoped",
    seedIds: ["sug_001"],
    reason: "reject",
  };
  const next: PendingRefreshScope = {
    kind: "scoped",
    seedIds: ["sug_002"],
    reason: "reject",
  };
  const merged = mergeRefreshScope(prev, next);
  assert.deepEqual(prev.seedIds, ["sug_001"]);
  assert.deepEqual(next.seedIds, ["sug_002"]);
  // merged は新しい配列(prev/next の配列参照ではない)
  assert.notEqual(merged.seedIds, prev.seedIds);
  assert.notEqual(merged.seedIds, next.seedIds);
});

// -----------------------------------------------------------------------------
// 連鎖マージ(高速連続操作のシミュレーション)
// -----------------------------------------------------------------------------
test("連鎖マージ: reject → reject → undo の seed が全部蓄積する", () => {
  // refresh より速く 3 操作した状況。in-flight 中に scope が蓄積される。
  let scope: PendingRefreshScope | null = null;
  scope = mergeRefreshScope(scope, {
    kind: "scoped",
    seedIds: ["sug_001"],
    reason: "reject",
  });
  scope = mergeRefreshScope(scope, {
    kind: "scoped",
    seedIds: ["sug_002"],
    reason: "reject",
  });
  scope = mergeRefreshScope(scope, {
    kind: "scoped",
    seedIds: ["sug_003"],
    reason: "undo",
  });
  assert.deepEqual(scope.seedIds, ["sug_001", "sug_002", "sug_003"]);
  assert.equal(scope.kind, "scoped");
  assert.equal(scope.reason, "undo");
});

test("連鎖マージ: 途中で full が来たら以降 full、seed は累積維持", () => {
  let scope: PendingRefreshScope | null = null;
  scope = mergeRefreshScope(scope, {
    kind: "scoped",
    seedIds: ["sug_001"],
    reason: "reject",
  });
  scope = mergeRefreshScope(scope, {
    kind: "full",
    seedIds: [],
    reason: "manual",
  });
  scope = mergeRefreshScope(scope, {
    kind: "scoped",
    seedIds: ["sug_007"],
    reason: "reject",
  });
  assert.equal(scope.kind, "full");
  assert.deepEqual(scope.seedIds, ["sug_001", "sug_007"]);
});

// -----------------------------------------------------------------------------
// mergeReEvaluatingIds — 再評価中バッジの union 整合(scope と判定軸を一致させる)
// -----------------------------------------------------------------------------
const scopedScope: PendingRefreshScope = {
  kind: "scoped",
  seedIds: ["sug_001"],
  reason: "reject",
};

test("reEvaluating: prevScope === null なら今回分のみ(消化済 = union しない)", () => {
  const merged = mergeReEvaluatingIds(null, ["sug_001"], ["sug_002"]);
  assert.deepEqual(merged, ["sug_002"]);
});

test("reEvaluating: prevScope 非 null(未消化)なら先行と union(バッジが消えない)", () => {
  const merged = mergeReEvaluatingIds(
    scopedScope,
    ["sug_001"],
    ["sug_002"],
  );
  assert.deepEqual(merged, ["sug_001", "sug_002"]);
});

test("reEvaluating: union の重複は除去される", () => {
  const merged = mergeReEvaluatingIds(
    scopedScope,
    ["sug_001", "sug_002"],
    ["sug_002", "sug_003"],
  );
  assert.deepEqual(merged, ["sug_001", "sug_002", "sug_003"]);
});

test("reEvaluating: 判定軸が scope マージと一致(prevScope null → 蒸し返さない)", () => {
  // scope が消化済(null)= 前の refresh が完了してバッジも clear 済。
  // 古い prevReEvaluating を渡しても今回分しか残らない。
  const merged = mergeReEvaluatingIds(null, ["古い_sug"], ["新_sug"]);
  assert.equal(merged.includes("古い_sug"), false);
  assert.deepEqual(merged, ["新_sug"]);
});

test("reEvaluating: 入力を mutate しない", () => {
  const prev = ["sug_001"];
  const next = ["sug_002"];
  mergeReEvaluatingIds(scopedScope, prev, next);
  assert.deepEqual(prev, ["sug_001"]);
  assert.deepEqual(next, ["sug_002"]);
});

// --- 結果出力 ---
process.stdout.write(`\n${passCount} passed, ${failCount} failed\n`);
if (failCount > 0) {
  process.stdout.write(`\n${failures.join("\n")}\n`);
  process.exit(1);
}
