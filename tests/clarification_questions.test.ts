/**
 * 2026-05-27: エージェント的対話(AI 逆質問)機能のユニットテスト。
 *
 * Task 8 dispatch §「対象 Task: 8 件」#8 で指定された case 群:
 *  - ClarificationQuestionSchema 検証(valid / 短すぎる question / rationale 不在 / id 空文字)
 *  - AnalyzeResult refine(suggestion-bound + global の合計 3 以下 / 超過 / 各境界)
 *  - updateClarificationAnswer reducer(空 / 既存更新 / 複数並行 / 空文字で除去)
 *  - clearClarificationAnswer reducer
 *  - triggerReanalysisWithClarifications で enriched_intent 経路の確認
 *    (buildClarificationEnrichedIntent / appendClarificationToUserContext 純粋関数)
 *  - reset 系で clarificationAnswers = [] になる確認
 *
 * 実行方法: `pnpm test:clarification`(net 呼び出しなし、ローカル即時実行)
 *
 * 前提:
 *  - net 呼び出しなし(純粋関数 + Zod schema + Zustand store の直接操作)
 *  - tsx ベースの既存 test pattern と同じく `node:assert` で結果確認
 *  - tsc strict / lint pass を維持
 *
 * SSOT:
 *  - lib/schema/clarification.ts(ClarificationQuestionSchema)
 *  - lib/schema/suggestion.ts(SuggestionSchema 拡張、clarification_questions optional)
 *  - lib/schema/analysis.ts(AnalysisResultSchema refine、合計 3 件以下)
 *  - lib/state/analyze_store.ts(reducer + buildClarificationEnrichedIntent +
 *    appendClarificationToUserContext)
 *  - DECISIONS.md `[2026-05-27] エージェント的対話 実装結果`
 */

import { strict as assert } from "node:assert";
import {
  ClarificationQuestionSchema,
  clarificationIdentity,
} from "@/lib/schema/clarification";
import { AnalysisResultSchema, AIInitialAnalysisOutputSchema } from "@/lib/schema/analysis";
import type { AnalysisResult } from "@/lib/schema/analysis";
import {
  appendClarificationToUserContext,
  buildClarificationEnrichedIntent,
  useAnalyzeStore,
} from "@/lib/state/analyze_store";
import type { ClarificationAnswer } from "@/lib/state/analyze_store";

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

// store の reset helper: 各テスト前に「初期状態」に揃える。
// useAnalyzeStore は singleton のため、テスト間で state が引き継がれないよう注意。
// resetSession で clarificationAnswers / actionLog / analysisResult をクリア。
function resetStore() {
  useAnalyzeStore.getState().resetSession();
}

// =============================================================================
// ClarificationQuestionSchema 検証
// =============================================================================
process.stdout.write("[ClarificationQuestionSchema 検証]\n");

test("valid な質問 — id / question / rationale が揃う", () => {
  const result = ClarificationQuestionSchema.safeParse({
    id: "q_001",
    question: "この特訓を始めたきっかけは何ですか?",
    rationale:
      "動機がエピソードの説得力に直結します。就任前なら主体性、就任後なら役割理解として書き分けられます",
  });
  assert.equal(result.success, true);
});

test("invalid: question が短すぎる(5 字未満)", () => {
  const result = ClarificationQuestionSchema.safeParse({
    id: "q_001",
    question: "短い", // 2 字
    rationale: "なぜこの質問を出すかの理由テキスト(10 字以上)",
  });
  assert.equal(result.success, false);
});

test("invalid: question が長すぎる(200 字超過)", () => {
  const longQuestion = "a".repeat(201);
  const result = ClarificationQuestionSchema.safeParse({
    id: "q_001",
    question: longQuestion,
    rationale: "なぜこの質問を出すかの理由テキスト(10 字以上)",
  });
  assert.equal(result.success, false);
});

test("invalid: rationale 不在(必須)", () => {
  const result = ClarificationQuestionSchema.safeParse({
    id: "q_001",
    question: "この特訓を始めたきっかけは何ですか?",
    // rationale 抜け
  });
  assert.equal(result.success, false);
});

test("invalid: rationale 短すぎる(10 字未満)", () => {
  const result = ClarificationQuestionSchema.safeParse({
    id: "q_001",
    question: "この特訓を始めたきっかけは何ですか?",
    rationale: "短い", // 2 字
  });
  assert.equal(result.success, false);
});

