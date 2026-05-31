/**
 * v2 bug fix (2026-05-26): getDerivedEsBody / getDerivedSpans のユニットテスト。
 *
 * 派生 ES 計算で `structural` カテゴリが完全 skip されることを担保する。
 * structural の `proposed` は「(段落削除:冒頭の宣言文段落を取り除き、直接エピソードに
 * 入る)」のような placeholder(operation 説明文)で、文字単位の置換対象ではない。
 * 採用済 structural を従来の置換ロジックで処理すると、Canvas に表示される派生 ES に
 * placeholder が混入する重大バグになる(本セッション dogfood で発覚)。
 *
 * 本テストは「structural の placeholder proposed が派生 ES 本文に混入しない」「累積
 * オフセット計算が structural の影響で狂わない」ことを構造で担保する。
 *
 * 実行方法: `pnpm test:derived`(net 呼び出しなし、ローカル即時実行)
 *
 * SSOT:
 *  - lib/state/analyze_store.ts:getDerivedEsBody / getDerivedSpans
 *  - lib/state/structural_ops.ts:applyStructuralOperation(structural 適用本体)
 *  - DECISIONS.md [2026-05-26] v2 緊急 bug fix(structural 採用後の派生 ES への
 *    operation 説明文混入)
 */

import { strict as assert } from "node:assert";
import {
  getDerivedEsBody,
  getDerivedSpans,
  reAnchorSuggestionsToFormEsBody,
  reconcileSpansToDisplayedText,
  useAnalyzeStore,
} from "@/lib/state/analyze_store";
import type { DerivedSpan } from "@/lib/state/analyze_store";
import type { AnalysisResult } from "@/lib/schema/analysis";
import type { Category, Suggestion } from "@/lib/schema/suggestion";

// テスト用 minimal suggestion 型(SuggestionForDerive と互換)。
type S = {
  id: string;
  category: Category;
  original_span: { start: number; end: number };
  proposed: string;
};

// reAnchorSuggestionsToFormEsBody 用フル Suggestion factory。
// SuggestionSchema の必須 field を埋めるが、テスト本体で関心がある field は
// `id` / `original` / `original_span` のみ。他は default placeholder。
function makeFullSuggestion(
  overrides: Pick<Suggestion, "id" | "original" | "original_span"> &
    Partial<Suggestion>,
): Suggestion {
  return {
    category: "convention",
    proposed: "代替テキスト",
    alternatives: [],
    rationale: "理由テキスト",
    rationale_source: { type: "convention", reference: "ES 慣習" },
    related_suggestion_ids: [],
    ...overrides,
  };
}

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
// getDerivedEsBody: structural placeholder 混入回避
// =============================================================================
process.stdout.write("[getDerivedEsBody: structural placeholder 混入回避]\n");

test("structural suggestion (採用済) の proposed placeholder が派生 ES 本文に混入しない", () => {
  // バグ報告: 「(削除し、副キャプテンとして向き合った課題から書き始める)」のような
  // operation 説明文が ES 冒頭に挿入されていた。本テストは同型の再現を防ぐ。
  const esBody = "本文段落のテキスト";
  const suggestions: S[] = [
    {
      id: "sug_007",
      category: "structural",
      original_span: { start: 0, end: 6 },
      proposed: "(削除し、副キャプテンとして向き合った課題から書き始める)",
    },
  ];
  const acceptedIds = ["sug_007"];
  const editedMap = {};
  const result = getDerivedEsBody(esBody, suggestions, acceptedIds, editedMap);
  // 採用済 structural は派生 ES 計算で完全 skip されるため、esBody がそのまま返る
  // (structural の派生 ES 反映は acceptSuggestion 内の applyStructuralOperation 側で完結)。
  assert.equal(result, esBody);
  assert.ok(
    !result.includes("(削除し"),
    `placeholder が派生 ES に混入: ${result}`,
  );
});

test("structural suggestion (未採用) も派生 ES 本文に何も影響を与えない", () => {
  const esBody = "本文段落のテキスト";
  const suggestions: S[] = [
    {
      id: "sug_007",
      category: "structural",
      original_span: { start: 0, end: 6 },
      proposed: "(削除し、〇〇から書き始める)",
    },
  ];
  const acceptedIds: string[] = [];
  const editedMap = {};
  const result = getDerivedEsBody(esBody, suggestions, acceptedIds, editedMap);
  assert.equal(result, esBody);
});

test("structural と error の混在: error の置換は正常、structural は完全 skip(累積オフセット狂わない)", () => {
  // 元 ES「ABCDEFGHIJ」(10 文字)
  // - error: span [0, 3]「ABC」→「X」(3 → 1 文字、offset -2)
  // - structural: span [5, 8]「FGH」→ placeholder(skip 必須、本来の挙動: 何も起きない)
  // 期待: 「XDEFGHIJ」(error のみ適用、structural は無視で累積オフセット影響なし)
  const esBody = "ABCDEFGHIJ";
  const suggestions: S[] = [
    {
      id: "err_001",
      category: "error",
      original_span: { start: 0, end: 3 },
      proposed: "X",
    },
    {
      id: "str_001",
      category: "structural",
      original_span: { start: 5, end: 8 },
      proposed: "(段落削除:中盤を除去)",
    },
  ];
  const acceptedIds = ["err_001", "str_001"];
  const editedMap = {};
  const result = getDerivedEsBody(esBody, suggestions, acceptedIds, editedMap);
  assert.equal(result, "XDEFGHIJ");
  // structural の placeholder は混入していない
  assert.ok(!result.includes("(段落削除"), `placeholder が混入: ${result}`);
});

test("structural が先頭 span でも、後続 error の派生位置がずれない", () => {
  // 修正前のバグ: structural の span を処理すると lastEnd が更新され、後続 error の
  // 累積オフセット計算が狂う(structural の placeholder 長で offset += が走るため)。
  // 修正後: structural を完全 skip するため、後続 error は元の original_span 通り適用。
  const esBody = "ABCDEFGHIJ";
  const suggestions: S[] = [
    {
      id: "str_001",
      category: "structural",
      original_span: { start: 0, end: 3 },
      proposed:
        "(段落順 0 → 2 → 1 に並べ替える、長い placeholder で offset を狂わせる試み)",
    },
    {
      id: "err_001",
      category: "error",
      original_span: { start: 5, end: 8 },
      proposed: "Y",
    },
  ];
  const acceptedIds = ["str_001", "err_001"];
  const editedMap = {};
  const result = getDerivedEsBody(esBody, suggestions, acceptedIds, editedMap);
  // structural は何もしない、error は [5, 8] = "FGH" を "Y" に置換
  // → "ABCDE" + "Y" + "IJ" = "ABCDEYIJ"
  assert.equal(result, "ABCDEYIJ");
  assert.ok(
    !result.includes("(段落順"),
    `structural placeholder が混入: ${result}`,
  );
});

test("structural の original_span が currentEsBody の範囲内に偶然収まっても、何も挿入しない", () => {
  // 元 ES「段落1\n\n段落2」(7 文字)、structural delete_paragraph 採用後の currentEsBody は
  // 「段落2」(3 文字)に短縮。structural の original_span [0, 3] は新 currentEsBody の中に
  // 偶然収まっている。修正前: そのまま placeholder で置換 = バグ。修正後: skip。
  const currentEsBodyAfterStructural = "段落2";
  const suggestions: S[] = [
    {
      id: "str_001",
      category: "structural",
      original_span: { start: 0, end: 3 },
      proposed: "(段落削除:冒頭段落を削除して直接エピソードに入る)",
    },
  ];
  const acceptedIds = ["str_001"];
  const editedMap = {};
  const result = getDerivedEsBody(
    currentEsBodyAfterStructural,
    suggestions,
    acceptedIds,
    editedMap,
  );
  // 期待: 「段落2」がそのまま返る(structural は適用済として skip)
  assert.equal(result, "段落2");
  assert.ok(!result.includes("(段落削除"), `placeholder 混入: ${result}`);
});

// =============================================================================
// getDerivedSpans: structural が span 配列から除外される
// =============================================================================
process.stdout.write("[getDerivedSpans: structural 完全 skip]\n");

test("structural suggestion (採用済) は派生 span 配列に含まれない", () => {
  const suggestions: S[] = [
    {
      id: "str_001",
      category: "structural",
      original_span: { start: 0, end: 5 },
      proposed: "(段落削除:冒頭の宣言文段落を取り除く)",
    },
  ];
  const spans = getDerivedSpans(suggestions, ["str_001"], {}, [], 100);
  assert.equal(spans.length, 0);
});

test("structural suggestion (未採用) も派生 span 配列に含まれない", () => {
  const suggestions: S[] = [
    {
      id: "str_001",
      category: "structural",
      original_span: { start: 0, end: 5 },
      proposed: "(段落削除:冒頭の宣言文段落を取り除く)",
    },
  ];
  const spans = getDerivedSpans(suggestions, [], {}, [], 100);
  assert.equal(spans.length, 0);
});

test("structural と error の混在: error の span のみが返る、structural は除外", () => {
  const suggestions: S[] = [
    {
      id: "err_001",
      category: "error",
      original_span: { start: 0, end: 3 },
      proposed: "X",
    },
    {
      id: "str_001",
      category: "structural",
      original_span: { start: 5, end: 8 },
      proposed: "(段落削除:中盤を除去)",
    },
  ];
  const spans = getDerivedSpans(suggestions, ["err_001", "str_001"], {}, [], 10);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].suggestion_id, "err_001");
});

test("structural が先頭 span でも、後続 error の派生位置(derivedStart / derivedEnd)が狂わない", () => {
  // 修正前: structural の lastEnd 更新で後続 error の累積オフセット計算が狂っていた。
  // 修正後: structural skip で後続 error は元の original_span 通り。
  const suggestions: S[] = [
    {
      id: "str_001",
      category: "structural",
      original_span: { start: 0, end: 3 },
      proposed: "(段落順を並べ替える、長い placeholder)",
    },
    {
      id: "err_001",
      category: "error",
      original_span: { start: 5, end: 8 },
      proposed: "Y",
    },
  ];
  const spans = getDerivedSpans(suggestions, ["err_001"], {}, [], 10);
  // structural は除外、error 1 件のみ。採用済 error の派生 span は置換後の範囲 [5, 5+1=6]
  // (offset 0 で derivedStart = 5、replacement.length = 1)
  assert.equal(spans.length, 1);
  assert.equal(spans[0].suggestion_id, "err_001");
  assert.equal(spans[0].isApplied, true);
  assert.equal(spans[0].derivedStart, 5);
  assert.equal(spans[0].derivedEnd, 6);
});

// =============================================================================
// 2026-05-28 overlap-shadowing bug fix: 未採用提案が採用済提案を shadow しない
// =============================================================================
// 本 section は dogfood で発覚した「採用した修正が派生 ES から消える」bug の構造的
// 再発防止。root cause:
//   getDerivedEsBody / getDerivedSpans は suggestions を start 昇順で走査し、`lastEnd`
//   cursor で重なりを弾く(`if (start < lastEnd) continue`)。修正前は **未採用 / 未編集**
//   の suggestion も `lastEnd = end` を立てていた。未採用は派生 text を変えないにもかかわらず
//   cursor を進めるため、後続にソートされる **採用済** の suggestion で span が重なるものが
//   overlap ガードに弾かれ、採用済の置換が派生 ES から消えた(= 未採用が採用済を shadow)。
//
// 再現(es2 実データ): 採用済の誤字修正 sug_002(span [63,65]「成積」→「成績」)が、
//   未採用の sug_007(span [60,71])に shadow される。sug_007 が先にソートされ(60<63)
//   `lastEnd=71` を立てる → sug_002 は `63 < 71` で skip → 派生 ES から「成績」修正が消え、
//   typo「成積」が復活(ユーザーが画面で確認した visible bug)。
//
// 修正: 未採用 / 未編集(= 置換が発生しない側)は `lastEnd` を進めない。採用済 / 編集済
//   だけが cursor を進める。getDerivedEsBody / getDerivedSpans を対称に修正。
//   なお「採用済 → 未採用」順で採用済が未採用を弾く既存挙動(reAnchor 経路の防御線、
//   後述の reAnchor case 7 等)は採用済側の lastEnd で維持される(本修正は採用済の
//   lastEnd 更新を一切変えない)。
process.stdout.write("[overlap-shadowing: 未採用が採用済を shadow しない]\n");

test("getDerivedEsBody (es2 再現): 先にソートされる未採用提案 [60,71] が、採用済の誤字修正 [63,65]→「成績」を shadow しない", () => {
  // 修正前 RED: 未採用 sug_007 が lastEnd=71 を立て、採用済 sug_002 が 63<71 で skip
  //   → 派生 ES に「成績」が含まれず typo「成積」が残存。
  // 修正後 GREEN: 未採用は lastEnd を進めないので採用済 sug_002 が適用され「成積」→「成績」。
  // esBody は span 座標([63,65] が「成積」)を満たすダミー本文(長さ 80)。
  const esBody = "あ".repeat(63) + "成積" + "い".repeat(15); // 63 + 2 + 15 = 80
  const suggestions: S[] = [
    {
      id: "sug_007",
      category: "convention",
      original_span: { start: 60, end: 71 },
      proposed: "（未採用の言い換え提案）",
    },
    {
      id: "sug_002",
      category: "error",
      original_span: { start: 63, end: 65 },
      proposed: "成績",
    },
  ];
  const result = getDerivedEsBody(esBody, suggestions, ["sug_002"], {});
  // 採用済の誤字修正が派生 ES に **含まれる**
  assert.ok(result.includes("成績"), `採用済の修正が消えている: ${result}`);
  // typo が復活していない
  assert.ok(!result.includes("成積"), `typo「成積」が復活している: ${result}`);
  // 当該位置が正しく置換されている(未採用 sug_007 の placeholder は混入しない)
  assert.equal(result.slice(60, 66), "あああ成績い");
  assert.ok(
    !result.includes("（未採用"),
    `未採用提案の proposed が混入: ${result}`,
  );
});

test("getDerivedSpans (es2 再現): 先にソートされる未採用 [60,71] が、採用済 [63,65] のハイライト span を消さない", () => {
  // 修正前 RED: spans に sug_002 が含まれない(lastEnd=71 で 63<71 ガードに弾かれた)。
  // 修正後 GREEN: 未採用 sug_007 は lastEnd を進めないので採用済 sug_002 の span が残る。
  const esBodyLength = 80;
  const suggestions: S[] = [
    {
      id: "sug_007",
      category: "convention",
      original_span: { start: 60, end: 71 },
      proposed: "（未採用の言い換え提案）",
    },
    {
      id: "sug_002",
      category: "error",
      original_span: { start: 63, end: 65 },
      proposed: "成績",
    },
  ];
  const spans = getDerivedSpans(suggestions, ["sug_002"], {}, [], esBodyLength);
  // 両方の span が返る(未採用 sug_007 + 採用済 sug_002)
  assert.equal(spans.length, 2);
  const applied = spans.find((s) => s.suggestion_id === "sug_002");
  assert.ok(applied, "採用済 sug_002 のハイライト span が消えている");
  assert.equal(applied!.isApplied, true);
  // sug_007 が先にソートされても lastEnd を進めないため、sug_002 は元座標基準で span を持つ。
  // sug_007 は採用前で offset 0 のまま → sug_002 の derived span = [63, 63+「成績」.length=65]。
  assert.equal(applied!.derivedStart, 63);
  assert.equal(applied!.derivedEnd, 65);
  const unaccepted = spans.find((s) => s.suggestion_id === "sug_007");
  assert.ok(unaccepted, "未採用 sug_007 の span も維持される");
  assert.equal(unaccepted!.isApplied, false);
});

