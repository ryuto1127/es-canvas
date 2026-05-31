// =============================================================================
// i18n routing 設定(2026-05-25 アプリ i18n 対応、Commit 1)
// =============================================================================
//
// next-intl 公式の Next.js 16 App Router セットアップ。本ファイルは locale 一覧 /
// デフォルト locale / URL prefix 戦略を集約する。`middleware.ts` と
// `i18n/request.ts` / 各 client component が本ファイルを参照する。
//
// 設計判断:
//  - `defaultLocale: "ja"` — 日本語デフォルト(ユーザー指示)
//  - `localeDetection: false` — Accept-Language を参照せず、常に日本語デフォルト。
//    英語圏ブラウザのユーザーも初期表示は日本語、明示的に LocaleSwitcher で `/en` に切替可能
//  - `localePrefix: "as-needed"` — デフォルト言語(ja)では prefix なし(`/`)、
//    en の時だけ `/en` を付ける。URL がきれいに保てる + UX 上自然
//  - `locales: ["ja", "en"]` — v1 では 2 言語のみサポート。将来追加可能な構造
//
// 参照: https://next-intl.dev/docs/getting-started/app-router/with-i18n-routing

import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  // サポート言語一覧
  locales: ["ja", "en"] as const,

  // デフォルト言語(`/` でアクセスされた時の初期表示言語)
  defaultLocale: "ja",

  // Accept-Language ヘッダーを参照しない(常に日本語デフォルト)
  // → 英語ブラウザのユーザーも初期は日本語表示、LocaleSwitcher で明示切替
  localeDetection: false,

  // URL prefix 戦略
  //  - "as-needed": ja のとき prefix なし(`/`)、en のとき `/en/...`
  //  - "always":    どちらも `/ja/...` `/en/...`(SEO 厳密)
  // ここでは "as-needed" を採用(URL を `/` のまま保つため)。
  localePrefix: "as-needed",
});

// locale literal union 型(各 client / server component で使う)
export type Locale = (typeof routing.locales)[number];