test("invalid: id 空文字", () => {
  const result = ClarificationQuestionSchema.safeParse({
    id: "",
    question: "この特訓を始めたきっかけは何ですか?",
    rationale: "なぜこの質問を出すかの理由テキスト(10 字以上)",
  });
  assert.equal(result.success, false);
});

// =============================================================================
// AnalyzeResult refine(suggestion-bound + global の合計上限 3)
// =============================================================================
process.stdout.write("\n[AnalyzeResult refine(合計上限 3)]\n");

function makeValidQ(id: string) {
  // question 本文に id を含めることで「q_001 と q_002 の問本文が同一」事故を防ぐ。
  return {
    id,
    question: `テスト質問本文 ${id}(5 字以上 200 字以下)`,
    rationale: "テスト理由テキスト(10 字以上 300 字以下です)",
  };
}

function makeBaseSuggestion(id: string) {
  return {
    id,
    category: "convention" as const,
    original: "原文テキスト",
    proposed: "提案テキスト",
    alternatives: [],
    rationale: "理由",
    rationale_source: {
      type: "convention" as const,
      reference: "ES 慣習",
    },
    related_suggestion_ids: [],
    original_span: { start: 0, end: 4 },
  };
}

function makeBaseResult(): AnalysisResult {
  return {
    es_state_version: 0,
    overall_assessment: {
      summary: "総評",
      strengths: ["強み"],
      weaknesses: ["弱み"],
      preserved_voice_note: "個性メモ",
    },
    suggestions: [],
  };
}

test("valid: 合計 0(全省略)", () => {
  const result = AnalysisResultSchema.safeParse(makeBaseResult());
  assert.equal(result.success, true);
});

test("valid: suggestion-bound 1 + global 2 = 3(境界 OK)", () => {
  const data = {
    ...makeBaseResult(),
    suggestions: [
      {
        ...makeBaseSuggestion("sug_001"),
        clarification_questions: [makeValidQ("q_001")],
      },
    ],
    global_clarification_questions: [makeValidQ("q_002"), makeValidQ("q_003")],
  };
  const result = AnalysisResultSchema.safeParse(data);
  assert.equal(result.success, true);
});

test("valid: suggestion-bound 0 + global 3 = 3(境界 OK、全 global)", () => {
  const data = {
    ...makeBaseResult(),
    global_clarification_questions: [
      makeValidQ("q_001"),
      makeValidQ("q_002"),
      makeValidQ("q_003"),
    ],
  };
  const result = AnalysisResultSchema.safeParse(data);
  assert.equal(result.success, true);
});

test("invalid: suggestion-bound 1 + global 3 = 4(NG、合計超過)", () => {
  const data = {
    ...makeBaseResult(),
    suggestions: [
      {
        ...makeBaseSuggestion("sug_001"),
        clarification_questions: [makeValidQ("q_001")],
      },
    ],
    global_clarification_questions: [
      makeValidQ("q_002"),
      makeValidQ("q_003"),
      makeValidQ("q_004"),
    ],
  };
  const result = AnalysisResultSchema.safeParse(data);
  assert.equal(result.success, false);
});

test("invalid: global 単独で 4 件(NG、配列単独の max 3 で弾く)", () => {
  const data = {
    ...makeBaseResult(),
    global_clarification_questions: [
      makeValidQ("q_001"),
      makeValidQ("q_002"),
      makeValidQ("q_003"),
      makeValidQ("q_004"),
    ],
  };
  const result = AnalysisResultSchema.safeParse(data);
  assert.equal(result.success, false);
});

test("invalid: suggestion.clarification_questions に 2 件以上(NG、suggestion 単独の max 1)", () => {
  const data = {
    ...makeBaseResult(),
    suggestions: [
      {
        ...makeBaseSuggestion("sug_001"),
        clarification_questions: [makeValidQ("q_001"), makeValidQ("q_002")],
      },
    ],
  };
  const result = AnalysisResultSchema.safeParse(data);
  assert.equal(result.success, false);
});

