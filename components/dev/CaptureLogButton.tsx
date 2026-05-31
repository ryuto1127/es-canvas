"use client";

// =============================================================================
// CaptureLogButton (2026-05-28 dogfood round 3 / 提出ドキュメント支援 — dev 専用)
// =============================================================================
//
// 責務:
//  - 開発モード(localhost)限定で、貯まった AI 出力 capture ログをワンクリックで
//    整形 JSON としてダウンロードする dev 専用フローティングボタン。
//  - 件数表示で「録画中に何件貯まっているか」を可視化(任意機能、安心材料)。
//
// SSOT: docs/dispatch/2026-05-28-capture-utility.md
//       lib/state/analyze_store.ts(captureLog 本体 + getCaptureLog / clearCaptureLog)
//
// 設計判断:
//  1) **production 非 render**: `process.env.NODE_ENV !== "development"` のとき early return
//     null。Next.js のビルド時 dead-code elimination + 実行時 gate の二重防御で、公開版
//     (production)には一切描画されない。store 側 appendCaptureLog も同じ gate を持つため、
//     production では「ログも貯まらない・ボタンも出ない」(dispatch §「公開版には出さない」)。
//  2) **mount 位置はページ root 近く**(`app/[locale]/page.tsx` の <main> 内)。Canvas.tsx や
//     A+B 等の既存コンポーネントを汚さず、衝突を避けるため独立した dev 専用ノードにする
//     (dispatch §「mount 位置は Canvas.tsx ではなく、ページ root 近く」)。
//  3) **件数のリアクティブ更新**: capture は store の結果受領 action(analysisResult を
//     更新する経路)と同期して append される。よって `analysisResult` を購読すれば、結果が
//     来るたびに再 render が走り `getCaptureLog().length` が最新化される。capture バッファ
//     自体は store 外の module-level array(dev 専用・production no-op)なので store field
//     には載せない(prompt/schema/state ロジックに混ぜない方針の維持)。
//  4) **i18n を使わない**: dev 専用ツールのため `messages/*.json`(production i18n)に
//     dev 文言を混ぜない。固定日本語文字列で十分(公開版に出ないため翻訳不要)。
//  5) **保存形式**: pretty JSON(2-space indent)。timestamp / kind / esLabel / input /
//     output を持つエントリの配列。ファイル名は採取時刻入り(録画の連番保存に整合)。
//
// AGENTS.md Inviolable constraints との対応:
//  - localStorage / 永続化なし: Blob ダウンロードのみ(ファイルは OS の DL フォルダに保存、
//    アプリ内 storage は使わない)。
//  - 数値スコア禁止: 表示するのは「採取件数」のみ(品質スコアではない)。

import * as React from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getCaptureLog,
  clearCaptureLog,
  useAnalyzeStore,
} from "@/lib/state/analyze_store";

export function CaptureLogButton() {
  // production では描画もフックも一切走らせない(ビルド時除外 + 実行時 gate)。
  // 注: early return が hooks より前にあるが、本コンポーネントは production で
  // 「常に return null」「development で常に return JSX」と分岐が固定(同一 build 内で
  // 切り替わらない)ため、hooks のルール上の問題は起きない。
  if (process.env.NODE_ENV !== "development") {
    return null;
  }
  return <CaptureLogButtonDev />;
}

function CaptureLogButtonDev() {
  // 結果受領のたびに再 render させて件数を最新化するための購読(値自体は使わない)。
  useAnalyzeStore((s) => s.analysisResult);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  // clear 後など、store 購読では拾えない件数変化を即反映するための強制再 render。
  const [, forceRerender] = React.useReducer((n: number) => n + 1, 0);

  const count = getCaptureLog().length;

  const handleDownload = React.useCallback(() => {
    const entries = getCaptureLog();
    if (entries.length === 0) return;
    const json = JSON.stringify(entries, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    // ファイル名: capture-log-YYYYMMDD-HHMMSS.json(録画の連番保存に整合)
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
      now.getDate(),
    )}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    a.href = url;
    a.download = `capture-log-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setSavedAt(Date.now());
  }, []);

  const handleClear = React.useCallback(() => {
    clearCaptureLog();
    setSavedAt(null);
    // clear 後に件数 0 を即反映するため強制再 render(store 購読では拾えない)
    forceRerender();
  }, []);

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2">
      {/* dev 専用バッジ(公開版には出ない目印) */}
      <span className="rounded-full bg-amber-500/90 px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm">
        DEV
      </span>
      {count > 0 && (
        <button
          type="button"
          onClick={handleClear}
          className="rounded-md border border-border/60 bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm hover:bg-muted"
          title="採取ログを空にする(保存後のリセット用)"
        >
          クリア
        </button>
      )}
      <Button
        type="button"
        variant="default"
        size="sm"
        onClick={handleDownload}
        disabled={count === 0}
        className="shadow-md"
        title="貯まった AI 出力ログを JSON で保存"
      >
        <Download />
        <span>出力ログを保存</span>
        <span className="ml-1 rounded bg-primary-foreground/20 px-1.5 py-0.5 font-mono text-[10px]">
          {count} 件
        </span>
      </Button>
      {savedAt !== null && (
        <span className="rounded-md bg-emerald-600/90 px-2 py-1 text-[11px] font-medium text-white shadow-sm">
          保存しました
        </span>
      )}
    </div>
  );
}
