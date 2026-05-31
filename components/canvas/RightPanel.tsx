"use client";

// =============================================================================
// Commit D-4 (2026-05-25): 右パネル統合(指摘 / 企業要約 / 面接質問 / 履歴 タブ)
// Task #32a (2026-05-25): タブクリック bug 解消 — activeTab を store に格上げ
// =============================================================================
//
// 責務:
//  - 右パネルのトップレベルコンテナ。「指摘」「企業要約」「面接質問」「履歴」4 タブを管理。
//  - 各タブの中身は別 component に委譲:
//    - 指摘: SuggestionDetailPanel(D-1/D-3 既存)
//    - 企業要約: CompanySummaryPanel(D-4 新規)
//    - 面接質問: InterviewPanel(D-4 新規)
//    - 履歴: HistoryPanel(2026-05-25 既存)
//
// 設計判断 (Task #32a, 2026-05-25):
//  1) **タブ active state は store 中心 (activeTab + setActiveTab)** — 旧設計の
//     `userTabValue` (useState) + `selectedSuggestionId !== null` での derived 強制
//     上書きを撤去。Task #30 の auto-select 強化で `selectedSuggestionId` が常に
//     立つようになった結果、derived 上書きが「企業要約 / 面接質問」タブのクリックを
//     完全に無視する bug が発生していた(dogfood 観察 2026-05-25)。
//  2) **ハイライトクリックでの「指摘タブ強制移動」は Canvas 側で setActiveTab を併発**
//     (Canvas.tsx の HighlightSpan / AutoCorrectedSpan onClick で
//      `selectSuggestion(id)` 直後に `setActiveTab("suggestions")` を呼ぶ動線)。
//     これにより「ハイライトクリック → 指摘詳細が見える」UX 整合は維持しつつ、
//     selectedSuggestionId が立っていてもユーザーが他タブをクリックすれば移動できる。
//  3) **下部の OverallAssessment / CompanySummary / InterviewQuestions セクションは維持** —
//     右タブと下部は別目的(編集中の参照 vs 全体読み返し)、両立させる。
//
// AGENTS.md Inviolable constraints:
//  - 数値スコア禁止: 各タブ内で件数のみ表示
//  - 競合通知中間プレビューなし: 本コンポーネントは競合通知に関与しない
//
// SSOT: lib/state/analyze_store.ts (activeTab, setActiveTab, TabValue)

import * as React from "react";
import { useTranslations } from "next-intl";
import type { Suggestion } from "@/lib/schema/suggestion";
import type { CompanySummary } from "@/lib/schema/company";
import type { InterviewQuestions } from "@/lib/schema/interview";
import { useAnalyzeStore, type TabValue } from "@/lib/state/analyze_store";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SuggestionDetailPanel } from "@/components/canvas/SuggestionDetailPanel";
// 2026-05-28 dogfood round 3: AI 逆質問を個別カードから取り出し、指摘タブ最上部に集約。
import { ClarificationSection } from "@/components/canvas/ClarificationSection";
import { CompanySummaryPanel } from "@/components/transparency/CompanySummaryPanel";
import { InterviewPanel } from "@/components/interview/InterviewPanel";
import { HistoryPanel } from "@/components/canvas/HistoryPanel";
import {
  Building2,
  History,
  ListChecks,
  MessageCircleQuestion,
} from "lucide-react";

export interface RightPanelProps {
  suggestions: Suggestion[];
  companySummary: CompanySummary | null;
  interviewQuestions: InterviewQuestions | undefined;
}

export function RightPanel({
  suggestions,
  companySummary,
  interviewQuestions,
}: RightPanelProps) {
  const t = useTranslations("rightPanel");
  // 2026-05-25: 履歴タブの badge / 件数表示用
  const actionLogCount = useAnalyzeStore((s) => s.actionLog.length);
  // Task #32a (2026-05-25): activeTab を store から直接購読(旧 userTabValue 撤去)
  const activeTab = useAnalyzeStore((s) => s.activeTab);
  const setActiveTab = useAnalyzeStore((s) => s.setActiveTab);

  // 面接質問の件数(空 / undefined なら 0)
  const interviewCount = interviewQuestions?.questions.length ?? 0;
  // 企業要約の有無で badge / disabled を切替
  const hasCompanySummary = companySummary !== null;

  return (
    <Tabs
      value={activeTab}
      onValueChange={(v) => setActiveTab(v as TabValue)}
      className="flex flex-col gap-3"
    >
      <TabsList variant="line" className="w-full justify-start gap-2 px-0">
        <TabsTrigger value="suggestions" className="gap-1.5">
          <ListChecks className="size-3.5" />
          <span>{t("tab_suggestions")}</span>
        </TabsTrigger>
        <TabsTrigger value="company" className="gap-1.5">
          <Building2 className="size-3.5" />
          <span>{t("tab_company")}</span>
          {hasCompanySummary && companySummary.evidence.length > 0 && (
            <span className="font-mono text-[10px] text-muted-foreground">
              {companySummary.evidence.length}
            </span>
          )}
        </TabsTrigger>
        <TabsTrigger
          value="interview"
          className="gap-1.5"
          disabled={interviewCount === 0}
        >
          <MessageCircleQuestion className="size-3.5" />
          <span>{t("tab_interview")}</span>
          {interviewCount > 0 && (
            <span className="font-mono text-[10px] text-muted-foreground">
              {interviewCount}
            </span>
          )}
        </TabsTrigger>
        {/* 2026-05-25: 履歴タブ追加(4 タブ目)。badge は操作履歴件数。 */}
        <TabsTrigger value="history" className="gap-1.5">
          <History className="size-3.5" />
          <span>{t("tab_history")}</span>
          {actionLogCount > 0 && (
            <span className="font-mono text-[10px] text-muted-foreground">
              {actionLogCount}
            </span>
          )}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="suggestions" className="flex flex-col gap-3">
        {/* 2026-05-28 dogfood round 3: AI 逆質問の統一セクション(指摘タブ最上部)。
            全 suggestion の clarification_questions + global を 1 か所に集約。0 件なら非表示。
            SuggestionDetailPanel の上に置くことで、詳細展開 / 完了 / placeholder のどの
            状態でも常に最上部に見える(回答 → 全体再評価 という挙動と置き場所の意味を一致)。 */}
        <ClarificationSection suggestions={suggestions} />
        {/* 2026-05-25 (1 件詳細展開モード): SuggestionDetailPanel に props を渡す経路。
            完了画面の「履歴を見る」クリックで履歴タブに切り替える。 */}
        <SuggestionDetailPanel
          suggestions={suggestions}
          onRequestHistoryTab={() => setActiveTab("history")}
        />
      </TabsContent>

      <TabsContent value="company" className="flex flex-col gap-3">
        <CompanySummaryPanel summary={companySummary} />
      </TabsContent>

      <TabsContent value="interview" className="flex flex-col gap-3">
        <InterviewPanel questions={interviewQuestions} />
      </TabsContent>

      <TabsContent value="history" className="flex flex-col gap-3">
        <HistoryPanel />
      </TabsContent>
    </Tabs>
  );
}
