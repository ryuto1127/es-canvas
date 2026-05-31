/**
 * dogfood round 3 ⑦ B のユニットテスト(2026-05-28)。
 *
 * `buildInitialUserMessage`(lib/prompts/initial.ts)の **削減優先ブロックの条件付き注入**
 * を純関数として担保する:
 *
 *  - ES が設問上限を **超過** している(es_body.length > char_limit)とき:
 *    削減優先ブロック([文字数の制約 — 重要])が user メッセージに含まれること。
 *    現在長 / 上限 / 超過字数が正しく埋め込まれること。冒頭寄り([設問] の直後 = [企業要約]
 *    より前)に置かれること。
 *  - ES が上限 **以内**(<=)のとき:削減優先ブロックを含まないこと(従来挙動を完全維持)。
 *    境界(length === char_limit)では注入しない(超過は厳密な > のみ)。
 *  - いずれの場合も既存セクション(ES本体 / 設問 / 企業要約 / 添削条件 / ユーザー文脈 /
 *    承認済み evidence)は従来どおり全て含まれること(注入が既存構造を壊さない)。
 *
 * これは static system.ts / fewshot.ts を一切触らず、user メッセージ側の条件付き注入のみで
 * 「初回分析が上限超過時に削減を優先する」を実現する変更(B)の回帰防止。
 *
 * 実行方法: `pnpm test:initial`(net 呼び出しなし、ローカル即時実行)
 *
 * SSOT:
 *  - lib/prompts/initial.ts:buildInitialUserMessage / renderOverLimitReductionBlock
 *  - docs/dispatch/2026-05-28-overlimit-reduction.md(設計 = SSOT、B section)
 *  - DECISIONS.md [2026-05-28] dogfood round 3 追加 ⑦ 実装結果
 */

import { strict as assert } from "node:assert";
import { buildInitialUserMessage } from "@/lib/prompts/initial";
import type { AnalyzeInputBundle } from "@/lib/schema/input";

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
// initial モードの最小 bundle factory。es_body / char_limit をテストごとに差し替える。
// company_summary は undefined(企業 URL 未指定)で固定 — 削減ブロックは企業要約と独立。
function makeInitialBundle(args: {
  esBody: string;
  charLimit: number | undefined;
}): Extract<AnalyzeInputBundle, { mode: "initial" }> {
  return {
    mode: "initial",
    es_body: args.esBody,
    question: {
      text: "学生時代に最も力を入れたことを教えてください。",
      char_limit: args.charLimit,
    },
    company_summary: undefined,
    edit_conditions: {
      preset: "バランス",
      free_text: "",
    },
    user_context: "",
    current_es_version: 0,
  };
}

// 削減優先ブロックの安定したマーカー(文言の一部が変わっても見出しは load-bearing)。
const REDUCTION_BLOCK_MARKER = "[文字数の制約 — 重要]";

// -----------------------------------------------------------------------------
// 超過時: 削減優先ブロックが注入される
// -----------------------------------------------------------------------------
process.stdout.write("\n[超過時: 削減優先ブロック注入]\n");

test("es_body.length > char_limit で削減優先ブロックを含む", () => {
  const esBody = "あ".repeat(450); // 450 字
  const msg = buildInitialUserMessage(makeInitialBundle({ esBody, charLimit: 400 }));
  assert.ok(
    msg.includes(REDUCTION_BLOCK_MARKER),
    "超過時はブロック見出しを含むべき",
  );
});

test("現在長 / 上限 / 超過字数が正しく埋め込まれる", () => {
  const esBody = "あ".repeat(450);
  const msg = buildInitialUserMessage(makeInitialBundle({ esBody, charLimit: 400 }));
  // 現在 450 字 / 上限 400 字 / 50 字超過
  assert.ok(msg.includes("450 字"), "現在長 450 字を含むべき");
  assert.ok(msg.includes("上限 400 字"), "上限 400 字を含むべき");
  assert.ok(msg.includes("50 字超過"), "超過 50 字を含むべき");
});

test("削減ブロックは [設問] の直後(冒頭寄り = 企業要約より前)に置かれる", () => {
  const esBody = "あ".repeat(450);
  const msg = buildInitialUserMessage(makeInitialBundle({ esBody, charLimit: 400 }));
  const idxQuestion = msg.indexOf("[設問]");
  const idxBlock = msg.indexOf(REDUCTION_BLOCK_MARKER);
  const idxCompany = msg.indexOf("[企業要約]");
  assert.ok(idxQuestion >= 0 && idxBlock >= 0 && idxCompany >= 0, "各セクションが存在");
  assert.ok(idxQuestion < idxBlock, "削減ブロックは [設問] の後");
  assert.ok(idxBlock < idxCompany, "削減ブロックは [企業要約] より前(冒頭寄り)");
});

