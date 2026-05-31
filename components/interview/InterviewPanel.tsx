"use client";

// =============================================================================
// Commit D-4 (2026-05-25): 右パネル用 面接質問パネル(stale 表示)
// =============================================================================
//
// 責務:
//  - 面接質問(3-5 問)を right-panel コンパクトに表示
//  - is_stale = true の場合は「ES が更新されました、再分析で最新化されます」の注釈
//
// Task #27 (2026-05-25): 再分析ボタンを本パネルから撤去 — SummaryBar 右側に
// 1 つに集約。stale 通知の注釈テキスト(AlertTriangle + stale_message)は維持し、
// 「stale 認知の動線」は保持する(ユーザー要望「注釈テキストだけ残す」を反映)。
//   - 旧: stale 時に「最新化」ボタン(triggerFullRefresh)を併置
//   - 新: ボタン無し、注釈テキストのみ表示
//   - ユーザーは SummaryBar 右側の「再分析」ボタンから明示的に triggerFullRefresh を実行
//   - 詳細: DECISIONS.md [2026-05-25] Task #27 計画 §修正 3
//
// ResultPanel 下部の InterviewQuestionsSection との違い:
//  - 下部 = 全体読み返し用、各 question の purpose_hint / answer_hint を詳細表示
//  - 右パネル = 編集中の参照、question 本体を主、hint は折りたたみ
//
// 設計判断:
//  1) **新規 API 経路を作らない** — interview 単独の「再生成 API」を新設するのは
//     dispatch 触らない領域(LLM 層)。「再分析」= triggerFullRefresh() で
//     全体再分析の一環として再生成される(initial と同じ経路)経由を選ぶ
//  2) **stale 表示は subtle に** — 警告ではなくお知らせ、「ES を編集した結果、
//     面接質問は前のバージョン基準のままです」を明示
//  3) **数値スコア禁止** — 問数のみ表示(「Q1」「N 問」)
//
// AGENTS.md Inviolable constraints:
//  - 数値スコア禁止: 件数のみ
//  - 面接質問 3〜5 問: schema 保証
//  - localStorage 不使用: store 直接購読
//
// SSOT: lib/schema/interview.ts (InterviewQuestion, InterviewQuestions),
//       lib/state/analyze_store.ts (analysisResult)
//       DECISIONS.md [2026-05-25] Task #27 計画 §修正 3

import * as React from "react";
import { useTranslations } from "next-intl";
import type {
  InterviewQuestion,
  InterviewQuestions,
} from "@/lib/schema/interview";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  ChevronRight,
  Crosshair,
  Lightbulb,
  MessageCircleQuestion,
} from "lucide-react";

export interface InterviewPanelProps {
  questions: InterviewQuestions | undefined;
}

export function InterviewPanel({ questions }: InterviewPanelProps) {
  const t = useTranslations("interviewPanel");

  if (!questions) {
    return (
      <div
        className="rounded-md border border-dashed border-border/60 bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground"
        role="region"
        aria-label={t("region_aria")}
      >
        <MessageCircleQuestion className="mx-auto mb-2 size-5 text-muted-foreground/60" />
        <p className="text-jp">{t("empty_message")}</p>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-border/60 bg-card/70 p-3"
      role="region"
      aria-label={t("region_aria")}
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-sm font-medium">
          <MessageCircleQuestion className="size-4 text-primary" />
          <span>{t("title_template", { count: questions.questions.length })}</span>
        </h4>
      </div>

      {/* stale 通知 — Task #27 (2026-05-25): 「最新化」ボタンを撤去、注釈テキストのみ。
          ユーザーは SummaryBar 右側の「再分析」ボタンから triggerFullRefresh を実行。
          AlertTriangle + amber box + stale_message のみで「stale 認知」動線を維持。 */}
      {questions.is_stale && (
        <div
          className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-50/70 px-2.5 py-1.5 text-[11px] dark:border-amber-500/30 dark:bg-amber-950/30"
          role="status"
        >
          <AlertTriangle
            className="size-3 mt-0.5 shrink-0 text-amber-700 dark:text-amber-400"
            aria-hidden
          />
          <span className="text-amber-900 dark:text-amber-200 text-jp">
            {t("stale_message")}
          </span>
        </div>
      )}

      <ul className="flex flex-col gap-2.5">
        {questions.questions.map((q, i) => (
          <InterviewQuestionCard key={q.id} question={q} index={i + 1} />
        ))}
      </ul>
    </div>
  );
}

// =============================================================================
// InterviewQuestionCard — 各質問(右パネル コンパクト版)
// =============================================================================
// 設計:
//  - Q 番号(円形 badge) + 質問本体(主役)
//  - purpose_hint / answer_hint は <details> で折りたたみ(右パネル幅優先のため)
function InterviewQuestionCard({
  question,
  index,
}: {
  question: InterviewQuestion;
  index: number;
}) {
  const t = useTranslations("interviewPanel");
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border/60 bg-background/40 p-2.5">
      <div className="flex items-start gap-2">
        <Badge
          variant="outline"
          className={cn(
            "inline-flex size-6 shrink-0 items-center justify-center rounded-full p-0",
            "border border-primary/40 bg-primary/10 text-primary",
            "font-mono text-[10px] font-semibold",
          )}
          aria-label={t("question_aria_template", { index })}
        >
          Q{index}
        </Badge>
        <p className="mt-0.5 text-xs font-medium leading-relaxed text-foreground text-jp">
          {question.question}
        </p>
      </div>
      <details className="group">
        <summary className="flex items-center gap-1.5 cursor-pointer text-[10px] font-medium tracking-wide text-muted-foreground hover:text-foreground marker:hidden [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
          <span className="group-open:hidden">{t("expand_label")}</span>
          <span className="hidden group-open:inline">{t("collapse_label")}</span>
        </summary>
        <div className="mt-1.5 flex flex-col gap-1.5 pl-2">
          <div>
            <h6 className="mb-0.5 flex items-center gap-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              <Crosshair className="size-2.5" />
              {t("purpose_label")}
            </h6>
            <p className="text-[11px] leading-relaxed text-foreground/85 text-jp">
              {question.purpose_hint}
            </p>
          </div>
          <div>
            <h6 className="mb-0.5 flex items-center gap-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              <Lightbulb className="size-2.5" />
              {t("answer_hint_label")}
            </h6>
            <p className="text-[11px] leading-relaxed text-foreground/85 text-jp">
              {question.answer_hint}
            </p>
          </div>
        </div>
      </details>
    </li>
  );
}