test("AIInitialAnalysisOutput も同 refine: 3 件超過は NG", () => {
  // AIInitialAnalysisOutputSchema は AnalysisResultSchema と独立だが同 refine
  // (clarificationTotalIsValid)で守られる(few-shot prompt と同期した tool 出力検証用)。
  const data = {
    es_state_version: 0,
    overall_assessment: {
      summary: "総評",
      strengths: ["強み"],
      weaknesses: ["弱み"],
      preserved_voice_note: "個性メモ",
    },
    suggestions: [
      {
        id: "sug_001",
        category: "convention",
        original: "原文",
        proposed: "提案",
        alternatives: [],
        rationale: "理由",
        rationale_source: { type: "convention", reference: "慣習" },
        related_suggestion_ids: [],
        internal_priority: 5,
        clarification_questions: [makeValidQ("q_001")],
      },
    ],
    interview_questions: {
      generated_at_es_version: 0,
      is_stale: false,
      questions: [
        {
          id: "iq_001",
          question: "面接質問 1",
          rationale: "理由",
          answer_hint: "ヒント",
          purpose_hint: "意図",
        },
        {
          id: "iq_002",
          question: "面接質問 2",
          rationale: "理由",
          answer_hint: "ヒント",
          purpose_hint: "意図",
        },
        {
          id: "iq_003",
          question: "面接質問 3",
          rationale: "理由",
          answer_hint: "ヒント",
          purpose_hint: "意図",
        },
      ],
    },
    global_clarification_questions: [
      makeValidQ("q_002"),
      makeValidQ("q_003"),
      makeValidQ("q_004"),
    ], // 合計 1 + 3 = 4 → NG
  };
  const result = AIInitialAnalysisOutputSchema.safeParse(data);
  assert.equal(result.success, false);
});

// =============================================================================
// updateClarificationAnswer reducer
// =============================================================================
process.stdout.write("\n[updateClarificationAnswer reducer]\n");

test("新規追加: 空配列 → 1 件追加", () => {
  resetStore();
  const { updateClarificationAnswer } = useAnalyzeStore.getState();
  updateClarificationAnswer({
    question_id: "q_001",
    suggestion_id: "sug_001",
    scope: "suggestion",
    answer_text: "テスト回答",
  });
  const answers = useAnalyzeStore.getState().clarificationAnswers;
  assert.equal(answers.length, 1);
  assert.equal(answers[0].question_id, "q_001");
  assert.equal(answers[0].answer_text, "テスト回答");
  assert.equal(answers[0].scope, "suggestion");
  assert.equal(answers[0].suggestion_id, "sug_001");
});

test("既存更新: 同 question_id を再 update すると上書き(1 件のまま)", () => {
  resetStore();
  const { updateClarificationAnswer } = useAnalyzeStore.getState();
  updateClarificationAnswer({
    question_id: "q_001",
    scope: "global",
    answer_text: "1 回目",
  });
  updateClarificationAnswer({
    question_id: "q_001",
    scope: "global",
    answer_text: "2 回目(上書き)",
  });
  const answers = useAnalyzeStore.getState().clarificationAnswers;
  assert.equal(answers.length, 1);
  assert.equal(answers[0].answer_text, "2 回目(上書き)");
});

test("複数 question 並行: 異なる question_id は別 entry として並ぶ", () => {
  resetStore();
  const { updateClarificationAnswer } = useAnalyzeStore.getState();
  updateClarificationAnswer({
    question_id: "q_001",
    scope: "global",
    answer_text: "A",
  });
  updateClarificationAnswer({
    question_id: "q_002",
    suggestion_id: "sug_001",
    scope: "suggestion",
    answer_text: "B",
  });
  updateClarificationAnswer({
    question_id: "q_003",
    scope: "global",
    answer_text: "C",
  });
  const answers = useAnalyzeStore.getState().clarificationAnswers;
  assert.equal(answers.length, 3);
  const ids = answers.map((a) => a.question_id);
  assert.deepEqual(ids, ["q_001", "q_002", "q_003"]);
});

test("空文字で entry 自動除去(textarea を空にした時の clean-up)", () => {
  resetStore();
  const { updateClarificationAnswer } = useAnalyzeStore.getState();
  updateClarificationAnswer({
    question_id: "q_001",
    scope: "global",
    answer_text: "初回回答",
  });
  assert.equal(useAnalyzeStore.getState().clarificationAnswers.length, 1);
  // 空文字で update → entry 除去
  updateClarificationAnswer({
    question_id: "q_001",
    scope: "global",
    answer_text: "",
  });
  assert.equal(useAnalyzeStore.getState().clarificationAnswers.length, 0);
});

test("trim 後空(空白のみ)も entry 除去", () => {
  resetStore();
  const { updateClarificationAnswer } = useAnalyzeStore.getState();
  updateClarificationAnswer({
    question_id: "q_001",
    scope: "global",
    answer_text: "初回",
  });
  updateClarificationAnswer({
    question_id: "q_001",
    scope: "global",
    answer_text: "   \n   ", // trim 後 0 字
  });
  assert.equal(useAnalyzeStore.getState().clarificationAnswers.length, 0);
});

