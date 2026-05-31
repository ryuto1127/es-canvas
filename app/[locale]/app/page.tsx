// =============================================================================
// Phase F UX 改修 1 (2026-05-23): アプリ本体ページ — ヘッダーバンド + MainArea
// i18n 対応 (2026-05-25): ヘッダ右上に LocaleSwitcher、文言は useTranslations 経由
// ルート移動 (2026-05-29): `/`(LP 新設)→ アプリ本体は `/app`(ja)/ `/en/app`(en)へ
//   移動。中身・挙動・スタイルは一切変更なし(ルート位置のみの移動)。
// =============================================================================
//
// レイアウト方針(UX 改修 1):
//  - スクロールは **画面全体で 1 つ**(`<main>` 自体が縦スクロール)。
//    左カラム / 右カラムの独立スクロール(`overflow-y-auto`)は廃止。
//  - ヘッダーバンドは sticky(`sticky top-0`)。Canvas や入力フォームが縦に
//    積まれても常にプロダクト名と理念バナーが視認できる。
//  - 本体のレイアウト分岐(分析前は左右 2 カラム / 分析後は上下分割)は
//    `MainArea` という client component に委ねる(store.phase 購読のため)。
//
// `app/[locale]/page.tsx` 自体は server component のまま、layout シェルだけ提供する。
// 文言は `getTranslations` 経由で server side で解決(client hydrate 時のフラッシュなし)。
//
// UX 改修 1 以前の挙動:
//  - 左カラム = InputForm、右カラム = ResultPanel の 2 カラム grid を常時表示
//  - 各カラムは `lg:max-h-[calc(100vh-10rem)] lg:overflow-y-auto` で独立スクロール
//  - ヘッダーは非 sticky(スクロールアウト)
//
// ユーザーフィードバック (2026-05-23):
//  - 「ユーザー入力欄がスクロールしていて、画面全体のスクロールとは別になっている、
//    同じにしたい」→ 独立スクロール廃止
//  - 「分析後に左側で入力欄を表示し続ける必要はあるか?トグル式やまとめて短くしたい」
//    → 分析後は入力サマリバー(折りたたみ)+ Canvas 主役レイアウトに切替(MainArea)

import { getTranslations, setRequestLocale } from "next-intl/server";
import { hasLocale } from "next-intl";
import { notFound } from "next/navigation";
import { MainArea } from "@/components/layout/MainArea";
import { LocaleSwitcher } from "@/components/layout/LocaleSwitcher";
import { ApiKeySettings } from "@/components/layout/ApiKeySettings";
// 2026-05-28(dev 専用): 提出ドキュメント採取用の出力ログ保存ボタン。
// CaptureLogButton 内部で NODE_ENV gate するが、ここでも条件付き render で
// production バンドルから確実に除外する(二重防御、production では非 render)。
import { CaptureLogButton } from "@/components/dev/CaptureLogButton";
import { routing } from "@/i18n/routing";

export default async function Home({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations("header");

  // BYOK ヒント出し分け(2026-05-29): サーバ env に OpenAI 鍵があるかの boolean のみ
  // をクライアントへ渡す(鍵そのものは渡さない = 安全)。
  //  - localhost dev(.env.local に鍵あり)→ true → BYOK は「任意」案内
  //  - 本番デプロイ(env に鍵なし)→ false → BYOK は「必須」案内
  // server component で評価するため SSG では build 時 / dev では runtime に解決され、
  // どちらのケースでも正しい値が prop で初期描画に渡る(hydration mismatch なし)。
  // force-dynamic は付けない(SSG prerender を壊さない)。
  const hasServerKey = !!process.env.OPENAI_API_KEY;

  return (
    <main className="flex min-h-screen flex-col">
      {/* ヘッダーバンド: sticky で常時表示、プロダクト名 + tagline + 言語切替 */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-7xl items-start justify-between gap-4 px-6 py-5 lg:px-8">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline gap-3">
              <h1 className="text-2xl font-bold tracking-tight">
                {t("product_name")}
              </h1>
              <span className="text-xs font-medium text-muted-foreground">
                {t("product_subtitle")}
              </span>
            </div>
            <p className="text-xs text-muted-foreground italic">
              {t("tagline")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ApiKeySettings />
            <LocaleSwitcher />
          </div>
        </div>
      </header>

      {/* 本体: 分析前後で構成切替(client、store.phase を購読)
          全体は画面全体スクロールに参加する(min-h なし、内部 overflow-y-auto なし)。 */}
      <div className="mx-auto w-full max-w-7xl flex-1 px-6 py-8 lg:px-8 lg:py-10">
        <MainArea hasServerKey={hasServerKey} />
      </div>

      {/* dev 専用: AI 出力ログのワンクリック保存ボタン(production では非 render)。
          component 側にも NODE_ENV gate があるが、ここでも条件で確実に除外する。 */}
      {process.env.NODE_ENV === "development" && <CaptureLogButton />}
    </main>
  );
}
