"use client";

// =============================================================================
// Phase G Step 3a: SuggestionCard — リスト型 UI 用 inline block (F1.3 上書き)
// =============================================================================
//
// 役割(Step 3a 改修後):
//  - SuggestionListPanel 内で **inline で表示される** suggestion 1 件の詳細 + アクション
//  - 過去(F1.3): PopoverContent 内に renderされていた。Step 3a で Popover ラップを撤廃。
//  - 双方向ハイライト: 自身のカードに onMouseEnter/Leave、selected/hovered の視覚区別。
//
// 表示内容(変更なし):
//  1. カテゴリ Badge(色分け) + 指摘 ID(monospace 小) + status Badge
//  2. 元の表現(<blockquote>)
//  3. 提案表現(強調)
//  4. 根拠(rationale, 1〜3 文)
//  5. 根拠ソース(type + reference + URL [company_value のみ] + evidence_id [optional])
//  6. 代替案配列(alternative カテゴリのみ)
//  7. 関連指摘 ID(badge 列、UX 改修 3a で clickable navigate + 被り注意 alert、Step 3a 維持)
//  8. アクションフッタ: [採用] [編集して採用] [却下](status に応じて変化)
//  9. 編集して採用クリック時: inline Textarea + [保存] [取消]
//
// Step 3a の設計判断(F1.3 を上書き):
//  - Popover を廃止し、リスト内で常時 inline 表示。これにより同時に全 suggestion を
//    視認できる(ChatGPT Canvas / Notion AI のリスト方式と整合)。
//  - selected (クリック): 明確な ring + 強いアクセント、related navigation の到達点。
//    border-l(category アクセント、太め)+ primary 色の ring。scroll into view あり。
//  - hovered (hover): subtle な強調、border 色を強めるのみ。scroll into view なし。
//  - selected / hovered は別 state、両立可能(両方真なら selected の見た目が優先)。
//  - クリックでカード自身が選択され、Canvas 内ハイライトも同期で強調される
//    (Canvas 側が selectedSuggestionId を購読しているため)。
//  - related_suggestion_ids クリックは selectSuggestion(rid) で同一動作
//    (該当ブロックの ring + scroll into view が走る)。UX 改修 3a の経路を維持。
//
// AGENTS.md Inviolable constraints:
//  - 数値スコア禁止: 表示にスコアは出さない
//  - ES 全面書き換え禁止: 個別カード単位のアクションのみ。「全採用」「全却下」は無い
//  - すべての操作は Undo 可能: 操作後の取り消しは Canvas 上部 Undo ボタンから
//  - 競合通知 / 楽観的並行制御: Phase G Step 2 で実装済、Step 3a で機能不変
//
// SSOT: lib/schema/suggestion.ts (Suggestion, RationaleSource),
//       lib/state/analyze_store.ts (acceptSuggestion, rejectSuggestion, editSuggestion,
//         selectSuggestion, setHoveredSuggestion, hoveredSuggestionId)

import * as React from "react";
import { useTranslations } from "next-intl";
import type {
  Category,
  RationaleSource,
  StructuralOperationParams,
  Suggestion,
} from "@/lib/schema/suggestion";
// 2026-05-27 エージェント的対話(AI 逆質問): SuggestionCard inline 質問 + 回答 UI で
// 質問本文と回答 state を扱うため import。
import type { ClarificationQuestion } from "@/lib/schema/clarification";
import { clarificationIdentity } from "@/lib/schema/clarification";
import { EVIDENCE_SOURCE_USER_INPUT } from "@/lib/schema/company";
import { useAnalyzeStore } from "@/lib/state/analyze_store";
import { applyStructuralOperation } from "@/lib/state/structural_ops";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Check, ChevronRight, HelpCircle, Info, Link2, Loader2, Pencil, Shuffle, Undo2, X } from "lucide-react";

// selector 内で `?? []` を評価すると毎 render 新参照になり Zustand の getSnapshot 等価判定を
// すり抜けて無限再レンダーになる(ClarificationSection 2026-05-28 事故と同一クラス)。
// 既定値は module レベルの安定参照を使い、?? は hook 戻り値側(selector の外)で適用する。
const EMPTY_SUGGESTIONS: Suggestion[] = [];

const CATEGORY_BADGE_CLASS: Record<Category, string> = {
  // error は destructive 色を直接当てる(Badge variant=destructive と等価のトーン)
  error: "border-destructive/40 bg-destructive text-destructive-foreground",
  // convention は amber
  convention:
    "border-amber-500/40 bg-amber-200/80 text-amber-900 dark:bg-amber-800/40 dark:text-amber-100",
  // alternative は blue subtle
  alternative:
    "border-blue-400/40 bg-blue-200/60 text-blue-900 dark:bg-blue-800/40 dark:text-blue-100",
  // v2 Phase B4 (2026-05-26): structural 専用 badge 色 — purple 系 subtle。
  // 設計判断: error(destructive)/ convention(amber)/ alternative(blue)と
  // 直交した色軸を選ぶことで「文単位指摘」と「段落 / 文構造の操作」を視覚で
  // 即時識別できる。violet/purple は「再構成 / 再配置」感を伝える慣用色
  // (Notion AI の構造変更プロンプト等で同系統が使われる)。
  structural:
    "border-purple-400/40 bg-purple-200/60 text-purple-900 dark:bg-purple-800/40 dark:text-purple-100",
};

// Phase G Step 3a: カテゴリ別の左 accent border 色(リストカードの category 色アクセント)
// Canvas 内のハイライト色と整合する subtle アクセント。selected/hovered とは別軸。
// v2 Phase B4 (2026-05-26): structural は CATEGORY_BADGE_CLASS と整合する purple 系。
const CATEGORY_ACCENT_BORDER_CLASS: Record<Category, string> = {
  error: "border-l-destructive/70",
  convention: "border-l-amber-500/70",
  alternative: "border-l-blue-400/70",
  structural: "border-l-purple-400/70",
};

// 1 行サマリ作成: ActionHistoryEntry.suggestion_summary に流す簡潔表現。
// 形式: "[カテゴリ] original の最初の N 字..."
// schema 上 min(1) があるため空文字にならないよう保証。
// i18n (2026-05-25): categoryLabel は呼び出し側から渡す(useTranslations の hook 呼び出しが
// 関数の中では使えないため、関数外の hook 結果を引数として注入)
function buildSuggestionSummary(s: Suggestion, categoryLabel: string): string {
  const SNIPPET_LEN = 30;
  const snippet =
    s.original.length > SNIPPET_LEN
      ? s.original.slice(0, SNIPPET_LEN) + "…"
      : s.original;
  return `[${categoryLabel}] ${snippet}`;
}

// 指摘の現在 status を導出(store から派生)
// Phase G Step 3b-1 (2026-05-23): "auto_corrected" status を追加。
//   error カテゴリのうち自動修正対象の状態。判定優先順:
//     1. edited (ユーザー明示編集が最優先)
//     2. auto_corrected (autoCorrectedSuggestionIds + acceptedSuggestionIds 両方に含まれる)
//     3. accepted (acceptedSuggestionIds のみ、ユーザー能動的採用)
//     4. rejected (rejectedSuggestionIds、ユーザー能動的却下 or 自動修正取り消し)
//     5. pending (どこにも含まれない、未対応)
type SuggestionStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "edited"
  | "auto_corrected";