// =============================================================================
// clearClarificationAnswer reducer
// =============================================================================
process.stdout.write("\n[clearClarificationAnswer reducer]\n");

test("既存 entry を明示クリアで除去", () => {
  resetStore();
  const { updateClarificationAnswer, clearClarificationAnswer } =
    useAnalyzeStore.getState();
  updateClarificationAnswer({
    question_id: "q_001",
    scope: "global",
    answer_text: "回答",
  });
  updateClarificationAnswer({
    question_id: "q_002",
    scope: "global",
    answer_text: "別回答",
  });
  clearClarificationAnswer({ question_id: "q_001", scope: "global" });
  const answers = useAnalyzeStore.getState().clarificationAnswers;
  assert.equal(answers.length, 1);
  assert.equal(answers[0].question_id, "q_002");
});

test("存在しない question_id を clear しても no-op", () => {
  resetStore();
  const { updateClarificationAnswer, clearClarificationAnswer } =
    useAnalyzeStore.getState();
  updateClarificationAnswer({
    question_id: "q_001",
    scope: "global",
    answer_text: "回答",
  });
  clearClarificationAnswer({ question_id: "q_nonexistent", scope: "global" });
  assert.equal(useAnalyzeStore.getState().clarificationAnswers.length, 1);
});

// =============================================================================
// buildClarificationEnrichedIntent + appendClarificationToUserContext 純粋関数
// =============================================================================
process.stdout.write(
  "\n[buildClarificationEnrichedIntent + appendClarificationToUserContext]\n",
);

function makeResultWithQuestions(
  globalQs: ReturnType<typeof makeValidQ>[],
  suggestionsWithQs: { id: string; questions: ReturnType<typeof makeValidQ>[] }[],
): AnalysisResult {
  return {
    ...makeBaseResult(),
    suggestions: suggestionsWithQs.map((s) => ({
      ...makeBaseSuggestion(s.id),
      clarification_questions: s.questions,
    })),
    global_clarification_questions: globalQs,
  };
}

test("buildClarificationEnrichedIntent: 回答なし → 空文字", () => {
  const result = makeResultWithQuestions([makeValidQ("q_001")], []);
  const text = buildClarificationEnrichedIntent([], result);
  assert.equal(text, "");
});

test("buildClarificationEnrichedIntent: result null → 空文字", () => {
  const answers: ClarificationAnswer[] = [
    {
      question_id: "q_001",
      answer_text: "テスト回答",
      answered_at: Date.now(),
      scope: "global",
    },
  ];
  const text = buildClarificationEnrichedIntent(answers, null);
  assert.equal(text, "");
});

test("buildClarificationEnrichedIntent: 全部空文字回答 → 空文字", () => {
  const result = makeResultWithQuestions([makeValidQ("q_001")], []);
  const answers: ClarificationAnswer[] = [
    {
      question_id: "q_001",
      answer_text: "   ", // 空白のみ
      answered_at: Date.now(),
      scope: "global",
    },
  ];
  const text = buildClarificationEnrichedIntent(answers, result);
  assert.equal(text, "");
});

test("buildClarificationEnrichedIntent: global 1 件のみ", () => {
  const q = makeValidQ("q_001");
  const result = makeResultWithQuestions([q], []);
  const answers: ClarificationAnswer[] = [
    {
      question_id: "q_001",
      answer_text: "私の回答",
      answered_at: Date.now(),
      scope: "global",
    },
  ];
  const text = buildClarificationEnrichedIntent(answers, result);
  assert.ok(text.includes("[逆質問への回答]"), `prefix が含まれていない: ${text}`);
  assert.ok(text.includes(q.question), `質問本文が含まれていない: ${text}`);
  assert.ok(text.includes("私の回答"), `回答が含まれていない: ${text}`);
  assert.ok(text.includes("Q (全体):"), `Q (全体) prefix が含まれていない: ${text}`);
});

