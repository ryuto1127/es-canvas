// =============================================================================
// i18n request 設定 — server side message 読み込み(2026-05-25 Commit 1)
// =============================================================================
//
// next-intl が server component / server-side rendering 時に呼び出す entrypoint。
// 受け取った locale に応じて `messages/<locale>.json` を動的 import で読み込む。
//
// 設計判断:
//  - 動的 import を使う(全 locale の json を bundle に固定しない、code splitting 効く)
//  - locale 不正値(URL を直接書き換えた等)は `routing.defaultLocale` に fallback
//  - 旧 `requestLocale` API(v4.x)を使う(next-intl 4.x 標準、`locale` は deprecated)
//
// 参照: https://next-intl.dev/docs/getting-started/app-router/with-i18n-routing#i18n-request

import { getRequestConfig } from "next-intl/server";
import { hasLocale } from "next-intl";
import { routing } from "./routing";

export default getRequestConfig(async ({ requestLocale }) => {
  // requestLocale は `[locale]` segment から自動取得される(middleware が解決済)
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested)
    ? requested
    : routing.defaultLocale;

  return {
    locale,
    // 動的 import で対象 locale の messages を読み込む。
    // tsconfig の `resolveJsonModule: true` が必須(既に設定済)。
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
