// =============================================================================
// ProblemContrast — 課題セクションの Before/After 対比(2026-05-29 改修2)
// =============================================================================
//
// 背景・課題:
//  - 旧課題セクションは見出し + リード段落だけで「課題感」が乏しかった
//    (ユーザーフィードバック 改修2)。
//
// 改修方針:
//  - 同じミニ ES を「ありがちなAI添削」と「es-canvas」の 2 パネルで横並びにし、
//    見て分かる対比にする(モバイルは縦積み)。
//  - 左(ありがちなAI添削): くすんだ / 赤み寄りトーン。ミニ ES 全文が赤の
//    取り消し線 + 赤塗りで覆われ「丸ごと書き換えられる怖さ」を視覚化。✕ 3 点。
//  - 右(es-canvas): primary 青の鮮やかなトーン。同じミニ ES のうち 1 フレーズ
//    (mini_es_highlight)だけを青ハイライト(下線つき = 実アプリの highlight span
//    に寄せる)。残りは通常テキスト。✓ 3 点。
//  - 中央に矢印(課題 → 解放)を置く。
//  - ラスター画像は使わず HTML/CSS で製品 UI を小さく再現する。
//
// 設計判断:
//  - 文言は server component(page.tsx)側で getTranslations 解決し props で渡す。
//    本コンポーネント自体は純粋な markup(client 不要、SSR で完結)。
//  - ハイライトは mini_es を highlight 部分の前後で split し、中央 span だけ強調。
//    highlight が mini_es の部分文字列であることは messages 側で担保(parity 検証
//    でも substring 含有を確認済み)。万一含まれない異常系では split が空振りし
//    全文を通常テキストとして表示する(防御的フォールバック)。
//  - 配色は既存テーマ変数の範囲内。赤み(destructive 系)は「ありがち AI」の警告
//    トーン、primary 青は es-canvas の世界観。新色は足さない。

import { Check, X, ArrowRight } from "lucide-react";

type ProblemContrastProps = {
  beforeLabel: string;
  beforeItems: readonly [string, string, string];
  afterLabel: string;
  afterItems: readonly [string, string, string];
  miniEs: string;
  miniEsHighlight: string;
};

// mini_es を highlight 部分の前後で 3 分割する。highlight が含まれない異常系では
// [全文, "", ""] を返し、呼び出し側で全文を通常テキスト表示にフォールバックする。
function splitForHighlight(
  text: string,
  highlight: string,
): { before: string; mid: string; after: string } {
  const idx = highlight ? text.indexOf(highlight) : -1;
  if (idx === -1) {
    return { before: text, mid: "", after: "" };
  }
  return {
    before: text.slice(0, idx),
    mid: text.slice(idx, idx + highlight.length),
    after: text.slice(idx + highlight.length),
  };
}

export function ProblemContrast({
  beforeLabel,
  beforeItems,
  afterLabel,
  afterItems,
  miniEs,
  miniEsHighlight,
}: ProblemContrastProps) {
  const { before, mid, after } = splitForHighlight(miniEs, miniEsHighlight);

  return (
    <div className="mt-12 lg:mt-16">
      <div className="grid items-stretch gap-6 md:grid-cols-[1fr_auto_1fr] md:gap-4 lg:gap-6">
        {/* ===== 左パネル: ありがちなAI添削(赤み・くすみトーン) ===== */}
        <div className="flex flex-col rounded-2xl border border-destructive/25 bg-destructive/[0.04] p-6 shadow-sm lg:p-7">
          <div className="mb-4 flex items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded-full bg-destructive/15 text-destructive">
              <X className="size-3.5" aria-hidden />
            </span>
            <span className="text-sm font-semibold text-destructive/90">
              {beforeLabel}
            </span>
          </div>

          {/* ミニ ES: 全文が赤の取り消し線 + 赤塗りで覆われる = 丸ごと書き換え */}
          <div className="rounded-xl border border-destructive/20 bg-background/60 p-4">
            <p className="text-[0.9rem] leading-relaxed text-jp-flow">
              <span className="bg-destructive/15 text-muted-foreground line-through decoration-destructive/70 decoration-2 [text-decoration-skip-ink:none]">
                {miniEs}
              </span>
            </p>
          </div>

          <ul className="mt-5 space-y-2.5">
            {beforeItems.map((item) => (
              <li
                key={item}
                className="flex items-start gap-2 text-sm text-muted-foreground text-jp-flow"
              >
                <X
                  className="mt-0.5 size-4 shrink-0 text-destructive/70"
                  aria-hidden
                />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* ===== 中央: 課題 → 解放 の矢印(モバイルでは縦向き相当に回転) ===== */}
        <div
          className="flex items-center justify-center md:px-1"
          aria-hidden
        >
          <span className="flex size-9 items-center justify-center rounded-full border border-border/60 bg-background text-muted-foreground shadow-sm">
            <ArrowRight className="size-4 rotate-90 md:rotate-0" />
          </span>
        </div>

        {/* ===== 右パネル: es-canvas(primary 青・鮮やかトーン) ===== */}
        <div className="flex flex-col rounded-2xl border border-primary/30 bg-primary/[0.04] p-6 shadow-sm shadow-primary/5 lg:p-7">
          <div className="mb-4 flex items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded-full bg-primary/15 text-primary">
              <Check className="size-3.5" aria-hidden />
            </span>
            <span className="text-sm font-semibold text-primary">
              {afterLabel}
            </span>
          </div>

          {/* ミニ ES: 1 フレーズだけ青ハイライト(下線つき = 実アプリの highlight span) */}
          <div className="rounded-xl border border-primary/15 bg-card p-4">
            <p className="text-[0.9rem] leading-relaxed text-foreground text-jp-flow">
              {before}
              {mid && (
                <span className="rounded-sm bg-primary/15 px-0.5 text-primary underline decoration-primary/60 decoration-2 underline-offset-4">
                  {mid}
                </span>
              )}
              {after}
            </p>
          </div>

          <ul className="mt-5 space-y-2.5">
            {afterItems.map((item) => (
              <li
                key={item}
                className="flex items-start gap-2 text-sm text-foreground/80 text-jp-flow"
              >
                <Check
                  className="mt-0.5 size-4 shrink-0 text-primary"
                  aria-hidden
                />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
