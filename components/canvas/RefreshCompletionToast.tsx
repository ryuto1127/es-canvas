"use client";

// =============================================================================
// RefreshCompletionToast (v2 dogfood UX 改善 Task C, 2026-05-26)
// =============================================================================
//
// 責務:
//  - partial refresh が正常完了した時に、画面右下に「指摘が更新されました」を
//    3 秒間表示する subtle toast。dogfood で発覚した「partial refresh の完了が
//    視認しづらい」を解消するための短時間 banner 通知。
//
// 設計判断:
//  1) **store の `refreshCompletedAt` (timestamp) を購読** —
//     boolean ではなく number(Date.now())。連続 refresh の 2 回目でも値が
//     変わるため useEffect dependency として確実に再発火、新規 3 秒タイマーを
//     張り直せる(連続 refresh の通知抜け落ちを防ぐ)。
//  2) **shadcn Toast component は未導入** — 独自 `position: fixed` 要素で実装
//     (AnalyzingOverlay pattern 流用)。新規 shadcn 導入は本 dispatch 範囲外
//     (dispatch §「想定外パターン 2」)。
//  3) **3 秒で自動消失** — useEffect + setTimeout(3000ms)で
//     `clearRefreshCompletedAt()` を呼ぶ。手動 dismiss は不要(subtle / read-only
//     の通知、dispatch §「クリック動作: なし」)。
//  4) **暗くしない overlay 不要 / 画面を覆わない subtle スタイル** — dispatch §「スタイル」。
//     bottom-4 right-4 に固定、bg-foreground + text-background で標準的な toast 色、
//     subtle fade-in animation(tailwind animate-in fade-in)。
//  5) **全分析(refresh stream)完了時は表示しない** — store 側で
//     applyPartialResult 経路のみ refreshCompletedAt を set する設計。
//     applyRefreshResult / applyConflictNewVersion では立てない
//     (前者は AnalyzingOverlay 終了で十分、後者はユーザー明示クリック経由のため
//     既に認識済、二重通知回避)。
//
// AGENTS.md Inviolable constraints 遵守確認:
//  - 数値スコア禁止: timestamp は内部 state、UI 表示は文字列メッセージのみ
//  - ES 全面書き換え禁止: 通知のみで store mutation なし(clearRefreshCompletedAt
//    は timestamp を null に戻すだけ、suggestions / accepted 等には touch しない)
//  - すべての操作は Undo 可能: 本 component は通知のみ、ユーザー操作経路を伴わない
//  - 競合通知は中間プレビューステップなし: partial 完了通知であり、競合通知ではない
//    (競合通知は ConflictNotificationBanner が別途担当)
//
// SSOT: lib/state/analyze_store.ts (refreshCompletedAt, clearRefreshCompletedAt)

import * as React from "react";
import { useTranslations } from "next-intl";
import { useAnalyzeStore } from "@/lib/state/analyze_store";
import { CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

// 表示時間(ms)。dispatch §「表示時間」= 3 秒。
const TOAST_DURATION_MS = 3000;

export function RefreshCompletionToast() {
  const t = useTranslations("canvas.refresh_toast");
  const refreshCompletedAt = useAnalyzeStore((s) => s.refreshCompletedAt);
  const clearRefreshCompletedAt = useAnalyzeStore(
    (s) => s.clearRefreshCompletedAt,
  );

  // 3 秒タイマー。refreshCompletedAt が新しい timestamp に変わるたびに新しい
  // setTimeout を張り直す(連続 refresh で正しく延長 / 再表示できる)。
  // cleanup で前のタイマーを必ず clear し、unmount 時 / 次の effect 実行直前の
  // 二重発火を防ぐ。
  React.useEffect(() => {
    if (refreshCompletedAt === null) return;
    const handle = setTimeout(() => {
      clearRefreshCompletedAt();
    }, TOAST_DURATION_MS);
    return () => clearTimeout(handle);
  }, [refreshCompletedAt, clearRefreshCompletedAt]);

  if (refreshCompletedAt === null) {
    return null;
  }

  return (
    <div
      // `fixed` で画面右下に表示、Canvas / 他コンポーネントのレイアウトに影響しない。
      // `z-50` で他 UI 要素より前面、AnalyzingOverlay (z-50) と重なる可能性は
      // 通常ない(partial refresh と initial 分析は時系列で排他)。
      // animate-in / fade-in / slide-in-from-bottom は tailwind の animation utility。
      className={cn(
        "fixed bottom-4 right-4 z-50",
        "flex items-center gap-2 rounded-md px-4 py-2.5 shadow-lg",
        "bg-foreground text-background text-xs",
        "animate-in fade-in-0 slide-in-from-bottom-2 duration-200",
      )}
      role="status"
      // aria-live="polite": スクリーンリーダーが控えめに読み上げ(緊急ではない通知)
      aria-live="polite"
      // refreshCompletedAt は number、re-mount せず animation を活かすため key 不要
    >
      <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
      <span className="text-jp">{t("completed")}</span>
    </div>
  );
}