test("buildClarificationEnrichedIntent: suggestion-bound 1 件のみ", () => {
  const q = makeValidQ("q_001");
  const result = makeResultWithQuestions([], [{ id: "sug_001", questions: [q] }]);
  const answers: ClarificationAnswer[] = [
    {
      question_id: "q_001",
      answer_text: "私の回答",
      answered_at: Date.now(),
      scope: "suggestion",
      suggestion_id: "sug_001",
    },
  ];
  const text = buildClarificationEnrichedIntent(answers, result);
  assert.ok(text.includes("Q (sug_001):"), `sug_001 prefix が含まれていない: ${text}`);
  assert.ok(text.includes(q.question), `質問本文が含まれていない: ${text}`);
});

test("buildClarificationEnrichedIntent: 空回答は除外、有効回答のみ含む", () => {
  const q1 = makeValidQ("q_001");
  const q2 = makeValidQ("q_002");
  const result = makeResultWithQuestions([q1, q2], []);
  const answers: ClarificationAnswer[] = [
    {
      question_id: "q_001",
      answer_text: "有効回答",
      answered_at: Date.now(),
      scope: "global",
    },
    {
      question_id: "q_002",
      answer_text: "   ", // 空回答
      answered_at: Date.now(),
      scope: "global",
    },
  ];
  const text = buildClarificationEnrichedIntent(answers, result);
  assert.ok(text.includes("有効回答"), "有効回答が含まれていない");
  assert.ok(!text.includes(q2.question), "空回答に対応する質問が含まれている");
});

test("buildClarificationEnrichedIntent: デッドリンク回答(質問が消えた)は skip", () => {
  const q = makeValidQ("q_001");
  // result には q_001 のみ、回答は q_999(存在しない)+ q_001
  const result = makeResultWithQuestions([q], []);
  const answers: ClarificationAnswer[] = [
    {
      question_id: "q_999",
      answer_text: "デッドリンク回答",
      answered_at: Date.now(),
      scope: "global",
    },
    {
      question_id: "q_001",
      answer_text: "正常回答",
      answered_at: Date.now(),
      scope: "global",
    },
  ];
  const text = buildClarificationEnrichedIntent(answers, result);
  assert.ok(text.includes("正常回答"), "正常回答が含まれていない");
  assert.ok(!text.includes("デッドリンク回答"), "デッドリンク回答が混入");
});

test("appendClarificationToUserContext: 空 enrichedIntent → base そのまま返す", () => {
  const result = appendClarificationToUserContext("既存 user_context", "");
  assert.equal(result, "既存 user_context");
});

test("appendClarificationToUserContext: undefined enrichedIntent → base そのまま返す", () => {
  const result = appendClarificationToUserContext("既存", undefined);
  assert.equal(result, "既存");
});

test("appendClarificationToUserContext: 空 base + 有効 enriched → enriched のみ", () => {
  const result = appendClarificationToUserContext(
    "",
    "[逆質問への回答]\nQ: テスト\nA: 回答",
  );
  assert.equal(result, "[逆質問への回答]\nQ: テスト\nA: 回答");
});

test("appendClarificationToUserContext: base ありで 1 空行区切り append", () => {
  const result = appendClarificationToUserContext(
    "既存文脈",
    "[逆質問への回答]\nQ: テスト\nA: 回答",
  );
  assert.equal(result, "既存文脈\n\n[逆質問への回答]\nQ: テスト\nA: 回答");
});

// =============================================================================
// triggerReanalysisWithClarifications: enriched_intent 経路 + log entry
// =============================================================================
process.stdout.write(
  "\n[triggerReanalysisWithClarifications: enriched_intent 経路]\n",
);

test("triggerReanalysisWithClarifications: 0 件で no-op(trigger 立たない)", () => {
  resetStore();
  const before = useAnalyzeStore.getState().partialRefreshTrigger;
  useAnalyzeStore.getState().triggerReanalysisWithClarifications();
  const after = useAnalyzeStore.getState().partialRefreshTrigger;
  assert.equal(after, before);
});