test("getDerivedEsBody: 未採用提案が複数連続しても採用済の置換を shadow しない(cursor が暴走しない)", () => {
  // 元 ES = "ABCDEFGHIJ"(10 文字)
  //  - 未採用 sug_a: [0, 6]「ABCDEF」(先頭、長い)
  //  - 未採用 sug_b: [1, 4]「BCD」(sug_a に内包)
  //  - 採用済 sug_c: [2, 5]「CDE」→「X」(sug_a / sug_b と重なる)
  // 修正前: sug_a が lastEnd=6 → sug_b skip(1<6)+ sug_c skip(2<6)→ 置換消失「ABCDEFGHIJ」。
  // 修正後: 未採用は lastEnd を進めない → sug_c が適用「AB」+「X」+「FGHIJ」=「ABXFGHIJ」。
  const esBody = "ABCDEFGHIJ";
  const suggestions: S[] = [
    {
      id: "sug_a",
      category: "convention",
      original_span: { start: 0, end: 6 },
      proposed: "（未採用a）",
    },
    {
      id: "sug_b",
      category: "alternative",
      original_span: { start: 1, end: 4 },
      proposed: "（未採用b）",
    },
    {
      id: "sug_c",
      category: "error",
      original_span: { start: 2, end: 5 },
      proposed: "X",
    },
  ];
  const result = getDerivedEsBody(esBody, suggestions, ["sug_c"], {});
  assert.equal(result, "ABXFGHIJ");
  assert.ok(!result.includes("（未採用"), `未採用 proposed 混入: ${result}`);
});

test("getDerivedSpans: 既存の防御線維持 — 「採用済 → 未採用」順では採用済が後続の重なる未採用を弾く(本修正で壊さない)", () => {
  // 採用済 sug_old [5,10]→「Y」が lastEnd=10 を立て、後続にソートされる未採用 sug_new [6,11]
  // (6 < 10)は overlap ガードで skip される。これは reAnchor 経路の防御線(座標系混在時の
  // 多重ハイライト回避)。本修正は採用済側の lastEnd 更新を一切変えないため、この挙動は不変。
  const suggestions: S[] = [
    {
      id: "sug_old",
      category: "error",
      original_span: { start: 5, end: 10 },
      proposed: "Y",
    },
    {
      id: "sug_new",
      category: "convention",
      original_span: { start: 6, end: 11 },
      proposed: "改善",
    },
  ];
  const spans = getDerivedSpans(suggestions, ["sug_old"], {}, [], 20);
  // 採用済が lastEnd=10 を立て、未採用 sug_new(6<10)は依然 skip される(防御線維持)。
  assert.equal(spans.length, 1);
  assert.equal(spans[0].suggestion_id, "sug_old");
});

// =============================================================================
// 2026-05-27 Task E bug fix regression: 累積オフセット計算と範囲ガード基準
// =============================================================================
// 本 section は dogfood round 2 で発覚した「partial refresh 完了後、未採用 suggestion が
// ハイライトされない」bug の構造的再発防止。
//
// 仕様:
//  - `getDerivedSpans` の `esBodyLength` 引数は「**分析時点の元 ES の長さ**」を渡す。
//    `suggestion.original_span` は LLM が分析時点の ES 本文に対して出した座標で、
//    範囲ガード `end > esBodyLength` はその基準で判定すべき。
//  - structural 採用で currentEsBody が短縮しても、`original_span` の座標系は不変。
//    範囲ガードに `currentEsBody.length`(structural 後の短い値)を渡すと、未採用 suggestion の
//    `end > currentEsBody.length` が成立して span が落ち、ハイライト消失 bug が起きていた。
//    修正後の Canvas は `form.es_body.length`(分析時点の元 ES の長さ)を渡す。
//  - 累積オフセット計算は **通常 suggestion(error/convention/alternative)の置換差分** のみ。
//    structural は派生計算から完全 skip(category === "structural" で continue)のため
//    `offset` 更新も span 追加もしない、影響なし。
process.stdout.write("[Task E regression: 累積 offset + 範囲ガード]\n");

test("case 1: 未採用 1 件が採用済より前にある — 座標は変わらず", () => {
  // 元 ES = "ABCDEFGHIJ"(10 文字)
  //  - 未採用 sug_pre: [0, 3] = "ABC"
  //  - 採用済 sug_after: [5, 8] = "FGH" → "Y"(置換、offset -2)
  // 期待: 未採用 sug_pre は accepted/edited 集合に無いため `isApplied: false`、derivedStart = 0
  // (前にあるので offset 0、後続採用済の置換は前の span に影響なし)
  const suggestions: S[] = [
    {
      id: "sug_pre",
      category: "convention",
      original_span: { start: 0, end: 3 },
      proposed: "X",
    },
    {
      id: "sug_after",
      category: "error",
      original_span: { start: 5, end: 8 },
      proposed: "Y",
    },
  ];
  const spans = getDerivedSpans(suggestions, ["sug_after"], {}, [], 10);
  assert.equal(spans.length, 2);
  const preSpan = spans.find((s) => s.suggestion_id === "sug_pre")!;
  assert.equal(preSpan.derivedStart, 0);
  assert.equal(preSpan.derivedEnd, 3);
  assert.equal(preSpan.isApplied, false);
});

test("case 2: 未採用 1 件が採用済より後にある — offset 分ずれる", () => {
  // 元 ES = "ABCDEFGHIJ"(10 文字)
  //  - 採用済 sug_first: [0, 3] = "ABC" → "X"(offset -2)
  //  - 未採用 sug_later: [5, 8] = "FGH"(派生 ES では位置が -2 ずれて [3, 6])
  const suggestions: S[] = [
    {
      id: "sug_first",
      category: "error",
      original_span: { start: 0, end: 3 },
      proposed: "X",
    },
    {
      id: "sug_later",
      category: "convention",
      original_span: { start: 5, end: 8 },
      proposed: "Y",
    },
  ];
  const spans = getDerivedSpans(suggestions, ["sug_first"], {}, [], 10);
  assert.equal(spans.length, 2);
  const laterSpan = spans.find((s) => s.suggestion_id === "sug_later")!;
  assert.equal(laterSpan.derivedStart, 3); // 5 + offset(-2)
  assert.equal(laterSpan.derivedEnd, 6); // 8 + offset(-2)
  assert.equal(laterSpan.isApplied, false);
});

test("case 3: 採用済 proposed が original より短い — 後続 offset が負", () => {
  // 元 ES = "ABCDEFGHIJ"(10 文字)
  //  - 採用済 sug_short: [0, 5] = "ABCDE" → "X"(1 文字、offset -4)
  //  - 未採用 sug_after: [7, 9] = "HI"(派生 ES では [3, 5])
  const suggestions: S[] = [
    {
      id: "sug_short",
      category: "error",
      original_span: { start: 0, end: 5 },
      proposed: "X",
    },
    {
      id: "sug_after",
      category: "convention",
      original_span: { start: 7, end: 9 },
      proposed: "Z",
    },
  ];
  const spans = getDerivedSpans(suggestions, ["sug_short"], {}, [], 10);
  const afterSpan = spans.find((s) => s.suggestion_id === "sug_after")!;
  assert.equal(afterSpan.derivedStart, 3);
  assert.equal(afterSpan.derivedEnd, 5);
});

test("case 4: 採用済 proposed が original より長い — 後続 offset が正", () => {
  // 元 ES = "ABCDEFGHIJ"(10 文字)
  //  - 採用済 sug_long: [0, 3] = "ABC" → "WXYZ"(4 文字、offset +1)
  //  - 未採用 sug_after: [5, 8] = "FGH"(派生 ES では [6, 9])
  const suggestions: S[] = [
    {
      id: "sug_long",
      category: "error",
      original_span: { start: 0, end: 3 },
      proposed: "WXYZ",
    },
    {
      id: "sug_after",
      category: "convention",
      original_span: { start: 5, end: 8 },
      proposed: "Z",
    },
  ];
  const spans = getDerivedSpans(suggestions, ["sug_long"], {}, [], 10);
  const afterSpan = spans.find((s) => s.suggestion_id === "sug_after")!;
  assert.equal(afterSpan.derivedStart, 6); // 5 + offset(+1)
  assert.equal(afterSpan.derivedEnd, 9); // 8 + offset(+1)
});

test("case 5: 採用済 2 件 + 未採用 1 件 — 累積 offset 正しく加算される", () => {
  // 元 ES = "ABCDEFGHIJKL"(12 文字)
  //  - 採用済 sug_1: [0, 2] = "AB" → "Z"(1 文字、offset -1)
  //  - 採用済 sug_2: [4, 6] = "EF" → "WWW"(3 文字、offset -1 + 1 = 0)
  //  - 未採用 sug_3: [8, 11] = "IJK"(派生 ES でも [8, 11])
  const suggestions: S[] = [
    {
      id: "sug_1",
      category: "error",
      original_span: { start: 0, end: 2 },
      proposed: "Z",
    },
    {
      id: "sug_2",
      category: "error",
      original_span: { start: 4, end: 6 },
      proposed: "WWW",
    },
    {
      id: "sug_3",
      category: "convention",
      original_span: { start: 8, end: 11 },
      proposed: "Q",
    },
  ];
  const spans = getDerivedSpans(suggestions, ["sug_1", "sug_2"], {}, [], 12);
  const sug3Span = spans.find((s) => s.suggestion_id === "sug_3")!;
  // 累積 offset = (-1) + (1) = 0 → 元の座標と同じ
  assert.equal(sug3Span.derivedStart, 8);
  assert.equal(sug3Span.derivedEnd, 11);
});

test("case 6 (本 bug 直接再現): structural 採用で currentEsBody が短縮した後、未採用通常 suggestion の original_span.end > currentEsBody.length でもハイライト span を返す", () => {
  // 修正前 bug:
  //   - 元 ES.length = 100、structural 採用で currentEsBody.length が 70 に短縮
  //   - 未採用 sug_text.original_span = { start: 75, end: 90 }(元 ES 上の座標、有効)
  //   - 修正前: Canvas が `currentEsBody.length`(=70)を esBodyLength として渡す
  //     → 範囲ガード `end > esBodyLength`(90 > 70)が真 → span 落ち、ハイライト消失
  // 修正後:
  //   - Canvas が `form.es_body.length`(=100)を渡す
  //   - 範囲ガード `end > esBodyLength`(90 > 100)が偽 → span 維持
  // 本テストは getDerivedSpans の引数 esBodyLength を「元 ES の長さ」として渡す前提を担保。
  const suggestions: S[] = [
    {
      id: "sug_text",
      category: "convention",
      original_span: { start: 75, end: 90 },
      proposed: "改善後の表現",
    },
  ];
  // esBodyLength は「元 ES の長さ = 100」(structural 採用で currentEsBody が 70 に短縮した
  // ケースを想定するが、本関数は esBodyLength 引数を信頼する設計のため、呼び出し側 Canvas
  // が `form.es_body.length` を渡せば正しく動く)
  const spans = getDerivedSpans(suggestions, [], {}, [], 100);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].suggestion_id, "sug_text");
  assert.equal(spans[0].derivedStart, 75);
  assert.equal(spans[0].derivedEnd, 90);
  assert.equal(spans[0].isApplied, false);
});

test("case 7 (regression edge): esBodyLength より end が大きい場合のみ span 落ちる(範囲ガードが正しく機能)", () => {
  // 範囲ガード自体は維持(LLM が壊れた span を出した時の防御線)。
  // esBodyLength = 50 で end > 50 の span が来たら正常に落ちる。
  const suggestions: S[] = [
    {
      id: "sug_invalid",
      category: "error",
      original_span: { start: 30, end: 60 },
      proposed: "X",
    },
  ];
  const spans = getDerivedSpans(suggestions, [], {}, [], 50);
  assert.equal(spans.length, 0); // end (60) > esBodyLength (50) で skip
});

// =============================================================================
// 2026-05-27 derivedSpans 座標系統一 bug fix: reAnchorSuggestionsToFormEsBody
// =============================================================================
// 本 section は dogfood で再発した「partial refresh 完了後のハイライト境界ずれ + 消失」
// bug の構造的再発防止。root cause: サーバ側 resolveOriginalSpans は派生 ES(displayEsBody)
// 基準で indexOf 解決するため、partial 応答の updated / added は **派生 ES 座標系** の
// `original_span` を持つ。一方、未触の既存 suggestion は **form.es_body 座標系**。両者が
// merge されると Canvas の累積オフセット計算が壊れる(2 座標系混在)。
//
// 修正: applyPartialResult / applyRefreshResult / applyConflictNewVersion で新規 suggestion を
// `reAnchorSuggestionsToFormEsBody(form.es_body, ...)` で form.es_body 基準に再アンカーし、
// `analysisResult.suggestions` 全体を単一座標系(form.es_body)に揃える。
//
// 本 section は再アンカー関数の直接テスト + 仮想 partial 結果での再現テスト。
process.stdout.write("[derivedSpans 座標系統一: reAnchorSuggestionsToFormEsBody]\n");

test("reAnchor case 1: 派生 ES 基準 span を form.es_body 基準に正しく書き換える", () => {
  // 元 ES = "12345ABCDE67890XYZWV"(20 文字)
  // 採用済 sug_old: [5, 10]「ABCDE」→「Y」(置換、displayEsBody = "12345Y67890XYZWV"、16 文字)
  // partial 応答の sug_new(LLM が displayEsBody を見て生成、original = "XYZWV")
  //  - サーバが resolveOriginalSpans("12345Y67890XYZWV", "XYZWV") = indexOf → 11
  //  - つまり sug_new.original_span = {11, 16}(派生 ES 基準)
  // 期待: form.es_body 基準では "XYZWV" は indexOf = 15 → {15, 20}
  const formEsBody = "12345ABCDE67890XYZWV";
  const partialResultAdded: Suggestion[] = [
    makeFullSuggestion({
      id: "sug_new",
      original: "XYZWV",
      original_span: { start: 11, end: 16 }, // 派生 ES 基準
    }),
  ];
  const reAnchored = reAnchorSuggestionsToFormEsBody(
    formEsBody,
    partialResultAdded,
  );
  assert.equal(reAnchored.length, 1);
  assert.equal(reAnchored[0].id, "sug_new");
  assert.equal(reAnchored[0].original, "XYZWV");
  assert.equal(reAnchored[0].original_span.start, 15); // form.es_body 基準
  assert.equal(reAnchored[0].original_span.end, 20);
});

test("reAnchor case 2: form.es_body に元から存在する span(初回分析 / 採用なし)は no-op", () => {
  // 採用なし状態で初回分析時 = displayEsBody === form.es_body、座標系一致 = no-op
  const formEsBody = "abcDEFghi";
  const suggestions: Suggestion[] = [
    makeFullSuggestion({
      id: "sug_001",
      original: "DEF",
      original_span: { start: 3, end: 6 },
    }),
  ];
  const reAnchored = reAnchorSuggestionsToFormEsBody(formEsBody, suggestions);
  assert.equal(reAnchored.length, 1);
  // 既に form.es_body 基準なら参照同一(no-op 最適化)。挙動上の同等性のみ assert。
  assert.equal(reAnchored[0].original_span.start, 3);
  assert.equal(reAnchored[0].original_span.end, 6);
});

