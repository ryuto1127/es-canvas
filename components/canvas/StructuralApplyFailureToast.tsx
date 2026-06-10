"use client";

// =============================================================================
// StructuralApplyFailureToast (提出後改善 #4, 2026-06-10)
// =============================================================================
//
// 責務:
//  - structural suggestion の採用時に structural_params が現在の本文に適用できなかった
//    (applyStructuralOperationWithStatus が applied=false を返した)とき、画面右下に
//    「この提案は現在の本文には適用できませんでした」を数秒間表示するエラートーン toast。
//
// 背景(2026-06-09 設計レビュー指摘):
//  - 旧実装は不正な段落 index 等の防御的 no-op でも ACCEPTED 記録 + version+1 +
//    履歴 snapshot を行っており、「採用したのに何も変わらないのに対応済みになる」
//    不正直な状態だった。本修正で no-op 時は状態を一切変更せず(suggestion は
//    PENDING のまま)、本 toast でユーザーに正直に通知する。
//
// 設計判断:
//  1) **RefreshCompletionToast の pattern を流用** — store の timestamp
//     (`structuralApplyFailedAt`)を購読し、null 以外なら表示 → タイマー満了で
//     clear action を呼ぶ。number(Date.now())なので連続発生でも useEffect が
//     確実に再発火する(boolean では 2 回目が発火しない)。
//  2) **shadcn Toast component は未導入** — 独自 `position: fixed` 要素
//     (RefreshCompletionToast と同じ)。新規 shadcn 依存追加は本 dispatch 範囲外。
//  3) **エラートーン** — 既存のエラー表示(refresh エラーバナー等)と同じ
//     destructive 系配色 + AlertTriangle icon で「失敗の通知」であることを伝える。
//  4) **5 秒で自動消失** — 完了通知(3 秒)より読む時間が必要なエラーメッセージの
//     ため少し長め。手動 dismiss は不要(状態は何も変わっていない read-only 通知)。
//
// AGENTS.md Inviolable constraints 遵守確認:
//  - 数値スコア禁止: timestamp は内部 state、UI 表示は文字列メッセージのみ
//  - すべての操作は Undo 可能: 本 toast は通知のみ。no-op 経路は store を一切
//    変更しない(undo すべき操作自体が発生していない)
//
// SSOT: lib/state/analyze_store.ts (structuralApplyFailedAt, clearStructuralApplyFailedAt)

import * as React from "react";
import { useTranslations } from "next-intl";
import { useAnalyzeStore } from "@/lib/state/analyze_store";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

// 表示時間(ms)。エラーメッセージは完了通知(3 秒)より読む時間を確保して 5 秒。
const TOAST_DURATION_MS = 5000;

export function StructuralApplyFailureToast() {
  const t = useTranslations("canvas.structural_apply_failed_toast");
  const structuralApplyFailedAt = useAnalyzeStore(
    (s) => s.structuralApplyFailedAt,
  );
  const clearStructuralApplyFailedAt = useAnalyzeStore(
    (s) => s.clearStructuralApplyFailedAt,
  );

  // 5 秒タイマー。structuralApplyFailedAt が新しい timestamp に変わるたびに
  // setTimeout を張り直す(連続発生で正しく再表示できる)。cleanup で前のタイマーを
  // 必ず clear し、unmount 時 / 次の effect 実行直前の二重発火を防ぐ。
  React.useEffect(() => {
    if (structuralApplyFailedAt === null) return;
    const handle = setTimeout(() => {
      clearStructuralApplyFailedAt();
    }, TOAST_DURATION_MS);
    return () => clearTimeout(handle);
  }, [structuralApplyFailedAt, clearStructuralApplyFailedAt]);

  if (structuralApplyFailedAt === null) {
    return null;
  }

  return (
    <div
      // RefreshCompletionToast と同じ fixed 右下配置。両者が同時に出るケースは
      // 実質ない(partial refresh 完了と structural 採用失敗は別操作起点)が、
      // 万一重なっても bottom-4 を共有して上書き表示になるだけで実害はない。
      className={cn(
        "fixed bottom-4 right-4 z-50",
        "flex items-center gap-2 rounded-md px-4 py-2.5 shadow-lg",
        // 既存エラーバナー(Canvas の refresh エラー表示)と同じ destructive 系
        // 配色トーン。fixed toast は背後に本文が透けないよう不透明 bg-card を下地にする。
        "border border-destructive/40 bg-card text-destructive text-xs",
        "animate-in fade-in-0 slide-in-from-bottom-2 duration-200",
      )}
      role="status"
      // aria-live="polite": 緊急の割り込みではない通知(状態は何も変わっていない)
      aria-live="polite"
    >
      <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
      <span className="text-jp">{t("message")}</span>
    </div>
  );
}
