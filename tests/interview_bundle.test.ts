/**
 * buildInterviewBundle / deriveAcceptedSuggestionsSummary — 決定論ユニットテスト。
 *
 * 提出後改善 #1 (2026-06-09): 「質問を更新」ボタンが /api/interview に送る
 * InterviewInputBundle の組立を純関数として担保する(net 呼び出しなし):
 *
 *  - char_limit: parseCharLimit 経由で optional(空欄 / 非正整数 → undefined)
 *  - question / company_summary / edit_conditions / current_es_version の素直な詰め込み
 *  - user_context: appendClarificationToUserContext(通常は form.user_context のまま)
 *  - accepted_suggestions_summary: deriveAcceptedSuggestionsSummary が
 *      ・ACCEPTED / EDITED の actionHistory entry だけを direction に採る
 *      ・REJECTED / PENDING / DIRECT_EDIT は除外する
 *      ・同一 suggestion_id の重複は **最後の出現** を採る(EDITED が ACCEPTED を上書き)
 *      ・liveAcceptedOrEditedIds で「現在 採用 or 編集済」の id に絞る(却下 / undo で
 *        外れた id は summary に含めない = 派生 ES と整合)
 *  - 生成された bundle が InterviewInputBundleSchema を満たす(サーバが 400 を返さない)
 *
 * これは lib/schema/ lib/tools/ lib/prompts/ を一切触らず、store 側の bundle builder と
 * その accepted summary 導出ロジックの回帰防止。buildRefreshBundle が action_history を
 * actionHistory からそのまま渡すのと同じ「単一の actionHistory ソース」から導出する。
 *
 * 実行方法: `tsx tests/interview_bundle.test.ts`(net 呼び出しなし、ローカル即時実行)
 *
 * SSOT: lib/state/analyze_store.ts:buildInterviewBundle / deriveAcceptedSuggestionsSummary
 *       lib/schema/input.ts:InterviewInputBundleSchema
 */

import { strict as assert } from "node:assert";
import {
  buildInterviewBundle,
  deriveAcceptedSuggestionsSummary,
  type FormState,
} from "@/lib/state/analyze_store";
import type { ActionHistoryEntry } from "@/lib/schema/input";
import { InterviewInputBundleSchema } from "@/lib/schema/input";
import type { CompanySummary } from "@/lib/schema/company";

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
function baseForm(overrides: Partial<FormState> = {}): FormState {
  return {
    es_body: "これは妥当な ES 本文です。データに基づく仮説検証を回した経験。",
    question_text: "学生時代に最も力を入れたことを教えてください",
    char_limit: "400",
    company_input_type: "url",
    company_url: "",
    company_name: "",
    company_freetext: "",
    preset: "バランス",
    free_text: "厳しめにお願いします",
    user_context: "テック系志望",
    ...overrides,
  };
}

const COMPANY: CompanySummary = {
  company_name: "株式会社メルカリ",
  business_summary: "C2C マーケットプレイスを中核とするテック企業。",
  evidence: [],
  values: ["Go Bold"],
  ideal_candidate: "データを起点に大胆に挑戦できる人材。",
  hiring_criteria: ["データに基づく判断力"],
  research_log: [],
  source_input: { type: "url", value: "https://about.mercari.com/" },
  research_started_at: "2026-06-09T00:00:00.000Z",
  research_finished_at: "2026-06-09T00:00:05.000Z",
  total_iterations: 1,
};

function accepted(id: string, summary: string): ActionHistoryEntry {
  return { verb: "ACCEPTED", suggestion_id: id, suggestion_summary: summary };
}
function rejected(id: string, summary: string): ActionHistoryEntry {
  return { verb: "REJECTED", suggestion_id: id, suggestion_summary: summary };
}
function pending(id: string, summary: string): ActionHistoryEntry {
  return { verb: "PENDING", suggestion_id: id, suggestion_summary: summary };
}
function edited(id: string, summary: string): ActionHistoryEntry {
  return {
    verb: "EDITED",
    suggestion_id: id,
    suggestion_summary: summary,
    edited_text: "ユーザーが編集した本文",
  };
}
function directEdit(): ActionHistoryEntry {
  return { verb: "DIRECT_EDIT", description: "本文を直接編集した" };
}