test("reAnchor case 3: form.es_body に original が存在しない場合(unanchorable)は元の span を温存", () => {
  // 採用済 sug の proposed 内のテキストを LLM が拾った稀ケース。
  // 例: form.es_body = "ABC...XYZ" に「DEF」(採用後の displayEsBody でのみ存在)を指す
  // 新規 sug が来た場合、indexOf = -1 → 元の派生 ES 基準 span 温存(防御線)。
  // Canvas の累積オフセットで slightly off になるが、span 落ち / ハイライト消失よりはマシ。
  const formEsBody = "12345XYZ"; // "DEF" は含まれない
  const suggestions: Suggestion[] = [
    makeFullSuggestion({
      id: "sug_in_proposed",
      original: "DEF",
      original_span: { start: 5, end: 8 }, // 派生 ES 基準で来た span
    }),
  ];
  const reAnchored = reAnchorSuggestionsToFormEsBody(formEsBody, suggestions);
  assert.equal(reAnchored.length, 1);
  // 元の span を温存(参照同一性 / 値同一性のどちらかで OK、ここでは値で確認)
  assert.equal(reAnchored[0].original_span.start, 5);
  assert.equal(reAnchored[0].original_span.end, 8);
});

test("reAnchor case 4: 重複出現(同一文字列が form.es_body に複数回)は最初の一致を採用", () => {
  // resolveOriginalSpans(lib/utils/es_anchor.ts:20)と同じ仕様(indexOf は最初の一致)。
  // 重複曖昧性の解消は v1 スコープ外(別 dispatch 課題)、本関数で挙動を変えない。
  const formEsBody = "テストAテストB"; // 「テスト」が 2 回
  const suggestions: Suggestion[] = [
    makeFullSuggestion({
      id: "sug_dup",
      original: "テスト",
      original_span: { start: 4, end: 7 }, // 2 回目のテスト位置(派生 ES 基準だった想定)
    }),
  ];
  const reAnchored = reAnchorSuggestionsToFormEsBody(formEsBody, suggestions);
  // form.es_body 上の最初の「テスト」= [0, 3] を採用
  assert.equal(reAnchored[0].original_span.start, 0);
  assert.equal(reAnchored[0].original_span.end, 3);
});

test("reAnchor case 5: 複数 suggestion を一括処理(map で 1 個ずつ独立に再アンカー)", () => {
  const formEsBody = "ABCDE12345fghij"; // 15 文字
  const suggestions: Suggestion[] = [
    makeFullSuggestion({
      id: "sug_a",
      original: "ABCDE",
      original_span: { start: 0, end: 5 },
    }),
    makeFullSuggestion({
      id: "sug_b",
      original: "12345",
      original_span: { start: 0, end: 5 }, // 派生 ES 基準で誤った位置だった想定
    }),
    makeFullSuggestion({
      id: "sug_c",
      original: "fghij",
      original_span: { start: 100, end: 105 }, // 不正だった想定
    }),
  ];
  const reAnchored = reAnchorSuggestionsToFormEsBody(formEsBody, suggestions);
  assert.equal(reAnchored.length, 3);
  assert.equal(reAnchored.find((s) => s.id === "sug_a")!.original_span.start, 0);
  assert.equal(reAnchored.find((s) => s.id === "sug_a")!.original_span.end, 5);
  assert.equal(reAnchored.find((s) => s.id === "sug_b")!.original_span.start, 5);
  assert.equal(reAnchored.find((s) => s.id === "sug_b")!.original_span.end, 10);
  assert.equal(reAnchored.find((s) => s.id === "sug_c")!.original_span.start, 10);
  assert.equal(reAnchored.find((s) => s.id === "sug_c")!.original_span.end, 15);
});

test("reAnchor case 6 (本 bug 直接再現): 派生 ES 基準 span を再アンカーしないと getDerivedSpans が誤位置 → 再アンカー後は正位置", () => {
  // 元 ES = "12345ABCDE67890XYZWV"(20 文字)
  // 採用済 sug_old: original_span [5, 10]「ABCDE」→ proposed「Y」
  //   - displayEsBody = "12345Y67890XYZWV"(16 文字)
  //   - 累積 offset = 1 - 5 = -4
  // partial 応答の sug_new(LLM が displayEsBody を見て生成、original = "XYZWV")
  //   - サーバが resolveOriginalSpans("12345Y67890XYZWV", "XYZWV") → start = 11
  //   - つまり partial 応答 sug_new.original_span = {11, 16}(派生 ES 基準)
  //
  // 再アンカー無しで Canvas に渡すと:
  //   getDerivedSpans([sug_old: {5,10}, sug_new: {11,16}], accepted=[sug_old], ..., esBodyLength=20)
  //   - sug_old: applied=true、derivedStart=5、derivedEnd=6(replacement「Y」.length=1)、offset=-4
  //   - sug_new: start=11 >= lastEnd=10、ガード OK
  //     derivedStart = 11 + (-4) = 7  ← 誤位置!正しくは 11(派生 ES 基準のまま)
  //     derivedEnd = 16 + (-4) = 12   ← 誤位置!正しくは 16
  //   → ハイライトが 4 文字ずれる(ユーザー報告の境界ずれ症状)
  //
  // 再アンカー有り(本 fix):
  //   form.es_body 上「XYZWV」の indexOf = 15、再アンカー後 sug_new.original_span = {15, 20}
  //   getDerivedSpans([sug_old: {5,10}, sug_new: {15,20}], accepted=[sug_old], ..., esBodyLength=20)
  //   - sug_old: derivedStart=5、derivedEnd=6、offset=-4
  //   - sug_new: derivedStart = 15 + (-4) = 11、derivedEnd = 20 + (-4) = 16 ← 正位置!
  //   → 派生 ES 上 [11, 16]「XYZWV」が正しくハイライトされる
  const formEsBody = "12345ABCDE67890XYZWV";

  // 再アンカー無し(bug 再現): 派生 ES 基準 span をそのまま getDerivedSpans に渡す
  const sugOldRaw: S = {
    id: "sug_old",
    category: "error",
    original_span: { start: 5, end: 10 },
    proposed: "Y",
  };
  const sugNewRaw: S = {
    id: "sug_new",
    category: "convention",
    original_span: { start: 11, end: 16 }, // 派生 ES 基準のまま
    proposed: "改善",
  };
  const spansWithoutReAnchor = getDerivedSpans(
    [sugOldRaw, sugNewRaw],
    ["sug_old"],
    {},
    [],
    formEsBody.length,
  );
  const sugNewSpanBug = spansWithoutReAnchor.find(
    (s) => s.suggestion_id === "sug_new",
  )!;
  // bug の証拠: derivedStart が 7(誤位置)になる
  assert.equal(sugNewSpanBug.derivedStart, 7);
  assert.equal(sugNewSpanBug.derivedEnd, 12);

  // 再アンカー有り(fix): reAnchorSuggestionsToFormEsBody で form.es_body 基準に書き換え
  const partialUpdated: Suggestion[] = [
    makeFullSuggestion({
      id: "sug_new",
      original: "XYZWV",
      original_span: { start: 11, end: 16 }, // 派生 ES 基準
    }),
  ];
  const reAnchored = reAnchorSuggestionsToFormEsBody(formEsBody, partialUpdated);
  // 再アンカー後の sug_new は form.es_body 基準 [15, 20]
  assert.equal(reAnchored[0].original_span.start, 15);
  assert.equal(reAnchored[0].original_span.end, 20);

  // 再アンカー後の span を getDerivedSpans に渡すと derivedStart = 11(派生 ES 上の正位置)
  const sugNewReAnchored: S = {
    id: "sug_new",
    category: "convention",
    original_span: { start: 15, end: 20 }, // 再アンカー後
    proposed: "改善",
  };
  const spansWithReAnchor = getDerivedSpans(
    [sugOldRaw, sugNewReAnchored],
    ["sug_old"],
    {},
    [],
    formEsBody.length,
  );
  const sugNewSpanFixed = spansWithReAnchor.find(
    (s) => s.suggestion_id === "sug_new",
  )!;
  // fix の証拠: derivedStart が 11(派生 ES 上の "XYZWV" の正位置)
  assert.equal(sugNewSpanFixed.derivedStart, 11);
  assert.equal(sugNewSpanFixed.derivedEnd, 16);
});

test("reAnchor case 7 (lastEnd ガードによるハイライト消失再現): 派生 ES 基準 span が前 suggestion の lastEnd 範囲内に落ちると span 消える → 再アンカーで救出", () => {
  // 元 ES = "12345ABCDE67890XYZWV"(20 文字)
  // 採用済 sug_old: original_span [5, 10]「ABCDE」→ proposed「Y」(displayEsBody は "12345Y67890XYZWV"、16 文字)
  // partial 応答の sug_new(LLM が displayEsBody を見て生成、original = "67890")
  //   - サーバが resolveOriginalSpans("12345Y67890XYZWV", "67890") → start = 6
  //   - partial 応答 sug_new.original_span = {6, 11}(派生 ES 基準)
  //
  // 再アンカー無し:
  //   getDerivedSpans 内ソート後 [sug_old: start=5, sug_new: start=6]
  //   - sug_old: applied=true、derivedStart=5、derivedEnd=6、offset=-4、lastEnd=10
  //   - sug_new: start=6 < lastEnd=10 → `if (start < lastEnd) continue;` で skip
  //   → ハイライトが完全消失!(ユーザー報告の「採用後に未採用の suggestion がハイライトされない」症状)
  //
  // 再アンカー有り:
  //   form.es_body 上「67890」の indexOf = 10、再アンカー後 sug_new.original_span = {10, 15}
  //   getDerivedSpans 内ソート後 [sug_old: start=5, sug_new: start=10]
  //   - sug_old: derivedStart=5、derivedEnd=6、offset=-4、lastEnd=10
  //   - sug_new: start=10 not < lastEnd=10、ガード通過、derivedStart=10+(-4)=6、derivedEnd=15+(-4)=11
  //   → 派生 ES 上 [6, 11]「67890」が正しくハイライトされる
  const formEsBody = "12345ABCDE67890XYZWV";

  // 再アンカー無し(bug 再現)
  const sugOldRaw: S = {
    id: "sug_old",
    category: "error",
    original_span: { start: 5, end: 10 },
    proposed: "Y",
  };
  const sugNewRaw: S = {
    id: "sug_new",
    category: "convention",
    original_span: { start: 6, end: 11 }, // 派生 ES 基準
    proposed: "改善",
  };
  const spansWithoutReAnchor = getDerivedSpans(
    [sugOldRaw, sugNewRaw],
    ["sug_old"],
    {},
    [],
    formEsBody.length,
  );
  // bug の証拠: sug_new が span 配列に存在しない(lastEnd ガードで落ちた = ハイライト消失)
  assert.equal(spansWithoutReAnchor.length, 1);
  assert.equal(spansWithoutReAnchor[0].suggestion_id, "sug_old");

  // 再アンカー有り(fix)
  const partialAdded: Suggestion[] = [
    makeFullSuggestion({
      id: "sug_new",
      original: "67890",
      original_span: { start: 6, end: 11 }, // 派生 ES 基準
    }),
  ];
  const reAnchored = reAnchorSuggestionsToFormEsBody(formEsBody, partialAdded);
  assert.equal(reAnchored[0].original_span.start, 10);
  assert.equal(reAnchored[0].original_span.end, 15);

  // 再アンカー後の span を getDerivedSpans に渡すと sug_new が span 配列に含まれる
  const sugNewReAnchored: S = {
    id: "sug_new",
    category: "convention",
    original_span: { start: 10, end: 15 }, // 再アンカー後
    proposed: "改善",
  };
  const spansWithReAnchor = getDerivedSpans(
    [sugOldRaw, sugNewReAnchored],
    ["sug_old"],
    {},
    [],
    formEsBody.length,
  );
  assert.equal(spansWithReAnchor.length, 2);
  const sugNewSpanFixed = spansWithReAnchor.find(
    (s) => s.suggestion_id === "sug_new",
  )!;
  assert.equal(sugNewSpanFixed.derivedStart, 6); // 派生 ES 上 "67890" の正位置
  assert.equal(sugNewSpanFixed.derivedEnd, 11);
});

test("reAnchor case 8: structural suggestion も同じ仕組みで処理(派生計算では skip される、再アンカー自体は害なし)", () => {
  // structural は getDerivedSpans / getDerivedEsBody で完全 skip されるため座標系混在の
  // 影響を受けないが、reAnchorSuggestionsToFormEsBody は category を見ずに一律処理する
  // (構造を単純化、structural の original も indexOf で扱える)。
  const formEsBody = "段落1\n\n段落2";
  const suggestions: Suggestion[] = [
    makeFullSuggestion({
      id: "sug_struct",
      original: "段落1",
      original_span: { start: 0, end: 3 },
      category: "structural",
      proposed: "(段落削除:冒頭段落を削除)",
    }),
  ];
  const reAnchored = reAnchorSuggestionsToFormEsBody(formEsBody, suggestions);
  // form.es_body 上の「段落1」位置 [0, 3] と一致 → 再アンカー後も同じ
  assert.equal(reAnchored[0].original_span.start, 0);
  assert.equal(reAnchored[0].original_span.end, 3);
  assert.equal(reAnchored[0].category, "structural");
});

// =============================================================================
// 2026-05-28 dogfood round 3 ⑤ 直接編集 bug fix: bakedIds による二重適用防止(pure)
// =============================================================================
// getDerivedEsBody / getDerivedSpans の第 5/6 引数 bakedIds の skip 挙動を直接担保する。
// baked id は structural と同様に「置換 / 累積オフセット / span 出力」を一切行わない。
process.stdout.write("[直接編集 bug fix: bakedIds 二重適用防止 (pure)]\n");

test("getDerivedEsBody: baked id は再適用されない(flatten 後の二重適用防止)", () => {
  // flatten 後の currentEsBody = "ABCDE。かきくけこ。"(text 採用 sug_t1 を既に焼き込み済)。
  // sug_t1 は accepted のままだが baked のため、getDerivedEsBody は再置換しない。
  const flattenedBody = "ABCDE。かきくけこ。";
  const suggestions: S[] = [
    {
      id: "sug_t1",
      category: "convention",
      // original_span は form.es_body 基準([0,5] = "あいうえお")だが、baked なので参照されない。
      original_span: { start: 0, end: 5 },
      proposed: "ABCDE",
    },
  ];
  const result = getDerivedEsBody(
    flattenedBody,
    suggestions,
    ["sug_t1"], // accepted
    {},
    ["sug_t1"], // baked
  );
  // baked のため二重適用されず、flatten 後の本文がそのまま返る(破損なし)。
  assert.equal(result, flattenedBody);
});

test("getDerivedEsBody: baked が空(default)なら従来通り採用を適用(後方互換)", () => {
  const esBody = "あいうえお。かきくけこ。";
  const suggestions: S[] = [
    {
      id: "sug_t1",
      category: "convention",
      original_span: { start: 0, end: 5 },
      proposed: "ABCDE",
    },
  ];
  // 第 5 引数省略 = baked 空 → 採用が適用される(既存挙動)。
  const result = getDerivedEsBody(esBody, suggestions, ["sug_t1"], {});
  assert.equal(result, "ABCDE。かきくけこ。");
});

