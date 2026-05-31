import type { Metadata } from "next";
import { Geist, Geist_Mono, Noto_Sans_JP } from "next/font/google";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import "../globals.css";
import { routing } from "@/i18n/routing";

// Phase E UI polish:
//  - Geist (ASCII 中心、Linear / Vercel 系の標準) を主軸に
//  - Noto Sans JP (日本語 glyph 補完) を CSS variable で stack に流し込む
//  - 重みは 400 / 500 / 600 / 700 のみ(bundle 重量を抑えつつ heading / body の階層に十分)
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const notoSansJp = Noto_Sans_JP({
  variable: "--font-noto-sans-jp",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

// =============================================================================
// 静的 locale 生成(Next.js 16 + next-intl 4.x)
// =============================================================================
// `[locale]` segment が取りうる値を build 時に列挙して static prerender 対象にする。
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

// =============================================================================
// Metadata — locale 別 title / description
// =============================================================================
// 翻訳キー `meta.title` `meta.description` を引いて返す。
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale, namespace: "meta" });
  return {
    title: t("title"),
    description: t("description"),
  };
}

export default async function RootLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;

  // 無効な locale が URL から流れてきた場合は 404。
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  // server component で `useTranslations` を使う場合に必要(static rendering 対応)
  setRequestLocale(locale);

  return (
    <html
      lang={locale}
      className={`${geistSans.variable} ${geistMono.variable} ${notoSansJp.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