test("triggerReanalysisWithClarifications: 1 件以上で trigger +1 + actionLog 追加", () => {
  resetStore();
  // analysisResult を setup(質問本文 lookup に必要)
  const q = makeValidQ("q_001");
  const result: AnalysisResult = {
    ...makeBaseResult(),
    es_state_version: 1,
    global_clarification_questions: [q],
  };
  useAnalyzeStore.setState({ analysisResult: result });
  const { updateClarificationAnswer, triggerReanalysisWithClarifications } =
    useAnalyzeStore.getState();
  updateClarificationAnswer({
    question_id: "q_001",
    scope: "global",
    answer_text: "テスト回答",
  });

  const beforeTrigger = useAnalyzeStore.getState().partialRefreshTrigger;
  const beforeLogLength = useAnalyzeStore.getState().actionLog.length;
  triggerReanalysisWithClarifications();
  const after = useAnalyzeStore.getState();

  assert.equal(after.partialRefreshTrigger, beforeTrigger + 1);
  assert.equal(after.actionLog.length, beforeLogLength + 1);
  const entry = after.actionLog[after.actionLog.length - 1];
  assert.equal(entry.type, "clarification_answered");
  assert.equal(entry.clarificationSnapshot?.question_id, "q_001");
  assert.equal(entry.clarificationSnapshot?.scope, "global");
  assert.equal(entry.clarificationSnapshot?.answer_text, "テスト回答");
  assert.equal(entry.clarificationSnapshot?.question_text, q.question);
  // pendingRefreshScope が立っている(reason: manual、scope: scoped)
  assert.equal(after.pendingRefreshScope?.kind, "scoped");
  assert.equal(after.pendingRefreshScope?.reason, "manual");
});

// =============================================================================
// 2026-05-29 dogfood(es5 capture): clarification question id の重複(q_001 衝突)
// =============================================================================
// 複数 suggestion が同じ question_id(q_001)を持つ時、回答が混線しないこと +
// 集約リストの identity(React key 相当)が一意であることを担保する。
process.stdout.write(
  "\n[question_id 重複(q_001 衝突): 複合キーで回答が混線しない]\n",
);

test("clarificationIdentity: 別 suggestion の同名 question_id は別キー", () => {
  const k1 = clarificationIdentity({
    scope: "suggestion",
    suggestion_id: "sug_003",
    question_id: "q_001",
  });
  const k2 = clarificationIdentity({
    scope: "suggestion",
    suggestion_id: "sug_005",
    question_id: "q_001",
  });
  const kGlobal = clarificationIdentity({ scope: "global", question_id: "q_001" });
  assert.notEqual(k1, k2, "別 suggestion の q_001 が同一キーになっている(衝突)");
  assert.notEqual(k1, kGlobal, "suggestion と global の q_001 が同一キー");
  // 同一(scope, suggestion_id, question_id)は安定して同じキー
  assert.equal(
    k1,
    clarificationIdentity({
      scope: "suggestion",
      suggestion_id: "sug_003",
      question_id: "q_001",
    }),
  );
});

test("2 提案が同じ q_001 を持つ時、回答が別 entry として独立保存される(混線しない)", () => {
  resetStore();
  const { updateClarificationAnswer } = useAnalyzeStore.getState();
  // sug_003 の q_001 に回答
  updateClarificationAnswer({
    question_id: "q_001",
    suggestion_id: "sug_003",
    scope: "suggestion",
    answer_text: "sug_003 への回答",
  });
  // sug_005 の q_001 に回答(同じ question_id だが別 suggestion)
  updateClarificationAnswer({
    question_id: "q_001",
    suggestion_id: "sug_005",
    scope: "suggestion",
    answer_text: "sug_005 への回答",
  });
  const answers = useAnalyzeStore.getState().clarificationAnswers;
  // 上書きされず 2 entry として独立して並ぶ(question_id 単独照合だと 1 件に潰れる)
  assert.equal(answers.length, 2, "回答が上書きされて混線している");
  const a003 = answers.find((a) => a.suggestion_id === "sug_003");
  const a005 = answers.find((a) => a.suggestion_id === "sug_005");
  assert.equal(a003?.answer_text, "sug_003 への回答");
  assert.equal(a005?.answer_text, "sug_005 への回答");
});

test("2 提案の同名 q_001: 片方を更新しても他方の回答は変わらない", () => {
  resetStore();
  const { updateClarificationAnswer } = useAnalyzeStore.getState();
  updateClarificationAnswer({
    question_id: "q_001",
    suggestion_id: "sug_003",
    scope: "suggestion",
    answer_text: "旧 sug_003",
  });
  updateClarificationAnswer({
    question_id: "q_001",
    suggestion_id: "sug_005",
    scope: "suggestion",
    answer_text: "sug_005 固定",
  });
  // sug_003 の q_001 だけ更新
  updateClarificationAnswer({
    question_id: "q_001",
    suggestion_id: "sug_003",
    scope: "suggestion",
    answer_text: "新 sug_003",
  });
  const answers = useAnalyzeStore.getState().clarificationAnswers;
  assert.equal(answers.length, 2, "更新が他方を巻き込んで件数が変わった");
  const a003 = answers.find((a) => a.suggestion_id === "sug_003");
  const a005 = answers.find((a) => a.suggestion_id === "sug_005");
  assert.equal(a003?.answer_text, "新 sug_003");
  assert.equal(a005?.answer_text, "sug_005 固定", "他方が巻き込まれて変化した");
});