// -----------------------------------------------------------------------------
// deriveAcceptedSuggestionsSummary
// -----------------------------------------------------------------------------
test("ACCEPTED entry が direction に乗る", () => {
  const out = deriveAcceptedSuggestionsSummary([
    accepted("sug_001", "具体的数値の追加を採用"),
  ]);
  assert.deepEqual(out, [
    { suggestion_id: "sug_001", direction: "具体的数値の追加を採用" },
  ]);
});

test("EDITED entry も direction に乗る(採用の一種)", () => {
  const out = deriveAcceptedSuggestionsSummary([
    edited("sug_002", "規模の明示を編集して採用"),
  ]);
  assert.deepEqual(out, [
    { suggestion_id: "sug_002", direction: "規模の明示を編集して採用" },
  ]);
});

test("REJECTED / PENDING / DIRECT_EDIT は除外される", () => {
  const out = deriveAcceptedSuggestionsSummary([
    rejected("sug_003", "却下した指摘"),
    pending("sug_004", "保留した指摘"),
    directEdit(),
  ]);
  assert.deepEqual(out, []);
});

test("同一 id の重複は最後の出現を採る(EDITED が ACCEPTED を上書き)", () => {
  const out = deriveAcceptedSuggestionsSummary([
    accepted("sug_005", "最初は採用サマリ"),
    edited("sug_005", "後で編集して採用したサマリ"),
  ]);
  assert.deepEqual(out, [
    { suggestion_id: "sug_005", direction: "後で編集して採用したサマリ" },
  ]);
});

test("配列順は最初に登場した順を保つ", () => {
  const out = deriveAcceptedSuggestionsSummary([
    accepted("sug_b", "B のサマリ"),
    accepted("sug_a", "A のサマリ"),
  ]);
  assert.deepEqual(
    out.map((o) => o.suggestion_id),
    ["sug_b", "sug_a"],
  );
});

test("liveAcceptedOrEditedIds で現在の採用 / 編集済 id に絞る", () => {
  // sug_006 は ACCEPTED 履歴があるが、現在は却下されて live set に居ない → 除外。
  const out = deriveAcceptedSuggestionsSummary(
    [accepted("sug_006", "後で外れた採用"), accepted("sug_007", "残っている採用")],
    new Set(["sug_007"]),
  );
  assert.deepEqual(out, [
    { suggestion_id: "sug_007", direction: "残っている採用" },
  ]);
});

test("liveAcceptedOrEditedIds 未指定なら絞り込みなし(全 ACCEPTED/EDITED)", () => {
  const out = deriveAcceptedSuggestionsSummary([
    accepted("sug_008", "A"),
    accepted("sug_009", "B"),
  ]);
  assert.equal(out.length, 2);
});

test("空 actionHistory は空配列", () => {
  assert.deepEqual(deriveAcceptedSuggestionsSummary([]), []);
});

// -----------------------------------------------------------------------------
// buildInterviewBundle
// -----------------------------------------------------------------------------
test("基本的な bundle が schema を満たす", () => {
  const bundle = buildInterviewBundle({
    form: baseForm(),
    companySummary: COMPANY,
    esBody: "派生 ES 本文(採用反映済)。",
    actionHistory: [accepted("sug_001", "具体的数値の追加を採用")],
    baseVersion: 2,
    liveAcceptedOrEditedIds: new Set(["sug_001"]),
  });
  const parsed = InterviewInputBundleSchema.safeParse(bundle);
  assert.equal(parsed.success, true, JSON.stringify(parsed, null, 2));
});

test("es_body / current_es_version / question を素直に詰める", () => {
  const bundle = buildInterviewBundle({
    form: baseForm({ question_text: "自己PR", char_limit: "300" }),
    companySummary: undefined,
    esBody: "現在の派生 ES。",
    actionHistory: [],
    baseVersion: 5,
  });
  assert.equal(bundle.es_body, "現在の派生 ES。");
  assert.equal(bundle.current_es_version, 5);
  assert.equal(bundle.question.text, "自己PR");
  assert.equal(bundle.question.char_limit, 300);
});