test("削減ブロックは structural delete/merge と lost_content 明示を促す(質維持も併記)", () => {
  const esBody = "あ".repeat(450);
  const msg = buildInitialUserMessage(makeInitialBundle({ esBody, charLimit: 400 }));
  assert.ok(msg.includes("delete_paragraph"), "delete_paragraph への言及");
  assert.ok(msg.includes("merge_paragraphs"), "merge_paragraphs への言及");
  assert.ok(msg.includes("lost_content"), "lost_content の明示要求");
  // 「削減だけ」にしない = 初回の質評価を維持する文言が併記されていること
  assert.ok(
    msg.includes("削減だけが目的ではありません"),
    "削減だけにしない(質維持)の併記",
  );
});

test("超過は厳密な > のみ(length === char_limit ではブロックを注入しない)", () => {
  const esBody = "あ".repeat(400); // ちょうど上限
  const msg = buildInitialUserMessage(makeInitialBundle({ esBody, charLimit: 400 }));
  assert.ok(
    !msg.includes(REDUCTION_BLOCK_MARKER),
    "境界(length === limit)では非超過扱いで注入しない",
  );
});

// -----------------------------------------------------------------------------
// 非超過時: 従来挙動を完全維持(ブロックを注入しない)
// -----------------------------------------------------------------------------
process.stdout.write("\n[非超過時: 従来挙動維持]\n");

test("es_body.length <= char_limit で削減優先ブロックを含まない", () => {
  const esBody = "あ".repeat(300); // 上限 400 以内
  const msg = buildInitialUserMessage(makeInitialBundle({ esBody, charLimit: 400 }));
  assert.ok(
    !msg.includes(REDUCTION_BLOCK_MARKER),
    "非超過時はブロックを含まないべき",
  );
});

test("非超過時も既存セクションは全て揃う(注入なしで構造を壊さない)", () => {
  const esBody = "あ".repeat(300);
  const msg = buildInitialUserMessage(makeInitialBundle({ esBody, charLimit: 400 }));
  for (const section of [
    "[ES本体]",
    "[設問]",
    "[企業要約]",
    "[添削条件]",
    "[ユーザー文脈]",
    "[承認済み evidence]",
  ]) {
    assert.ok(msg.includes(section), `${section} を含むべき`);
  }
});

test("超過時も既存セクションは全て揃う(注入が既存構造を壊さない)", () => {
  const esBody = "あ".repeat(450);
  const msg = buildInitialUserMessage(makeInitialBundle({ esBody, charLimit: 400 }));
  for (const section of [
    "[ES本体]",
    "[設問]",
    "[企業要約]",
    "[添削条件]",
    "[ユーザー文脈]",
    "[承認済み evidence]",
  ]) {
    assert.ok(msg.includes(section), `${section} を含むべき`);
  }
});

// -----------------------------------------------------------------------------
// char_limit 任意化(2026-05-29): char_limit が未指定なら上限の記述を注入しない
// -----------------------------------------------------------------------------
process.stdout.write("\n[char_limit 任意: 制限なしの挙動]\n");

test("char_limit 未指定なら [設問] に「字以内」を付けない", () => {
  const msg = buildInitialUserMessage(
    makeInitialBundle({ esBody: "あ".repeat(300), charLimit: undefined }),
  );
  assert.ok(msg.includes("[設問]"), "[設問] セクションは存在");
  assert.ok(!msg.includes("字以内"), "制限なしでは「字以内」を含まない");
});

test("char_limit 未指定なら長文でも削減優先ブロックを注入しない", () => {
  // 制限が無いので「超過」が定義できない → 削減ブロックは出さない
  const msg = buildInitialUserMessage(
    makeInitialBundle({ esBody: "あ".repeat(5000), charLimit: undefined }),
  );
  assert.ok(
    !msg.includes(REDUCTION_BLOCK_MARKER),
    "制限なしでは削減優先ブロックを注入しない",
  );
});

test("char_limit 未指定でも既存セクションは全て揃う", () => {
  const msg = buildInitialUserMessage(
    makeInitialBundle({ esBody: "あ".repeat(300), charLimit: undefined }),
  );
  for (const section of [
    "[ES本体]",
    "[設問]",
    "[企業要約]",
    "[添削条件]",
    "[ユーザー文脈]",
    "[承認済み evidence]",
  ]) {
    assert.ok(msg.includes(section), `${section} を含むべき`);
  }
});

test("char_limit 有り(従来)では「字以内」を含む(後方互換)", () => {
  const msg = buildInitialUserMessage(
    makeInitialBundle({ esBody: "あ".repeat(300), charLimit: 400 }),
  );
  assert.ok(msg.includes("(400字以内)"), "制限ありでは従来どおり「(400字以内)」");
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
