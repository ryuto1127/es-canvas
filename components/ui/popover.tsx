"use client"

// =============================================================================
// Popover ラッパ — @base-ui/react/popover を shadcn 風に薄くラップ
// =============================================================================
//
// 既存の Select / Tabs と同じパターン: @base-ui/react のプリミティブを
// 受けて、Tailwind class を被せたラッパーを作る。追加 npm install は不要
// (`@base-ui/react` は package.json に既に含まれている)。
//
// 構造(shadcn 慣例):
//   Popover (Root)
//     - PopoverTrigger (button)
//     - PopoverContent (PopoverPortal > PopoverPositioner > PopoverPopup)
//
// 設計判断:
//  - Portal は PopoverContent 内に隠す(呼び出し側で意識させない、shadcn と同じ)
//  - side / align / sideOffset は PopoverContent prop で受ける(Positioner に流す)
//  - styling は Select の Content と同じトーン(`bg-popover` + `shadow-md ring-1
//    ring-foreground/10` + open/close アニメーション)に揃える

import * as React from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"

import { cn } from "@/lib/utils"

const Popover = PopoverPrimitive.Root

const PopoverTrigger = PopoverPrimitive.Trigger

function PopoverContent({
  className,
  side = "bottom",
  sideOffset = 6,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<
    PopoverPrimitive.Positioner.Props,
    "side" | "sideOffset" | "align" | "alignOffset"
  >) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        className="isolate z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "relative isolate z-50 w-80 max-w-[calc(100vw-2rem)] origin-(--transform-origin) rounded-lg bg-popover p-4 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none duration-100",
            "data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2",
            "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
            "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverContent }
