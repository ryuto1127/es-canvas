"use client"

// =============================================================================
// Switch ラッパ — @base-ui/react/switch を shadcn 風に薄くラップ
// =============================================================================
//
// 既存の Select / Tabs / Popover と同じパターン。
// Phase F Step 1 では「代替案を表示」トグルとして使用(Canvas 上部、
// alternative ハイライトの可視性制御)。
//
// 構造:
//   Switch (Root, <button role="switch">) > SwitchThumb (<span>)
//
// styling:
//  - data-checked / data-unchecked で背景色を切り替え(primary / muted)
//  - thumb は translate-x で左右移動
//  - focus-visible: ring(shadcn / Tailwind デフォルト準拠)

import * as React from "react"
import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "@/lib/utils"

function Switch({
  className,
  ...props
}: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "data-[checked]:bg-primary data-[unchecked]:bg-muted",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-background shadow ring-1 ring-foreground/10 transition-transform",
          "data-[checked]:translate-x-4 data-[unchecked]:translate-x-0.5",
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
