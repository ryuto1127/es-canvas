"use client";

// =============================================================================
// LocaleSwitcher — 言語切替トグル(2026-05-25 アプリ i18n 対応、Commit 4)
// =============================================================================
//
// 役割: ヘッダ右上の言語切替ドロップダウン。日本語 / English の 2 択。
//
// 設計判断:
//  - shadcn の `<Select>`(base-ui ベース)を使う — A11y(キーボード操作 / ARIA)
//    を base-ui に委譲、追加実装不要
//  - 切替時は `router.replace(pathname, { locale })` で同じ pathname のまま locale
//    だけ切り替える(現在の画面を維持)
//  - 切替直前と直後で同じ locale を選んだ場合は何もしない(無駄な遷移を避ける)
//  - `useTransition` で切替中の pending state を保持し、disabled にする
//  - base-ui Select の onValueChange は `(value: Value | null, ...details) => void`
//    なので null をガードし、型を `(value: string | null) => void` に揃える
//
// SSOT: i18n/routing.ts (locales), i18n/navigation.ts (usePathname / useRouter)

import * as React from "react";
import { Languages } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing, type Locale } from "@/i18n/routing";

export function LocaleSwitcher() {
  const t = useTranslations("localeSwitcher");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = React.useTransition();

  function handleChange(value: string | null) {
    if (value === null) return;
    // 同じ locale を選んだ場合は no-op
    if (value === locale) return;
    if (!routing.locales.includes(value as Locale)) return;
    const next = value as Locale;
    startTransition(() => {
      // localePrefix: "as-needed" を尊重するために、router.replace に locale option
      // だけ渡せば next-intl 側で prefix の有無を補正してくれる(現 pathname は
      // localized prefix を除いた純粋なパス、`/` 等)
      router.replace(pathname, { locale: next });
    });
  }

  return (
    <Select
      value={locale}
      onValueChange={handleChange}
      disabled={isPending}
    >
      <SelectTrigger
        aria-label={t("aria_label")}
        className="h-8 w-fit gap-1.5 px-2.5 text-xs"
      >
        <Languages className="size-3.5" aria-hidden />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {routing.locales.map((loc) => (
          <SelectItem key={loc} value={loc} className="text-xs">
            {t(loc)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
