/**
 * v2 Phase B3 (2026-05-26): structural_ops.ts のユニットテスト
 *
 * lib/state/structural_ops.ts の純粋関数(splitParagraphs / splitSentences /
 * applyStructuralOperation)に対する境界と 5 operations の検証。
 *
 * 実行方法: `pnpm test:structural`(net 呼び出しなし、ローカル即時実行)
 *
 * 前提:
 *  - structural_ops は副作用なし純粋関数 = ネットワーク / dev server 不要
 *  - tsx ベースの既存 test pattern と同じく assert で結果確認
 *  - tsc strict / lint pass を維持(コメント内のテンプレートリテラル類を回避)
 *
 * SSOT:
 *  - lib/state/structural_ops.ts
 *  - lib/schema/suggestion.ts:StructuralOperationParamsSchema(Phase B1)
 *  - DECISIONS.md [2026-05-26] v2 Phase B3 実装結果
 */

import { strict as assert } from "node:assert";
import {
  applyStructuralOperation,
  splitParagraphs,
  splitSentences,
} from "@/lib/state/structural_ops";

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

// =============================================================================
// splitParagraphs
// =============================================================================
process.stdout.write("[splitParagraphs]\n");

test("splits by double newline", () => {
  assert.deepEqual(splitParagraphs("段落1\n\n段落2\n\n段落3"), [
    "段落1",
    "段落2",
    "段落3",
  ]);
});

test("collapses multiple blank lines", () => {
  assert.deepEqual(splitParagraphs("段落1\n\n\n\n段落2"), ["段落1", "段落2"]);
});

test("returns single paragraph when no double newline", () => {
  assert.deepEqual(splitParagraphs("単一段落、改行なし"), ["単一段落、改行なし"]);
});

test("filters empty/whitespace-only paragraphs", () => {
  assert.deepEqual(splitParagraphs("A\n\n   \n\nB"), ["A", "B"]);
});

test("handles empty string", () => {
  assert.deepEqual(splitParagraphs(""), []);
});

// =============================================================================
// splitSentences
// =============================================================================
process.stdout.write("[splitSentences]\n");

test("splits by 。 / ! / ? and keeps punctuation", () => {
  assert.deepEqual(splitSentences("これは文1。文2!文3?"), [
    "これは文1。",
    "文2!",
    "文3?",
  ]);
});

test("keeps trailing sentence without punctuation", () => {
  assert.deepEqual(splitSentences("文1。文2"), ["文1。", "文2"]);
});

test("returns single sentence when no punctuation", () => {
  assert.deepEqual(splitSentences("句読点なし"), ["句読点なし"]);
});

test("handles empty paragraph", () => {
  assert.deepEqual(splitSentences(""), []);
});

test("preserves inter-sentence whitespace on the preceding sentence (N3 lossless)", () => {
  // 2026-05-30 N3 lossless 化: 「文1。  文2。」のような「句読点と次本文の間の空白」は、
  // 区切り `[。!?]\s*` のキャプチャで **前の文の末尾に保持** される。旧実装は \s* を
  // キャプチャ外で消費して空白を捨てていた(lossy)。split → join("") の round-trip 性を
  // 担保するため、空白は前文に残す。
  assert.deepEqual(splitSentences("文1。  文2。"), ["文1。  ", "文2。"]);
});

test("round-trips losslessly via join('') (N3)", () => {
  // 2026-05-30 N3: split → join("") が元の文字列を完全復元すること(空白・改行も保持)。
  const inputs = ["文1。  文2。", "A。\nB。", "句読点なし", "文1。文2!文3?"];
  for (const input of inputs) {
    assert.equal(
      splitSentences(input).join(""),
      input,
      `round-trip 失敗: ${JSON.stringify(input)}`,
    );
  }
});

test("preserves punctuation-only token when consecutive punctuation appears (N3)", () => {
  // 「文1。   。文2」のような病的入力。区切り `[。!?]\s*` で「。   」「。」がキャプチャされ、
  // 結果 ["文1", "。   ", "", "。", "文2"] となる。実装は body+delim を pair で結合する
  // ため、["文1。   ", "。", "文2"](空白は前文に保持)。
  // structural の通常 use case では発生しないが、純粋関数の挙動を documentation。
  assert.deepEqual(splitSentences("文1。   。文2"), ["文1。   ", "。", "文2"]);
});