test("2 提案の同名 q_001: 片方を空にしても他方は残る(clean-up が混線しない)", () => {
  resetStore();
  const { updateClarificationAnswer } = useAnalyzeStore.getState();
  updateClarificationAnswer({
    question_id: "q_001",
    suggestion_id: "sug_003",
    scope: "suggestion",
    answer_text: "sug_003",
  });
  updateClarificationAnswer({
    question_id: "q_001",
    suggestion_id: "sug_005",
    scope: "suggestion",
    answer_text: "sug_005",
  });
  // sug_003 の q_001 を空に(entry 除去)
  updateClarificationAnswer({
    question_id: "q_001",
    suggestion_id: "sug_003",
    scope: "suggestion",
    answer_text: "",
  });
  const answers = useAnalyzeStore.getState().clarificationAnswers;
  assert.equal(answers.length, 1, "片方クリアで両方消えた(混線)");
  assert.equal(answers[0].suggestion_id, "sug_005");
  assert.equal(answers[0].answer_text, "sug_005");
});

test("2 提案の同名 q_001: clearClarificationAnswer は複合キーで片方のみ除去", () => {
  resetStore();
  const { updateClarificationAnswer, clearClarificationAnswer } =
    useAnalyzeStore.getState();
  updateClarificationAnswer({
    question_id: "q_001",
    suggestion_id: "sug_003",
    scope: "suggestion",
    answer_text: "sug_003",
  });
  updateClarificationAnswer({
    question_id: "q_001",
    suggestion_id: "sug_005",
    scope: "suggestion",
    answer_text: "sug_005",
  });
  clearClarificationAnswer({
    question_id: "q_001",
    suggestion_id: "sug_003",
    scope: "suggestion",
  });
  const answers = useAnalyzeStore.getState().clarificationAnswers;
  assert.equal(answers.length, 1);
  assert.equal(answers[0].suggestion_id, "sug_005");
});

test("buildClarificationEnrichedIntent: 同名 q_001 でも各回答が正しい suggestion の質問に紐づく", () => {
  // sug_003 / sug_005 が両方 q_001 を持つ(本文は別)
  const q003 = {
    id: "q_001",
    question: "sug_003 の特訓のきっかけは何ですか?(5 字以上)",
    rationale: "sug_003 用の理由テキスト(10 字以上 300 字以下)",
  };
  const q005 = {
    id: "q_001",
    question: "sug_005 のチームでの役割は何でしたか?(5 字以上)",
    rationale: "sug_005 用の理由テキスト(10 字以上 300 字以下)",
  };
  const result = makeResultWithQuestions(
    [],
    [
      { id: "sug_003", questions: [q003] },
      { id: "sug_005", questions: [q005] },
    ],
  );
  const answers: ClarificationAnswer[] = [
    {
      question_id: "q_001",
      answer_text: "sug_003 の回答内容",
      answered_at: Date.now(),
      scope: "suggestion",
      suggestion_id: "sug_003",
    },
    {
      question_id: "q_001",
      answer_text: "sug_005 の回答内容",
      answered_at: Date.now(),
      scope: "suggestion",
      suggestion_id: "sug_005",
    },
  ];
  const text = buildClarificationEnrichedIntent(answers, result);
  // 各 Q/A ペアが「正しい質問本文」に紐づくこと(取り違えが起きない)。
  // sug_003 の回答が sug_003 の質問本文の直後に出る、sug_005 も同様。
  assert.ok(
    text.includes(`Q (sug_003): ${q003.question}\nA: sug_003 の回答内容`),
    `sug_003 の Q/A が正しく対応していない: ${text}`,
  );
  assert.ok(
    text.includes(`Q (sug_005): ${q005.question}\nA: sug_005 の回答内容`),
    `sug_005 の Q/A が正しく対応していない: ${text}`,
  );
  // 取り違え(sug_003 の回答が sug_005 の質問本文に付く 等)が無いこと
  assert.ok(
    !text.includes(`Q (sug_005): ${q005.question}\nA: sug_003 の回答内容`),
    `回答が取り違えた質問に紐づいた(混線): ${text}`,
  );
});

