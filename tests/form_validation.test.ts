/**
 * isFormValid — 「分析開始」ボタン enable 条件の純粋関数 unit test。
 *
 * 2026-05-29 改修(入力の最低文字数撤廃 + char_limit 任意化)を構造で固定する:
 *   - es_body:       非空であれば valid(以前の 50 字下限を撤廃)
 *   - question_text: 非空であれば valid(以前の 5 字下限を撤廃)
 *                    → 「自己PR」(4 字)等の正当な短い設問がブロックされないこと
 *   - char_limit:    任意。空欄 = 制限なしで valid。入力するなら正の整数のみ
 *                    (旧 50〜2000 の範囲ゲートは下限・上限とも撤廃)
 *
 * char_limit 任意化の根拠: 文字数制限の無い設問もあるため。空欄では超過警告も
 * カウンタの上限表示も出さず、プロンプトに上限の記述を注入しない。
 * es_body 上限(8000)は schema(lib/schema/input.ts:es_body.max(8000))の安全弁。
 * 2026-05-29 修正で isFormValid もこの上限を見るようにした(以前は下限のみで、
 * 8001 字超でも送信ボタンが有効 → 送信直後に client Zod で落ちる不具合があった)。
 * 判定基準は schema と合わせ raw な es_body.length(trim しない)で 8000 超を弾く。
 *
 * 実行方法: `pnpm test:form`(net 呼び出しなし、ローカル即時実行)
 *
 * SSOT: lib/state/analyze_store.ts:isFormValid
 */

import { strict as assert } from "node:assert";
import { isFormValid, type FormState } from "@/lib/state/analyze_store";

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

// すべて妥当な base form。各テストで 1 フィールドだけ上書きして境界を検証する。
function baseForm(overrides: Partial<FormState> = {}): FormState {
  return {
    es_body: "これは妥当な ES 本文です。",
    question_text: "学生時代に最も力を入れたことを教えてください",
    char_limit: "400",
    company_input_type: "url",
    company_url: "",
    company_name: "",
    company_freetext: "",
    preset: "バランス",
    free_text: "",
    user_context: "",
    ...overrides,
  };
}

// --- baseline ---
test("妥当な base form は valid", () => {
  assert.equal(isFormValid(baseForm()), true);
});

// --- es_body: 下限撤廃(非空であれば OK)---
test("es_body が空文字なら invalid", () => {
  assert.equal(isFormValid(baseForm({ es_body: "" })), false);
});

test("es_body が空白のみなら invalid(trim 後 0 字)", () => {
  assert.equal(isFormValid(baseForm({ es_body: "   \n\t " })), false);
});

test("es_body が 1 字でも非空なら valid(50 字下限は撤廃)", () => {
  assert.equal(isFormValid(baseForm({ es_body: "あ" })), true);
});

test("es_body が旧下限(50 字)未満でも valid(改修前は invalid だった)", () => {
  assert.equal(isFormValid(baseForm({ es_body: "短いES本文" })), true);
});

// --- es_body: 上限 8000(schema と同基準、2026-05-29 追加)---
test("es_body ちょうど 8000 字は valid(上限ぴったりは許容)", () => {
  assert.equal(isFormValid(baseForm({ es_body: "あ".repeat(8000) })), true);
});

test("es_body 8001 字は invalid(上限超過、schema の es_body.max(8000) と同基準)", () => {
  assert.equal(isFormValid(baseForm({ es_body: "あ".repeat(8001) })), false);
});

test("es_body 大幅超過(20000 字)も invalid", () => {
  assert.equal(isFormValid(baseForm({ es_body: "あ".repeat(20000) })), false);
});

// --- question_text: 下限撤廃(「自己PR」等の短い設問を通す)---
test("question_text が空文字なら invalid", () => {
  assert.equal(isFormValid(baseForm({ question_text: "" })), false);
});

test("question_text が空白のみなら invalid", () => {
  assert.equal(isFormValid(baseForm({ question_text: "  " })), false);
});

test("question_text 「自己PR」(4 字)は valid(改修前は 5 字下限で invalid だった)", () => {
  assert.equal(isFormValid(baseForm({ question_text: "自己PR" })), true);
});

test("question_text が 1 字でも非空なら valid", () => {
  assert.equal(isFormValid(baseForm({ question_text: "夢" })), true);
});

// --- char_limit: 任意(空欄 OK / 入力するなら正の整数のみ)---
test("char_limit が空文字は valid(任意 = 制限なし)", () => {
  assert.equal(isFormValid(baseForm({ char_limit: "" })), true);
});

test("char_limit が空白のみは valid(trim 後 0 字 = 制限なし)", () => {
  assert.equal(isFormValid(baseForm({ char_limit: "   " })), true);
});

test("char_limit 400(正の整数)は valid", () => {
  assert.equal(isFormValid(baseForm({ char_limit: "400" })), true);
});

test("char_limit 1(最小の正の整数)は valid(旧 50 下限は撤廃)", () => {
  assert.equal(isFormValid(baseForm({ char_limit: "1" })), true);
});

test("char_limit 5000(旧上限超過)も valid(上限ゲート撤廃)", () => {
  assert.equal(isFormValid(baseForm({ char_limit: "5000" })), true);
});

test("char_limit 0 は invalid(正の整数のみ)", () => {
  assert.equal(isFormValid(baseForm({ char_limit: "0" })), false);
});

test("char_limit -5(負数)は invalid", () => {
  assert.equal(isFormValid(baseForm({ char_limit: "-5" })), false);
});

test("char_limit が非整数(400.5)は invalid", () => {
  assert.equal(isFormValid(baseForm({ char_limit: "400.5" })), false);
});

test("char_limit が非数値文字列(abc)は invalid", () => {
  assert.equal(isFormValid(baseForm({ char_limit: "abc" })), false);
});

// --- 結果出力 ---
process.stdout.write(`\n${passCount} passed, ${failCount} failed\n`);
if (failCount > 0) {
  process.stdout.write(`\n${failures.join("\n")}\n`);
  process.exit(1);
}
