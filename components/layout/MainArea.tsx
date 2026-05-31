"use client";

// =============================================================================
// Phase F UX 改修 1 (2026-05-23): 本体レイアウト切替 — 分析前 vs 分析後
// UX 改修 1b (2026-05-23): 分析前 full 幅 + 編集モードの「戻る」追加
// UX 改修 (2026-05-24): 初回分析中は全画面モーダルオーバーレイで操作 block
// =============================================================================
//
// 責務:
//  - `analyze_store.phase` を購読し、layout を切り替える
//  - 分析前(idle): 入力フォーム単一カラム(全幅 / 中央)
//  - 初回分析中(researching / analyzing): 入力フォームを背後に残し、
//    全画面 `AnalyzingOverlay` で操作を block(2026-05-24 改修)
//  - エラー時(error): 入力フォーム単一カラム + エラー表示
//  - 分析後(done): 上下分割(InputSummaryBar 折りたたみ + ResultPanel = Canvas 主役)
//  - 編集モード(idle かつ editingSnapshot あり): 単一カラム + 「戻る」ボタン
//    + 「分析開始は新規セッション」注釈
//
// 設計判断:
//  1) **server component には phase を購読させない** — page.tsx は server のまま、
//     phase 依存の分岐をこの client component に閉じ込める
//  2) **分析前は単一カラム(全幅)** (UX 改修 1b) — 右側が empty な 2 カラム構成は
//     画面を無駄に消費するため、分析前は入力に集中する単一カラム構成に。
//     IdlePreview は廃止(Canvas / 結果が「何が出るか」を伝える役割は、
//     現実の結果表示が代替する)。
//  3) **初回分析中は全画面オーバーレイで操作 block** (2026-05-24) — 待ち時間に
//     入力フォームの再編集を許すと矛盾 state を生む。`AnalyzingOverlay` を
//     `<MainArea>` の末尾にマウントし、`fixed inset-0 z-50` で背後の入力を
//     構造的に操作不可にする。背後の入力フォームはオーバーレイ越しに薄く見える
//     状態を維持(完全非表示にしない、「今分析している ES が何か」が分かる)。
//     ResultPanel の下部 LoadingDisplay 表示は本改修でオーバーレイに集約。
//  4) **エラー時も単一カラム** — 修正して再分析する文脈で、InputForm を即座に
//     修正可能にする。ErrorDisplay は下部に配置。
//  5) **分析後は上下分割** — Canvas が主役、入力サマリは「畳まれた要約」として上部に置く。
//     ユーザーが入力を修正したくなったら「編集する」ボタンで `startEditingMode` を呼ぶ。
//  6) **編集モードの「戻る」** (UX 改修 1b) — InputForm の上部に「戻る」ボタンを
//     表示。snapshot から完全 restore して done 画面に戻れる。
//  7) **「分析開始」が新規セッションであることの明示** (UX 改修 1b) — 編集モード時、
//     InputForm の上部に小さく注釈(「分析開始は新規セッション。
//     Phase G の再分析(差分のみ)と区別」)を表示。
//
// 全体スクロール統一の核:
//  - この component 自身は `overflow-y-auto` を持たない
//  - 子の InputForm / ResultPanel / InputSummaryBar も独立スクロールを持たない
//  - スクロールは `<body>` / `<main>` 自体に任せる(page.tsx 参照)
//  - オーバーレイ表示中は AnalyzingOverlay が body スクロールを抑止(useEffect 内)
//  - 2026-05-25 (Task #25): phase が "done" に遷移した瞬間に window.scrollTo({ top: 0 }) で
//    ページ最上部に戻す。Next.js App Router の自動 scroll reset は route 遷移時のみで、
//    単一 page + phase 駆動の SPA-like 切替では走らないため、useEffect で明示的にリセット。
//    InputForm を下スクロールした状態から分析開始 → Canvas 切替時にスクロール位置が
//    引き継がれて「画面が少し下にスクロールされた状態で Canvas が始まる」体験を防ぐ。
//
// 「ユーザーは待たない」との整合:
//  - これは動的 HITL(refresh / partial 採用・編集・却下後の更新)に対する原則。
//    初回分析の待ち時間 = まだ結果が無い状態は対象外。
//  - 動的 HITL の refresh 中(refreshPhase === "loading")はオーバーレイを出さない
//    (AnalyzingOverlay は phase が researching / analyzing の時のみ表示する)。
//
// SSOT: lib/state/analyze_store.ts (phase, editingSnapshot, cancelEditingMode)

import * as React from "react";
import { useTranslations } from "next-intl";
import { useAnalyzeStore, isLoadingPhase } from "@/lib/state/analyze_store";
import { InputForm } from "@/components/input/InputForm";
import { ResultPanel } from "@/components/result/ResultPanel";
import { InputSummaryBar } from "@/components/input/InputSummaryBar";
import { AnalyzingOverlay } from "@/components/layout/AnalyzingOverlay";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Info } from "lucide-react";