// =============================================================================
// applyStructuralOperation: delete_paragraph
// =============================================================================
process.stdout.write("[applyStructuralOperation: delete_paragraph]\n");

test("delete_paragraph removes target paragraph", () => {
  const result = applyStructuralOperation("段落1\n\n段落2\n\n段落3", {
    operation: "delete_paragraph",
    target_paragraph_index: 1,
  });
  assert.equal(result, "段落1\n\n段落3");
});

test("delete_paragraph removes first paragraph", () => {
  const result = applyStructuralOperation("段落1\n\n段落2", {
    operation: "delete_paragraph",
    target_paragraph_index: 0,
  });
  assert.equal(result, "段落2");
});

test("delete_paragraph returns esBody unchanged when index out of range", () => {
  const original = "A\n\nB";
  const result = applyStructuralOperation(original, {
    operation: "delete_paragraph",
    target_paragraph_index: 99,
  });
  assert.equal(result, original);
});

test("delete_paragraph last paragraph yields single paragraph", () => {
  const result = applyStructuralOperation("A\n\nB", {
    operation: "delete_paragraph",
    target_paragraph_index: 1,
  });
  assert.equal(result, "A");
});

// =============================================================================
// applyStructuralOperation: reorder_paragraphs
// =============================================================================
process.stdout.write("[applyStructuralOperation: reorder_paragraphs]\n");

test("reorder_paragraphs swaps order", () => {
  const result = applyStructuralOperation("A\n\nB\n\nC", {
    operation: "reorder_paragraphs",
    new_order: [2, 0, 1],
  });
  assert.equal(result, "C\n\nA\n\nB");
});

test("reorder_paragraphs identity returns same body", () => {
  const result = applyStructuralOperation("A\n\nB\n\nC", {
    operation: "reorder_paragraphs",
    new_order: [0, 1, 2],
  });
  assert.equal(result, "A\n\nB\n\nC");
});

test("reorder_paragraphs returns esBody unchanged when length mismatch", () => {
  const original = "A\n\nB\n\nC";
  const result = applyStructuralOperation(original, {
    operation: "reorder_paragraphs",
    new_order: [0, 1], // 2 段落しか指定していない = 3 段落と長さ不一致
  });
  assert.equal(result, original);
});

test("reorder_paragraphs returns esBody unchanged when index out of range", () => {
  const original = "A\n\nB";
  const result = applyStructuralOperation(original, {
    operation: "reorder_paragraphs",
    new_order: [0, 99],
  });
  assert.equal(result, original);
});

test("reorder_paragraphs returns esBody unchanged when duplicate index", () => {
  const original = "A\n\nB\n\nC";
  const result = applyStructuralOperation(original, {
    operation: "reorder_paragraphs",
    new_order: [0, 0, 1], // 重複は permutation 違反
  });
  assert.equal(result, original);
});

// =============================================================================
// applyStructuralOperation: merge_paragraphs
// =============================================================================
process.stdout.write("[applyStructuralOperation: merge_paragraphs]\n");

// 2026-05-30 N3 融合防止: 段落が句点で終わらない場合、無区切り連結だと文が融合するため、
// joinParagraphContents が境界に半角スペース 1 つを挿入する。"A" / "B" / "C" は句点なし
// プレースホルダのため、統合結果は "A B" のように空白区切りになる(期待値を更新)。
test("merge_paragraphs concatenates consecutive paragraphs with boundary space (N3)", () => {
  const result = applyStructuralOperation("A\n\nB\n\nC", {
    operation: "merge_paragraphs",
    target_paragraph_indices: [0, 1],
  });
  assert.equal(result, "A B\n\nC");
});

