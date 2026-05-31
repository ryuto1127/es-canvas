"use client";

// =============================================================================
// ClarificationSection — 2026-05-28 dogfood round 3: AI 逆質問の統一セクション
// =============================================================================
//
// 背景 / 理由(dispatch `docs/dispatch/2026-05-28-clarification-relocation.md`):
//  逆質問(clarification question)への回答は「全体への入力」— 回答すると既存提案を
//  含めて全体が再評価される(SummaryBar の「この回答で再分析」=
//  triggerReanalysisWithClarifications)。それを個別の SuggestionCard 内に inline 表示
//  すると「特定の提案の付属物」に見え、挙動(全体再評価)と置き場所(1 提案)の意味が
//  ズレる。さらに 1 件詳細展開モード(SuggestionDetailPanel)では選択中の 1 件しか
//  カードが出ないため、他の提案に紐づく質問が「見えなくなる」問題もあった。
//
//  → suggestion 紐付き + global の質問を **指摘タブ最上部の 1 セクションに集約** する。
//    どの提案を選択中でも、また完了画面 / placeholder のどの状態でも常に最上部に見える。
//
// 責務:
//  - 全 suggestion の `clarification_questions`(schema 上 max 1)+ store の
//    `global_clarification_questions` を 1 か所に集めて既存 ClarificationBlock で描画。
//  - suggestion 紐付きの質問には「この指摘について: <original 冒頭 ~20 字>」ラベルを
//    添え、どの指摘に対する質問かの文脈を保つ(個別カードから出したことによる文脈喪失を補う)。
//  - global には「全体について」ラベル。
//  - 合計 0 件なら **セクションごと非表示**(null を返す、noise を増やさない)。
//  - <details open> の折りたたみ式。質問は能動的に見せたいのでデフォルト展開。
//
// store / schema / prompt / API は不変(本セクションは UI 移設のみ):
//  - 回答 state(clarificationAnswers)/ 保存(updateClarificationAnswer)/
//    suggestion_id 紐付け / 反映(triggerReanalysisWithClarifications)は
//    ClarificationBlock がそのまま担う。本 component は「どの質問をどのラベルで並べるか」
//    だけを決める表示層。回答・再分析の挙動は移設前と完全に同一。
//
// マウント先: RightPanel の `TabsContent value="suggestions"`、SuggestionDetailPanel の
//  **上**。これにより SuggestionDetailPanel のどの分岐(詳細展開 / 完了画面 /
//  placeholder / empty)でも常に指摘タブ最上部に出る。
//
// 二重表示回避:
//  - SuggestionCard の inline ClarificationBlock は撤去済(suggestion 紐付きは本セクションへ一本化)。
//  - SuggestionListPanel の global section も撤去済(global も本セクションへ一本化)。
//  - よって本 component が唯一の逆質問描画箇所。
//
// AGENTS.md Inviolable constraints:
//  - 数値スコア禁止: 件数(N)のみ表示、スコアは出さない
//  - すべての操作は Undo 可能: 回答は textarea でいつでも上書き / 空にして未回答へ(ClarificationBlock)
//  - localStorage 不使用: clarificationAnswers は store の session 揮発(ClarificationBlock)
//
// SSOT: lib/schema/clarification.ts (ClarificationQuestion),
//       lib/state/analyze_store.ts (analysisResult.global_clarification_questions),
//       components/canvas/SuggestionCard.tsx (ClarificationBlock)

import * as React from "react";
import { useTranslations } from "next-intl";
import type { Suggestion } from "@/lib/schema/suggestion";
import type { ClarificationQuestion } from "@/lib/schema/clarification";
import { clarificationIdentity } from "@/lib/schema/clarification";
import { useAnalyzeStore } from "@/lib/state/analyze_store";
import { ClarificationBlock } from "@/components/canvas/SuggestionCard";
import { ChevronRight, HelpCircle } from "lucide-react";

// suggestion 紐付き質問の「どの指摘か」ラベル用に original の冒頭を切り出す。
// ~20 字 + 省略記号。SuggestionCard 内の related snippet(24 字)や summary(30 字)と
// 同系統だが、ラベル併記で短く済ませたいので 20 字。
const LABEL_SNIPPET_LEN = 20;
function labelSnippet(original: string): string {
  return original.length > LABEL_SNIPPET_LEN
    ? original.slice(0, LABEL_SNIPPET_LEN) + "…"
    : original;
}

// 空配列を selector 内で生成すると毎 render 新しい参照になり、Zustand の getSnapshot
// 等価判定(Object.is)を毎回すり抜けて無限再レンダーになる(2026-05-28 infinite loop 事故)。
// 既定値は module レベルの安定参照を使い、?? は hook の戻り値側(selector の外)で適用する。
const EMPTY_CLARIFICATION_QUESTIONS: ClarificationQuestion[] = [];

// 描画する 1 行の正規化済データ。
//  - scope === "suggestion": suggestionId + label(原文冒頭)を持つ
//  - scope === "global": label = 「全体について」(suggestionId は無し)
// ClarificationBlock は scope / suggestionId をそのまま store action に渡すため、
// 既存の回答紐付けロジックと完全互換(本 component は順序とラベルのみ決める)。
type ClarificationItem =
  | {
      scope: "suggestion";
      suggestionId: string;
      label: string;
      question: ClarificationQuestion;
    }
  | {
      scope: "global";
      label: string;
      question: ClarificationQuestion;
    };

