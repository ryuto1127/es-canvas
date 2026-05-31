"use client";

// =============================================================================
// LandingHeader — LP のヘッダー(2026-05-29 改修1: ヒーローへの溶け込み)
// =============================================================================
//
// 背景・課題:
//  - 旧実装はヘッダーが `bg-background/70 + border-b` の常時不透明寄り背景で、
//    その下のヒーロー animated gradient との間に「白い境目(seam)」ができ、
//    最上部に違和感が出ていた(ユーザーフィードバック 改修1)。
//
// 改修方針:
//  - ページ最上部(スクロール 0)では **完全に透明**(背景なし / border なし)。
//    ヒーローの gradient がヘッダー領域まで連続して見え、境目が消える。
//  - 少しスクロールしたら(scrollY > 8px)微 backdrop(半透明背景 + blur +
//    薄い border)に切り替え、本文の上を流れる際の可読性を確保する。sticky の
//    挙動自体は維持(top-0 z-40)。
//  - transition で透明 ⇄ backdrop を滑らかに(視覚 noise を抑える)。
//
// 設計判断:
//  - scroll 状態に依存するため client component。`passive` リスナーで scroll を
//    監視し、初期値も mount 時に読む(リロード位置がページ途中でも整合)。
//  - 透明状態の初期 SSR markup は「背景なし」で出す。最上部のみが要件の本丸で
//    あり、SSR / 初期描画は scroll 0 = 透明が正(hydration mismatch を出さない)。
//  - prefers-reduced-motion でも本質(透明 ⇄ backdrop の状態切替)は維持しつつ、
//    transition の有無は CSS の transition utility に委ねる(背景色 fade のみで
//    動きの大きいアニメではないため、reduced-motion 配慮としては軽微)。

import * as React from "react";
import { LocaleSwitcher } from "@/components/layout/LocaleSwitcher";

export function LandingHeader() {
  const [scrolled, setScrolled] = React.useState(false);

  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll(); // mount 時の初期位置を反映(ページ途中リロード対応)
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={[
        "sticky top-0 z-40 transition-colors duration-300",
        scrolled
          ? "border-b border-border/40 bg-background/70 backdrop-blur-md"
          : "border-b border-transparent bg-transparent",
      ].join(" ")}
    >
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-4 lg:px-8">
        <div className="flex items-baseline gap-2.5">
          <span className="text-lg font-bold tracking-tight">es-canvas</span>
        </div>
        <LocaleSwitcher />
      </div>
    </header>
  );
}