test("getDerivedSpans: baked id は span 配列に含まれず累積オフセットにも影響しない", () => {
  // baked な採用済 sug_t1 と、未採用 sug_t2 が混在。baked は skip され、
  // sug_t2 の派生位置は baked の影響を受けない(structural skip と同じ精神)。
  const suggestions: S[] = [
    {
      id: "sug_t1",
      category: "convention",
      original_span: { start: 0, end: 5 },
      proposed: "ABCDE",
    },
    {
      id: "sug_t2",
      category: "alternative",
      original_span: { start: 6, end: 11 },
      proposed: "改善",
    },
  ];
  const spans = getDerivedSpans(
    suggestions,
    ["sug_t1"], // accepted
    {},
    [],
    12,
    ["sug_t1"], // baked
  );
  // baked sug_t1 は除外、未採用 sug_t2 のみ。offset は baked の影響を受けず 0 のまま。
  assert.equal(spans.length, 1);
  assert.equal(spans[0].suggestion_id, "sug_t2");
  assert.equal(spans[0].derivedStart, 6);
  assert.equal(spans[0].derivedEnd, 11);
  assert.equal(spans[0].isApplied, false);
});

// =============================================================================
// 2026-05-28 dogfood round 3 ⑤ 直接編集 bug fix: store 統合(本 bug 直接再現 + undo)
// =============================================================================
// 本 section は dogfood round 3 ⑤「直接編集トグルが原文を編集してしまう」bug の構造的
// 再発防止。store action(toggleDirectEdit / acceptSuggestion / undo / redo)を直接駆動し、
// 「直接編集 ON で編集対象が派生 ES + 二重適用なし + undo 復元 + structural 併用」を assert。
//
// useAnalyzeStore は singleton のため、各テスト前に resetSession で初期化する。
process.stdout.write("[直接編集 bug fix: store 統合 (本 bug 直接再現 + undo)]\n");

// AnalysisResult の最小ビルダー(setAnalysisResult に渡す形)。
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

// store を初期化し、form.es_body + analysisResult を seed する helper。
// setAnalysisResult は currentEsBody = form.es_body にし、error カテゴリを自動採用する。
function seedStore(esBody: string, suggestions: Suggestion[]): void {
  const store = useAnalyzeStore.getState();
  store.resetSession();
  useAnalyzeStore.getState().setField("es_body", esBody);
  useAnalyzeStore.getState().setAnalysisResult(makeResult(suggestions));
}

test("本 bug 直接再現: text 採用済で直接編集 ON → 編集対象が派生 ES(採用反映済)になる", () => {
  // 元 ES = "あいうえお。かきくけこ。"(12 字)
  // convention sug_t1: [0,5]「あいうえお」→「ABCDE」を採用。
  // 派生 ES = "ABCDE。かきくけこ。"
  const esBody = "あいうえお。かきくけこ。";
  seedStore(esBody, [
    makeFullSuggestion({
      id: "sug_t1",
      category: "convention",
      original: "あいうえお",
      original_span: { start: 0, end: 5 },
      proposed: "ABCDE",
    }),
  ]);
  // text 採用(error ではないので明示採用が必要)
  useAnalyzeStore
    .getState()
    .acceptSuggestion({ suggestion_id: "sug_t1", suggestion_summary: "[要修正] あいうえお" });

  // 採用直後: currentEsBody はまだ form.es_body 基準("あいうえお。…")。派生 ES が上乗せ表示。
  const beforeToggle = useAnalyzeStore.getState();
  assert.equal(beforeToggle.currentEsBody, esBody, "採用後 currentEsBody は原文のまま(派生で上乗せ)");

  // 直接編集 ON
  useAnalyzeStore.getState().toggleDirectEdit();
  const afterOn = useAnalyzeStore.getState();
  // ★ 本 bug の核心 assert: 直接編集 ON で currentEsBody が「採用反映済の派生 ES」に flatten される。
  //   旧挙動ではここが原文("あいうえお。…")のままだった(採用が消えた状態を編集)。
  assert.equal(
    afterOn.currentEsBody,
    "ABCDE。かきくけこ。",
    "直接編集 ON で編集対象が派生 ES になる(採用が反映されている)",
  );
  assert.ok(afterOn.directEditMode, "directEditMode = true");
  // baked 集合に採用済 id が入る
  assert.ok(
    afterOn.bakedSuggestionIds.includes("sug_t1"),
    "採用済 id が baked 集合に入る",
  );
});

test("二重適用なし: 直接編集 ON で flatten 後、派生 ES 算出が採用を二重適用しない", () => {
  const esBody = "あいうえお。かきくけこ。";
  seedStore(esBody, [
    makeFullSuggestion({
      id: "sug_t1",
      category: "convention",
      original: "あいうえお",
      original_span: { start: 0, end: 5 },
      proposed: "ABCDE",
    }),
  ]);
  useAnalyzeStore
    .getState()
    .acceptSuggestion({ suggestion_id: "sug_t1", suggestion_summary: "s" });
  useAnalyzeStore.getState().toggleDirectEdit();
  const s = useAnalyzeStore.getState();
  // flatten 後の currentEsBody に対して getDerivedEsBody を再実行(Canvas displayEsBody 相当)。
  // baked を渡せば二重適用されず、flatten 結果がそのまま返る(破損 / 重複なし)。
  const redisplayed = getDerivedEsBody(
    s.currentEsBody,
    s.analysisResult!.suggestions,
    s.acceptedSuggestionIds,
    s.editedSuggestions,
    s.bakedSuggestionIds,
  );
  assert.equal(redisplayed, "ABCDE。かきくけこ。");
  // "ABCDEABCDE" のような二重適用文字列が出ていないこと
  assert.ok(!redisplayed.includes("ABCDEABCDE"), `二重適用検出: ${redisplayed}`);
});

test("undo 復元: 直接編集 → undo で「直接編集前の積み重ね状態」に戻る(採用が消えない)", () => {
  const esBody = "あいうえお。かきくけこ。";
  seedStore(esBody, [
    makeFullSuggestion({
      id: "sug_t1",
      category: "convention",
      original: "あいうえお",
      original_span: { start: 0, end: 5 },
      proposed: "ABCDE",
    }),
  ]);
  useAnalyzeStore
    .getState()
    .acceptSuggestion({ suggestion_id: "sug_t1", suggestion_summary: "s" });
  // 直接編集 ON → 末尾に追記して OFF
  useAnalyzeStore.getState().toggleDirectEdit();
  useAnalyzeStore.getState().updateEsBody("ABCDE。かきくけこ。追記文。");
  useAnalyzeStore.getState().toggleDirectEdit();

  const afterEdit = useAnalyzeStore.getState();
  assert.equal(afterEdit.currentEsBody, "ABCDE。かきくけこ。追記文。");
  assert.equal(afterEdit.directEditMode, false);
  // DIRECT_EDIT entry が積まれている
  assert.equal(
    afterEdit.actionHistory[afterEdit.actionHistory.length - 1].verb,
    "DIRECT_EDIT",
  );

  // undo: 直接編集を取り消す
  useAnalyzeStore.getState().undo(1);
  const afterUndo = useAnalyzeStore.getState();
  // ★ 採用を積み重ねた直接編集前の状態に戻る(原文リセットではない)
  assert.equal(
    afterUndo.currentEsBody,
    esBody,
    "undo で直接編集前の currentEsBody(原文 + structural 基準)に戻る",
  );
  assert.ok(
    afterUndo.acceptedSuggestionIds.includes("sug_t1"),
    "undo 後も採用が消えない(積み重ね状態が復元)",
  );
  // baked 集合も直接編集前(空)に戻る
  assert.equal(
    afterUndo.bakedSuggestionIds.length,
    0,
    "undo で baked 集合も直接編集前に戻る",
  );
  // undo 後の派生 ES は採用反映済("ABCDE。…")= 採用が生きている証拠
  const derivedAfterUndo = getDerivedEsBody(
    afterUndo.currentEsBody,
    afterUndo.analysisResult!.suggestions,
    afterUndo.acceptedSuggestionIds,
    afterUndo.editedSuggestions,
    afterUndo.bakedSuggestionIds,
  );
  assert.equal(derivedAfterUndo, "ABCDE。かきくけこ。");
});

test("redo 対称: 直接編集 undo → redo で編集後の状態が復元される", () => {
  const esBody = "あいうえお。かきくけこ。";
  seedStore(esBody, [
    makeFullSuggestion({
      id: "sug_t1",
      category: "convention",
      original: "あいうえお",
      original_span: { start: 0, end: 5 },
      proposed: "ABCDE",
    }),
  ]);
  useAnalyzeStore
    .getState()
    .acceptSuggestion({ suggestion_id: "sug_t1", suggestion_summary: "s" });
  useAnalyzeStore.getState().toggleDirectEdit();
  useAnalyzeStore.getState().updateEsBody("ABCDE。かきくけこ。追記文。");
  useAnalyzeStore.getState().toggleDirectEdit();
  useAnalyzeStore.getState().undo(1);
  useAnalyzeStore.getState().redo(1);

  const afterRedo = useAnalyzeStore.getState();
  // 編集後の本文 + baked 集合が復元される(undo と対称)
  assert.equal(afterRedo.currentEsBody, "ABCDE。かきくけこ。追記文。");
  assert.ok(
    afterRedo.bakedSuggestionIds.includes("sug_t1"),
    "redo で baked 集合が再適用される",
  );
  assert.equal(
    afterRedo.actionHistory[afterRedo.actionHistory.length - 1].verb,
    "DIRECT_EDIT",
  );
});

test("編集なしトグル: 直接編集 ON → 編集せず OFF で flatten が巻き戻り DIRECT_EDIT entry を作らない", () => {
  const esBody = "あいうえお。かきくけこ。";
  seedStore(esBody, [
    makeFullSuggestion({
      id: "sug_t1",
      category: "convention",
      original: "あいうえお",
      original_span: { start: 0, end: 5 },
      proposed: "ABCDE",
    }),
  ]);
  useAnalyzeStore
    .getState()
    .acceptSuggestion({ suggestion_id: "sug_t1", suggestion_summary: "s" });
  const historyLenBefore = useAnalyzeStore.getState().actionHistory.length;

  // ON → 何も編集せず OFF
  useAnalyzeStore.getState().toggleDirectEdit();
  useAnalyzeStore.getState().toggleDirectEdit();

  const after = useAnalyzeStore.getState();
  // flatten が巻き戻り、currentEsBody は原文基準に戻る(採用は派生で上乗せのまま)
  assert.equal(after.currentEsBody, esBody, "編集なしなら flatten 巻き戻し");
  // baked 集合も巻き戻る(空)
  assert.equal(after.bakedSuggestionIds.length, 0, "編集なしなら baked も巻き戻し");
  // DIRECT_EDIT entry は積まれない
  assert.equal(
    after.actionHistory.length,
    historyLenBefore,
    "編集なしトグルは history を増やさない",
  );
});

test("structural 併用: structural 採用済 + 直接編集で破綻しない(二重適用 / placeholder 混入なし)", () => {
  // 元 ES = "冒頭段落。\n\n本論段落。"(段落 2 つ)
  // structural delete_paragraph(index 0)= 冒頭段落を削除 → currentEsBody = "本論段落。"
  // その後 text 採用は無し。直接編集 ON で派生 ES(= structural 反映済の "本論段落。")が編集対象。
  const esBody = "冒頭段落。\n\n本論段落。";
  seedStore(esBody, [
    makeFullSuggestion({
      id: "sug_str",
      category: "structural",
      original: "冒頭段落。",
      original_span: { start: 0, end: 5 },
      proposed: "(段落削除:冒頭段落を削除して直接本論に入る)",
      structural_params: { operation: "delete_paragraph", target_paragraph_index: 0 },
    }),
  ]);
  // structural 採用 → currentEsBody が applyStructuralOperation で短縮される
  useAnalyzeStore
    .getState()
    .acceptSuggestion({ suggestion_id: "sug_str", suggestion_summary: "段落削除" });
  const afterAccept = useAnalyzeStore.getState();
  assert.equal(
    afterAccept.currentEsBody,
    "本論段落。",
    "structural 採用で currentEsBody が短縮(機械適用)",
  );

  // 直接編集 ON: structural は既に currentEsBody に焼き込み済 + getDerivedEsBody で skip。
  // flatten 結果も "本論段落。" のまま(placeholder 混入なし)。
  useAnalyzeStore.getState().toggleDirectEdit();
  const afterOn = useAnalyzeStore.getState();
  assert.equal(
    afterOn.currentEsBody,
    "本論段落。",
    "structural 併用でも flatten が placeholder を混入しない",
  );
  assert.ok(
    !afterOn.currentEsBody.includes("(段落削除"),
    `placeholder 混入: ${afterOn.currentEsBody}`,
  );
  // structural id は baked 集合に **入れない**(category skip で除外されるため不要)
  assert.ok(
    !afterOn.bakedSuggestionIds.includes("sug_str"),
    "structural は baked 集合に入れない(category skip で除外)",
  );

  // 末尾に追記して OFF → undo で structural 採用状態("本論段落。")に戻る
  useAnalyzeStore.getState().updateEsBody("本論段落。追記。");
  useAnalyzeStore.getState().toggleDirectEdit();
  useAnalyzeStore.getState().undo(1);
  const afterUndo = useAnalyzeStore.getState();
  assert.equal(
    afterUndo.currentEsBody,
    "本論段落。",
    "undo で structural 採用済の currentEsBody に戻る(原文リセットではない)",
  );
  assert.ok(
    afterUndo.acceptedSuggestionIds.includes("sug_str"),
    "undo 後も structural 採用が生きている",
  );
});

// =============================================================================
// reconcileSpansToDisplayedText: 表示テキストへの verify→relocate→suppress 補正(症状 B)
// =============================================================================
// 2026-05-28 ハイライト位置ずれ(症状 B)修正。getDerivedSpans の出力(派生 span)を、
// 表示中 ES の実テキスト(displayEsBody)で検証・補正する additive な post-process の
// 純関数テスト。座標計算で位置を追う既存ロジックが unanchorable case で残す誤位置 span を、
// 実テキストにアンカーし直す / 出せないなら抑制する。正しい span は素通りであることを assert。
process.stdout.write(
  "\n[reconcileSpansToDisplayedText: 表示テキスト検証・補正(症状 B)]\n",
);

const NO_OPTS = {
  acceptedIds: [] as string[],
  editedMap: {} as Record<string, string>,
  autoCorrectedIds: [] as string[],
};

test("reconcile case 1: 正しい pending span(slice が original と一致)は無変更で素通り", () => {
  const displayEsBody = "私は部活で成績を改善しました。";
  // 「成績」= index 5..7。pending suggestion の original = 「成績」。span も正位置。
  const suggestions = [
    makeFullSuggestion({
      id: "sug_a",
      original: "成績",
      original_span: { start: 5, end: 7 },
    }),
  ];
  const spans: DerivedSpan[] = [
    { suggestion_id: "sug_a", derivedStart: 5, derivedEnd: 7, isApplied: false, isRejected: false },
  ];
  const out = reconcileSpansToDisplayedText(spans, suggestions, displayEsBody, NO_OPTS);
  assert.equal(out.length, 1, "span は維持される");
  assert.equal(out[0].derivedStart, 5, "正しい span は relocate されない");
  assert.equal(out[0].derivedEnd, 7);
  assert.equal(
    displayEsBody.slice(out[0].derivedStart, out[0].derivedEnd),
    "成績",
    "補正後 slice が original と一致",
  );
});