test("merge_paragraphs concatenates non-consecutive paragraphs at min index (N3 boundary space)", () => {
  // [0, 2] を統合 → A+C(出現順)、min index = 0 の位置に挿入、B はそのまま残る
  const result = applyStructuralOperation("A\n\nB\n\nC", {
    operation: "merge_paragraphs",
    target_paragraph_indices: [0, 2],
  });
  assert.equal(result, "A C\n\nB");
});

test("merge_paragraphs preserves order regardless of indices order (N3 boundary space)", () => {
  // [2, 0] と指定しても出現順 = [0, 2] でマージされる
  const result = applyStructuralOperation("A\n\nB\n\nC", {
    operation: "merge_paragraphs",
    target_paragraph_indices: [2, 0],
  });
  assert.equal(result, "A C\n\nB");
});

// 2026-05-30 N3: 融合防止の本質ケース(realistic 句点なし末尾 → 融合させずスペース 1 つ)
test("merge_paragraphs inserts space when left paragraph lacks ending punctuation (N3 fusion guard)", () => {
  const result = applyStructuralOperation("私は挑戦する\n\n失敗を恐れない。", {
    operation: "merge_paragraphs",
    target_paragraph_indices: [0, 1],
  });
  // 旧実装は "私は挑戦する失敗を恐れない。" と文が融合していた。N3 で半角スペースを挿入。
  assert.equal(result, "私は挑戦する 失敗を恐れない。");
});

// 2026-05-30 N3: 左段落が句点で終わる場合は冗長な空白を挿入しない(自然な単一段落)
test("merge_paragraphs adds no space when left paragraph ends with punctuation (N3)", () => {
  const result = applyStructuralOperation("文1だ。\n\n文2だ。", {
    operation: "merge_paragraphs",
    target_paragraph_indices: [0, 1],
  });
  assert.equal(result, "文1だ。文2だ。");
});

test("merge_paragraphs returns esBody unchanged when index out of range", () => {
  const original = "A\n\nB";
  const result = applyStructuralOperation(original, {
    operation: "merge_paragraphs",
    target_paragraph_indices: [0, 99],
  });
  assert.equal(result, original);
});

test("merge_paragraphs returns esBody unchanged when duplicate indices", () => {
  const original = "A\n\nB\n\nC";
  const result = applyStructuralOperation(original, {
    operation: "merge_paragraphs",
    target_paragraph_indices: [0, 0],
  });
  assert.equal(result, original);
});

// =============================================================================
// applyStructuralOperation: move_sentence
// =============================================================================
process.stdout.write("[applyStructuralOperation: move_sentence]\n");

test("move_sentence across paragraphs (before)", () => {
  // 段落0「P0文1。P0文2。」、段落1「P1文1。」
  // source = (0, 0)、target = (1, before) → P0文1 を段落1 先頭に
  const result = applyStructuralOperation("P0文1。P0文2。\n\nP1文1。", {
    operation: "move_sentence",
    source_paragraph_index: 0,
    source_sentence_index: 0,
    target_paragraph_index: 1,
    target_position: "before",
  });
  assert.equal(result, "P0文2。\n\nP0文1。P1文1。");
});

test("move_sentence across paragraphs (after)", () => {
  const result = applyStructuralOperation("P0文1。P0文2。\n\nP1文1。", {
    operation: "move_sentence",
    source_paragraph_index: 0,
    source_sentence_index: 0,
    target_paragraph_index: 1,
    target_position: "after",
  });
  assert.equal(result, "P0文2。\n\nP1文1。P0文1。");
});

test("move_sentence within same paragraph (before)", () => {
  // 段落0「A。B。C。」内で文 2 (= C。) を冒頭に
  const result = applyStructuralOperation("A。B。C。", {
    operation: "move_sentence",
    source_paragraph_index: 0,
    source_sentence_index: 2,
    target_paragraph_index: 0,
    target_position: "before",
  });
  assert.equal(result, "C。A。B。");
});

test("move_sentence drops source paragraph when empty after move", () => {
  // 段落0「A。」(文 1 個のみ)、段落1「B。」
  // source = (0, 0) を段落1 末尾に移動 → 段落0 が空になる → 削除される
  const result = applyStructuralOperation("A。\n\nB。", {
    operation: "move_sentence",
    source_paragraph_index: 0,
    source_sentence_index: 0,
    target_paragraph_index: 1,
    target_position: "after",
  });
  assert.equal(result, "B。A。");
});