test("triggerReanalysisWithClarifications: 同名 q_001 の各回答が正しい質問本文で履歴 push される", () => {
  resetStore();
  const q003 = {
    id: "q_001",
    question: "sug_003 の特訓のきっかけは?(5 字以上)",
    rationale: "sug_003 用の理由テキスト(10 字以上 300 字以下)",
  };
  const q005 = {
    id: "q_001",
    question: "sug_005 の役割は?(5 字以上 OK)",
    rationale: "sug_005 用の理由テキスト(10 字以上 300 字以下)",
  };
  const result: AnalysisResult = {
    ...makeBaseResult(),
    es_state_version: 1,
    suggestions: [
      { ...makeBaseSuggestion("sug_003"), clarification_questions: [q003] },
      { ...makeBaseSuggestion("sug_005"), clarification_questions: [q005] },
    ],
  };
  useAnalyzeStore.setState({ analysisResult: result });
  const { updateClarificationAnswer, triggerReanalysisWithClarifications } =
    useAnalyzeStore.getState();
  updateClarificationAnswer({
    question_id: "q_001",
    suggestion_id: "sug_003",
    scope: "suggestion",
    answer_text: "回答 003",
  });
  updateClarificationAnswer({
    question_id: "q_001",
    suggestion_id: "sug_005",
    scope: "suggestion",
    answer_text: "回答 005",
  });
  triggerReanalysisWithClarifications();
  const log = useAnalyzeStore.getState().actionLog;
  const claLog = log.filter((e) => e.type === "clarification_answered");
  assert.equal(claLog.length, 2, "2 件の回答が履歴に push されていない");
  const snap003 = claLog.find(
    (e) => e.clarificationSnapshot?.suggestion_id === "sug_003",
  )?.clarificationSnapshot;
  const snap005 = claLog.find(
    (e) => e.clarificationSnapshot?.suggestion_id === "sug_005",
  )?.clarificationSnapshot;
  // question_text が取り違えられていない(複合キー lookup で正しい質問が引けている)
  assert.equal(snap003?.question_text, q003.question);
  assert.equal(snap003?.answer_text, "回答 003");
  assert.equal(snap005?.question_text, q005.question);
  assert.equal(snap005?.answer_text, "回答 005");
});

test("集約リスト identity が一意: 同名 q_001 + global q_001 でも key が衝突しない", () => {
  // ClarificationSection の React key 相当の集約。3 件中 q_001 が 3 回出るが key は一意。
  const aggregate = [
    clarificationIdentity({
      scope: "suggestion",
      suggestion_id: "sug_003",
      question_id: "q_001",
    }),
    clarificationIdentity({
      scope: "suggestion",
      suggestion_id: "sug_005",
      question_id: "q_001",
    }),
    clarificationIdentity({ scope: "global", question_id: "q_001" }),
  ];
  const unique = new Set(aggregate);
  assert.equal(
    unique.size,
    aggregate.length,
    `集約リストの key が衝突している: ${JSON.stringify(aggregate)}`,
  );
});

// =============================================================================
// reset 系で clarificationAnswers が空になる
// =============================================================================
process.stdout.write("\n[reset 系で clarificationAnswers = []]\n");

test("startAnalysis で clarificationAnswers がクリア", () => {
  resetStore();
  const { updateClarificationAnswer, startAnalysis } = useAnalyzeStore.getState();
  updateClarificationAnswer({
    question_id: "q_001",
    scope: "global",
    answer_text: "回答",
  });
  assert.equal(useAnalyzeStore.getState().clarificationAnswers.length, 1);
  startAnalysis();
  assert.equal(useAnalyzeStore.getState().clarificationAnswers.length, 0);
});

test("resetSession で clarificationAnswers がクリア", () => {
  resetStore();
  const { updateClarificationAnswer, resetSession } = useAnalyzeStore.getState();
  updateClarificationAnswer({
    question_id: "q_001",
    scope: "global",
    answer_text: "回答",
  });
  assert.equal(useAnalyzeStore.getState().clarificationAnswers.length, 1);
  resetSession();
  assert.equal(useAnalyzeStore.getState().clarificationAnswers.length, 0);
});

// =============================================================================
// 結果出力
// =============================================================================
process.stdout.write(
  `\nResults: ${passCount} pass / ${failCount} fail\n`,
);
if (failCount > 0) {
  process.stdout.write("\nFailures:\n");
  for (const f of failures) process.stdout.write(f + "\n");
  process.exit(1);
}