test("reconcile case 2 (es2 sug_008 シナリオ): ずれた pending span を original の実在位置へ relocate", () => {
  // es2 実データ再現: 先行提案採用で「上げました」→「改善しました」が焼き込まれた表示 ES。
  // 後発 pending sug_008 の original =「生徒の成績を改善しました」は表示 ES に実在するが、
  // 座標系統一 fix の unanchorable 温存で span が締めの別位置(「ら、目標を定めた後も行動」)に
  // ずれている。reconcile が displayEsBody の実テキストで正位置へ貼り直すことを assert。
  const displayEsBody =
    "塾講師として生徒の成績を改善しました。生徒が自ら目標を定めた後も行動できるよう支援しました。";
  const correctStart = displayEsBody.indexOf("生徒の成績を改善しました");
  assert.ok(correctStart >= 0, "前提: original は表示 ES に実在する");
  // 誤位置 span(締めの「ら、目標を定めた後も行動」付近 = unanchorable で温存された displayEsBody
  // 基準のままの座標を、累積オフセットで別位置に押しやられた状態を模す)。
  const wrongStart = displayEsBody.indexOf("自ら目標を定めた後も行動");
  assert.ok(wrongStart >= 0 && wrongStart !== correctStart, "前提: 誤位置は正位置と異なる");
  const suggestions = [
    makeFullSuggestion({
      id: "sug_008",
      original: "生徒の成績を改善しました",
      // original_span は form.es_body 基準(元原文「上げました」時代)の温存値で、ここでは
      // 関数の関心外(reconcile は derivedStart のみ見る)。placeholder で埋める。
      original_span: { start: wrongStart, end: wrongStart + "生徒の成績を改善しました".length },
    }),
  ];
  const spans: DerivedSpan[] = [
    {
      suggestion_id: "sug_008",
      derivedStart: wrongStart,
      derivedEnd: wrongStart + "生徒の成績を改善しました".length,
      isApplied: false,
      isRejected: false,
    },
  ];
  const out = reconcileSpansToDisplayedText(spans, suggestions, displayEsBody, NO_OPTS);
  assert.equal(out.length, 1, "span は suppress されず relocate される(original 実在のため)");
  assert.equal(out[0].derivedStart, correctStart, "誤位置から original の実在位置へ relocate");
  assert.equal(out[0].derivedEnd, correctStart + "生徒の成績を改善しました".length);
  assert.equal(
    displayEsBody.slice(out[0].derivedStart, out[0].derivedEnd),
    "生徒の成績を改善しました",
    "補正後 slice が original と完全一致(誤ハイライト解消)",
  );
});

test("reconcile case 3: original が複数箇所に出現 → 元 derivedStart に最も近い出現を採用", () => {
  // 「改善」が 3 箇所。誤 span は 2 番目付近を指す → 最も近い 2 番目の出現に貼り直す。
  const displayEsBody = "改善あ改善い改善う"; // 改善@0, 改善@3, 改善@6
  const occ = [0, 3, 6];
  const suggestions = [
    makeFullSuggestion({
      id: "sug_dup",
      original: "改善",
      original_span: { start: 0, end: 2 },
    }),
  ];
  // 誤 span derivedStart=4(occ[1]=3 が最も近い、occ[0]=0 は距離4、occ[2]=6 は距離2 vs occ[1] は距離1)。
  const spans: DerivedSpan[] = [
    { suggestion_id: "sug_dup", derivedStart: 4, derivedEnd: 6, isApplied: false, isRejected: false },
  ];
  const out = reconcileSpansToDisplayedText(spans, suggestions, displayEsBody, NO_OPTS);
  assert.equal(out.length, 1);
  assert.equal(out[0].derivedStart, occ[1], "計算位置(4)に最も近い出現 occ[1]=3 を採用");
  assert.equal(out[0].derivedEnd, occ[1] + 2);
  assert.equal(displayEsBody.slice(out[0].derivedStart, out[0].derivedEnd), "改善");
});

test("reconcile case 4: original が表示 ES に 0 箇所 → suppress(span を返さない)", () => {
  // 採用で消えたテキストを後発提案が指し、表示 ES にも form.es_body にも残っていない稀ケース。
  // 誤ハイライトより「ハイライトを出さない」方がマシ。
  const displayEsBody = "全く別の本文に置き換わっています。";
  const suggestions = [
    makeFullSuggestion({
      id: "sug_gone",
      original: "存在しない原文テキスト",
      original_span: { start: 0, end: 5 },
    }),
  ];
  const spans: DerivedSpan[] = [
    { suggestion_id: "sug_gone", derivedStart: 0, derivedEnd: 5, isApplied: false, isRejected: false },
  ];
  const out = reconcileSpansToDisplayedText(spans, suggestions, displayEsBody, NO_OPTS);
  assert.equal(out.length, 0, "0 箇所一致は suppress = span を返さない");
});

test("reconcile case 5: applied(autoCorrected)は proposed で検証 → ずれを正位置へ relocate", () => {
  // 自動修正済の span は表示テキスト = proposed。誤位置の auto span を proposed の実在位置へ。
  const displayEsBody = "冒頭。自動修正済みの正しい表現。末尾。";
  const correct = displayEsBody.indexOf("自動修正済みの正しい表現");
  assert.ok(correct >= 0);
  const suggestions = [
    makeFullSuggestion({
      id: "sug_auto",
      original: "古い誤った表現",
      proposed: "自動修正済みの正しい表現",
      original_span: { start: 0, end: 5 },
    }),
  ];
  // 誤 span(別位置「末尾」付近)。isApplied=true + autoCorrectedIds に含む。
  const wrong = displayEsBody.indexOf("末尾");
  const spans: DerivedSpan[] = [
    {
      suggestion_id: "sug_auto",
      derivedStart: wrong,
      derivedEnd: wrong + "自動修正済みの正しい表現".length,
      isApplied: true,
      isRejected: false,
    },
  ];
  const out = reconcileSpansToDisplayedText(spans, suggestions, displayEsBody, {
    acceptedIds: [],
    editedMap: {},
    autoCorrectedIds: ["sug_auto"],
  });
  assert.equal(out.length, 1, "autoCorrected は描画対象なので検証・relocate される");
  assert.equal(out[0].derivedStart, correct, "proposed の実在位置へ relocate");
  assert.equal(
    displayEsBody.slice(out[0].derivedStart, out[0].derivedEnd),
    "自動修正済みの正しい表現",
    "補正後 slice が proposed と一致",
  );
});

test("reconcile case 6: edited は編集後テキスト(editedMap)で検証 → ずれを正位置へ relocate", () => {
  // 編集済 + autoCorrected の span は表示テキスト = editedMap[id]。
  const displayEsBody = "冒頭。ユーザーが手で直した文言。末尾。";
  const correct = displayEsBody.indexOf("ユーザーが手で直した文言");
  assert.ok(correct >= 0);
  const suggestions = [
    makeFullSuggestion({
      id: "sug_edit",
      original: "元の表現",
      proposed: "提案された表現",
      original_span: { start: 0, end: 4 },
    }),
  ];
  const wrong = displayEsBody.indexOf("末尾");
  const spans: DerivedSpan[] = [
    {
      suggestion_id: "sug_edit",
      derivedStart: wrong,
      derivedEnd: wrong + "ユーザーが手で直した文言".length,
      isApplied: true,
      isRejected: false,
    },
  ];
  const out = reconcileSpansToDisplayedText(spans, suggestions, displayEsBody, {
    acceptedIds: [],
    editedMap: { sug_edit: "ユーザーが手で直した文言" },
    autoCorrectedIds: ["sug_edit"],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].derivedStart, correct, "edited_text の実在位置へ relocate");
  assert.equal(
    displayEsBody.slice(out[0].derivedStart, out[0].derivedEnd),
    "ユーザーが手で直した文言",
    "proposed ではなく編集後テキストで検証されている",
  );
});

test("reconcile case 7: applied かつ非 autoCorrected(描画スキップ side)は検証せず素通り", () => {
  // 通常の採用済(ユーザー能動)は buildSegments がハイライト描画を skip する。表示テキストが
  // proposed とずれていても、累積整合のため span を動かさず温存する(誤ハイライトは生じない)。
  const displayEsBody = "本文。採用済みで置換された範囲。本文。";
  const suggestions = [
    makeFullSuggestion({
      id: "sug_applied",
      original: "元",
      proposed: "全く一致しない別の文字列",
      original_span: { start: 0, end: 1 },
    }),
  ];
  // 意図的に displayEsBody と一致しない span を渡す。relocate も suppress もせず素通りが正。
  const spans: DerivedSpan[] = [
    { suggestion_id: "sug_applied", derivedStart: 2, derivedEnd: 5, isApplied: true, isRejected: false },
  ];
  const out = reconcileSpansToDisplayedText(spans, suggestions, displayEsBody, {
    acceptedIds: ["sug_applied"],
    editedMap: {},
    autoCorrectedIds: [],
  });
  assert.equal(out.length, 1, "描画スキップ side の span は維持(累積整合のため)");
  assert.equal(out[0].derivedStart, 2, "applied 非 autoCorrected は relocate されない");
  assert.equal(out[0].derivedEnd, 5);
});

test("reconcile case 8: 正しい span / ずれた span / suppress 対象が混在 → 個別に処理 + 昇順維持", () => {
  // 複数 span を一括処理し、relocate 後も derivedStart 昇順で返る(buildSegments の cursor 前提)。
  const displayEsBody = "アルファは正位置。ベータは別位置にずれ。ガンマは消失。";
  const alphaStart = displayEsBody.indexOf("アルファ"); // 0
  const betaStart = displayEsBody.indexOf("ベータ");
  const suggestions = [
    makeFullSuggestion({ id: "alpha", original: "アルファ", original_span: { start: alphaStart, end: alphaStart + 4 } }),
    makeFullSuggestion({ id: "beta", original: "ベータ", original_span: { start: betaStart, end: betaStart + 3 } }),
    makeFullSuggestion({ id: "gamma", original: "存在しない語", original_span: { start: 0, end: 6 } }),
  ];
  // alpha は正位置、beta は誤位置(末尾付近)、gamma は誤位置だが original 不在 → suppress。
  const betaWrong = displayEsBody.length - 2;
  const spans: DerivedSpan[] = [
    { suggestion_id: "beta", derivedStart: betaWrong, derivedEnd: betaWrong + 3, isApplied: false, isRejected: false },
    { suggestion_id: "alpha", derivedStart: alphaStart, derivedEnd: alphaStart + 4, isApplied: false, isRejected: false },
    { suggestion_id: "gamma", derivedStart: betaWrong, derivedEnd: betaWrong + 6, isApplied: false, isRejected: false },
  ];
  const out = reconcileSpansToDisplayedText(spans, suggestions, displayEsBody, NO_OPTS);
  assert.equal(out.length, 2, "gamma は suppress、alpha + beta が残る");
  // 昇順検証
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].derivedStart >= out[i - 1].derivedStart, "derivedStart 昇順で返る");
  }
  const alpha = out.find((s) => s.suggestion_id === "alpha");
  const beta = out.find((s) => s.suggestion_id === "beta");
  assert.ok(alpha && beta, "alpha / beta は維持");
  assert.equal(alpha!.derivedStart, alphaStart, "alpha は正位置のまま無変更");
  assert.equal(beta!.derivedStart, betaStart, "beta は正位置へ relocate");
  assert.equal(displayEsBody.slice(beta!.derivedStart, beta!.derivedEnd), "ベータ");
});

test("reconcile case 9: 空 spans / suggestion 欠落 span は安全に処理(防御)", () => {
  const displayEsBody = "本文テキスト。";
  // 空入力
  assert.equal(reconcileSpansToDisplayedText([], [], displayEsBody, NO_OPTS).length, 0);
  // suggestion が見つからない span はそのまま通す(理論上起きないが防御)。
  const orphan: DerivedSpan[] = [
    { suggestion_id: "missing", derivedStart: 0, derivedEnd: 2, isApplied: false, isRejected: false },
  ];
  const out = reconcileSpansToDisplayedText(orphan, [], displayEsBody, NO_OPTS);
  assert.equal(out.length, 1, "対応 suggestion 欠落 span は素通り(落とさない)");
  assert.equal(out[0].derivedStart, 0);
});

// =============================================================================
// 2026-05-28 unanchorable-accept APPLY bug fix: getDerivedEsBody の APPLY 2-pass
// =============================================================================
// 逆質問の回答を取り込んだ提案(es4 sug_009 型)は、`original` が「先行採用で圧縮された後の
// テキスト」を指すため baseline(form.es_body)に存在せず、`reAnchorSuggestionsToFormEsBody`
// で unanchorable 温存(case 3)になる。`original_span` は派生 ES 座標のまま残るので、従来の
// 単一 pass は baseline の誤位置に当てて「採用しても本文に反映されない」症状を起こしていた。
//
// 本 section は APPLY 2-pass(pass 1 verify→defer / pass 2 現派生テキストで locate→置換)が
// この採用を正しく反映すること、かつ anchorable 通常採用 / 真の locate 不能ケースの挙動が
// 変わらないことを構造で担保する。
//
// SSOT: lib/state/analyze_store.ts:getDerivedEsBody(APPLY 2-pass)
//       reconcileSpansToDisplayedText(対称な HIGHLIGHT 版)
process.stdout.write(
  "[getDerivedEsBody: unanchorable-accept APPLY 2-pass(es4 sug_009 型)]\n",
);

// `original` を持つ minimal suggestion 型(production の full Suggestion が `original` を
// 持つことを模す)。getDerivedEsBody は SuggestionForDerive(`original` optional)を受ける。
type SWithOriginal = S & { original: string };

