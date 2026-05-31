"use client";

// =============================================================================
// AnalyzingOverlay — 初回分析中の全画面モーダルオーバーレイ (2026-05-24)
// =============================================================================
//
// 責務:
//  - 初回分析(researching / analyzing)中だけ、画面全体を覆うオーバーレイを表示
//  - 入力フォーム / Canvas の操作を構造的に block(pointer-events で受け止め)
//  - 「企業情報を収集中 → ES を分析中」の段階表示で「動いている」を強く伝える
//  - 既存 LoadingDisplay(Card 形式の下部表示)を本コンポーネントに集約
//
// UX 改修(2026-05-24): 待ち時間体感改善 — agent の動きをもっと細かく見せる。
//  - A. analyzing 中の streamingStage 連動文言を「LLM が何をしているか」が
//       想像できる粒度に書き直す。
//  - E. researching 中の文言を時間経過で段階的に切り替え(0-5s / 5-15s / 15s+)。
//       /api/research が POST 一括返却で SSE event を流さないため、SSE 化は
//       本改修の範囲外。代わりに「実時間ベースの fake-but-truthful な段階表示」
//       で「動いている」を体感させる方針(dispatch E-1 で縮小判断)。
//  - 2026-05-24 追補: initial model を Opus 4.7 → Sonnet 4.6 に切替(DECISIONS 同日)。
//    UI 文言を Sonnet 4.6 に整合。streamingStage の "thinking" case は Sonnet では
//    現状到達しないが、将来の adaptive thinking 第 2 段階導入時に復活するため case は残し、
//    文言だけ adaptive thinking 非依存に書き換え。
//  - 2026-05-25 統合改修パッケージで provider 完全統一(OpenAI GPT-5.4 採用、DECISIONS 同日)。
//    UI 文言は GPT-5.4 で整合済(messages/{ja,en}.json analyzing.* 配下)。本コメント内の
//    モデル名は LLM / GPT-5.4 に揃え、過去の Sonnet 4.6 経由経緯は経緯記録として残置。
//
// 設計判断:
//  1) **初回分析 (researching / analyzing) のみ表示** — refresh / partial の動的 HITL は
//     楽観的並行制御の対象で、ユーザー操作を block しない(AGENTS.md「ユーザーは待たない」
//     は動的 HITL 原則。初回分析の待ち時間 = 結果が無い状態 = 対象外)。
//  2) **shadcn Dialog ではなく独自 fixed 要素** — Radix UI / 新規依存追加を避け、
//     最小 surface area。aria-modal + role=dialog で a11y を担保、Escape は意図的に
//     handle しない(分析を途中で破棄する経路は現状 UI 上存在せず、誤操作で消えると
//     混乱する)。
//  3) **streamingStage に応じた段階表示** — researching → analyzing(started → thinking
//     → generating → retrying → finalizing)で文言を切り替え。analyzing 文言は
//     「AI 動作の透明性」と整合した粒度に再設計(2026-05-24 改修)。
//  4) **進捗段階リスト** — 「企業情報収集中」「ES 分析中」の 2 段を縦に並べ、現在の
//     段階を強調(primary 色 + Loader2 spin)、完了済みは muted(チェックマーク icon)。
//     ユーザーが「今どこにいるか」を一目で把握できる。
//  5) **researching 中の段階詳細(2026-05-24 追加)** — 経過秒で文言が切り替わる。
//     初回分析の研究フェーズは典型 20-60 秒、ユーザーの体感としては「ずっと同じ表示」
//     になりがちなのを避ける。SSE で実際の tool action は流れていないが、研究
//     エージェントの典型挙動(初期 fetch → web_search → 派生 fetch → 合成)に
//     即した文言で「進んでいる感」を持たせる。
//  6) **背後の入力フォーム / Canvas は透過 + 操作不可** — `fixed inset-0` で全画面を
//     覆い、`bg-background/80 backdrop-blur-sm` で背後を薄く見せる。クリックは
//     オーバーレイ自身が capture(`pointer-events-auto`)。
//  7) **body スクロール抑止** — オーバーレイ表示中は背後のスクロールを止める。useEffect で
//     `document.body.style.overflow = "hidden"` を立て、cleanup で復元。
//  8) **日本語向け改行(2026-05-24 追加)** — 主要テキスト要素に `text-jp` /
//     `text-jp-balance` を適用、break-keep + balance で読み心地を改善。
//
// AGENTS.md Inviolable constraints との対応:
//  - 数値スコア禁止: token_usage や priority の数値は一切出さない、段階文言のみ
//  - ユーザーは待たない: 動的 HITL(refresh / partial)は block しない(本コンポーネントは
//    isLoadingPhase が true の時 = 初回分析中のみマウント)
//  - すべての操作は Undo 可能: 本コンポーネント自体は操作を提供しない(表示のみ)
//
// SSOT: lib/state/analyze_store.ts (AnalyzePhase, StreamingStage, isLoadingPhase)