export interface ClarificationSectionProps {
  suggestions: Suggestion[];
}

export function ClarificationSection({ suggestions }: ClarificationSectionProps) {
  const t = useTranslations("clarification");
  // global 質問は analysisResult.global_clarification_questions から購読
  //（suggestions 配列とは独立の経路、refresh 後の更新で自動的に最新値を反映）。
  const globalClarificationQuestions =
    useAnalyzeStore((s) => s.analysisResult?.global_clarification_questions) ??
    EMPTY_CLARIFICATION_QUESTIONS;

  // 表示順:
  //  1) suggestion 紐付き質問を original_span.start 昇順(ES の出現順、上から順)で並べる
  //     — ②③④ で確立した「上から順」方針と一貫。span 同一の稀ケースは suggestion.id 昇順。
  //  2) global を末尾に置く(全体に関わる質問は個別指摘の質問の後に読むのが自然)。
  const items: ClarificationItem[] = React.useMemo(() => {
    const suggestionItems: ClarificationItem[] = suggestions
      .filter(
        (s) =>
          s.clarification_questions && s.clarification_questions.length > 0,
      )
      .slice()
      .sort((a, b) => {
        const spanDiff = a.original_span.start - b.original_span.start;
        if (spanDiff !== 0) return spanDiff;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      // schema 上 clarification_questions は max 1。先頭のみ採用(filter で非空保証済)。
      .map((s) => ({
        scope: "suggestion" as const,
        suggestionId: s.id,
        label: labelSnippet(s.original),
        question: s.clarification_questions![0],
      }));

    const globalItems: ClarificationItem[] = globalClarificationQuestions.map(
      (q: ClarificationQuestion) => ({
        scope: "global" as const,
        label: t("for_global_label"),
        question: q,
      }),
    );

    return [...suggestionItems, ...globalItems];
  }, [suggestions, globalClarificationQuestions, t]);

  // details の開閉を React state で制御する(2026-05-28 dogfood: トグルが閉じない不具合修正)。
  //  - 静的リテラルの `open` は re-render のたびに details を open に戻すため、summary を
  //    クリックして閉じても開き直り、`group-open:` が常時 true → ラベルが「閉じる」固定だった。
  //  - useState(true) で「デフォルト展開」(逆質問は能動的に見せたい)を維持。
  //  - onToggle で native トグル後の open を state に反映 → `group-open:` と同期し、
  //    開閉ヒントのラベルも正しく切替わる。
  const [open, setOpen] = React.useState(true);

  // 合計 0 件ならセクションごと非表示
  if (items.length === 0) return null;

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="group flex flex-col gap-2 rounded-md border border-indigo-400/30 bg-indigo-50/40 dark:border-indigo-500/30 dark:bg-indigo-950/20 px-3 py-2"
    >
      {/* ヘッダ(summary): HelpCircle + 「AI からの質問」+ 件数 + 開閉ヒント */}
      <summary
        className="flex cursor-pointer flex-wrap items-center gap-2 text-sm font-medium text-indigo-700 dark:text-indigo-300 marker:hidden [&::-webkit-details-marker]:hidden"
        aria-label={t("unified_section_aria", { count: items.length })}
      >
        <ChevronRight
          className="size-3.5 transition-transform group-open:rotate-90"
          aria-hidden
        />
        <HelpCircle className="size-4" aria-hidden />
        <span>{t("unified_section_heading")}</span>
        <span className="font-mono text-[10px] text-indigo-600/70 dark:text-indigo-400/70">
          {items.length}
        </span>
        <span className="ml-auto text-[10px] font-normal text-indigo-600/60 dark:text-indigo-400/60">
          <span className="group-open:inline hidden">
            {t("unified_section_open_label")}
          </span>
          <span className="group-open:hidden inline">
            {t("unified_section_closed_label")}
          </span>
        </span>
      </summary>

      <ul className="mt-1 flex flex-col gap-2">
        {items.map((item) => (
          // React key: question.id は suggestion ごとに振られ集約リスト全体で一意でない
          // (sug_003 と sug_005 が両方 q_001 を持ちうる)ため、複合キー
          // (scope + suggestion_id + question_id)で一意化する(2026-05-29 key 衝突修正)。
          <li
            key={clarificationIdentity({
              scope: item.scope,
              suggestion_id:
                item.scope === "suggestion" ? item.suggestionId : undefined,
              question_id: item.question.id,
            })}
            className="flex flex-col gap-1"
          >
            {/* どの指摘 / 全体か のラベル(個別カードから出したことによる文脈喪失を補う)。
                suggestion 紐付きは「この指摘について: <原文冒頭>」、global は「全体について」。 */}
            <p className="flex items-center gap-1 text-[10px] text-indigo-600/80 dark:text-indigo-400/80 text-jp">
              {item.scope === "suggestion" ? (
                <>
                  <span className="font-medium">{t("for_suggestion_label")}</span>
                  <span className="text-muted-foreground">{item.label}</span>
                  <span className="font-mono text-[10px] text-muted-foreground/70">
                    {item.suggestionId}
                  </span>
                </>
              ) : (
                <span className="font-medium">{item.label}</span>
              )}
            </p>
            {item.scope === "suggestion" ? (
              <ClarificationBlock
                question={item.question}
                scope="suggestion"
                suggestionId={item.suggestionId}
              />
            ) : (
              <ClarificationBlock question={item.question} scope="global" />
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