test("unanchorable accept 1 (es4 sug_009 型): 先行採用で圧縮後のテキストを original に持つ採用が派生 ES に正しく反映される", () => {
  // baseline(form.es_body / currentEsBody)= 圧縮 **前** の原文。
  //   前半: "AAAそこで私は調査を企画しました。" / 後半: "BBB"
  // 先行採用 sug_pre: 原文 "そこで私は調査を企画しました。" → "そこで、調査を企画しました。"(圧縮)
  //   この sug_pre は baseline に anchorable(original が baseline に存在)。
  // 逆質問採用 sug_clar: original = 圧縮 **後** の "そこで、調査を企画しました。"
  //   → baseline には存在しない(unanchorable)。proposed = 回答を取り込んだ拡充文。
  //   original_span は「派生 ES 座標(圧縮後)」のまま温存されているとする = baseline では誤位置。
  const baseline = "AAAそこで私は調査を企画しました。BBB";
  const preOriginal = "そこで私は調査を企画しました。"; // baseline 内 [3, 18)
  const preProposed = "そこで、調査を企画しました。"; // 圧縮後(2 文字短い)
  // baseline 上の sug_pre の位置を確認(テストの前提が崩れていないか)。
  const preStart = baseline.indexOf(preOriginal);
  assert.equal(preStart, 3, "前提: sug_pre は baseline の [3,…) に anchorable");

  // 圧縮後の派生 ES(pass 1 で sug_pre を適用した結果)。sug_clar.original はこの中にだけ存在。
  const compressedDerived =
    baseline.slice(0, preStart) +
    preProposed +
    baseline.slice(preStart + preOriginal.length);
  const clarOriginal = preProposed; // = "そこで、調査を企画しました。"(圧縮後 = unanchorable)
  const clarProposed =
    "そこで、20代100名への調査を企画し、結果を代表に共有しました。"; // 回答取り込みの拡充
  const clarStartInDerived = compressedDerived.indexOf(clarOriginal);
  assert.ok(clarStartInDerived >= 0, "前提: sug_clar.original は圧縮後派生 ES に存在");
  assert.equal(
    baseline.indexOf(clarOriginal),
    -1,
    "前提: sug_clar.original は baseline には存在しない(unanchorable)",
  );

  const suggestions: SWithOriginal[] = [
    {
      id: "sug_pre",
      category: "convention",
      original: preOriginal,
      original_span: { start: preStart, end: preStart + preOriginal.length },
      proposed: preProposed,
    },
    {
      id: "sug_clar",
      category: "convention",
      original: clarOriginal,
      // 派生 ES 座標のまま温存された span(baseline 基準では誤位置 / 当たらない)。
      original_span: {
        start: clarStartInDerived,
        end: clarStartInDerived + clarOriginal.length,
      },
      proposed: clarProposed,
    },
  ];

  const result = getDerivedEsBody(
    baseline,
    suggestions,
    ["sug_pre", "sug_clar"],
    {},
  );
  // 期待: pass 1 で sug_pre が適用され圧縮、pass 2 で sug_clar が圧縮後テキストから
  //       locate されて proposed に置換される。
  const expected =
    baseline.slice(0, preStart) + clarProposed + baseline.slice(preStart + preOriginal.length);
  assert.equal(result, expected, `採用が反映されていない: ${result}`);
  assert.ok(result.includes(clarProposed), "sug_clar の proposed が派生 ES に出る");
  assert.ok(
    !result.includes(preProposed),
    "sug_clar 適用後は圧縮後 original は残らない(置換済)",
  );
});

test("unanchorable accept 2: anchorable な通常採用(original が baseline に存在)は従来どおり pass 1 で適用(無変更)", () => {
  // original が baseline に anchorable で original_span も正しい = 従来の正常採用。
  // pass 1 の verify を通って即適用され、deferred には入らない(挙動完全互換)。
  const baseline = "誤字をふくむ文章です。";
  const original = "ふくむ"; // baseline [3, 6)
  const start = baseline.indexOf(original);
  assert.equal(start, 3, "前提: anchorable");
  const suggestions: SWithOriginal[] = [
    {
      id: "sug_ok",
      category: "error",
      original,
      original_span: { start, end: start + original.length },
      proposed: "含む",
    },
  ];
  const result = getDerivedEsBody(baseline, suggestions, ["sug_ok"], {});
  assert.equal(result, "誤字を含む文章です。");
});

test("unanchorable accept 3: 採用だが original が baseline にも現派生テキストにも無い(真に locate 不能)→ 安全に skip(誤適用しない)", () => {
  // sug_pre で圧縮した後の派生テキストにも sug_ghost.original が存在しない場合。
  // pass 1 verify 不一致 → deferred、pass 2 indexOf も 0 箇所 → skip(誤位置置換しない)。
  const baseline = "AAA本文テキストBBB";
  const suggestions: SWithOriginal[] = [
    {
      id: "sug_ghost",
      category: "convention",
      original: "どこにも存在しない原文ZZZ",
      original_span: { start: 3, end: 10 }, // baseline 範囲内だが text は別物
      proposed: "置換されてはいけない",
    },
  ];
  const result = getDerivedEsBody(baseline, suggestions, ["sug_ghost"], {});
  // baseline がそのまま返る(誤適用なし)。
  assert.equal(result, baseline);
  assert.ok(
    !result.includes("置換されてはいけない"),
    "locate 不能な採用の proposed が誤って混入してはならない",
  );
});

test("unanchorable accept 4: range 外 span(end > esBody.length)の採用でも original を現派生テキストから locate して反映", () => {
  // sug_clar.original_span が baseline 長を超える(派生 ES 座標で end が baseline.length 超)
  // ケース。従来は範囲ガードで無条件 skip = 反映されなかった。pass 2 で救済する。
  const baseline = "短い原文。"; // length 5
  const original = "短い原文。"; // baseline 全体
  const suggestions: SWithOriginal[] = [
    {
      id: "sug_clar",
      category: "convention",
      original,
      // end=99 は baseline.length(5)を大きく超える(派生 ES 座標で来た想定)。
      original_span: { start: 0, end: 99 },
      proposed: "丁寧に書き直した原文です。",
    },
  ];
  const result = getDerivedEsBody(baseline, suggestions, ["sug_clar"], {});
  assert.equal(result, "丁寧に書き直した原文です。", `range 外採用が反映されない: ${result}`);
});

test("unanchorable accept 5: 編集済(editedMap)の unanchorable も pass 2 で edited_text に置換される", () => {
  // sug_clar が編集済(editedMap に入っている)かつ unanchorable の場合、proposed ではなく
  // edited_text で置換されることを確認(pass 1 の編集優先ロジックが deferred 経由でも保たれる)。
  const baseline = "AAAもとの文章です。BBB";
  const original = "もとの文章です。"; // baseline には存在するが、span を派生座標でずらす
  const trueStart = baseline.indexOf(original);
  const suggestions: SWithOriginal[] = [
    {
      id: "sug_clar",
      category: "convention",
      original,
      // 派生座標でずれた span(baseline の trueStart とは異なる位置 = verify 不一致 → defer)。
      original_span: { start: trueStart + 2, end: trueStart + 2 + original.length },
      proposed: "proposed のテキスト",
    },
  ];
  const result = getDerivedEsBody(baseline, suggestions, ["sug_clar"], {
    sug_clar: "編集後のテキストです。",
  });
  // 編集が優先される(proposed ではなく edited_text)。
  const expected =
    baseline.slice(0, trueStart) + "編集後のテキストです。" + baseline.slice(trueStart + original.length);
  assert.equal(result, expected, `編集済 unanchorable が edited_text で反映されない: ${result}`);
  assert.ok(!result.includes("proposed のテキスト"), "proposed が使われてはならない(編集優先)");
});

test("unanchorable accept 6: anchorable 採用 + unanchorable 採用の混在 — 両方とも正しく反映", () => {
  // 1 回の getDerivedEsBody で anchorable(pass 1)と unanchorable(pass 2)が共存するケース。
  // baseline: "頭DDD。そこで私は調査を企画しました。尾EEE。"
  //  - sug_typo: anchorable。原文 "DDD" → "ddd"(pass 1 で適用)。
  //  - sug_pre: anchorable 圧縮。"そこで私は調査を企画しました。" → "そこで、調査を企画しました。"
  //  - sug_clar: unanchorable。original = 圧縮後 "そこで、調査を企画しました。" → 拡充文(pass 2)。
  const baseline = "頭DDD。そこで私は調査を企画しました。尾EEE。";
  const typoOriginal = "DDD";
  const typoStart = baseline.indexOf(typoOriginal);
  const preOriginal = "そこで私は調査を企画しました。";
  const preStart = baseline.indexOf(preOriginal);
  const preProposed = "そこで、調査を企画しました。";

  // 圧縮 + typo 適用後の派生 ES(sug_clar.original を locate する母集合)。
  // pass 1 は start 昇順なので typo → pre の順で適用。
  const afterTypo =
    baseline.slice(0, typoStart) + "ddd" + baseline.slice(typoStart + typoOriginal.length);
  const preStartAfterTypo = afterTypo.indexOf(preOriginal);
  const compressed =
    afterTypo.slice(0, preStartAfterTypo) +
    preProposed +
    afterTypo.slice(preStartAfterTypo + preOriginal.length);
  const clarStartInCompressed = compressed.indexOf(preProposed);
  assert.ok(clarStartInCompressed >= 0, "前提: sug_clar.original は圧縮後に存在");

  const clarProposed = "そこで、20代100名への調査を企画しました。";
  const suggestions: SWithOriginal[] = [
    {
      id: "sug_typo",
      category: "error",
      original: typoOriginal,
      original_span: { start: typoStart, end: typoStart + typoOriginal.length },
      proposed: "ddd",
    },
    {
      id: "sug_pre",
      category: "convention",
      original: preOriginal,
      original_span: { start: preStart, end: preStart + preOriginal.length },
      proposed: preProposed,
    },
    {
      id: "sug_clar",
      category: "convention",
      original: preProposed, // 圧縮後 = unanchorable
      original_span: {
        start: clarStartInCompressed,
        end: clarStartInCompressed + preProposed.length,
      },
      proposed: clarProposed,
    },
  ];

  const result = getDerivedEsBody(
    baseline,
    suggestions,
    ["sug_typo", "sug_pre", "sug_clar"],
    {},
  );
  // 期待: typo は ddd、圧縮文は clarProposed に置換。
  const expected =
    baseline.slice(0, typoStart) +
    "ddd" +
    baseline.slice(typoStart + typoOriginal.length, preStart) +
    clarProposed +
    baseline.slice(preStart + preOriginal.length);
  assert.equal(result, expected, `混在ケースが正しく反映されない: ${result}`);
  assert.ok(result.includes("ddd"), "anchorable typo が反映される");
  assert.ok(result.includes(clarProposed), "unanchorable 採用が反映される");
});

test("unanchorable accept 7: 未採用かつ unanchorable な提案は pass 2 へ回さず一切反映しない(採用フラグが gate)", () => {
  // sug_clar.original は baseline に存在しない(unanchorable)が **未採用** の場合、
  // unanchorable バイパスは `(isAccepted || isEdited)` を要求するため発火せず deferred に
  // 入らない。本文は変わらない(派生テキストに偶然 original が出ても置換されない)。
  const baseline = "AAA素の本文テキストBBB"; // 圧縮後の "そこで、…" は含まれない
  const suggestions: SWithOriginal[] = [
    {
      id: "sug_clar",
      category: "convention",
      original: "そこで、調査を企画しました。", // baseline に無い = unanchorable
      original_span: { start: 3, end: 16 }, // 派生 ES 座標(温存)
      proposed: "拡充された文章。",
    },
  ];
  // acceptedIds 空。
  const result = getDerivedEsBody(baseline, suggestions, [], {});
  assert.equal(result, baseline, "未採用は反映されてはならない");
  assert.ok(!result.includes("拡充された文章"), "未採用 proposed の混入なし");
});

test("unanchorable accept 8: 採用済の unanchorable が 2 件 — pass 2 で順に locate して両方反映(誤適用・破損なし)", () => {
  // 先行採用で 2 箇所が圧縮され、その圧縮後テキストを original に持つ unanchorable 採用が 2 件。
  // pass 2 は body を逐次更新して都度 re-search するため、両方が独立に locate されて反映される。
  // baseline: "頭。圧縮対象A。中。圧縮対象B。尾。"
  const baseline = "頭。圧縮対象A。中。圧縮対象B。尾。";
  // 先行圧縮(anchorable): "圧縮対象A。" → "Aだ。" / "圧縮対象B。" → "Bだ。"
  const preAOriginal = "圧縮対象A。";
  const preAStart = baseline.indexOf(preAOriginal);
  const preAProposed = "Aだ。";
  const preBOriginal = "圧縮対象B。";
  const preBStart = baseline.indexOf(preBOriginal);
  const preBProposed = "Bだ。";

  const suggestions: SWithOriginal[] = [
    {
      id: "sug_preA",
      category: "convention",
      original: preAOriginal,
      original_span: { start: preAStart, end: preAStart + preAOriginal.length },
      proposed: preAProposed,
    },
    {
      id: "sug_preB",
      category: "convention",
      original: preBOriginal,
      original_span: { start: preBStart, end: preBStart + preBOriginal.length },
      proposed: preBProposed,
    },
    // unanchorable 採用 2 件(original = 圧縮後テキスト、baseline に無い)。
    {
      id: "sug_clarA",
      category: "convention",
      original: preAProposed, // "Aだ。"(圧縮後 = unanchorable)
      original_span: { start: 3, end: 6 }, // 派生座標(適当)
      proposed: "Aを丁寧に書き直した。",
    },
    {
      id: "sug_clarB",
      category: "convention",
      original: preBProposed, // "Bだ。"(圧縮後 = unanchorable)
      original_span: { start: 12, end: 15 },
      proposed: "Bを丁寧に書き直した。",
    },
  ];
  const result = getDerivedEsBody(
    baseline,
    suggestions,
    ["sug_preA", "sug_preB", "sug_clarA", "sug_clarB"],
    {},
  );
  assert.ok(result.includes("Aを丁寧に書き直した。"), "unanchorable A が反映される");
  assert.ok(result.includes("Bを丁寧に書き直した。"), "unanchorable B が反映される");
  // 圧縮後テキストは置換で消えている(残骸が無い)。
  assert.ok(!result.includes("Aだ。"), "圧縮後 A は置換済で残らない");
  assert.ok(!result.includes("Bだ。"), "圧縮後 B は置換済で残らない");
});

// =============================================================================
// 2026-05-28 BUG #1 fix: getDerivedSpans の 2-pass 非対称 → unanchorable 採用の
// ハイライト落ちを reconcileSpansToDisplayedText の生成的補完(approach B)で救済
// =============================================================================
// a289 で getDerivedEsBody は unanchorable 採用を **本文に反映** するようになったが、
// getDerivedSpans は単一 pass のまま overlap / 範囲ガードで span を **完全に落とす**。
// reconcile は入力 span の補正(relocate / suppress)しかしないため、落ちた span は復活できず
// 本文は出るがハイライト(特に autoCorrected の emerald)が消える。
// 本 section は「getDerivedSpans が落とす(再現)→ reconcile が生成的に復活させる(fix)」を
// 直接 assert する。
// SSOT: lib/state/analyze_store.ts:reconcileSpansToDisplayedText(生成的補完ブロック)
process.stdout.write(
  "\n[BUG #1: getDerivedSpans 落ち → reconcile 生成的補完(unanchorable applied/autoCorrected)]\n",
);