function useSuggestionStatus(suggestion: Suggestion): {
  status: SuggestionStatus;
  editedText: string | null;
} {
  const acceptedSuggestionIds = useAnalyzeStore((s) => s.acceptedSuggestionIds);
  const rejectedSuggestionIds = useAnalyzeStore((s) => s.rejectedSuggestionIds);
  const editedSuggestions = useAnalyzeStore((s) => s.editedSuggestions);
  const autoCorrectedSuggestionIds = useAnalyzeStore(
    (s) => s.autoCorrectedSuggestionIds,
  );

  if (suggestion.id in editedSuggestions) {
    return { status: "edited", editedText: editedSuggestions[suggestion.id] };
  }
  if (autoCorrectedSuggestionIds.includes(suggestion.id)) {
    return { status: "auto_corrected", editedText: null };
  }
  if (acceptedSuggestionIds.includes(suggestion.id)) {
    return { status: "accepted", editedText: null };
  }
  if (rejectedSuggestionIds.includes(suggestion.id)) {
    return { status: "rejected", editedText: null };
  }
  return { status: "pending", editedText: null };
}

const STATUS_BADGE_CLASS: Record<SuggestionStatus, string> = {
  pending: "border-border bg-muted text-muted-foreground",
  accepted: "border-primary/40 bg-primary/15 text-primary",
  rejected:
    "border-muted-foreground/40 bg-muted text-muted-foreground line-through",
  edited:
    "border-amber-500/40 bg-amber-100/60 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
  // Phase G Step 3b-1: 自動修正済 は emerald 系の subtle トーン
  // (AI が安心して修正したことを示す、過剰主張ではなく落ち着いた仕上がり色)
  auto_corrected:
    "border-emerald-500/40 bg-emerald-100/60 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200",
};