test("move_sentence returns esBody unchanged when source paragraph out of range", () => {
  const original = "A。\n\nB。";
  const result = applyStructuralOperation(original, {
    operation: "move_sentence",
    source_paragraph_index: 99,
    source_sentence_index: 0,
    target_paragraph_index: 1,
    target_position: "before",
  });
  assert.equal(result, original);
});

test("move_sentence returns esBody unchanged when source sentence out of range", () => {
  const original = "A。\n\nB。";
  const result = applyStructuralOperation(original, {
    operation: "move_sentence",
    source_paragraph_index: 0,
    source_sentence_index: 99,
    target_paragraph_index: 1,
    target_position: "before",
  });
  assert.equal(result, original);
});

// 2026-05-30 N3: 文間に空白がある段落で文を移動しても、残った文の空白が失われないこと。
// 旧実装は splitSentences が空白を捨てていたため、move 後に "甲。乙。" のように空白が
// 消えていた。lossless 化で残存文側の空白が保持される。
test("move_sentence preserves inter-sentence whitespace of remaining sentences (N3)", () => {
  // 段落0「甲。 乙。 丙。」(甲・乙の後に半角スペース、丙の後は無し)。文 0(甲。)を
  // 段落1 末尾へ。残る段落0 は "乙。 丙。"(乙・丙の間の空白を保持)、移動した "甲。 " は
  // 末尾空白を保ったまま段落1 へ。旧実装は空白を捨てて "乙。丙。" / "甲。" になっていた。
  const result = applyStructuralOperation("甲。 乙。 丙。\n\n丁。", {
    operation: "move_sentence",
    source_paragraph_index: 0,
    source_sentence_index: 0,
    target_paragraph_index: 1,
    target_position: "after",
  });
  assert.equal(result, "乙。 丙。\n\n丁。甲。 ");
});

// =============================================================================
// applyStructuralOperation: add_paragraph
// =============================================================================
process.stdout.write("[applyStructuralOperation: add_paragraph]\n");

// 2026-05-27 Task b-1: new_content は outline / 方向性(5〜50 字)を保持する仕様に変更。
// applyStructuralOperation は段落構築 logic のため Zod 制約と独立(value は文字列リテラル
// として段落間に挿入される)。test 入力は意味解釈 + 新 Zod 下限(min 5)と整合するよう
// outline 形式に書き換える。
test("add_paragraph before target index", () => {
  const result = applyStructuralOperation("A\n\nC", {
    operation: "add_paragraph",
    target_paragraph_index: 1,
    target_position: "before",
    new_content: "B 段落 outline",
  });
  assert.equal(result, "A\n\nB 段落 outline\n\nC");
});

test("add_paragraph after target index", () => {
  const result = applyStructuralOperation("A\n\nC", {
    operation: "add_paragraph",
    target_paragraph_index: 0,
    target_position: "after",
    new_content: "B 段落 outline",
  });
  assert.equal(result, "A\n\nB 段落 outline\n\nC");
});

test("add_paragraph at the beginning (before index 0)", () => {
  const result = applyStructuralOperation("B\n\nC", {
    operation: "add_paragraph",
    target_paragraph_index: 0,
    target_position: "before",
    new_content: "A 段落 outline",
  });
  assert.equal(result, "A 段落 outline\n\nB\n\nC");
});

test("add_paragraph at the end (after last index)", () => {
  const result = applyStructuralOperation("A\n\nB", {
    operation: "add_paragraph",
    target_paragraph_index: 1,
    target_position: "after",
    new_content: "C 段落 outline",
  });
  assert.equal(result, "A\n\nB\n\nC 段落 outline");
});

test("add_paragraph returns esBody unchanged when target index out of range", () => {
  const original = "A\n\nB";
  const result = applyStructuralOperation(original, {
    operation: "add_paragraph",
    target_paragraph_index: 99,
    target_position: "before",
    new_content: "C 段落 outline",
  });
  assert.equal(result, original);
});

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
