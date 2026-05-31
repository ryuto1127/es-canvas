// =============================================================================
// ランディングページ(LP) — `/`(ja)/ `/en`(en)、2026-05-29 新設
// =============================================================================
//
// 背景・構成:
//  - もともと `/` がアプリ本体だったが、アプリを `/app`(ja)/ `/en/app`(en)へ
//    移動し、`/` を製品紹介の LP として新設した(ルート構成: `/` `/en` = LP、
//    `/app` `/en/app` = アプリ本体)。
//  - 本ファイルは server component のシェル。文言は `getTranslations("lp")` で
//    server side 解決(layout の i18n 機構を踏襲、`generateStaticParams` は layout
//    側で既出のため不要)。
//  - locale ガード(`hasLocale` + `notFound` + `setRequestLocale`)はアプリ本体
//    ページと同じパターンで維持。
//
// 演出方針(「華やかめ」要件 / 新規依存なし):
//  - hero は animated gradient(globals.css の lp-animated-gradient)+ ぼかした
//    光彩 blob(lp-float / lp-blob-drift)で奥行きを出す。
//  - 各セクションは <Reveal>(IntersectionObserver ベースの小さな client
//    component)でスクロールに応じて fade + slide-up。stagger は delay prop で。
//  - hover の微モーション(card lift / アイコン色)は Tailwind transition で。
//  - 配色は既存テーマ変数(--primary 等)を流用し、アプリと世界観を統一。
//    華やかさは「動き・グラデ・hover」で出し、色では逸脱しない。
//  - prefers-reduced-motion は globals.css / Reveal 側で尊重。
//
// 注意: 特定企業名・選考に関わる情報は LP に書かない(コピーは汎用フレーミング)。
//       数値スコアも LP に一切出さない(Inviolable constraint)。

import { getTranslations, setRequestLocale } from "next-intl/server";
import { hasLocale } from "next-intl";
import { notFound } from "next/navigation";
import {
  MessageCircleQuestion,
  Building2,
  Fingerprint,
  RefreshCw,
  ClipboardPaste,
  ScanSearch,
  MousePointerClick,
  ArrowRight,
} from "lucide-react";
import { Link } from "@/i18n/navigation";
import { LandingHeader } from "@/components/landing/LandingHeader";
import { Reveal } from "@/components/landing/Reveal";
import { ProblemContrast } from "@/components/landing/ProblemContrast";
import { routing } from "@/i18n/routing";