import * as React from "react";
import { useTranslations } from "next-intl";
import { useAnalyzeStore, type StreamingStage } from "@/lib/state/analyze_store";
import { CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// -----------------------------------------------------------------------------
// streamingStage に応じた文言(analyzing フェーズ)
// -----------------------------------------------------------------------------
// 2026-05-24 改修(2026-05-25 GPT-5.4 整合): 「LLM が何をしているか」を想像しやすい
// 粒度に再設計。旧版は「AI が考えています」のような generic 表現が中心だったが、
// agent の動きをもっと細かく見せたいユーザー要求に応える形に切替。
// i18n (2026-05-25): 文言は messages/<locale>.json analyzing.analyzing_stage 配下に
// 移行。stage の switch は文字列 key 解決の関数に変換。
//
// 設計:
//  - primary: 短く動詞中心、状態の進行が一目でわかる
//  - detail: 「いま AI が何を見て / 何をしているか」を平易に説明
//  - retrying は positive 表現(検証 fail は内部実装で、ユーザーには「精度向上」)
type AnalyzingStageMessage = { primary: string; detail: string };

function useAnalyzingStageMessage(stage: StreamingStage): AnalyzingStageMessage {
  const t = useTranslations("analyzing.analyzing_stage");
  const key = stage ?? "null";
  return {
    primary: t(`${key}_primary`),
    detail: t(`${key}_detail`),
  };
}

// -----------------------------------------------------------------------------
// researching フェーズの時間経過ベース段階表示 (2026-05-24 追加)
// -----------------------------------------------------------------------------
// /api/research は POST 一括返却で SSE event を流さないため、本物の tool action
// を取得する経路は無い(SSE 化は本改修の範囲外、dispatch E-1 で縮小判断)。
// 代わりに「研究エージェントの典型挙動(初期 fetch → web_search → 派生 fetch
// → 合成)に即した文言を、経過秒で段階的に切り替える」方針。
//
// 段階:
//   - 0〜5s    : 「企業の公式 HP を取得しています」
//                (URL 入力経路: server side で先に extractFromUrl が走る初期 fetch)
//   - 5〜15s   : 「採用方針・価値観の引用を整理しています」
//                (LLM round-trip + web_search ~ fetch_page の中盤、典型ピーク)
//   - 15s 以上  : 「引用元を確認して企業要約を組み立てています」
//                (合成 + Zod 検証フェーズ、長尾)
//
// fake progress と呼べばそうだが、研究エージェントの実挙動と整合しているため
// truthful な「進んでいる感」になる。SSE で実時間を流せない制約下の妥協。
type ResearchPhase = "fetching_hp" | "extracting_values" | "synthesizing";

function useResearchingStageMessage(phase: ResearchPhase): {
  primary: string;
  detail: string;
} {
  const t = useTranslations("analyzing.researching");
  return {
    primary: t(`${phase}_primary`),
    detail: t(`${phase}_detail`),
  };
}

// -----------------------------------------------------------------------------
// 進捗段階リスト(researching → analyzing)
// -----------------------------------------------------------------------------
// 各段階の見え方:
//   - "current": primary 色 + Loader2 アニメ(現在進行中)
//   - "done":    muted + CheckCircle2(完了済み、researching 完了後の analyzing 中)
//   - "pending": muted + 空の丸枠(まだ来ていない、analyzing 中の next 段は無いので未使用)
//
// researching 中: stage[0] = current, stage[1] = pending
// analyzing 中  : stage[0] = done,    stage[1] = current
type StageStatus = "current" | "done" | "pending";

function StageRow({
  status,
  label,
  detail,
}: {
  status: StageStatus;
  label: string;
  detail: string;
}) {
  return (
    <li
      className={cn(
        "flex items-start gap-3 rounded-md border px-3 py-2.5 transition-colors",
        status === "current" &&
          "border-primary/40 bg-primary/5",
        status === "done" && "border-border/60 bg-muted/40",
        status === "pending" && "border-border/40 bg-background/40",
      )}
    >
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
        {status === "current" && (
          <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
        )}
        {status === "done" && (
          <CheckCircle2
            className="size-4 text-muted-foreground"
            aria-hidden
          />
        )}
        {status === "pending" && (
          <span
            className="size-3 rounded-full border border-border"
            aria-hidden
          />
        )}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p
          className={cn(
            "text-sm font-medium leading-snug text-jp-balance",
            status === "current" && "text-foreground",
            status === "done" && "text-muted-foreground",
            status === "pending" && "text-muted-foreground/80",
          )}
        >
          {label}
        </p>
        <p
          className={cn(
            "text-xs leading-relaxed text-jp",
            status === "current" && "text-muted-foreground",
            status === "done" && "text-muted-foreground/80",
            status === "pending" && "text-muted-foreground/60",
          )}
        >
          {detail}
        </p>
      </div>
    </li>
  );
}

// -----------------------------------------------------------------------------
// AnalyzingOverlay (top-level)
// -----------------------------------------------------------------------------
// 表示条件:
//   - phase === "researching" or "analyzing" の時のみマウント
//   - それ以外の phase(idle / done / error)では何も返さない(null)
//
// MainArea が phase を購読してオーバーレイをマウントする経路にしているため、
// 本コンポーネント自体は「常に loading 中である前提」で動く(内部で再度 phase を
// 購読し直して null 返しの保険を入れる二段構え)。
export function AnalyzingOverlay() {
  const t = useTranslations("analyzing");
  const phase = useAnalyzeStore((s) => s.phase);
  const streamingStage = useAnalyzeStore((s) => s.streamingStage);

  const isResearching = phase === "researching";
  const isAnalyzing = phase === "analyzing";
  const visible = isResearching || isAnalyzing;

  // -----------------------------------------------------------------------------
  // researching 中の経過秒トラッキング (2026-05-24 追加)
  // -----------------------------------------------------------------------------
  // researching 開始時刻を記録し、setInterval(1000ms)で elapsed を更新。
  // analyzing に遷移したら interval を止める。
  //
  // 設計:
  //  - elapsed は秒単位の整数。研究フェーズ判定にのみ使う(値は isResearching が
  //    true の時だけ意味を持つ。false の時は研究フェーズ判定自体が走らないので
  //    elapsed の reset は不要)。
  //  - 研究フェーズ判定は isResearching が true の間だけ行う(下記の researchPhase
  //    計算が isResearching ガード下で動く)。
  //  - effect 内で setState を同期的に呼ばない設計(react-hooks/set-state-in-effect
  //    回避): isResearching が false→true に遷移した瞬間に新しい interval が立ち、
  //    最初の tick(1 秒後)で elapsed が 1 になる。0 秒時点は state の初期値
  //    (= 前回 researching の最終値 or 初期 0)が反映されるが、次の判定上限
  //    (5 秒)未満なので fetching_hp が正しく表示される。
  //  - 厳密には「前回 researching で 15 秒以上経過 → 一旦 analyzing → 再度
  //    researching」の特殊シナリオで一瞬「合成中」と表示される可能性があるが、
  //    実際の動線で researching が 2 回走るケースは存在しない(initial 分析の
  //    1 回のみ)ため許容。
  const [elapsed, setElapsed] = React.useState(0);
  React.useEffect(() => {
    if (!isResearching) return;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [isResearching]);

  // 経過秒から researching 段階を決定。isResearching が false の時は表示に
  // 使わないので値の精度は問わない(下の heading で isResearching ガード下で
  // のみ参照される)。
  const researchPhase: ResearchPhase =
    elapsed < 5
      ? "fetching_hp"
      : elapsed < 15
        ? "extracting_values"
        : "synthesizing";

  // body スクロール抑止: オーバーレイ表示中は背後を完全に止める。
  // cleanup で復元(初回分析以外の経路でアンマウントされたら必ず戻す)。
  React.useEffect(() => {
    if (!visible) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [visible]);

  // 中央カードの primary 文言 / detail:
  //  - researching 中: 経過秒に応じた段階文言(2026-05-24 改修)
  //  - analyzing 中: streamingStage 連動文言
  // React の規律: hooks は早期 return より前に必ず呼ぶ。visible が false でも hook 自体は実行する。
  const researchingMessage = useResearchingStageMessage(researchPhase);
  const analyzingMessage = useAnalyzingStageMessage(streamingStage);

  if (!visible) {
    return null;
  }

  // 段階 1: 企業情報収集(researching の間 current、analyzing 以降 done)
  const stage1Status: StageStatus = isResearching ? "current" : "done";
  // 段階 2: ES 分析(researching 中 pending、analyzing 中 current)
  const stage2Status: StageStatus = isAnalyzing ? "current" : "pending";

  const heading = isResearching ? researchingMessage : analyzingMessage;

  // 段階リストの detail も researching 中は経過秒の動的文言で上書き
  // (StageRow 内の固定 detail を上書きし、リスト上でも進行を感じられるように)
  const stage1Detail = isResearching
    ? researchingMessage.detail
    : t("stage1_done_detail");

  // 段階リストの段階 2 detail も analyzing 中は streamingStage 連動の detail で
  // 表示(中央カードと重複するが、ユーザーが「リストの今いる段階を見たい」場合
  // にも理解できるように同じ情報を冗長表示)
  const stage2Detail = isAnalyzing
    ? analyzingMessage.detail
    : t("stage2_pending_detail");

  return (
    <div
      // fixed inset-0 で全画面を覆う。z-50 でヘッダー(z-40)より前面、
      // backdrop-blur-sm + bg-background/80 で背後を薄く見せる(完全非表示にしない)。
      // pointer-events-auto を明示し、背後へのクリック通過を防ぐ(default で auto だが
      // 意図を明示)。
      role="dialog"
      aria-modal="true"
      aria-labelledby="analyzing-overlay-heading"
      aria-describedby="analyzing-overlay-detail"
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8 bg-background/80 backdrop-blur-sm pointer-events-auto"
    >
      <div
        // 中央カード。max-w-md で読み心地を保ち、shadcn Card 風のスタイルを直書きで再現
        // (新規依存を避け、最小 surface area)。
        className={cn(
          "flex w-full max-w-md flex-col gap-5",
          "rounded-xl border border-border/70 bg-card text-card-foreground",
          "p-6 shadow-2xl",
        )}
      >
        {/* ヘッダー: 大きめスピナー + 見出し + 補足 */}
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
            <Loader2 className="size-6 animate-spin text-primary" aria-hidden />
          </div>
          <h2
            id="analyzing-overlay-heading"
            className="text-lg font-semibold tracking-tight text-jp-balance"
          >
            {heading.primary}
          </h2>
          <p
            id="analyzing-overlay-detail"
            className="text-sm leading-relaxed text-muted-foreground text-jp"
          >
            {heading.detail}
          </p>
        </div>

        {/* 進捗段階リスト */}
        <ul
          aria-label={t("list_aria")}
          className="flex flex-col gap-2"
        >
          <StageRow
            status={stage1Status}
            label={t("stage1_label")}
            detail={stage1Detail}
          />
          <StageRow
            status={stage2Status}
            label={t("stage2_label")}
            detail={stage2Detail}
          />
        </ul>

        {/* 補足: 操作不可の明示 */}
        <p className="text-center text-xs text-muted-foreground/80 text-jp-balance">
          {t("footer_note")}
        </p>
      </div>
    </div>
  );
}