test("edit_conditions は form の preset / free_text を反映", () => {
  const bundle = buildInterviewBundle({
    form: baseForm({ preset: "個性保護", free_text: "個性は残して" }),
    companySummary: undefined,
    esBody: "ES。",
    actionHistory: [],
    baseVersion: 0,
  });
  assert.equal(bundle.edit_conditions.preset, "個性保護");
  assert.equal(bundle.edit_conditions.free_text, "個性は残して");
});

test("char_limit が空欄なら undefined(任意 = 制限なし)", () => {
  const bundle = buildInterviewBundle({
    form: baseForm({ char_limit: "" }),
    companySummary: undefined,
    esBody: "ES。",
    actionHistory: [],
    baseVersion: 0,
  });
  assert.equal(bundle.question.char_limit, undefined);
  // schema は char_limit optional を許容する
  assert.equal(InterviewInputBundleSchema.safeParse(bundle).success, true);
});

test("char_limit が非正整数なら undefined", () => {
  const bundle = buildInterviewBundle({
    form: baseForm({ char_limit: "0" }),
    companySummary: undefined,
    esBody: "ES。",
    actionHistory: [],
    baseVersion: 0,
  });
  assert.equal(bundle.question.char_limit, undefined);
});

test("company_summary 未指定(undefined)でも schema を満たす", () => {
  const bundle = buildInterviewBundle({
    form: baseForm(),
    companySummary: undefined,
    esBody: "ES。",
    actionHistory: [],
    baseVersion: 0,
  });
  assert.equal(bundle.company_summary, undefined);
  assert.equal(InterviewInputBundleSchema.safeParse(bundle).success, true);
});

test("accepted_suggestions_summary が actionHistory + live set から導出される", () => {
  const bundle = buildInterviewBundle({
    form: baseForm(),
    companySummary: undefined,
    esBody: "ES。",
    actionHistory: [
      accepted("sug_001", "数値の追加を採用"),
      rejected("sug_002", "却下"),
      edited("sug_003", "編集して採用"),
    ],
    baseVersion: 3,
    liveAcceptedOrEditedIds: new Set(["sug_001", "sug_003"]),
  });
  assert.deepEqual(bundle.accepted_suggestions_summary, [
    { suggestion_id: "sug_001", direction: "数値の追加を採用" },
    { suggestion_id: "sug_003", direction: "編集して採用" },
  ]);
});

test("user_context は form.user_context をそのまま使う(clarification 無し時)", () => {
  const bundle = buildInterviewBundle({
    form: baseForm({ user_context: "海外大経験あり" }),
    companySummary: undefined,
    esBody: "ES。",
    actionHistory: [],
    baseVersion: 0,
  });
  assert.equal(bundle.user_context, "海外大経験あり");
});

test("clarificationEnrichedIntent があれば user_context に append される", () => {
  const bundle = buildInterviewBundle({
    form: baseForm({ user_context: "ベース文脈" }),
    companySummary: undefined,
    esBody: "ES。",
    actionHistory: [],
    baseVersion: 0,
    clarificationEnrichedIntent: "[逆質問への回答]\nQ (全体): 何故?\nA: こうです",
  });
  assert.ok(bundle.user_context.includes("ベース文脈"));
  assert.ok(bundle.user_context.includes("[逆質問への回答]"));
});

test("採用なし(空 actionHistory)でも schema を満たす(初回直後の更新)", () => {
  const bundle = buildInterviewBundle({
    form: baseForm(),
    companySummary: COMPANY,
    esBody: "ES。",
    actionHistory: [],
    baseVersion: 0,
    liveAcceptedOrEditedIds: new Set(),
  });
  assert.deepEqual(bundle.accepted_suggestions_summary, []);
  assert.equal(InterviewInputBundleSchema.safeParse(bundle).success, true);
});

// --- 結果出力 ---
process.stdout.write(`\n${passCount} passed, ${failCount} failed\n`);
if (failCount > 0) {
  process.stdout.write(`\n${failures.join("\n")}\n`);
  process.exit(1);
}