test("BUG #1 case 1 (本 bug 直接再現): 先行採用で圧縮後のテキストを original に持つ autoCorrected 採用 — getDerivedSpans は span を落とすが reconcile が正位置で復活させる", () => {
  // 構成は es4 sug_009 型 + autoCorrected。
  // baseline 原文 → sug_pre 採用で圧縮 → sug_clar.original = 圧縮後テキスト(baseline に無い)。
  const baseline = "冒頭の文。圧縮対象の長い文。末尾の文。";
  const preOriginal = "圧縮対象の長い文。";
  const preStart = baseline.indexOf(preOriginal);
  const preProposed = "短い文。";
  // 先行採用後の派生本文(getDerivedEsBody pass 1 の出力相当)
  const afterPre =
    baseline.slice(0, preStart) + preProposed + baseline.slice(preStart + preOriginal.length);
  const clarOriginal = preProposed; // "短い文。" = 圧縮後 = unanchorable(baseline に無い)
  const clarProposed = "丁寧に書き直した充実の文。";
  const clarDerivedStart = afterPre.indexOf(clarOriginal);
  assert.ok(baseline.indexOf(clarOriginal) < 0, "前提: clar.original は baseline に無い(unanchorable)");

  const suggestions = [
    makeFullSuggestion({
      id: "sug_pre",
      original: preOriginal,
      proposed: preProposed,
      original_span: { start: preStart, end: preStart + preOriginal.length },
    }),
    makeFullSuggestion({
      id: "sug_clar",
      original: clarOriginal,
      proposed: clarProposed,
      // 派生 ES 座標(reAnchor case 3 で温存される値)。baseline 座標では別領域を指す。
      original_span: { start: clarDerivedStart, end: clarDerivedStart + clarOriginal.length },
    }),
  ];
  const accepted = ["sug_pre", "sug_clar"];
  const autoCorrected = ["sug_pre", "sug_clar"];

  // a289: 本文には clarProposed が反映される(前提確認)。
  const displayEsBody = getDerivedEsBody(baseline, suggestions, accepted, {});
  assert.ok(
    displayEsBody.includes(clarProposed),
    "前提(a289): 本文には unanchorable 採用が反映される",
  );

  // BUG #1 再現: getDerivedSpans は sug_clar の span を落とす。
  const rawSpans = getDerivedSpans(suggestions, accepted, {}, [], baseline.length);
  assert.ok(
    !rawSpans.some((s) => s.suggestion_id === "sug_clar"),
    "再現: getDerivedSpans は unanchorable 採用の span を落とす(単一 pass の非対称)",
  );

  // fix: reconcile が displayEsBody から proposed を locate して span を生成的に復活させる。
  const reconciled = reconcileSpansToDisplayedText(rawSpans, suggestions, displayEsBody, {
    acceptedIds: accepted,
    editedMap: {},
    autoCorrectedIds: autoCorrected,
  });
  const clarSpan = reconciled.find((s) => s.suggestion_id === "sug_clar");
  assert.ok(clarSpan, "fix: reconcile が sug_clar の span を生成的に復活させる(ハイライトが落ちない)");
  assert.equal(
    displayEsBody.slice(clarSpan.derivedStart, clarSpan.derivedEnd),
    clarProposed,
    "復活した span が proposed の正位置を指す(slice 一致)",
  );
  assert.equal(clarSpan.isApplied, true, "生成 span は applied(描画 = autoCorrected emerald)");
});

test("BUG #1 case 2: 編集済(editedMap)の unanchorable autoCorrected も edited_text で生成的に復活する", () => {
  const baseline = "冒頭。元の長い対象文。末尾。";
  const preOriginal = "元の長い対象文。";
  const preStart = baseline.indexOf(preOriginal);
  const preProposed = "圧縮文。";
  const afterPre =
    baseline.slice(0, preStart) + preProposed + baseline.slice(preStart + preOriginal.length);
  const clarOriginal = preProposed; // unanchorable
  const editedText = "ユーザーが手で編集した最終文。";
  const clarDerivedStart = afterPre.indexOf(clarOriginal);

  const suggestions = [
    makeFullSuggestion({
      id: "sug_pre",
      original: preOriginal,
      proposed: preProposed,
      original_span: { start: preStart, end: preStart + preOriginal.length },
    }),
    makeFullSuggestion({
      id: "sug_clar",
      original: clarOriginal,
      proposed: "提案文(使われない)",
      original_span: { start: clarDerivedStart, end: clarDerivedStart + clarOriginal.length },
    }),
  ];
  const accepted = ["sug_pre"]; // sug_clar は editedMap 経由で applied
  const editedMap = { sug_clar: editedText };
  const autoCorrected = ["sug_pre", "sug_clar"];

  const displayEsBody = getDerivedEsBody(baseline, suggestions, accepted, editedMap);
  assert.ok(displayEsBody.includes(editedText), "前提(a289): 編集済 unanchorable が edited_text で本文反映");

  const rawSpans = getDerivedSpans(suggestions, accepted, editedMap, [], baseline.length);
  assert.ok(
    !rawSpans.some((s) => s.suggestion_id === "sug_clar"),
    "再現: getDerivedSpans は span を落とす",
  );

  const reconciled = reconcileSpansToDisplayedText(rawSpans, suggestions, displayEsBody, {
    acceptedIds: accepted,
    editedMap,
    autoCorrectedIds: autoCorrected,
  });
  const clarSpan = reconciled.find((s) => s.suggestion_id === "sug_clar");
  assert.ok(clarSpan, "fix: 編集済 unanchorable の span も復活");
  assert.equal(
    displayEsBody.slice(clarSpan.derivedStart, clarSpan.derivedEnd),
    editedText,
    "復活した span が proposed ではなく edited_text の位置を指す",
  );
});

test("BUG #1 safety 1: applied-vs-applied で legitimate に shadow された採用は生成されない(proposed が本文に無い)", () => {
  // baseline 座標で重なる 2 採用。getDerivedEsBody でも getDerivedSpans でも後者が shadow され、
  // 後者の proposed は displayEsBody に焼き込まれない → reconcile は 0 箇所 locate で生成しない。
  const baseline = "私は部活で成績を改善しました。";
  const suggestions = [
    makeFullSuggestion({
      id: "s_old",
      original: baseline.slice(5, 10),
      proposed: "YYYYY",
      original_span: { start: 5, end: 10 },
    }),
    makeFullSuggestion({
      id: "s_new",
      original: baseline.slice(6, 11),
      proposed: "NEWREPL",
      original_span: { start: 6, end: 11 },
    }),
  ];
  const accepted = ["s_old", "s_new"];
  const displayEsBody = getDerivedEsBody(baseline, suggestions, accepted, {});
  assert.ok(!displayEsBody.includes("NEWREPL"), "前提: shadow された採用の proposed は本文に無い");

  const rawSpans = getDerivedSpans(suggestions, accepted, {}, [], baseline.length);
  const reconciled = reconcileSpansToDisplayedText(rawSpans, suggestions, displayEsBody, {
    acceptedIds: accepted,
    editedMap: {},
    autoCorrectedIds: ["s_old", "s_new"],
  });
  assert.ok(
    !reconciled.some((s) => s.suggestion_id === "s_new"),
    "safety: legitimate shadow された採用は生成的に復活しない(overlap-shadowing fix 7772fc1 を壊さない)",
  );
});

test("BUG #1 safety 2: pending な提案は決して生成されない(overlap-shadowing 防御線 case 408 を壊さない)", () => {
  // 採用済 sug_old が pending sug_new を overlap-shadow(getDerivedSpans が sug_new を落とす)。
  // 生成的補完は applied/autoCorrected のみが対象なので、pending の sug_new は復活しない。
  const baseline = "私は部活で成績を改善しました。";
  const suggestions = [
    makeFullSuggestion({
      id: "sug_old",
      original: baseline.slice(5, 10),
      proposed: "Y改善",
      original_span: { start: 5, end: 10 },
    }),
    makeFullSuggestion({
      id: "sug_new",
      category: "convention",
      original: baseline.slice(6, 11),
      proposed: "改善案",
      original_span: { start: 6, end: 11 },
    }),
  ];
  const accepted = ["sug_old"]; // sug_new は pending
  const displayEsBody = getDerivedEsBody(baseline, suggestions, accepted, {});

  const rawSpans = getDerivedSpans(suggestions, accepted, {}, [], baseline.length);
  const reconciled = reconcileSpansToDisplayedText(rawSpans, suggestions, displayEsBody, {
    acceptedIds: accepted,
    editedMap: {},
    autoCorrectedIds: ["sug_old"],
  });
  assert.ok(
    !reconciled.some((s) => s.suggestion_id === "sug_new"),
    "safety: pending 提案は生成されない(applied/autoCorrected 限定 = case 408 防御線維持)",
  );
});

test("BUG #1 safety 3: baked id は生成的補完の対象外(getDerivedSpans と対称)", () => {
  // baked(直接編集 flatten 済)は本文に物理的に焼き込まれており、proposed が displayEsBody に
  // 存在しうるが、生成すると二重表示になる。bakedIds で除外することを確認。
  const displayEsBody = "冒頭。焼き込み済の確定文。末尾。";
  const suggestions = [
    makeFullSuggestion({
      id: "sug_baked",
      original: "元テキスト",
      proposed: "焼き込み済の確定文",
      original_span: { start: 0, end: 5 },
    }),
  ];
  // getDerivedSpans は baked を skip するため rawSpans は空。
  const rawSpans = getDerivedSpans(
    suggestions,
    ["sug_baked"],
    {},
    [],
    displayEsBody.length,
    ["sug_baked"],
  );
  assert.equal(rawSpans.length, 0, "前提: getDerivedSpans は baked を skip");

  // bakedIds を渡すと生成されない。
  const withBaked = reconcileSpansToDisplayedText(rawSpans, suggestions, displayEsBody, {
    acceptedIds: ["sug_baked"],
    editedMap: {},
    autoCorrectedIds: ["sug_baked"],
    bakedIds: ["sug_baked"],
  });
  assert.ok(
    !withBaked.some((s) => s.suggestion_id === "sug_baked"),
    "safety: baked id は生成的補完の対象外",
  );
});

test("BUG #1 safety 4: 既に正しい span を持つ applied/autoCorrected は生成で二重追加されない(冪等)", () => {
  // 正常系: span が入力にあり slice も一致するケース。生成 pass で同 id を二重追加しないこと。
  const displayEsBody = "冒頭。自動修正済みの表現。末尾。";
  const correct = displayEsBody.indexOf("自動修正済みの表現");
  const suggestions = [
    makeFullSuggestion({
      id: "sug_auto",
      original: "古い表現",
      proposed: "自動修正済みの表現",
      original_span: { start: 3, end: 7 },
    }),
  ];
  const spans: DerivedSpan[] = [
    {
      suggestion_id: "sug_auto",
      derivedStart: correct,
      derivedEnd: correct + "自動修正済みの表現".length,
      isApplied: true,
      isRejected: false,
    },
  ];
  const out = reconcileSpansToDisplayedText(spans, suggestions, displayEsBody, {
    acceptedIds: [],
    editedMap: {},
    autoCorrectedIds: ["sug_auto"],
  });
  assert.equal(
    out.filter((s) => s.suggestion_id === "sug_auto").length,
    1,
    "既存 span を持つ id は生成 pass で二重追加されない(presentIds ガード)",
  );
});

// =============================================================================
// 2026-05-28 BUG #2 fix: getDerivedEsBody pass 2 の deferred 適用を fixpoint ループ化
// (依存連鎖する deferred の取りこぼし防止)
// =============================================================================
// deferred 同士が依存(B の original が A の pass2 適用後の body にしか現れない)+ A が後ソート
// だと、単一 pass は B を先に locate して 0 箇所 → skip → B の採用が消える。
// fixpoint 化で A 適用後の周に B が locate でき、連鎖が解ける。
// SSOT: lib/state/analyze_store.ts:getDerivedEsBody(pass 2 fixpoint ループ)
process.stdout.write(
  "\n[BUG #2: getDerivedEsBody pass 2 fixpoint(依存連鎖 deferred)]\n",
);

test("BUG #2 case 1 (本 bug 直接再現): 依存連鎖する deferred 2 件(B.original が A.proposed に依存、A が後ソート)— 両方反映される", () => {
  // A: anchorable original だが span 範囲外(end > len)→ pass 1 で deferred(range/verify 経路)。
  //    original_span.start を大きくして deferred 配列で後ろに来るよう仕込む。
  // B: unanchorable(original = A.proposed = "ALPHA。"、baseline に無い)→ deferred。
  //    original_span.start を小さくして deferred 配列で先に来る → 単一 pass なら B が先に locate
  //    失敗して消える。fixpoint なら A 適用後の周で B が解ける。
  const baseline = "頭。XX。中。YY。尾。";
  const aOriginal = "XX。";
  const aStart = baseline.indexOf(aOriginal);
  assert.ok(aStart >= 0);
  const aProposed = "ALPHA。";
  const bOriginal = aProposed; // B は A の適用結果に依存
  const bProposed = "BETA文。";

  const suggestions: SWithOriginal[] = [
    {
      id: "sug_A",
      category: "convention",
      original: aOriginal,
      // 範囲外 span(end > baseline.length)→ pass 1 では適用されず deferred。start 大で後ソート。
      original_span: { start: 100, end: 103 },
      proposed: aProposed,
    },
    {
      id: "sug_B",
      category: "convention",
      original: bOriginal, // "ALPHA。"= baseline に無い = unanchorable → deferred。start 小で先ソート。
      original_span: { start: 1, end: 4 },
      proposed: bProposed,
    },
  ];
  const result = getDerivedEsBody(baseline, suggestions, ["sug_A", "sug_B"], {});
  assert.ok(result.includes(bProposed), "fix: 連鎖の終端 B.proposed が反映される(取りこぼさない)");
  assert.ok(
    !result.includes(aProposed),
    "中間結果 A.proposed は B 置換で消える(残骸なし = 連鎖が解けた証跡)",
  );
});

test("BUG #2 case 2 (独立 deferred の非回帰 = a289 test 8 と同型): 依存しない unanchorable 採用 2 件は引き続き両方反映", () => {
  // fixpoint 化で独立 2 件(連鎖なし)の挙動が変わらないことを担保(a289 unanchorable accept 8 の
  // 非回帰を本 section でも明示)。1 周目で両方 locate できる = fixpoint が余計な副作用を持たない。
  const baseline = "頭。圧縮対象A。中。圧縮対象B。尾。";
  const preAOriginal = "圧縮対象A。";
  const preAStart = baseline.indexOf(preAOriginal);
  const preAProposed = "Aだ。";
  const preBOriginal = "圧縮対象B。";
  const preBStart = baseline.indexOf(preBOriginal);
  const preBProposed = "Bだ。";

  const suggestions: SWithOriginal[] = [
    {
      id: "sug_preA",
      category: "convention",
      original: preAOriginal,
      original_span: { start: preAStart, end: preAStart + preAOriginal.length },
      proposed: preAProposed,
    },
    {
      id: "sug_preB",
      category: "convention",
      original: preBOriginal,
      original_span: { start: preBStart, end: preBStart + preBOriginal.length },
      proposed: preBProposed,
    },
    {
      id: "sug_clarA",
      category: "convention",
      original: preAProposed, // 圧縮後 = unanchorable(独立、B に依存しない)
      original_span: { start: 3, end: 6 },
      proposed: "Aを丁寧に書き直した。",
    },
    {
      id: "sug_clarB",
      category: "convention",
      original: preBProposed, // 圧縮後 = unanchorable(独立、A に依存しない)
      original_span: { start: 12, end: 15 },
      proposed: "Bを丁寧に書き直した。",
    },
  ];
  const result = getDerivedEsBody(
    baseline,
    suggestions,
    ["sug_preA", "sug_preB", "sug_clarA", "sug_clarB"],
    {},
  );
  assert.ok(result.includes("Aを丁寧に書き直した。"), "独立 unanchorable A が反映(非回帰)");
  assert.ok(result.includes("Bを丁寧に書き直した。"), "独立 unanchorable B が反映(非回帰)");
});

