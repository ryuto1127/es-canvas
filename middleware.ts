// =============================================================================
// Next.js middleware — i18n routing(2026-05-25 Commit 1)
// =============================================================================
//
// 役割:
//  - URL の locale prefix(`/en/...`)を解決して `[locale]` segment にマップ
//  - `/` (prefix なし)へのアクセスは defaultLocale (ja) に rewrite(localeDetection: false により Accept-Language は参照しない、常に日本語デフォルト)
//  - localePrefix: "as-needed" のため、ja の URL は `/...` のまま、en は `/en/...`
//
// 設計判断:
//  - `matcher` で `/api/*` `/_next/*` `/_vercel/*` 等を除外
//    → API route(`/api/research` `/api/analyze` 等)は locale prefix を持たない
//  - 静的アセット(favicon, images, fonts)も除外
//  - 末尾に `.` を含む path(画像 / フォント等の拡張子付き)も除外
//
// 参照: https://next-intl.dev/docs/routing/middleware

import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

export default createMiddleware(routing);

export const config = {
  // 除外対象: api / _next / _vercel / 拡張子付きファイル(static assets)
  // 含む対象: それ以外のページパス全て
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
