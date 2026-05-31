"use client"

// =============================================================================
// Collapsible ラッパ — @base-ui/react/collapsible を shadcn 風に薄くラップ
// =============================================================================
//
// 既存の Popover / Switch / Tabs と同じパターン: @base-ui/react のプリミティブを
// 受けて、Tailwind class を被せたラッパーを作る。追加 npm install は不要
// (`@base-ui/react` は package.json に既に含まれている)。
//
// 構造(shadcn 慣例):
//   Collapsible (Root) — open / defaultOpen / onOpenChange props
//     - CollapsibleTrigger (button、aria-expanded / data-state を自動付与)
//     - CollapsibleContent (open=false で `display: none`、open=true で展開)
//
// 設計判断:
//  - CollapsibleContent は base-ui の Panel をそのまま流す(高さアニメーションは
//    base-ui が CSS 変数 `--collapsible-panel-height` で提供。本ラッパでは
//    `data-[state=open]:animate-in` / `data-[state=closed]:animate-out` を
//    かぶせるだけで、アニメ詳細はプリミティブに委ねる)
//  - Trigger は呼び出し側でアイコン込みの自前の button を render する想定
//    (Popover Trigger と同じ、shadcn 慣例)
//
// 使用例:
//   <Collapsible open={open} onOpenChange={setOpen}>
//     <CollapsibleTrigger render={<button>...</button>} />
//     <CollapsibleContent>...</CollapsibleContent>
//   </Collapsible>

import * as React from "react"
import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible"

import { cn } from "@/lib/utils"

const Collapsible = CollapsiblePrimitive.Root

const CollapsibleTrigger = CollapsiblePrimitive.Trigger

function CollapsibleContent({
  className,
  children,
  ...props
}: CollapsiblePrimitive.Panel.Props) {
  // base-ui の Collapsible.Panel は `data-open` / `data-closed` 属性を提供し、
  // `--collapsible-panel-height` CSS 変数で展開時の高さを公開する。
  // hidden=until-found による検索可能折りたたみは base-ui 側のデフォルトに任せる。
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-content"
      className={cn(
        "overflow-hidden",
        "data-open:animate-in data-open:fade-in-0",
        "data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    >
      {children}
    </CollapsiblePrimitive.Panel>
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