test("BUG #2 case 3: 真に locate 不能な deferred は fixpoint でも安全に skip(無限ループしない)", () => {
  // 連鎖が解けない(どの周でも locate できない)deferred は、適用 0 件の周で終了して skip される。
  // 無限ループにならないこと + 誤適用しないことを担保。
  const baseline = "頭。XX。尾。";
  const suggestions: SWithOriginal[] = [
    {
      id: "sug_ghost",
      category: "convention",
      original: "存在しないテキスト", // baseline にも派生本文にも無い
      original_span: { start: 1, end: 4 },
      proposed: "GHOST。",
    },
  ];
  const result = getDerivedEsBody(baseline, suggestions, ["sug_ghost"], {});
  assert.equal(result, baseline, "locate 不能な deferred は適用されず baseline のまま(誤適用なし)");
  assert.ok(!result.includes("GHOST。"), "proposed は反映されない");
});

// =============================================================================
// 2026-05-29 shadow-rescue fix: 採用済 unanchorable が隣接 pending を過剰 shadow した
// ハイライト落ちを reconcileSpansToDisplayedText の pending-rescue 生成パスで救済
// =============================================================================
// root cause(es5 実画面で観測):
//  - 採用済が unanchorable(`original` が「先行採用で変化した後のテキスト」を指し form.es_body
//    に無い → reAnchor case 3 で派生座標を温存)だと、その `original_span.end` は実適用範囲より
//    長い派生座標のまま残る。getDerivedSpans の overlap ガードはこの過大 end を `lastEnd` に立て、
//    baseline 座標で正当に後続する anchorable な **pending** 提案を `start < lastEnd` で完全に
//    落とす(rawSpans に span が現れない)。
//  - BUG #1 生成的補完は applied/autoCorrected のみが対象なので、落ちた pending は復活できず、
//    本文にテキストは在るのにハイライトだけ消える。
// 本 section は es5 シナリオ(sug_001 auto + sug_002 + sug_005 unanchorable 採用 → pending
// sug_003 / sug_004)を再現し、「修正前は sug_003 の span が落ちる(再現)」「reconcile の
// pending-rescue で正位置に復活(fix)」「sug_004 維持」「sug_005 自身の span が実適用範囲
// (過大でない)」、および case 408 防御線(legitimate に上書き shadow された pending は復活しない)
// を担保する。
// SSOT: lib/state/analyze_store.ts:reconcileSpansToDisplayedText(pending-rescue ブロック)
process.stdout.write(
  "\n[shadow-rescue: 採用済 unanchorable が隣接 pending を過剰 shadow → reconcile pending-rescue]\n",
);

// es5 実データ(dispatch 記載のとおり)。
const ES5_FORM_BODY =
  "大学では3年間、50人規模のテニスサークルで代表を務めました。2年生の春に代表に就任し、それから2年間、運営に力を注ぎました。就任時の部員は40人でしたが、新歓に力を入れて60人まで増やしました。一方で活動の質を高めるため、最終的には部員を20人に絞り込みました。練習は週4回から週2回に減らしましたが、一回あたりの密度を上げ、大会成績は向上しました。引退するとき、後輩から「一番頼れる代表だった」と言われたことが、今でも一番の誇りです。";
// sug_001(error / autoCorrected)
const ES5_S1_ORIG = "大学では3年間、50人規模のテニスサークルで代表を務めました。";
const ES5_S1_PROP = "大学では3年間、50人規模のテニスサークルに所属し、2年生の春から代表を務めました。";
// sug_002(convention)
const ES5_S2_ORIG = "運営に力を注ぎました";
const ES5_S2_PROP = "部員数と練習体制の見直しに力を注ぎました";
// sug_005(convention, unanchorable): original = sug_001 + sug_002 適用後の冒頭 2 文(form.es_body に無い)
const ES5_S5_ORIG =
  "大学では3年間、50人規模のテニスサークルに所属し、2年生の春から代表を務めました。2年生の春に代表に就任し、それから2年間、部員数と練習体制の見直しに力を注ぎました。";
const ES5_S5_PROP =
  "大学では3年間、50人規模のテニスサークルに所属し、2年生の春から代表として部員数と練習体制の見直しに力を注ぎました。";
// pending(anchorable、原文にそのまま在る)
const ES5_S3_ORIG =
  "就任時の部員は40人でしたが、新歓に力を入れて60人まで増やしました。一方で活動の質を高めるため、最終的には部員を20人に絞り込みました。";
const ES5_S4_ORIG = "引退するとき、後輩から「一番頼れる代表だった」と言われたことが、今でも一番の誇りです。";

// es5 の suggestions 集合(full Suggestion。reconcile は Suggestion[] を取る)。
// sug_005 の original_span は派生座標(reAnchor case 3 で温存される過大 end [0,84])。
function buildEs5Suggestions(): Suggestion[] {
  const s1Start = ES5_FORM_BODY.indexOf(ES5_S1_ORIG); // 0
  const s2Start = ES5_FORM_BODY.indexOf(ES5_S2_ORIG); // 52
  const s3Start = ES5_FORM_BODY.indexOf(ES5_S3_ORIG); // 63
  const s4Start = ES5_FORM_BODY.indexOf(ES5_S4_ORIG); // 176
  return [
    makeFullSuggestion({
      id: "sug_001",
      category: "error",
      original: ES5_S1_ORIG,
      proposed: ES5_S1_PROP,
      original_span: { start: s1Start, end: s1Start + ES5_S1_ORIG.length },
    }),
    makeFullSuggestion({
      id: "sug_002",
      category: "convention",
      original: ES5_S2_ORIG,
      proposed: ES5_S2_PROP,
      original_span: { start: s2Start, end: s2Start + ES5_S2_ORIG.length },
    }),
    makeFullSuggestion({
      id: "sug_005",
      category: "convention",
      original: ES5_S5_ORIG,
      proposed: ES5_S5_PROP,
      // 派生座標(過大 end = 84)。baseline には original が無い(unanchorable)。
      original_span: { start: 0, end: 84 },
    }),
    makeFullSuggestion({
      id: "sug_003",
      category: "convention",
      original: ES5_S3_ORIG,
      proposed: "(pending sug_003 の proposed、本テストでは未使用)",
      original_span: { start: s3Start, end: s3Start + ES5_S3_ORIG.length },
    }),
    makeFullSuggestion({
      id: "sug_004",
      category: "convention",
      original: ES5_S4_ORIG,
      proposed: "(pending sug_004 の proposed、本テストでは未使用)",
      original_span: { start: s4Start, end: s4Start + ES5_S4_ORIG.length },
    }),
  ];
}

test("shadow-rescue 前提: sug_005 の original は form.es_body に存在しない(unanchorable)", () => {
  assert.ok(
    ES5_FORM_BODY.indexOf(ES5_S5_ORIG) < 0,
    "sug_005.original は先行採用後のテキスト = baseline に無い(reAnchor case 3 温存)",
  );
});

test("shadow-rescue 再現: getDerivedSpans は anchorable pending sug_003 の span を落とす(過大 lastEnd による過剰 shadow)", () => {
  // 修正前の挙動を直接担保(getDerivedSpans は本 fix で 1 行も変えていない)。
  const suggestions = buildEs5Suggestions();
  const accepted = ["sug_001", "sug_002", "sug_005"];
  const rawSpans = getDerivedSpans(
    suggestions,
    accepted,
    {},
    [],
    ES5_FORM_BODY.length,
  );
  assert.ok(
    !rawSpans.some((s) => s.suggestion_id === "sug_003"),
    "再現: sug_005 の過大 lastEnd(=84)が baseline start=63 の sug_003 を過剰 shadow して span を落とす",
  );
  // sug_005 自身の span は実適用範囲(proposed 長)で、過大ではない([0,84] ではなく [0,59])。
  const s5 = rawSpans.find((s) => s.suggestion_id === "sug_005");
  assert.ok(s5, "sug_005 の span は出る(applied)");
  assert.equal(
    s5!.derivedEnd - s5!.derivedStart,
    ES5_S5_PROP.length,
    "sug_005 の span 長は proposed 長(=実適用範囲)で、original_span の過大 end(84)ではない",
  );
});

test("shadow-rescue fix: reconcile の pending-rescue が sug_003 を正位置に復活させる(ハイライトが落ちない)", () => {
  const suggestions = buildEs5Suggestions();
  const accepted = ["sug_001", "sug_002", "sug_005"];
  const autoCorrected = ["sug_001"]; // sug_001 のみ autoCorrected(error 自動修正)
  const displayEsBody = getDerivedEsBody(ES5_FORM_BODY, suggestions, accepted, {});
  // 前提: 派生本文に各テキストが期待どおり存在する。
  assert.ok(displayEsBody.includes(ES5_S5_PROP), "前提: sug_005 の proposed が本文反映済");
  assert.ok(displayEsBody.includes(ES5_S3_ORIG), "前提: sug_003 の original は本文に手付かずで残る");
  assert.ok(displayEsBody.includes(ES5_S4_ORIG), "前提: sug_004 の original も本文に残る");

  const rawSpans = getDerivedSpans(suggestions, accepted, {}, [], ES5_FORM_BODY.length);
  const reconciled = reconcileSpansToDisplayedText(rawSpans, suggestions, displayEsBody, {
    acceptedIds: accepted,
    editedMap: {},
    autoCorrectedIds: autoCorrected,
    rejectedIds: [],
  });

  // sug_003 の span が復活し、displayEsBody 上の original の正位置を指す。
  const s3 = reconciled.find((s) => s.suggestion_id === "sug_003");
  assert.ok(s3, "fix: sug_003 の span が pending-rescue で復活(ハイライトが落ちない)");
  assert.equal(
    displayEsBody.slice(s3!.derivedStart, s3!.derivedEnd),
    ES5_S3_ORIG,
    "復活した sug_003 span が original の正位置を指す(slice 一致)",
  );
  assert.equal(s3!.isApplied, false, "pending として復活(描画は通常ハイライト)");
  assert.equal(s3!.isRejected, false);
});

test("shadow-rescue fix: sug_004(別座標の pending)も正位置で維持される", () => {
  const suggestions = buildEs5Suggestions();
  const accepted = ["sug_001", "sug_002", "sug_005"];
  const autoCorrected = ["sug_001"];
  const displayEsBody = getDerivedEsBody(ES5_FORM_BODY, suggestions, accepted, {});
  const rawSpans = getDerivedSpans(suggestions, accepted, {}, [], ES5_FORM_BODY.length);
  const reconciled = reconcileSpansToDisplayedText(rawSpans, suggestions, displayEsBody, {
    acceptedIds: accepted,
    editedMap: {},
    autoCorrectedIds: autoCorrected,
    rejectedIds: [],
  });
  const s4 = reconciled.find((s) => s.suggestion_id === "sug_004");
  assert.ok(s4, "sug_004 は維持される");
  assert.equal(
    displayEsBody.slice(s4!.derivedStart, s4!.derivedEnd),
    ES5_S4_ORIG,
    "sug_004 span が original の正位置を指す(reconcile の verify/relocate で正位置へ)",
  );
});

test("shadow-rescue fix: reconcile 出力は derivedStart 昇順(buildSegments の cursor 前提を維持)", () => {
  const suggestions = buildEs5Suggestions();
  const accepted = ["sug_001", "sug_002", "sug_005"];
  const displayEsBody = getDerivedEsBody(ES5_FORM_BODY, suggestions, accepted, {});
  const rawSpans = getDerivedSpans(suggestions, accepted, {}, [], ES5_FORM_BODY.length);
  const reconciled = reconcileSpansToDisplayedText(rawSpans, suggestions, displayEsBody, {
    acceptedIds: accepted,
    editedMap: {},
    autoCorrectedIds: ["sug_001"],
    rejectedIds: [],
  });
  for (let i = 1; i < reconciled.length; i++) {
    assert.ok(
      reconciled[i].derivedStart >= reconciled[i - 1].derivedStart,
      "derivedStart 昇順で返る",
    );
  }
});

test("shadow-rescue safety: 採用に baseline 上 legitimate に上書き shadow された pending は復活しない(case 408 防御線維持)", () => {
  // baseline 座標で本当に重なる 採用 vs pending。採用の proposed が pending の original を上書きし、
  // displayEsBody に pending.original が intact では残らない → pending-rescue は 0 箇所 locate で生成しない。
  const baseline = "私は部活で成績を改善しました。";
  const suggestions = [
    makeFullSuggestion({
      id: "sug_old",
      category: "convention",
      original: baseline.slice(5, 10), // "成績を改善"
      proposed: "Y改善", // 採用すると "成績を改善" が消える
      original_span: { start: 5, end: 10 },
    }),
    makeFullSuggestion({
      id: "sug_new",
      category: "convention",
      original: baseline.slice(6, 11), // "績を改善し" — sug_old と baseline 上で重なる
      proposed: "改善案",
      original_span: { start: 6, end: 11 },
    }),
  ];
  const accepted = ["sug_old"]; // sug_new は pending
  const displayEsBody = getDerivedEsBody(baseline, suggestions, accepted, {});
  assert.ok(
    displayEsBody.indexOf(suggestions[1].original) < 0,
    "前提: legitimate に上書き shadow された pending の original は本文に残らない",
  );
  const rawSpans = getDerivedSpans(suggestions, accepted, {}, [], baseline.length);
  const reconciled = reconcileSpansToDisplayedText(rawSpans, suggestions, displayEsBody, {
    acceptedIds: accepted,
    editedMap: {},
    autoCorrectedIds: ["sug_old"],
    rejectedIds: [],
  });
  assert.ok(
    !reconciled.some((s) => s.suggestion_id === "sug_new"),
    "safety: legitimate に上書き shadow された pending は pending-rescue で復活しない(case 408 維持)",
  );
});

test("shadow-rescue safety: 却下済 pending は pending-rescue で復活しない", () => {
  // 却下済はハイライトを出さない。span が落ちていても rejectedIds で除外する。
  const suggestions = buildEs5Suggestions();
  const accepted = ["sug_001", "sug_002", "sug_005"];
  const rejected = ["sug_003"]; // sug_003 を却下
  const displayEsBody = getDerivedEsBody(ES5_FORM_BODY, suggestions, accepted, {});
  const rawSpans = getDerivedSpans(
    suggestions,
    accepted,
    {},
    rejected,
    ES5_FORM_BODY.length,
  );
  const reconciled = reconcileSpansToDisplayedText(rawSpans, suggestions, displayEsBody, {
    acceptedIds: accepted,
    editedMap: {},
    autoCorrectedIds: ["sug_001"],
    rejectedIds: rejected,
  });
  assert.ok(
    !reconciled.some((s) => s.suggestion_id === "sug_003"),
    "safety: 却下済 sug_003 は pending-rescue で復活しない",
  );
});

test("shadow-rescue safety: rejectedIds 未指定(default)でも従来呼び出しは壊れない(後方互換)", () => {
  // 既存呼び出し(rejectedIds を渡さない)で例外を投げず、pending-rescue が機能すること。
  const suggestions = buildEs5Suggestions();
  const accepted = ["sug_001", "sug_002", "sug_005"];
  const displayEsBody = getDerivedEsBody(ES5_FORM_BODY, suggestions, accepted, {});
  const rawSpans = getDerivedSpans(suggestions, accepted, {}, [], ES5_FORM_BODY.length);
  const reconciled = reconcileSpansToDisplayedText(rawSpans, suggestions, displayEsBody, {
    acceptedIds: accepted,
    editedMap: {},
    autoCorrectedIds: ["sug_001"],
    // rejectedIds 省略
  });
  assert.ok(
    reconciled.some((s) => s.suggestion_id === "sug_003"),
    "後方互換: rejectedIds 省略でも pending-rescue は機能する",
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