// 中央配置 + 最大幅。Linear / Notion / ChatGPT Canvas 系の入力画面に近い
// 「中央寄せの一本柱」レイアウト。lg+ で画面が大きくなっても本文域は max-w-3xl に
// 抑え、左右に十分な余白を残す。
const SINGLE_COLUMN_WRAPPER = "mx-auto flex w-full max-w-3xl flex-col gap-6";

// hasServerKey: サーバ env に OpenAI 鍵があるか(server component の page.tsx から
// boolean のみ受け取る)。InputForm の BYOK ヒント出し分け(任意 / 必須)に使う。
export function MainArea({ hasServerKey }: { hasServerKey: boolean }) {
  const t = useTranslations("mainArea");
  const phase = useAnalyzeStore((s) => s.phase);
  const editingSnapshot = useAnalyzeStore((s) => s.editingSnapshot);
  const cancelEditingMode = useAnalyzeStore((s) => s.cancelEditingMode);

  // 編集モード: phase === idle かつ snapshot がある
  const isEditingMode = phase === "idle" && editingSnapshot !== null;
  // 初回分析中: オーバーレイ表示対象(researching / analyzing)
  const isAnalyzing = isLoadingPhase(phase);

  // Task #25 (2026-05-25): phase が "done" に遷移した瞬間に window.scrollTo(0, 0) で
  // ページ最上部に戻す(InputForm を下スクロールした状態で分析開始した場合の引き継ぎ防止)。
  // behavior: "auto" で smooth scroll を避ける(切替の瞬間に動きが見えない方が自然)。
  // previousPhase の useRef で「直前 phase が done でない、かつ今が done」の遷移エッジを検出する。
  const previousPhaseRef = React.useRef(phase);
  React.useEffect(() => {
    if (previousPhaseRef.current !== "done" && phase === "done") {
      if (typeof window !== "undefined") {
        window.scrollTo({ top: 0, behavior: "auto" });
      }
    }
    previousPhaseRef.current = phase;
  }, [phase]);

  // 分析後: 上下分割(入力サマリバー + Canvas 主役)
  if (phase === "done") {
    return (
      <div className="flex flex-col gap-6">
        <InputSummaryBar />
        <ResultPanel />
      </div>
    );
  }

  // それ以外(idle / researching / analyzing / error): 単一カラム(全幅)
  // 編集モード時は「戻る」ボタン + 「分析開始は新規セッション」注釈を InputForm の上に。
  // 初回分析中(researching / analyzing)は背後の入力フォームをそのまま残し、
  // AnalyzingOverlay が全画面でクリックを capture して操作を block する。
  // エラー時のみ下部に ResultPanel(ErrorDisplay)を表示。
  return (
    <>
      <div className={SINGLE_COLUMN_WRAPPER}>
        {isEditingMode && (
          <EditingModeBanner onCancel={() => cancelEditingMode()} />
        )}
        <section aria-label={t("input_section_label")} className="flex flex-col gap-6">
          <InputForm hasServerKey={hasServerKey} />
        </section>
        {/* エラー時のみ ResultPanel(ErrorDisplay)を下部に表示。
            分析中は AnalyzingOverlay に集約したため、下部表示しない。
            idle は InputForm のみを表示し、右側 idle preview は廃止。 */}
        {phase === "error" && (
          <section aria-label={t("status_section_label")} className="flex flex-col gap-6">
            <ResultPanel />
          </section>
        )}
      </div>
      {/* 初回分析中の全画面モーダルオーバーレイ(2026-05-24)
          phase === researching / analyzing の間だけ表示され、背後の入力フォームを
          薄く見せつつクリックを block する。完了 / エラー / idle 復帰でアンマウント。 */}
      {isAnalyzing && <AnalyzingOverlay />}
    </>
  );
}

// =============================================================================
// 編集モードのバナー(「戻る」+ 「分析開始は新規セッション」注釈)
// =============================================================================
// InputForm の上部に表示する。phase === idle かつ editingSnapshot がある時のみ。
function EditingModeBanner({ onCancel }: { onCancel: () => void }) {
  const t = useTranslations("mainArea");
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Info className="size-4 text-primary" />
            <span>{t("editing_mode_title")}</span>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground text-jp">
            {t("editing_mode_description")}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onCancel}
          aria-label={t("editing_mode_back_aria")}
        >
          <ArrowLeft className="size-3" />
          <span>{t("editing_mode_back")}</span>
        </Button>
      </div>
      <p className="rounded-md bg-background/60 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground text-jp">
        {t("editing_mode_note")}
      </p>
    </div>
  );
}
