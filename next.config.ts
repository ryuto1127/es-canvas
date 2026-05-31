// =============================================================================
// next.config.ts — i18n routing 対応(2026-05-25 Commit 1)
// =============================================================================
//
// next-intl plugin を有効化。`i18n/request.ts` を server 側 entrypoint として
// next-intl が起動時に読み込む(getRequestConfig)。
//
// 参照: https://next-intl.dev/docs/getting-started/app-router/with-i18n-routing#next-config

import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
  /* config options here */
};

export default withNextIntl(nextConfig);
