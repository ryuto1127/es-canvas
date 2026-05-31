// =============================================================================
// i18n navigation API(2026-05-25 Commit 1)
// =============================================================================
//
// 言語切替トグルや内部リンクで「現在の pathname を別 locale に切り替える」時に
// 使う navigation API を集約。`Link` / `useRouter` / `usePathname` / `redirect`
// の locale-aware 版を `i18n/routing.ts` の設定に紐付けて再 export する。
//
// `next/navigation` の API そのままだと localePrefix を勘案できない(en に
// 切り替えたい時に `/en/foo` を明示的に組み立てる必要が出る)。
// next-intl 提供の navigation を使うと `router.replace("/", { locale: "en" })` の
// ように locale を指定するだけで URL が組み立てられる。
//
// 参照: https://next-intl.dev/docs/routing/navigation

import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