// =============================================================================
// SuggestionCard — Phase G Step 3a: inline block(Popover ラップは撤廃)
// =============================================================================
// Props 設計:
//  - suggestion: 表示する Suggestion(必須)
//  - 内部で selectedSuggestionId / hoveredSuggestionId を購読し、自身の id と
//    比較して selected/hovered の視覚状態を切り替える。
//  - 外側の `<div>` が onMouseEnter/Leave/Click を受ける。クリックは selected の
//    トグル(自身が選択中なら null へ、そうでなければ自身を選択)。
//
// 視覚状態:
//  - status === "rejected": opacity-60(却下済はトーンを落とす)
//  - status === "accepted" / "edited": 通常の見た目(対応済は status badge で示す)
//  - status === "pending":     通常の見た目(未対応)
//  - selected (= selectedSuggestionId === id): primary ring 2px + ring-offset-2、background subtle
//  - hovered (= hoveredSuggestionId === id):    border 強調 + 軽い影、選択中なら効果重ねない
//  - カテゴリ accent: 左 border 4px、CATEGORY_ACCENT_BORDER_CLASS
//
// scroll into view:
//  - selected になった瞬間に scrollIntoView({ behavior: "smooth", block: "nearest" })。
//  - related_suggestion_ids クリックや Canvas からの navigate が常に到達点として
//    視認できるようにする。useEffect 内で selected === true のときに ref.current?.scrollIntoView。
//  - 2026-05-25 (Task #25): 初回 mount(画面遷移直後の auto-select 起因)では scrollIntoView を
//    skip。Canvas mode に切替直後、store の auto-select で最優先未処理 SuggestionCard が selected 化
//    した瞬間に scrollIntoView が発火するとページ全体が右パネル位置にスクロールしてしまう。
//    関連指摘クリック / J/K キーナビ / Canvas ハイライト navigate などのユーザー操作起因の
//    scroll は従来通り発火(本来の設計意図はこれら 3 つの navigation 到達点 visibility)。
export function SuggestionCard({ suggestion }: { suggestion: Suggestion }) {
  const t = useTranslations("suggestionCard");
  const tCategory = useTranslations("category");
  const tStatus = useTranslations("status");
  const tSource = useTranslations("rationaleSource");
  const tCommon = useTranslations("common");
  const { status, editedText } = useSuggestionStatus(suggestion);

  // Phase G Step 3a: selected / hovered の購読 + action
  // Task #22 (2026-05-25): selectSuggestion は SuggestionCard レベルでは使用しない
  // (card クリック toggle を削除したため)。RelatedSuggestionsBlock 側で別途購読する。
  const selectedSuggestionId = useAnalyzeStore((s) => s.selectedSuggestionId);
  const hoveredSuggestionId = useAnalyzeStore((s) => s.hoveredSuggestionId);
  const setHoveredSuggestion = useAnalyzeStore((s) => s.setHoveredSuggestion);

  // 2026-05-27 Task C+D (1)(2): partial refresh 中の対象 suggestion id を購読し、
  // card 内に subtle な「再評価中」label + spinner を表示する。
  //
  // 設計判断(2026-05-27): 既存 `partialRefreshSeedIds`(2026-05-25 Task #18 で導入、
  // beginPartialRefresh で set)を再利用する。
  //
  // 2026-05-28 dogfood round 3 ②④ 拡張: badge の trigger を 2 つの集合の union に拡げる:
  //  - partialRefreshSeedIds: beginPartialRefresh で set される「AI に投げた seed」(stream 開始後)
  //  - reEvaluatingSuggestionIds: accept/reject/edit の action 内で set される「再評価で変わり
  //    そうな指摘 = seed + その related_suggestion_ids」(action 時点 = stream 開始より前から立つ)
  //    → reject 等で「seed 自身は処理済だが related の pending が変わりそう」なケースも badge 対象になる
  //    (partialRefreshSeedIds だけでは related を拾えない)。
  //
  // 二重表示回避(dispatch report #4): `&& partialRefreshInProgress` を gate に必ず付ける。
  //  - applyPartialResult が応答受信時に partialRefreshInProgress を false 化 + recentlyUpdated を set。
  //    よって badge は応答受信の瞬間に消え、既存の recentlyUpdated(fade highlight、card 外側
  //    PartialRefreshSuggestionWrapper)に役割が引き継がれる。in-flight 予測 badge と応答後 確定
  //    badge が同一 card に同時表示されることはない(partialRefreshInProgress が排他 guard)。
  //
  // 視覚 cue の位置: SuggestionCard カードヘッダ右側(status badge 隣)に inline label。
  //  - 既存 PartialRefreshSuggestionWrapper の seed banner(card 外側 hint banner)とは
  //    冗長になり得るが、card 内部から直接視認できる場所が増えるためユーザー dogfood の
  //    「再評価中の対象が分からない」問題を解消する
  //  - aria-live="polite" で支援技術にも「処理中」を伝える
  const partialRefreshSeedIds = useAnalyzeStore(
    (s) => s.partialRefreshSeedIds,
  );
  const reEvaluatingSuggestionIds = useAnalyzeStore(
    (s) => s.reEvaluatingSuggestionIds,
  );
  const partialRefreshInProgress = useAnalyzeStore(
    (s) => s.partialRefreshInProgress,
  );
  const isRefreshing =
    partialRefreshInProgress &&
    (partialRefreshSeedIds.includes(suggestion.id) ||
      reEvaluatingSuggestionIds.includes(suggestion.id));

  // category label / status label を毎回引く
  const categoryLabel = tCategory(suggestion.category);
  const statusLabel = tStatus(status);

  const isSelected = selectedSuggestionId === suggestion.id;
  const isHovered = hoveredSuggestionId === suggestion.id;

  // インライン編集モード(編集して採用クリック後の Textarea 表示)。
  // selected/hovered とは独立。card 内ローカル state。
  const [editing, setEditing] = React.useState(false);
  const [draftText, setDraftText] = React.useState(suggestion.proposed);

  const acceptSuggestion = useAnalyzeStore((s) => s.acceptSuggestion);
  const rejectSuggestion = useAnalyzeStore((s) => s.rejectSuggestion);
  const editSuggestion = useAnalyzeStore((s) => s.editSuggestion);
  // Phase G Step 3b-1: 自動修正 1 件を「元に戻す」(却下扱い、action_history に記録)
  const undoAutoCorrection = useAnalyzeStore((s) => s.undoAutoCorrection);
  // 2026-05-25: 個別 revert(処理済 → pending、history panel と共通経路)
  const revertSuggestionAction = useAnalyzeStore(
    (s) => s.revertSuggestionAction,
  );

  const summary = buildSuggestionSummary(suggestion, categoryLabel);

  const handleAccept = () => {
    acceptSuggestion({
      suggestion_id: suggestion.id,
      suggestion_summary: summary,
    });
  };
  const handleReject = () => {
    rejectSuggestion({
      suggestion_id: suggestion.id,
      suggestion_summary: summary,
    });
  };
  const handleSaveEdited = () => {
    const text = draftText.trim();
    if (text.length === 0) return; // 空編集は保存しない
    editSuggestion({
      suggestion_id: suggestion.id,
      suggestion_summary: summary,
      edited_text: text,
    });
    setEditing(false);
  };
  // Phase G Step 3b-1: 自動修正 1 件の取り消しハンドラ
  const handleUndoAutoCorrection = () => {
    undoAutoCorrection({
      suggestion_id: suggestion.id,
      suggestion_summary: summary,
    });
  };
  // 2026-05-25: 個別 revert ハンドラ(処理済 → pending、history panel と共通経路)
  const handleRevert = () => {
    revertSuggestionAction({
      suggestion_id: suggestion.id,
      suggestion_summary: summary,
    });
  };

  // pending と auto_corrected はアクション選択肢を持つ(編集して採用 / 却下 / 元に戻す)
  // それ以外(accepted / rejected / edited)は対応済表示
  const actionsDisabled = status !== "pending" && status !== "auto_corrected";

  // Phase G Step 3a: scroll into view — selected になったらリスト内で見える位置へ
  // ref は外側の card div に付ける。selectedSuggestionId が自分の id に変わった
  // タイミングで scrollIntoView を発火。block: "nearest" にすることで、既に
  // 見えている場合はスクロールしない(無駄なジャンプを避ける)。
  const cardRef = React.useRef<HTMLDivElement>(null);
  // Task #25 (2026-05-25): 初回 mount 時の selected(画面遷移直後の auto-select 起因)では
  // scrollIntoView を skip。以降のユーザー操作起因の selected 変化では従来通り発火。
  // useRef は double-invoke (React strict mode) でも値が保持されるため安全。
  const isFirstSelectionRef = React.useRef(true);
  React.useEffect(() => {
    if (!isSelected) return;
    if (isFirstSelectionRef.current) {
      // 初回 selected = 画面遷移直後の auto-select 効果、scrollIntoView を skip。
      // flag を false にして以降の selected 変化では本来の scrollIntoView を発火させる。
      isFirstSelectionRef.current = false;
      return;
    }
    const el = cardRef.current;
    if (!el) return;
    // requestAnimationFrame で 1 tick 遅延させて、selected 化と同時にレイアウト変化が
    // 起きるケース(card の高さが変わる、Tab の切替等)でも安定して動くようにする。
    const rAF = requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    return () => cancelAnimationFrame(rAF);
  }, [isSelected]);

  // Task #22 (2026-05-25): card 全体の onClick(handleCardClick)を **削除**。
  // 旧実装は card 内テキスト / 余白クリックでも selected トグル発火していたが、
  // ユーザー dogfood で「右パネル card 内のテキスト / 余白クリックで次の提案に
  // 飛ぶ」バグが報告された。これは:
  //  - card クリックで selectSuggestion(null) 発火 → selected が null
  //  - SuggestionDetailPanel が pendingCount > 0 で「自動選択中…」spinner placeholder に
  //  - store の auto-select は accept/reject/edit action 内でしか走らないため、
  //    selectSuggestion(null) 単体経路では次への自動遷移が発火せず spinner 残留
  // 修正方針(DECISIONS §D-E): card レベル onClick を撤去、明示ボタン(採用/拒否/
  // 編集して採用/取り消す等)のクリックでのみ次へ遷移する。中央 Canvas のハイライト
  // クリック / 関連 suggestion badge クリックは別経路で維持(selectSuggestion を直接呼ぶ)。

  return (
    <div
      ref={cardRef}
      // Step 3a: カード全体を hover 対象にする(クリック toggle は Task #22 で削除)
      onMouseEnter={() => setHoveredSuggestion(suggestion.id)}
      onMouseLeave={() => setHoveredSuggestion(null)}
      data-suggestion-id={suggestion.id}
      className={cn(
        // base: card-like 外観 + 左カテゴリ accent border
        "flex flex-col gap-3 rounded-md border bg-card p-3 text-sm transition-all duration-150",
        "border-l-4",
        CATEGORY_ACCENT_BORDER_CLASS[suggestion.category],
        "border-y border-r border-y-border/60 border-r-border/60",
        // pending 以外(対応済 / 却下済)はトーンを落とす
        status === "rejected" && "opacity-60",
        // accepted / edited は派生 ES に反映済 → トーン subtle
        // auto_corrected も派生 ES に反映済だが、actions (元に戻す/編集) が残るため subtle にしすぎない
        (status === "accepted" || status === "edited") && "bg-card/70",
        // Phase G Step 3b-1: 自動修正済は emerald 系の subtle 背景でカードレベルでも識別
        status === "auto_corrected" &&
          "bg-emerald-50/40 dark:bg-emerald-950/20",
        // selected と hovered の視覚区別。selected が主役、hovered は subtle。
        // Task #22 (2026-05-25): Task #21 で朱系(red-500/60)に統一していた selected ring を
        // 青系 subtle (ring-1 ring-primary/50) に戻し、サイズも縮小 (ring-2 → ring-1、offset 削除)。
        // 採用ボタン(primary)と整合、隣のテキストにかぶる視覚問題も解消。
        // DECISIONS §B「選択枠: 朱系撤回 + サイズ縮小」を SSOT として参照。
        isSelected
          ? "ring-1 ring-primary/50 bg-card shadow-sm"
          : isHovered
            ? "border-y-foreground/30 border-r-foreground/30 shadow-sm"
            : "",
        // Task #22 (2026-05-25): cursor-pointer も削除。card クリックで何も起きないため
        // (採用 / 拒否ボタン等のアクションのみが UX 上「クリック可能」シグナル)。
      )}
      role="article"
      // role="article" は aria-selected を サポートしない(button/option/tab 等の選択
      // 可能 widget role でのみ妥当)。代わりに aria-current で「現在選択中の項目」
      // を表現する。リスト内で選択中のカードを支援技術にも伝える意図。
      aria-current={isSelected ? "true" : undefined}
      // 2026-05-27 Task C+D: partial refresh 中の対象 suggestion は `aria-busy="true"` で
      // 支援技術にも「処理中」を伝える(視覚 cue の inline label と一体)
      aria-busy={isRefreshing ? "true" : undefined}
      aria-label={t("card_aria_template", { category: categoryLabel, original: suggestion.original })}
    >
      {/* ヘッダ: カテゴリ Badge + 指摘 ID + status badge + (refresh 中 cue) */}
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge
            variant="outline"
            className={cn("text-[10px]", CATEGORY_BADGE_CLASS[suggestion.category])}
          >
            {categoryLabel}
          </Badge>
          <Badge
            variant="outline"
            className={cn("text-[10px]", STATUS_BADGE_CLASS[status])}
          >
            {statusLabel}
          </Badge>
          {/* 2026-05-27 Task C+D (1)(2): partial refresh 中 cue(subtle、対象が判別可能)。
              既存 PartialRefreshSuggestionWrapper の上部 banner と並ぶ二重表示だが、
              card 内部からも視認できる場所が増えてユーザーの「対象が分からない」問題を解消。 */}
          {isRefreshing && (
            <Badge
              variant="outline"
              className="border-primary/40 bg-primary/10 text-primary text-[10px] gap-1"
              role="status"
              aria-live="polite"
            >
              <Loader2 className="size-2.5 animate-spin" />
              <span>{t("refreshing_label")}</span>
            </Badge>
          )}
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">
          {suggestion.id}
        </span>
      </div>

      {/* v2 Phase B4 (2026-05-26): structural カテゴリは SideBySidePair をスキップし、
          専用 StructuralOperationBlock を表示する。理由:
            - structural の `proposed` は人間可読の placeholder(例: "(段落削除:冒頭の…)")で、
              SideBySidePair の「元の表現 / 提案」並列対比モデルに馴染まない。
            - 構造操作は文単位ではなく段落 / 文全体への作用 = operation 種別と影響範囲
              (失う内容、変更後 ES プレビュー)を独自 UI で表示する方が HITL の判断材料として明確。
          他カテゴリ(error / convention / alternative)は従来通り SideBySidePair で並列表示。 */}
      {suggestion.category === "structural" && suggestion.structural_params ? (
        <StructuralOperationBlock
          params={suggestion.structural_params}
          lostContent={suggestion.lost_content}
        />
      ) : (
        /* Task #23 (2026-05-25): 元の表現 / 提案 を「シンプル並列 2 box」で表示。
            Task #21 で導入した DiffPair(取り消し線 + 朱字 + 矢印)はユーザー dogfood で
            「煩雑」「斜線型は見にくくて好きではない」と判明し、本 Task で全撤回。
            - 元の表現: `bg-muted` + `text-muted-foreground`(灰系 subtle、過去・既存)
            - 提案: `bg-blue-50` / dark:bg-blue-950/20 + `font-medium`(primary 系 subtle、未来の状態)
            - 視線移動で対比、取り消し線・朱系・矢印は完全削除
            - 見出しは Section の上部見出しではなく、2 box それぞれに個別 label を付ける
              (a11y 上もセマンティクスが明確、各 box が独立した識別子を持つ)
            - 既存 i18n key `section_original` / `section_proposed` を再利用
              (Task #21 で旧 key 残置されていたもの、ラベル文字列も「元の表現」「提案」で一致)
            - SSOT: DECISIONS.md `[2026-05-25] Task #23 — 右パネル DiffPair 撤回 + シンプル並列表示に変更`

            2026-05-27 Task G-2: 通常 suggestion にも採用前 preview を追加。
            structural の StructuralOperationBlock パターンを踏襲し、SideBySidePair の下に
            inline `<details>` で「採用すると ES のこの部分がこう変わる」を提示。
            ユーザーが「採用前に最終形を確認できる」HITL の人間最終チェック層を構築。 */
        <>
          <SideBySidePair
            originalLabel={t("section_original")}
            proposedLabel={t("section_proposed")}
            original={suggestion.original}
            proposed={suggestion.proposed}
          />
          <NormalProposedPreviewBlock
            suggestion={suggestion}
          />
        </>
      )}
      {status === "edited" && editedText && (
        <div className="flex flex-col gap-1">
          <h5 className="text-[10px] font-medium tracking-wide text-amber-700 dark:text-amber-300 uppercase">
            {t("section_edited_heading")}
          </h5>
          <p className="rounded-sm bg-amber-100/60 dark:bg-amber-950/30 px-2 py-1.5 text-sm font-medium leading-relaxed text-jp">
            {editedText}
          </p>
        </div>
      )}

      {/* 根拠
          Task #27 (2026-05-25): text-jp → text-jp-flow に変更。rationale は long-form
          paragraph で、text-jp(word-break: keep-all)では句読点境界でしか改行できず
          各行が短く container 右側が大きく空く現象が dogfood で発生していた。
          text-jp-flow(word-break: normal + overflow-wrap: break-word + line-break: strict)で
          container 幅まで自然に折り返す。他のテキスト(元の表現、提案、tone_hint、UI 文言)
          は短文のため text-jp 維持。SSOT: app/globals.css の text-jp-flow 定義コメント。 */}
      <Section title={t("section_rationale")}>
        <p className="text-xs leading-relaxed text-foreground/90 text-jp-flow">
          {suggestion.rationale}
        </p>
      </Section>

      {/* 2026-05-28 dogfood round 3: suggestion-bound 逆質問の inline 表示を **撤去**。
          回答 → 全体再評価という挙動と「1 提案の付属物」という置き場所の意味がズレるため、
          指摘タブ最上部の統一セクション(ClarificationSection)へ集約した。
          回答 state / 紐付け / 再分析の挙動は不変(ClarificationBlock を同セクションで再利用)。
          ClarificationBlock の named export は ClarificationSection が import するため維持。
          SSOT: components/canvas/ClarificationSection.tsx /
                docs/dispatch/2026-05-28-clarification-relocation.md */}

      {/* 根拠ソース */}
      <Section title={t("section_source")}>
        <RationaleSourceBlock source={suggestion.rationale_source} tSource={tSource} tCommon={tCommon} tCard={t} />
      </Section>

      {/* 代替案(alternative カテゴリのみ展開) — Task #23 (2026-05-25):
          DiffPair 撤回に伴い、各代替案も「シンプル並列 2 box」で統一。
          元の表現は親 suggestion で 1 度表示済(SideBySidePair の上 box)→
          代替案セクションでは「案 N」のみを primary 系 subtle 1 box で並列 list 表示
          (DECISIONS L6498 / dispatch 観察事項 4「2 box × N は冗長、案 N のみ並列が簡素」)。
          tone_hint は維持。 */}
      {suggestion.category === "alternative" &&
        suggestion.alternatives.length > 0 && (
          <Section title={t("section_alternatives", { count: suggestion.alternatives.length })}>
            <ul className="flex flex-col gap-2">
              {suggestion.alternatives.map((alt) => (
                <li key={alt.id} className="flex flex-col gap-1">
                  <p
                    className={cn(
                      "rounded-sm px-2 py-1.5 text-sm font-medium leading-relaxed text-jp",
                      "bg-blue-50 dark:bg-blue-950/20",
                      "text-foreground",
                    )}
                  >
                    {alt.text}
                  </p>
                  {alt.tone_hint && (
                    <p className="text-[10px] text-muted-foreground text-jp pl-1">
                      {alt.tone_hint}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        )}

      {/* 関連する指摘(UX 改修 3a で F1.11 を上書き、Step 3a で挙動維持):
          - clickable badge: クリックで該当 suggestion の選択 + scroll into view
          - 被り注意 alert: 関連指摘がある場合は「両方採用すると被る可能性」を明示
          - 被り検出は LLM の自己宣言(related_suggestion_ids)を活用する option B
            (文字列類似度の独自計算は採用しない = 設計原則「指摘間の独立性」維持)。 */}
      {suggestion.related_suggestion_ids.length > 0 && (
        <Section title={t("section_related")}>
          <RelatedSuggestionsBlock
            relatedIds={suggestion.related_suggestion_ids}
            currentStatus={status}
          />
        </Section>
      )}

      <Separator className="mt-1" />

      {/* アクションフッタ(Step 2 で導入、Step 3a で挙動不変): 採用 / 編集して採用 / 却下、または inline editor */}
      {editing ? (
        <div className="flex flex-col gap-2" data-no-select>
          <h5 className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            {t("edit_block_heading")}
          </h5>
          <Textarea
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            placeholder={t("edit_textarea_placeholder")}
            className="min-h-20 max-h-48 text-xs leading-relaxed"
            autoFocus
          />
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setEditing(false);
                setDraftText(suggestion.proposed);
              }}
            >
              {t("edit_cancel")}
            </Button>
            <Button
              variant="default"
              size="xs"
              onClick={handleSaveEdited}
              disabled={draftText.trim().length === 0}
            >
              <Check className="size-3" />
              {t("edit_save_label")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {actionsDisabled ? (
            // 2026-05-25: status hint テキスト → 個別 revert ボタンに置換。
            // 採用済 / 拒否済 / 編集して採用済の処理済 suggestion に対して
            // 「この操作を取り消す」を一発で実行できる動線(履歴タブと共通)。
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={handleRevert}
              aria-label={t("revert_action_aria")}
              title={t("revert_action_title")}
            >
              <Undo2 className="size-3" />
              <span>{t("revert_action_label")}</span>
            </Button>
          ) : status === "auto_corrected" ? (
            // Phase G Step 3b-1: 自動修正済の場合は「編集 / 元に戻す」のみ提示。
            // 「採用」は既に適用済のため出さない(現在の派生 ES に proposed が反映されている)。
            // 「元に戻す」は内部的に REJECTED entry を生成し、上部 Undo でも巻き戻せる。
            <>
              <Button
                variant="ghost"
                size="xs"
                onClick={handleUndoAutoCorrection}
                aria-label={t("undo_auto_aria")}
                title={t("undo_auto_title")}
              >
                <X className="size-3" />
                {t("undo_auto_label")}
              </Button>
              <Button
                variant="outline"
                size="xs"
                onClick={() => setEditing(true)}
                aria-label={t("edit_accept_aria")}
              >
                <Pencil className="size-3" />
                {tCommon("edit_accept")}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="xs"
                onClick={handleReject}
                aria-label={t("reject_aria")}
              >
                <X className="size-3" />
                {tCommon("reject")}
              </Button>
              <Button
                variant="outline"
                size="xs"
                onClick={() => setEditing(true)}
                aria-label={t("edit_accept_aria")}
              >
                <Pencil className="size-3" />
                {tCommon("edit_accept")}
              </Button>
              <Button
                variant="default"
                size="xs"
                onClick={handleAccept}
                aria-label={t("accept_aria")}
              >
                <Check className="size-3" />
                {tCommon("accept")}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// 内部: Section ヘッダー + 子要素
// =============================================================================
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h5 className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h5>
      {children}
    </div>
  );
}

// =============================================================================
// StructuralOperationBlock — v2 Phase B4 (2026-05-26): structural 専用表示
// =============================================================================
// `structural` カテゴリの suggestion を採用する前に、ユーザーが「何が起きるか」を
// 判断できるよう以下を 1 つの inline block にまとめて表示する:
//   1. operation 種別 Badge(段落削除 / 段落順番変更 / 段落統合 / 文の移動 / 段落追加)
//   2. lost_content(delete_paragraph / merge_paragraphs で削除される原文の控え、optional)
//   3. 変更後 ES プレビュー(<details> 折りたたみ、デフォルト閉)
//
// 設計判断:
//  - 別 component file 化しない(SuggestionCard 内 internal、シンプル化優先、
//    Phase B4 dispatch §「重要」明示)
//  - StructuralPreviewModal 形式ではなく **inline details** を採用(クリックで
//    モーダルが開くより、その場で「展開して確認 → 採用判断」の動線の方が短い)
//  - preview の生成は `applyStructuralOperation`(structural_ops.ts、Phase B3 で新設の
//    純粋関数)を client side で実行 — 即時生成、LLM 呼び出しなし、hallucination リスクなし
//  - esBody は store の `currentEsBody` を購読(props 注入ではなく直接購読、
//    SuggestionCard の他 hooks pattern と整合)
//  - 視覚言語は purple 系(CATEGORY_BADGE_CLASS.structural と整合)+ amber 系
//    (lost_content = 失う情報の警告色)で、構造変更の意味性を伝える
//  - <details> ChevronRight icon は RationaleSourceBlock の evidence 展開 UI と
//    同じパターン(group-open:rotate-90)で統一(視覚言語一貫性)
//
// 不正 params のフォールバック:
//  - applyStructuralOperation は不正 index / 不正 params で esBody をそのまま返す(no-op)。
//    preview に「変更なし」を表示するケースは UI 上は許容(B3 の defensive 設計 + UI 側は
//    そのまま preview 表示で問題視されない、安全側)。
function StructuralOperationBlock({
  params,
  lostContent,
}: {
  params: StructuralOperationParams;
  lostContent?: string;
}) {
  const t = useTranslations("suggestionCard");
  const currentEsBody = useAnalyzeStore((s) => s.currentEsBody);
  const operationLabel = t(
    `structural_operation_label.${params.operation}` as
      | "structural_operation_label.delete_paragraph"
      | "structural_operation_label.reorder_paragraphs"
      | "structural_operation_label.merge_paragraphs"
      | "structural_operation_label.move_sentence"
      | "structural_operation_label.add_paragraph",
  );
  // preview は render 毎に純粋計算(currentEsBody / params の変化で自動再計算、
  // useMemo は overengineering — splitParagraphs + filter / sort + join 程度の軽量計算)。
  const preview = applyStructuralOperation(currentEsBody, params);
  return (
    <div className="flex flex-col gap-2">
      {/* operation 種別 Badge — purple 系で structural の視覚言語と整合 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge
          variant="outline"
          className={cn(
            "text-[10px] gap-1",
            CATEGORY_BADGE_CLASS.structural,
          )}
        >
          <Shuffle className="size-2.5" />
          <span>{operationLabel}</span>
        </Badge>
      </div>
      {/* lost_content — delete_paragraph / merge_paragraphs 等で失われる原文。
          amber 系 subtle 警告色で「採用すると失われる情報」をユーザーに明示。 */}
      {lostContent && (
        <div className="flex flex-col gap-1">
          <h5 className="text-[10px] font-medium tracking-wide text-amber-700 dark:text-amber-300 uppercase">
            {t("structural_lost_content_heading")}
          </h5>
          <p className="rounded-sm border border-amber-500/30 bg-amber-50/60 dark:bg-amber-950/30 px-2 py-1.5 text-xs leading-relaxed text-amber-900 dark:text-amber-200 text-jp-flow">
            {lostContent}
          </p>
        </div>
      )}
      {/* 変更後 ES プレビュー — <details> 折りたたみ、デフォルト閉(判断疲労を抑える、
          RationaleSourceBlock の evidence 展開 UI と同じパターン)。
          展開時は ES 全文を whitespace-pre-wrap で表示し、段落 / 文構造変更後の姿が
          ユーザーに見える。テストでも純粋関数 applyStructuralOperation の出力と一致。 */}
      <details className="group rounded-md border border-border/60 bg-muted/30 px-2 py-1.5">
        <summary className="flex items-center gap-1.5 cursor-pointer text-[10px] font-medium tracking-wide text-muted-foreground marker:hidden [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
          <span className="group-open:hidden">{t("structural_preview_label")}</span>
          <span className="hidden group-open:inline">{t("structural_preview_close")}</span>
        </summary>
        <pre className="mt-1.5 whitespace-pre-wrap text-[11px] leading-relaxed text-foreground text-jp-flow font-sans">
          {preview}
        </pre>
      </details>
    </div>
  );
}

// =============================================================================
// NormalProposedPreviewBlock — 2026-05-27 dogfood round 2 Task G-2
// =============================================================================
// 通常 suggestion(error / convention / alternative)を採用する前に、ユーザーが
// 「採用するとESがこう変わる」最終形を確認できる inline preview。
//
// 設計判断:
//  - structural の StructuralOperationBlock パターンを踏襲(同じ <details> 折りたたみ +
//    ChevronRight icon + group-open:rotate-90 で視覚言語統一)
//  - 「該当 1 箇所のみ」preview(ES 全体は出さない、dispatch §「簡易実装」推奨)
//    - original_span の前後 30 字を context として抽出、置換結果を視覚的に強調
//    - 「…前後 ES…」+「**proposed**」+「…前後 ES…」で「変化点が ES のどこか」が分かる
//  - SuggestionCard の他 hooks pattern に整合する直接 store 購読(currentEsBody)
//  - デフォルト閉(判断疲労を抑える)、StructuralOperationBlock の preview と同じ UX
//  - i18n key: suggestionCard.preview_normal_label / preview_normal_close を新規追加
//
// HITL 哲学の構造実装:
//  - 「AI が出した proposed を採用する前に、人間が最終形を確認できる」UX が
//    「AI は選択肢を提示する。判断と表現は人間が握る」(AGENTS.md)を強化する
//  - メタコメント混入(Task G-1 で prompt 改修)+ 採用前 preview(本 Task G-2)= 防衛の二重化
function NormalProposedPreviewBlock({
  suggestion,
}: {
  suggestion: Suggestion;
}) {
  const t = useTranslations("suggestionCard");
  const currentEsBody = useAnalyzeStore((s) => s.currentEsBody);
  // original_span を使って current ES から該当箇所 + 前後コンテキストを抽出。
  // 範囲外(LLM が壊れた span を出した / 採用後 currentEsBody が変動した 等)の場合は
  // 「変更なし」相当の安全側挙動として original 部分そのまま表示(防御的)。
  const { start, end } = suggestion.original_span;
  const CONTEXT_CHARS = 30;
  // 1) 範囲ガード: original_span が currentEsBody の範囲外なら防御的に proposed の前後なしで表示。
  //    (Task E bug fix と同様、currentEsBody は structural 適用で変動するため form.es_body との
  //     ずれがあり得る。ここでは preview は「目安」と割り切る = ES 全体に対する厳密な置換は
  //     getDerivedEsBody が担当、本 component は per-suggestion の inline preview 用)
  const isSpanValid =
    start >= 0 && end > start && end <= currentEsBody.length;
  const before = isSpanValid
    ? currentEsBody.slice(Math.max(0, start - CONTEXT_CHARS), start)
    : "";
  const after = isSpanValid
    ? currentEsBody.slice(end, Math.min(currentEsBody.length, end + CONTEXT_CHARS))
    : "";
  // 省略記号(context が ES 端まで届いていない場合は前後に "…" を付与)
  const prefixEllipsis = isSpanValid && start - CONTEXT_CHARS > 0 ? "…" : "";
  const suffixEllipsis =
    isSpanValid && end + CONTEXT_CHARS < currentEsBody.length ? "…" : "";
  return (
    <details className="group rounded-md border border-border/60 bg-muted/30 px-2 py-1.5">
      <summary className="flex items-center gap-1.5 cursor-pointer text-[10px] font-medium tracking-wide text-muted-foreground marker:hidden [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
        <span className="group-open:hidden">{t("preview_normal_label")}</span>
        <span className="hidden group-open:inline">{t("preview_normal_close")}</span>
      </summary>
      <p className="mt-1.5 whitespace-pre-wrap text-[11px] leading-relaxed text-jp-flow">
        <span className="text-muted-foreground">
          {prefixEllipsis}
          {before}
        </span>
        <span className="rounded-sm bg-blue-100/80 dark:bg-blue-900/40 px-1 font-medium text-foreground">
          {suggestion.proposed}
        </span>
        <span className="text-muted-foreground">
          {after}
          {suffixEllipsis}
        </span>
      </p>
    </details>
  );
}

// =============================================================================
// SideBySidePair — Task #23 (2026-05-25): シンプル並列 2 box(元の表現 / 提案)
// =============================================================================
// Task #21 で導入した DiffPair(取り消し線 + 朱字 + ArrowDown 矢印)はユーザー dogfood で
// 「煩雑」「斜線型は見にくくて好きではない」と判明し、本 Task #23 で全撤回。
// 「シンプル並列 2 box」(上 = 元 / 下 = 提案)で対比を視覚化する。
//
// 表現:
//  - 元の表現(上 box): bg-muted + text-muted-foreground(灰系 subtle、過去・既存の状態)
//                       + 小見出し「元の表現」(別 label)
//  - 提案(下 box): bg-blue-50 / dark:bg-blue-950/20 + text-foreground + font-medium
//                   (primary 系 subtle、これから採用する未来の状態)
//                   + 小見出し「提案」(別 label)
//  - 矢印アイコン・取り消し線・朱系背景・朱字は全削除(視覚 noise を最小化)
//  - 上下並列で視線移動による対比、過剰な装飾なし
//
// SSOT: DECISIONS.md `[2026-05-25] Task #23 — 右パネル DiffPair 撤回 + シンプル並列表示に変更`
function SideBySidePair({
  originalLabel,
  proposedLabel,
  original,
  proposed,
}: {
  originalLabel: string;
  proposedLabel: string;
  original: string;
  proposed: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <h5 className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {originalLabel}
        </h5>
        <p
          className={cn(
            "rounded-sm px-2 py-1.5 text-xs leading-relaxed text-jp",
            "bg-muted text-muted-foreground",
          )}
        >
          {original}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <h5 className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {proposedLabel}
        </h5>
        <p
          className={cn(
            "rounded-sm px-2 py-1.5 text-sm font-medium leading-relaxed text-jp",
            "bg-blue-50 dark:bg-blue-950/20",
            "text-foreground",
          )}
        >
          {proposed}
        </p>
      </div>
    </div>
  );
}

// =============================================================================
// RelatedSuggestionsBlock — 関連指摘の clickable badge 列 + 被り注意 alert
// =============================================================================
// UX 改修 3a (2026-05-23, F1.11 を上書き) + Phase G Step 3a 維持:
//  - badge 列: 各関連 id を clickable に、クリックで selectSuggestion(rid) →
//    該当 suggestion の SuggestionCard が selected ring + scroll into view。
//    badge の色は関連指摘のカテゴリに合わせる(category を store から引く)。
//    関連指摘が見つからない(削除されたケース等)場合は disabled 表示。
//  - 被り注意 alert: 現在の suggestion がまだ未対応で、関連指摘が存在する場合に
//    info box を表示。「両方採用すると被る可能性」をユーザーに認知させる
//    (HITL「個々のHITLが適切でも全体として判断品質を劣化させない」の実装)。
//    既に accepted/edited/rejected な場合は alert を出さない(対応後の認知負荷削減)。
function RelatedSuggestionsBlock({
  relatedIds,
  currentStatus,
}: {
  relatedIds: ReadonlyArray<string>;
  currentStatus: SuggestionStatus;
}) {
  const t = useTranslations("suggestionCard");
  const tCategory = useTranslations("category");
  const allSuggestions =
    useAnalyzeStore((s) => s.analysisResult?.suggestions) ?? EMPTY_SUGGESTIONS;
  const selectSuggestion = useAnalyzeStore((s) => s.selectSuggestion);
  const acceptedSuggestionIds = useAnalyzeStore((s) => s.acceptedSuggestionIds);
  const rejectedSuggestionIds = useAnalyzeStore((s) => s.rejectedSuggestionIds);
  const editedSuggestions = useAnalyzeStore((s) => s.editedSuggestions);

  // related id → Suggestion を引く(なければ undefined)。
  const relatedSuggestions = relatedIds.map((rid) => ({
    id: rid,
    suggestion: allSuggestions.find((s) => s.id === rid),
  }));

  // 被り注意 alert: currentStatus が pending の場合のみ表示
  //  (採用済 / 編集済 / 却下済 / 自動修正済になった後は警告意義がない、
  //   認知負荷を増やすだけ。自動修正済 = 派生 ES に proposed が既に反映済の
  //   ため警告対象ではない。Phase G Step 3b-1)。
  const showOverlapAlert = currentStatus === "pending";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {relatedSuggestions.map(({ id, suggestion: related }) => {
          if (!related) {
            // 関連指摘が見つからない(消えた / 不正な id)場合は disabled 表示
            return (
              <span
                key={id}
                className="rounded-md border border-border/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground opacity-50"
                title={t("related_not_found")}
              >
                {id}
              </span>
            );
          }
          // related の status を判定(badge の色味で「すでに対応済」がわかる)
          const isAccepted = acceptedSuggestionIds.includes(related.id);
          const isRejected = rejectedSuggestionIds.includes(related.id);
          const isEdited = related.id in editedSuggestions;
          const isHandled = isAccepted || isRejected || isEdited;

          // hover tooltip 用: original の冒頭 24 字
          const snippet =
            related.original.length > 24
              ? related.original.slice(0, 24) + "…"
              : related.original;

          return (
            <button
              key={id}
              type="button"
              onClick={(e) => {
                // card 全体クリックと競合しないよう伝播を止める
                e.stopPropagation();
                selectSuggestion(related.id);
              }}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] transition-colors cursor-pointer",
                CATEGORY_BADGE_CLASS[related.category],
                // Task #22 (2026-05-25): focus ring も青系 subtle に戻し、selected ring と整合。
                "hover:opacity-80 focus:outline-none focus:ring-1 focus:ring-primary/40",
                isHandled && "opacity-60",
              )}
              title={t("related_link_title_template", {
                category: tCategory(related.category),
                snippet,
                handled_suffix: isHandled ? t("related_handled_suffix") : "",
              })}
              aria-label={t("related_link_aria_template", { id: related.id })}
            >
              <Link2 className="size-2.5" />
              <span>{related.id}</span>
            </button>
          );
        })}
      </div>

      {showOverlapAlert && (
        <div
          className="mt-0.5 flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-50/60 dark:bg-amber-950/30 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800 dark:text-amber-200"
          role="note"
        >
          <Info className="size-3 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="text-jp">
            {t("overlap_alert_message")}
          </span>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// 根拠ソース block(company_value のみ URL を表示する discriminatedUnion 分岐)
// =============================================================================
// Phase E 拡張(2026-05-23): 自由テキスト経路で生成された企業要約に紐づく
// company_value 指摘では、url = "user-input"(EVIDENCE_SOURCE_USER_INPUT)になる。
// その場合は URL リンクの代わりに「ユーザー入力」テキストを muted で表示する。
//
// Commit D-4 (2026-05-25): evidence_id がある時に企業要約の claim / source_quote を
// inline 抜粋表示(透明性 UI 統合)。
//  - 折りたたみ <details> で展開可能、デフォルトは閉(判断疲労を抑える)
//  - companySummary が無い場合は何も追加しない(後方互換)
//  - 内部 HITL ロジック(採用 / 編集 / 却下)には一切影響しない、表示の追加のみ
// tSource: useTranslations("rationaleSource")
// tCommon: useTranslations("common")
// tCard: useTranslations("suggestionCard")
function RationaleSourceBlock({
  source,
  tSource,
  tCommon,
  tCard,
}: {
  source: RationaleSource;
  tSource: ReturnType<typeof useTranslations<"rationaleSource">>;
  tCommon: ReturnType<typeof useTranslations<"common">>;
  tCard: ReturnType<typeof useTranslations<"suggestionCard">>;
}) {
  const companySummary = useAnalyzeStore((s) => s.companySummary);
  const isUserInputSource =
    source.type === "company_value" &&
    source.url === EVIDENCE_SOURCE_USER_INPUT;
  // company_value + evidence_id を持つ場合、companySummary から該当 evidence を引く
  const linkedEvidence =
    source.type === "company_value" && source.evidence_id && companySummary
      ? companySummary.evidence.find((ev) => ev.id === source.evidence_id) ??
        null
      : null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="text-[10px]">
          {tSource(source.type)}
        </Badge>
        <span className="text-xs text-muted-foreground">{source.reference}</span>
        {source.type === "company_value" && (
          <>
            {isUserInputSource ? (
              <span
                className="text-[10px] text-muted-foreground"
                title={tCard("user_input_source_title")}
              >
                {tCommon("user_input_source")}
              </span>
            ) : (
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-primary underline underline-offset-2 hover:opacity-80"
              >
                {tCommon("view_source")}
              </a>
            )}
            {source.evidence_id && (
              <span
                className="font-mono text-[10px] text-muted-foreground"
                title={tCard("evidence_id_title")}
              >
                ({source.evidence_id})
              </span>
            )}
          </>
        )}
      </div>
      {/* Commit D-4: evidence_id 連動の claim / source_quote 抜粋(折りたたみ)
          2026-05-25 Task #28: ChevronRight icon を summary 内に配置、open で 90° 回転。
          messages JSON の ▶/▼ prefix は browser default marker と二重表示の原因だったため
          削除済(messages/{ja,en}.json L391-392)。Lucide icon の方が browser 横断で一貫した
          見た目を提供できる。details 展開時の slideDown animation は app/globals.css の
          details[open] > :not(summary) selector で吸収。 */}
      {linkedEvidence && (
        <details className="group rounded-md border border-border/60 bg-muted/30 px-2 py-1.5">
          <summary className="flex items-center gap-1.5 cursor-pointer text-[10px] font-medium tracking-wide text-muted-foreground marker:hidden [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
            <span className="group-open:hidden">
              {tCard("evidence_expand_label", { id: linkedEvidence.id })}
            </span>
            <span className="hidden group-open:inline">{tCard("evidence_collapse_label")}</span>
          </summary>
          <div className="mt-1.5 flex flex-col gap-1.5">
            <p className="text-[11px] leading-relaxed text-foreground text-jp">
              {linkedEvidence.claim}
            </p>
            <blockquote className="border-l-2 border-muted-foreground/30 bg-background/40 px-1.5 py-0.5 text-[10px] leading-relaxed italic text-muted-foreground text-jp">
              {linkedEvidence.source_quote}
            </blockquote>
          </div>
        </details>
      )}
    </div>
  );
}

// =============================================================================
// ClarificationBlock — 2026-05-27 エージェント的対話(AI 逆質問)
// =============================================================================
// AI が出した clarification_question 1 件 + 回答 textarea + status badge を 1 ブロック
// にまとめる component。SuggestionCard 内の inline 表示と、指摘タブヘッダの
// GlobalClarificationSection の両方で再利用する(scope prop で区別)。
//
// 表示要素:
//  1. ヘッダ: HelpCircle icon + 「AI からの質問」 + status badge(未回答 / 回答済)
//  2. 質問本文(text-jp-flow で日本語自然折り返し)
//  3. なぜ聞くか折りたたみ(<details>、デフォルト閉、判断疲労を抑える)
//  4. 回答 textarea(placeholder「ここに回答を入力(任意)」、resize-y で縦伸縮)
//
// 設計判断:
//  - textarea の onChange は debounce **無し** で store action を呼ぶ。debounce 案は
//    dispatch §「想定外パターン #3」で検討事項として挙がっているが、不要と判断:
//      * updateClarificationAnswer は array filter + immutable replace のみで軽量
//      * partial refresh は明示ボタン経路でしか発火しない(typing 中の自動発火は無し)
//      * controlled input は React の標準パターン、debounce は state lag を生む
//  - 「Q (全体)」/「Q (sug_XXX)」のような prefix は付けない(scope は status の
//    一部として伝わる、文言重複を避ける)。global vs suggestion-bound の視覚的区別は
//    container 側(指摘タブヘッダ vs SuggestionCard 内 inline)で十分
//  - 値の controlled source: clarificationAnswers から該当 question_id を引く
//    (なければ空文字 = 未回答 status)
//  - aria-live="polite" で status 変化(未回答 → 回答済)を screen reader へ通知
//
// Inviolable constraints:
//  - 数値スコア禁止: 件数 / status のみ表示
//  - すべての操作は Undo 可能: 回答は textarea でいつでも上書き / 空にして未回答に戻せる
//  - localStorage 不使用: store の clarificationAnswers は session 揮発
export function ClarificationBlock({
  question,
  scope,
  suggestionId,
}: {
  question: ClarificationQuestion;
  scope: "suggestion" | "global";
  // scope === "suggestion" の場合のみ set。store action にそのまま渡す。
  suggestionId?: string;
}) {
  const t = useTranslations("clarification");
  const clarificationAnswers = useAnalyzeStore((s) => s.clarificationAnswers);
  const updateClarificationAnswer = useAnalyzeStore(
    (s) => s.updateClarificationAnswer,
  );
  // current answer text の lookup(無ければ "" = 未回答)。
  // 2026-05-29: question_id 単独だと別 suggestion の同名 q_001 と混線する(片方の回答が
  // もう片方にも表示される)。複合キー(scope + suggestion_id + question_id)で照合する。
  const targetKey = clarificationIdentity({
    scope,
    suggestion_id: suggestionId,
    question_id: question.id,
  });
  const currentAnswer =
    clarificationAnswers.find(
      (a) =>
        clarificationIdentity({
          scope: a.scope,
          suggestion_id: a.suggestion_id,
          question_id: a.question_id,
        }) === targetKey,
    )?.answer_text ?? "";
  const isAnswered = currentAnswer.trim().length > 0;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-indigo-400/30 bg-indigo-50/40 dark:border-indigo-500/30 dark:bg-indigo-950/20 px-3 py-2">
      {/* ヘッダ: アイコン + heading + status badge */}
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5">
          <HelpCircle
            className="size-3.5 text-indigo-600 dark:text-indigo-300"
            aria-hidden
          />
          <h5 className="text-[10px] font-medium tracking-wide text-indigo-700 dark:text-indigo-300 uppercase">
            {t("card_heading")}
          </h5>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "text-[10px]",
            isAnswered
              ? "border-emerald-500/40 bg-emerald-100/60 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
              : "border-border bg-muted text-muted-foreground",
          )}
          aria-live="polite"
        >
          {isAnswered ? t("answer_status_answered") : t("answer_status_pending")}
        </Badge>
      </div>

      {/* 質問本文 */}
      <p className="text-xs leading-relaxed text-foreground text-jp-flow">
        {question.question}
      </p>

      {/* なぜ聞くか — 折りたたみ、判断疲労を抑える */}
      <details className="group rounded-md border border-border/40 bg-background/60 px-2 py-1">
        <summary className="flex items-center gap-1.5 cursor-pointer text-[10px] font-medium tracking-wide text-muted-foreground marker:hidden [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
          <span className="group-open:hidden">{t("rationale_open_label")}</span>
          <span className="hidden group-open:inline">{t("rationale_close_label")}</span>
        </summary>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground text-jp-flow">
          {question.rationale}
        </p>
      </details>

      {/* 回答 textarea — controlled、空文字で entry 自動除去(updateClarificationAnswer 内) */}
      <Textarea
        value={currentAnswer}
        onChange={(e) =>
          updateClarificationAnswer({
            question_id: question.id,
            ...(suggestionId !== undefined && { suggestion_id: suggestionId }),
            scope,
            answer_text: e.target.value,
          })
        }
        placeholder={t("answer_placeholder")}
        className="min-h-16 max-h-40 text-xs leading-relaxed"
        aria-label={t("card_aria_heading", { count: 1 })}
      />

      {/* 2026-05-28 dogfood round 3 ①: 回答の「反映(送信)導線」ヒント。
          根本原因: 回答は textarea で自動保存され送信ボタンが無い。反映は上部
          SummaryBar の「この回答で再分析」ボタン(回答 1 件以上で表示)で、カードと
          ボタンが離れているためユーザーが「答えたのに送信方法が分からない」状態に陥る。
          対策(state ロジック不変、文言と表示のみ): 回答済(isAnswered)の時だけ
          subtle なヒントを textarea 直下に出し、上部ボタンへ文言で誘導する。
          - 回答済の時のみ表示(未回答時は noise を増やさない、判断疲労を抑える)
          - カード内に「再分析」ボタンは増やさない(再分析は全回答まとめて 1 回の操作。
            カードごとに置くと「この質問だけ反映」と誤解される。単一 SummaryBar ボタンを維持)
          - 文言中のボタン名は clarification.trigger_button_label と完全一致(手動整合)
          - ClarificationBlock は suggestion-bound / global 両方で再利用されるため、
            ここ 1 箇所の追加で両スコープにヒントが揃う(SuggestionListPanel は無編集)
          - role="note" + Info icon(aria-hidden)で支援技術には補足注記として伝わる */}
      {isAnswered && (
        <p
          className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground text-jp-flow"
          role="note"
        >
          <Info className="size-3 mt-0.5 shrink-0 text-indigo-500 dark:text-indigo-400" aria-hidden />
          <span>{t("answer_reflect_hint")}</span>
        </p>
      )}
    </div>
  );
}