export default async function LandingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations("lp");

  // how の 3 ステップ(順序固定)。アイコンは server で確定。
  const steps = [
    { icon: ClipboardPaste, titleKey: "how.step1_title", bodyKey: "how.step1_body" },
    { icon: ScanSearch, titleKey: "how.step2_title", bodyKey: "how.step2_body" },
    { icon: MousePointerClick, titleKey: "how.step3_title", bodyKey: "how.step3_body" },
  ] as const;

  // features =「すごいところ」4 本柱(順序固定、2×2 対称グリッド)。
  // f1=個性が消えない / f2=書いていない強みを引き出す / f3=添削が進化する /
  // f4=企業ごとに根拠を持って。アイコンは各柱の意味に対応:
  // Fingerprint=個性、MessageCircleQuestion=逆質問、RefreshCw=作り直し、Building2=企業。
  const features = [
    { icon: Fingerprint, titleKey: "features.f1_title", bodyKey: "features.f1_body" },
    { icon: MessageCircleQuestion, titleKey: "features.f2_title", bodyKey: "features.f2_body" },
    { icon: RefreshCw, titleKey: "features.f3_title", bodyKey: "features.f3_body" },
    { icon: Building2, titleKey: "features.f4_title", bodyKey: "features.f4_body" },
  ] as const;

  return (
    // lp-jp-wrap: LP 配下の文章要素を日本語の文節境界で折り返す(globals.css 参照)。
    // LP root にのみ付与し、アプリ本体 /app には影響させない。
    // lp-page-gradient: ページ全体に 1 枚の連続縦グラデを敷く(継ぎ目を消す、改修
    // 2026-05-29)。各セクションは透明にしてこの背景の上に乗せ、区切りは余白・カード・
    // 見出しで表現する(色ブロックの段差を作らない)。
    <main className="lp-page-gradient lp-jp-wrap flex min-h-screen flex-col">
      {/* ===================================================================
          改修1: 透明 sticky ヘッダー。<main> 直下に置くことでページ全体で sticky
          を維持(挙動を崩さない)。最上部では完全透明で、直後の HERO wrapper の
          gradient がヘッダー領域まで連続して見える(白い境目=seam が消える)。
          スクロール時のみ微 backdrop に切り替わる(LandingHeader 内で制御)。
          =================================================================== */}
      <LandingHeader />

      {/* ===================================================================
          ① HERO — animated gradient + 光彩 blob + shimmer tagline。
          改修1: 透明ヘッダーの真下からではなく、負の上マージン(-mt-16)で
          ヘッダー領域の裏まで gradient を引き上げ、その分 padding-top で本文を
          押し下げる。これでヘッダー背後も hero gradient で埋まり seam が消える。
          連続グラデ化(2026-05-29): ヒーローの animated gradient は連続背景
          (lp-page-gradient)の「濃い最上部」に重なる動きのレイヤーとして残す。
          下端を締める seam div は撤去(ページ全体が連続グラデで流れるため不要)。
          animated gradient は下方向に向けて透明へフェードさせ、連続背景へ溶かす。
          =================================================================== */}
      <div className="relative isolate -mt-[4.5rem] overflow-hidden pt-[4.5rem]">
        {/* animated gradient(動きのある最上部レイヤー)。下端へ向けて mask で
            透明にフェードさせ、連続背景(lp-page-gradient)へなめらかに溶かす。 */}
        <div
          aria-hidden
          className="lp-animated-gradient pointer-events-none absolute inset-0 -z-10 [mask-image:linear-gradient(to_bottom,black_0%,black_45%,transparent_92%)]"
        />
        {/* ぼかした光彩 blob ×2(別位相でドリフト)。 */}
        <div
          aria-hidden
          className="lp-float pointer-events-none absolute -top-24 -left-24 -z-10 size-[30rem] rounded-full bg-primary/30 blur-3xl"
        />
        <div
          aria-hidden
          className="lp-blob-drift pointer-events-none absolute -right-32 top-24 -z-10 size-[28rem] rounded-full bg-primary/[0.18] blur-3xl"
        />

        <section className="mx-auto w-full max-w-6xl px-6 pb-24 pt-12 text-center lg:px-8 lg:pb-32 lg:pt-16">
          <Reveal>
            <p className="lp-shimmer-text mx-auto text-sm font-semibold tracking-wide text-jp-balance sm:text-base">
              {t("hero.tagline")}
            </p>
          </Reveal>

          <Reveal delay={80}>
            <h1 className="mx-auto mt-6 max-w-3xl text-balance text-4xl font-bold leading-tight tracking-tight text-jp-balance sm:text-5xl lg:text-6xl">
              {t("hero.headline")}
            </h1>
          </Reveal>

          <Reveal delay={160}>
            <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground text-jp-flow sm:text-lg">
              {t("hero.sub")}
            </p>
          </Reveal>

          <Reveal delay={240}>
            <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                href="/app"
                className="group inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-7 py-3.5 text-base font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:w-auto"
              >
                {t("hero.cta_primary")}
                <ArrowRight className="size-4 transition-transform duration-200 group-hover:translate-x-1" aria-hidden />
              </Link>
              <a
                href="#how"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-background/60 px-7 py-3.5 text-base font-medium text-foreground backdrop-blur-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:w-auto"
              >
                {t("hero.cta_secondary")}
              </a>
            </div>
          </Reveal>
        </section>
      </div>

      {/* ===================================================================
          ② PROBLEM — Before/After 対比(改修2)。見出し + リードの下に、同じ
          ミニ ES を「ありがちなAI添削」と「es-canvas」で横並びにして課題感を出す。
          連続グラデ化(2026-05-29): セクションの色塗り(bg-muted/50)と border-t を
          撤去して透明にし、連続背景の上に乗せる。区切りは余白(縦 padding)と
          カードで表現する(色ブロックの段差を作らない)。
          帯リズム(2026-05-29): lp-section-tint = 淡(上下フェードする淡い帯)。
          上端・下端は transparent なので隣接セクションとの境目に線ができない。
          =================================================================== */}
      <section className="lp-section-tint">
        <div className="mx-auto w-full max-w-5xl px-6 py-20 lg:px-8 lg:py-28">
          <Reveal>
            <h2 className="text-balance text-center text-2xl font-bold tracking-tight text-jp-balance sm:text-3xl">
              {t("problem.title")}
            </h2>
          </Reveal>
          <Reveal delay={100}>
            <p className="mx-auto mt-5 max-w-2xl text-center text-base leading-relaxed text-muted-foreground text-jp-flow sm:text-lg">
              {t("problem.body")}
            </p>
          </Reveal>
          <Reveal delay={180}>
            <ProblemContrast
              beforeLabel={t("problem.before_label")}
              beforeItems={[
                t("problem.before_1"),
                t("problem.before_2"),
                t("problem.before_3"),
              ]}
              afterLabel={t("problem.after_label")}
              afterItems={[
                t("problem.after_1"),
                t("problem.after_2"),
                t("problem.after_3"),
              ]}
              miniEs={t("problem.mini_es")}
              miniEsHighlight={t("problem.mini_es_highlight")}
            />
          </Reveal>
        </div>
      </section>

      {/* ===================================================================
          ③ HOW — 3 ステップ(stagger reveal)
          連続グラデ化(2026-05-29): セクションのグラデ面 / border-t を撤去して透明化。
          区切りは余白とカード(各ステップ card)で表現する。
          帯リズム(2026-05-29): ここは「素」(tint なし)。連続グラデ(lp-page-gradient)
          のまま流し、前後の淡い帯(課題 / 機能)との「明 → 淡 → 明」の呼吸を作る。
          =================================================================== */}
      <section id="how" className="scroll-mt-20">
        <div className="mx-auto w-full max-w-6xl px-6 py-20 lg:px-8 lg:py-28">
          <Reveal>
            <h2 className="text-center text-2xl font-bold tracking-tight text-jp-balance sm:text-3xl">
              {t("how.title")}
            </h2>
          </Reveal>

          <div className="mt-14 grid gap-8 md:grid-cols-3">
            {steps.map((step, i) => {
              const Icon = step.icon;
              return (
                <Reveal key={step.titleKey} delay={i * 120}>
                  <div className="group relative flex h-full flex-col items-center rounded-2xl border border-border/60 bg-card p-8 text-center shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5">
                    {/* ステップ番号(数値スコアではなく順序の表示)+ アイコン */}
                    <div className="relative mb-5">
                      <span className="absolute -right-2 -top-2 flex size-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                        {i + 1}
                      </span>
                      <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary transition-transform duration-300 group-hover:scale-110">
                        <Icon className="size-7" aria-hidden />
                      </span>
                    </div>
                    <h3 className="text-lg font-semibold tracking-tight text-jp-balance">
                      {t(step.titleKey)}
                    </h3>
                    <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground text-jp-flow">
                      {t(step.bodyKey)}
                    </p>
                  </div>
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      {/* ===================================================================
          ④ FEATURES —「すごいところ」4 本柱(stagger reveal、2×2 対称グリッド)
          再編(2026-05-29): 5 枚 → 4 本柱に整理。本文量が増えたため、3+2 中央寄せの
          非対称配置をやめ、2×2 の対称グリッドに作り替えた(lg=2列 / md=2列 / base=1列)。
          各カードが等幅・等高で並び、4 本柱が均等に立つ。max-w を 5xl に絞って 2 列が
          間延びしないようにする。
          連続グラデ化(2026-05-29): bg-muted/40 / border-t を撤去して透明化。区切りは
          余白と feature card で表現する。
          帯リズム(2026-05-29): lp-section-tint = 淡(上下フェードする淡い帯)。
          =================================================================== */}
      <section className="lp-section-tint">
        <div className="mx-auto w-full max-w-5xl px-6 py-20 lg:px-8 lg:py-28">
          <Reveal>
            <h2 className="text-center text-2xl font-bold tracking-tight text-jp-balance sm:text-3xl">
              {t("features.title")}
            </h2>
          </Reveal>

          <div className="mt-14 grid gap-6 md:grid-cols-2">
            {features.map((feature, i) => {
              const Icon = feature.icon;
              return (
                <Reveal
                  key={feature.titleKey}
                  delay={(i % 2) * 100}
                  className="h-full"
                >
                  <div className="group flex h-full flex-col rounded-2xl border border-border/60 bg-card p-7 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5">
                    <span className="mb-4 flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary transition-all duration-300 group-hover:scale-110 group-hover:bg-primary group-hover:text-primary-foreground">
                      <Icon className="size-6" aria-hidden />
                    </span>
                    <h3 className="text-base font-semibold tracking-tight text-jp-balance">
                      {t(feature.titleKey)}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground text-jp-flow">
                      {t(feature.bodyKey)}
                    </p>
                  </div>
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      {/* ===================================================================
          ⑤ PHILOSOPHY — 製品哲学。左に primary アクセントの縦線、静かな強調。
          連続グラデ化(2026-05-29): bg-muted/60 / border-t を撤去して透明化。
          境目撤去(2026-05-29): テキスト背後の光彩 blob を撤去し、素の連続グラデ
          (lp-page-gradient)の上に直接乗せる。局所的な明るみ(箱状の glow)が
          境目に見える問題を解消する。哲学の温度は左の primary 縦線のみで添える。
          帯リズム(2026-05-29): ここは「素」(tint なし)。前後の淡い帯(機能 / CTA)
          との呼吸を作る。哲学は静かに置きたいので素の連続グラデのままにする。 */}
      <section>
        <div className="mx-auto w-full max-w-3xl px-6 py-24 lg:px-8 lg:py-32">
          <Reveal>
            <div className="relative pl-6">
              <span
                aria-hidden
                className="absolute left-0 top-1 h-[calc(100%-0.25rem)] w-1 rounded-full bg-primary/60"
              />
              <h2 className="text-balance text-2xl font-bold tracking-tight text-jp-balance sm:text-3xl">
                {t("philosophy.title")}
              </h2>
              <p className="mt-6 text-base leading-relaxed text-muted-foreground text-jp-flow sm:text-lg">
                {t("philosophy.body")}
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ===================================================================
          ⑥ FOOTER CTA — 締めの誘導 + 製品名フッタ
          連続グラデ化(2026-05-29): 全面 animated gradient + bg-primary/[0.05] +
          border-t を撤去済。
          境目撤去(2026-05-29): 残っていた光彩 blob(lp-float)も撤去し、ページ下部を
          素の連続グラデ(lp-page-gradient)のなめらかな淡いトーンだけにする。ページ
          下部に帯状の局所的明るみ(境目)が見える問題を解消する。
          帯リズム(2026-05-29): lp-section-tint = 淡(上下フェードする淡い帯)。
          締めの CTA をゆるく持ち上げる。下端は transparent で footer へ溶ける。 */}
      <section className="lp-section-tint">
        <div className="mx-auto w-full max-w-4xl px-6 py-24 text-center lg:px-8 lg:py-28">
          <Reveal>
            <h2 className="mx-auto max-w-2xl text-balance text-3xl font-bold tracking-tight text-jp-balance sm:text-4xl">
              {t("footer.headline")}
            </h2>
          </Reveal>
          <Reveal delay={120}>
            <Link
              href="/app"
              className="group mt-10 inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-8 py-4 text-base font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {t("footer.cta")}
              <ArrowRight className="size-4 transition-transform duration-200 group-hover:translate-x-1" aria-hidden />
            </Link>
          </Reveal>
        </div>
      </section>

      {/* 連続グラデ化(2026-05-29): footer の bg-muted/40 / border-t を撤去して透明化。
          区切りは余白(py-8)のみで表現する。 */}
      <footer className="py-8">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-center px-6 lg:px-8">
          <span className="text-sm text-muted-foreground">es-canvas</span>
        </div>
      </footer>
    </main>
  );
}
