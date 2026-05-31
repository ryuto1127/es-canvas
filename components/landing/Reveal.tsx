"use client";

// =============================================================================
// Reveal — scroll-reveal ラッパー(LP 専用、2026-05-29)
// =============================================================================
//
// 役割: 子要素を「最初は透明 + 少し下にずれた状態」で描画し、viewport に入った
// 瞬間に fade + slide-up で現れさせる小さな client component。LP の各セクションを
// これで包むことで、スクロールに応じて段階的にコンテンツが立ち上がる「華やか」な
// 演出を、新規依存なし(IntersectionObserver + CSS transition のみ)で実現する。
//
// 設計判断:
//  - 新規依存禁止のため framer-motion 等は使わない。IntersectionObserver は
//    ブラウザ標準 API。transition は Tailwind の transition utility に委譲。
//  - `prefers-reduced-motion: reduce` を尊重: その場合は最初から「表示済」で、
//    transition を一切かけない(アクセシビリティ、AGENTS.md の reduced-motion
//    方針に整合)。
//  - 一度可視化したら observer を解除(`unobserve`)して再発火させない。下方向
//    スクロールで戻った時に消えると鬱陶しいため、reveal は片道。
//  - `delay` prop で同一セクション内の要素を時間差で立ち上げられる(stagger)。
//  - no-JS / hydration 前は必ず「表示済」markup を出す(SSR は visible)。これにより
//    JS 無効環境でもコンテンツは必ず読める。client mount 後、`requestAnimationFrame`
//    経由で「演出モード(隠す→observe→表示)」へ非同期に引き継ぐ。
//    → effect 本体での同期 setState を避け(cascading render lint 回避)、
//      setState は rAF コールバックと IntersectionObserver コールバック内のみ。

import * as React from "react";

type RevealProps = {
  children: React.ReactNode;
  /** 立ち上がりの遅延(ms)。同一行の複数カードを時間差で出す stagger に使う。 */
  delay?: number;
  /** ラッパに付与する追加クラス(レイアウト用)。 */
  className?: string;
  /** レンダリングするタグ(デフォルト div)。section 等に変えられる。 */
  as?: React.ElementType;
};

export function Reveal({
  children,
  delay = 0,
  className = "",
  as: Tag = "div",
}: RevealProps) {
  const ref = React.useRef<HTMLElement | null>(null);
  // 演出を有効化したか(reduced-motion / no-JS では false のまま = 常に表示)。
  const [animated, setAnimated] = React.useState(false);
  // 演出有効時に「現れた」か。animated=false の間は無視される。
  const [revealed, setRevealed] = React.useState(false);

  React.useEffect(() => {
    const prefersReduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (prefersReduced) return; // 演出なし(初期状態のまま常に表示)

    const node = ref.current;
    if (!node) return;

    // effect 本体での同期 setState を避けるため、次フレームで演出モードへ。
    // この時点でまだ画面内なら observer が即 isIntersecting を返して reveal する。
    const raf = requestAnimationFrame(() => setAnimated(true));

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setRevealed(true);
            observer.unobserve(entry.target);
          }
        }
      },
      // 少し下に入ってきた時点で発火(下端が 12% 見えたら)
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    observer.observe(node);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  // animated=false: 常に表示(reduced-motion / no-JS / mount 直後 1 フレーム)。
  // animated=true & !revealed: 隠す。animated=true & revealed: 現れる。
  const hidden = animated && !revealed;

  return (
    <Tag
      ref={ref}
      style={animated ? { transitionDelay: `${delay}ms` } : undefined}
      className={[
        className,
        animated
          ? "transition-all duration-700 ease-out will-change-transform"
          : "",
        hidden ? "translate-y-6 opacity-0" : "translate-y-0 opacity-100",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </Tag>
  );
}
