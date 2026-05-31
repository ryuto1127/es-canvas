"use client";

// =============================================================================
// 1 件詳細展開モード (2026-05-25 update): 右パネル指摘タブの主体 UI
// =============================================================================
//
// 責務:
//  - `selectedSuggestionId` がある時 = 単一 suggestion の詳細(SuggestionCard を再利用)
//  - `selectedSuggestionId` が null の時:
//    - 未処理が残っていれば「自動選択中…」placeholder(store の auto-select 効果が
//      数ミリ秒後に id を立てるため、ちらつきを抑える短い transition)
//    - 全件処理済なら **完了画面**(件数サマリ + 派生 ES 字数 + 「履歴を見る」導線)
//    - suggestions 自体が空(初回 done だが指摘ゼロ)なら empty state
//  - 任意で「コンパクト全件一覧」をオーバーレイ展開する toggle ボタン
//    (デフォルトは非表示、ユーザーが任意で開く保険、提案リストの全体感を見たい時用)
//
// 設計判断(2026-05-25 update):
//  1) **デフォルトは 1 件詳細展開モード** (旧: SuggestionListPanel 再利用フォールバック)。
//     dispatch §1「リスト型 → 1 件詳細展開モード」に対応。store 側で初回分析直後と
//     accept/reject/edit 直後に最優先未処理 id を自動選択するため、通常は selected
//     が null になる時間は瞬間的(Cmd+Z 直後など限定的 moment)。
//  2) **SuggestionListPanel の完全廃止は採用せず、コンパクト全件一覧 toggle で残す** —
//     sparring 推奨案。全件感を確認したいユーザーへの保険、デフォルトは非表示。
//  3) **SuggestionCard 内部は再利用** — SuggestionCard の内部 HITL 実装(採用 /
//     編集 / 却下)はそのまま生かす。本 component は「単一カードの強調コンテナ」。
//  4) **「次の指摘 / 前の指摘」ナビゲーション維持** — 自動遷移を override したい
//     ユーザー向け(高優先未処理を飛ばして低優先を見たい時、processed を巡回したい時)。
//  5) **`internal_priority` は UI で参照禁止** — `display_priority` 文字列タグのみ。
//
// AGENTS.md Inviolable constraints:
//  - 数値スコア禁止: priority 数値は出さない、完了画面も件数 / 字数のみ
//  - ES 全面書き換え禁止: 完了画面に「全採用」「全削除」のような bulk action なし
//  - 競合通知中間プレビューなし: 本 component は競合通知に直接関与しない(Canvas が担当)
//
// SSOT: lib/state/analyze_store.ts (selectedSuggestionId, selectSuggestion)
//       lib/schema/suggestion.ts (Suggestion)

import * as React from "react";
import { useTranslations } from "next-intl";
import type { Suggestion } from "@/lib/schema/suggestion";
import {
  useAnalyzeStore,
  getDerivedEsLength,
} from "@/lib/state/analyze_store";
import { SuggestionCard } from "@/components/canvas/SuggestionCard";
import { SuggestionListPanel } from "@/components/canvas/SuggestionListPanel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Layers,
  ListChecks,
  Loader2,
  X,
} from "lucide-react";

// onRequestHistoryTab: 完了画面の「履歴を見る」クリック時、親 RightPanel に履歴タブを
// active 化するよう依頼するコールバック。RightPanel が tab state を持つため、子から
// 親への通知経路として props で受ける(store 経由にしない、UI 一過性の navigation 信号)。
export interface SuggestionDetailPanelProps {
  suggestions: Suggestion[];
  onRequestHistoryTab?: () => void;
}

export function SuggestionDetailPanel({ suggestions, onRequestHistoryTab }: SuggestionDetailPanelProps) {
  const t = useTranslations("suggestionDetail");
  const tCard = useTranslations("suggestionCard");
  // Task #32a (2026-05-25): 詳細展開ヘッダの「カテゴリ別件数」表示用 i18n。
  // category enum 値「error / convention / alternative」は Load-bearing(リネーム禁止)、
  // 表示語のみ messages JSON 側で「要修正 / 推奨 / 代替案」に再定義(Task #32a 修正 4)。
  const tCategory = useTranslations("category");
  const selectedSuggestionId = useAnalyzeStore((s) => s.selectedSuggestionId);
  const selectSuggestion = useAnalyzeStore((s) => s.selectSuggestion);
  const showAlternatives = useAnalyzeStore((s) => s.showAlternatives);
  const acceptedSuggestionIds = useAnalyzeStore((s) => s.acceptedSuggestionIds);
  const rejectedSuggestionIds = useAnalyzeStore((s) => s.rejectedSuggestionIds);
  const editedSuggestions = useAnalyzeStore((s) => s.editedSuggestions);
  const autoCorrectedSuggestionIds = useAnalyzeStore(
    (s) => s.autoCorrectedSuggestionIds,
  );
  const currentEsBody = useAnalyzeStore((s) => s.currentEsBody);
  // 2026-05-28 dogfood round 3 ⑤ 直接編集 bug fix: 直接編集 flatten で焼き込み済の id 集合。
  // getDerivedEsLength に渡して二重適用を防ぐ(派生 ES 文字数表示の正確性を維持)。
  const bakedSuggestionIds = useAnalyzeStore((s) => s.bakedSuggestionIds);

  // 2026-05-25 Task #18: partial refresh の loading / animation 状態を購読。
  // selected suggestion がこれらに該当する場合、SuggestionCard の周囲に状態 banner を被せる
  // (内部 HITL 実装は触らない、外側ラッパで visual representation のみ追加)。
  const partialRefreshSeedIds = useAnalyzeStore(
    (s) => s.partialRefreshSeedIds,
  );
  const pendingDeletedSuggestionIds = useAnalyzeStore(
    (s) => s.pendingDeletedSuggestionIds,
  );
  const recentlyAddedSuggestionIds = useAnalyzeStore(
    (s) => s.recentlyAddedSuggestionIds,
  );
  const recentlyUpdatedSuggestionIds = useAnalyzeStore(
    (s) => s.recentlyUpdatedSuggestionIds,
  );
  // 2026-05-28 dogfood round 3 ②④: 再評価で変わりそうな指摘の id 群。
  //  - ② skip: auto-select useEffect が次選択から外す(変わる前のものを見せない)
  //  - 全件 edge: pending が全て再評価中なら強制選択せず「待ち」表示(下記 JSX 分岐)
  const reEvaluatingSuggestionIds = useAnalyzeStore(
    (s) => s.reEvaluatingSuggestionIds,
  );
  const partialRefreshInProgress = useAnalyzeStore(
    (s) => s.partialRefreshInProgress,
  );

  // Task #32a (2026-05-25): auto-select useEffect の活性条件として活用
  // (他タブ表示中は auto-select を抑止する)
  const activeTab = useAnalyzeStore((s) => s.activeTab);

  // コンパクト全件一覧 overlay の開閉(sparring 推奨案: 完全廃止せず toggle で残す保険)。
  // デフォルト false = 1 件詳細モードに集中、ユーザーが任意で開く。
  const [compactListOpen, setCompactListOpen] = React.useState(false);

  // selected な suggestion を取得(無ければ null)
  const selectedSuggestion = React.useMemo(() => {
    if (selectedSuggestionId === null) return null;
    return suggestions.find((s) => s.id === selectedSuggestionId) ?? null;
  }, [suggestions, selectedSuggestionId]);

  // ナビゲーション順序 = 未処理 → 自動修正 → 採用 → 編集 → 却下 の status 優先で並べ、
  // 同 status 内は original_span.start 昇順(= 上から順 / ES の出現順)。
  //
  // 2026-05-28 dogfood round 3 ③: 同 status 内の display_priority tiebreak を **除去**。
  //   短い ES では priority 並べ替えの利点が小さく、ES を上下に飛び回って読み流れが
  //   切れるため、status グループ内は純粋に「上から順」にする(priority は色タグのみ)。
  //   store の pickNextPendingSuggestionId と同じ「上から順」方針に揃える。
  //   span が同一の稀ケースは id 昇順で決定性を担保。
  //
  // 設計判断: ナビゲーションは「次の判断対象を探す」UX が中心 → 未処理優先(status)を
  //   主キーに残す。status を跨ぐ場合も「全 suggestion を順に巡れる」ことを担保しつつ、
  //   各 status グループ内は ES の出現順で読み流れを保つ。
  const navigableSuggestions = React.useMemo(() => {
    function statusWeight(s: Suggestion): number {
      if (autoCorrectedSuggestionIds.includes(s.id)) return 4;
      if (s.id in editedSuggestions) return 2;
      if (acceptedSuggestionIds.includes(s.id)) return 3;
      if (rejectedSuggestionIds.includes(s.id)) return 1;
      return 5; // pending = 最優先
    }
    const filtered = showAlternatives
      ? suggestions
      : suggestions.filter((s) => s.category !== "alternative");
    return filtered
      .slice()
      .sort((a, b) => {
        const sDiff = statusWeight(b) - statusWeight(a);
        if (sDiff !== 0) return sDiff;
        // 2026-05-28 ③: span 昇順を tiebreak の主キーに(priority は使わない)
        const spanDiff = a.original_span.start - b.original_span.start;
        if (spanDiff !== 0) return spanDiff;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
  }, [
    suggestions,
    showAlternatives,
    autoCorrectedSuggestionIds,
    editedSuggestions,
    acceptedSuggestionIds,
    rejectedSuggestionIds,
  ]);

  // 現在 selected の index(navigableSuggestions 内、無ければ -1)
  const selectedIndex = React.useMemo(() => {
    if (selectedSuggestionId === null) return -1;
    return navigableSuggestions.findIndex((s) => s.id === selectedSuggestionId);
  }, [navigableSuggestions, selectedSuggestionId]);

  // ---------------------------------------------------------------------------
  // Task #32a (2026-05-25): 詳細展開ヘッダ用カテゴリ別件数
  // ---------------------------------------------------------------------------
  // 「左側にカテゴリ別件数 +(上から順)、右側にナビゲーション」のヘッダレイアウト用。
  // alternative トグル状態に追従する navigableSuggestions を集計対象とする
  // (alternative 非表示時は alternative count = 0、UI と count の整合)。
  // category enum 値「error / convention / alternative」は Load-bearing(schema /
  // few-shot / system prompt の全件影響)のため絶対にリネームしない、表示語のみ messages
  // JSON 側で変更する設計(Task #32a 修正 4)。
  const categoryCounts = React.useMemo(() => {
    let error = 0;
    let convention = 0;
    let alternative = 0;
    for (const s of navigableSuggestions) {
      if (s.category === "error") error += 1;
      else if (s.category === "convention") convention += 1;
      else if (s.category === "alternative") alternative += 1;
    }
    return { error, convention, alternative };
  }, [navigableSuggestions]);

  // ---------------------------------------------------------------------------
  // 1 件詳細展開モード (2026-05-25) — selected === null 時の出し分けに使う derived state
  // ---------------------------------------------------------------------------
  // hooks rule のため、JSX 出し分け前に全 useMemo を完了させる(早期 return より上に置く)。
  //
  // pendingCount: alternative トグル設定下で「ユーザー判断が必要な未処理」件数。
  //   = 0  → 完了画面、> 0 → 自動選択中 placeholder(本来は瞬時に消える、後述 Task #30 useEffect 参照)
  // derivedEsLength: 派生 ES 文字数(完了画面の文字数サマリ用、数値スコアは出さない)
  const pendingCount = React.useMemo(() => {
    const accepted = new Set(acceptedSuggestionIds);
    const rejected = new Set(rejectedSuggestionIds);
    const auto = new Set(autoCorrectedSuggestionIds);
    return suggestions.filter((s) => {
      if (!showAlternatives && s.category === "alternative") return false;
      if (accepted.has(s.id)) return false;
      if (rejected.has(s.id)) return false;
      if (s.id in editedSuggestions) return false;
      if (auto.has(s.id)) return false;
      return true;
    }).length;
  }, [
    suggestions,
    showAlternatives,
    acceptedSuggestionIds,
    rejectedSuggestionIds,
    editedSuggestions,
    autoCorrectedSuggestionIds,
  ]);

  const derivedEsLength = React.useMemo(() => {
    if (!currentEsBody) return 0;
    return getDerivedEsLength(
      currentEsBody,
      suggestions,
      acceptedSuggestionIds,
      editedSuggestions,
      bakedSuggestionIds,
    );
  }, [
    currentEsBody,
    suggestions,
    acceptedSuggestionIds,
    editedSuggestions,
    bakedSuggestionIds,
  ]);

  // 次の指摘 / 前の指摘 ハンドラ(circular)
  const handlePrev = React.useCallback(() => {
    if (navigableSuggestions.length === 0) return;
    if (selectedIndex === -1) {
      selectSuggestion(navigableSuggestions[0].id);
      return;
    }
    const nextIdx =
      (selectedIndex - 1 + navigableSuggestions.length) % navigableSuggestions.length;
    selectSuggestion(navigableSuggestions[nextIdx].id);
  }, [navigableSuggestions, selectedIndex, selectSuggestion]);

  const handleNext = React.useCallback(() => {
    if (navigableSuggestions.length === 0) return;
    if (selectedIndex === -1) {
      selectSuggestion(navigableSuggestions[0].id);
      return;
    }
    const nextIdx = (selectedIndex + 1) % navigableSuggestions.length;
    selectSuggestion(navigableSuggestions[nextIdx].id);
  }, [navigableSuggestions, selectedIndex, selectSuggestion]);

  // Commit D-3 (2026-05-25): キーボードナビゲーション
  // - J / ArrowDown = 次の指摘
  // - K / ArrowUp = 前の指摘
  // - Escape = 一覧に戻る
  //
  // 入力系要素(input / textarea / contentEditable)にフォーカスがある時は無効化、
  // Cmd/Ctrl 修飾キー併用時も無効化(他のショートカットを侵食しない)。
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 修飾キー併用 = 他ショートカットの可能性、本 handler は素押しのみ反応
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // 入力系にフォーカス中は無視(typing と衝突するため)
      const active = document.activeElement;
      if (active) {
        const tag = active.tagName.toLowerCase();
        if (tag === "input" || tag === "textarea") return;
        if (active.getAttribute("contenteditable") !== null) return;
      }
      switch (e.key) {
        case "j":
        case "ArrowDown":
          if (navigableSuggestions.length > 0) {
            e.preventDefault();
            handleNext();
          }
          break;
        case "k":
        case "ArrowUp":
          if (navigableSuggestions.length > 0) {
            e.preventDefault();
            handlePrev();
          }
          break;
        case "Escape":
          if (selectedSuggestionId !== null) {
            e.preventDefault();
            selectSuggestion(null);
          }
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    navigableSuggestions.length,
    selectedSuggestionId,
    handleNext,
    handlePrev,
    selectSuggestion,
  ]);

  // ---------------------------------------------------------------------------
  // Task #30 (2026-05-25): auto-select 強化 useEffect(placeholder 永遠化の根本対策)
  // ---------------------------------------------------------------------------
  // `selectedSuggestionId === null` かつ未処理 suggestion が残っていれば、最優先
  // pending を即セットする。`lib/state/analyze_store.ts` の auto-select 効果は
  // `acceptSuggestion` / `rejectSuggestion` / `editSuggestion` の各 action 内に
  // 内蔵されている設計(SuggestionCard.tsx L286-289 のコメント参照)であり、
  // `selectSuggestion(null)` 単体経路(Esc キー / Cmd+Z / その他)では auto-select
  // が走らない。結果として下方の placeholder UI(L469-510)が永遠に表示される
  // dogfood bug が観察されたため、UI 層で fallback として走らせる。
  //
  // 設計判断: store(`selectSuggestion` action 自体)は無変更。Phase G の
  // 「auto-select は accept/reject/edit action 内に内蔵」設計意図を尊重し、
  // 副作用を UI 層に局所化する。placeholder UI も保険として残す(useEffect の
  // race condition で 1 tick だけ見える可能性、本 useEffect が何らかの理由で発火
  // しない極端なケース)。
  //
  // 未処理判定ロジックは下方 L504-510 の「最優先から始める」手動ボタンと同等
  // (accepted / rejected / edited / autoCorrected を除外、残りを navigableSuggestions
  // の優先順序(未処理優先 + 高優先優先 + span 昇順)で先頭から走査)。
  //
  // Task #32a (2026-05-25): 「他タブ表示中は auto-select を走らせない」guard を追加。
  //   - 旧設計では「ユーザーが企業要約タブを開いている時でも、内部で SuggestionDetailPanel
  //     が render され続けるため auto-select が走る → 戻った時に意図しない suggestion が
  //     selected」という副作用があった。
  //   - activeTab === "suggestions" の時のみ走らせることで、ユーザーの「企業要約 / 面接
  //     質問 / 履歴」閲覧中に suggestions タブ側で勝手に状態が変わる事故を防ぐ。
  //   - 指摘タブに戻った時(activeTab が "suggestions" に切り替わる)に effect が
  //     再評価され、必要なら最優先 pending を即セットする(挙動は旧設計と等価)。
  React.useEffect(() => {
    if (activeTab !== "suggestions") return;
    if (selectedSuggestionId !== null) return;
    if (navigableSuggestions.length === 0) return;
    const firstPending = navigableSuggestions.find((s) => {
      if (acceptedSuggestionIds.includes(s.id)) return false;
      if (rejectedSuggestionIds.includes(s.id)) return false;
      if (s.id in editedSuggestions) return false;
      if (autoCorrectedSuggestionIds.includes(s.id)) return false;
      // 2026-05-28 dogfood round 3 ②: 再評価で変わりそうな指摘は次選択から外す
      // (変わる前のものを見せて考えさせない)。store の pickNext と同じ excludeIds 方針。
      if (reEvaluatingSuggestionIds.includes(s.id)) return false;
      return true;
    });
    // 2026-05-28 dogfood round 3 edge: 残り pending が全て再評価中(firstPending = undefined)
    // なら強制選択しない。selectedSuggestionId を null のままにし、JSX 側で「再評価中、
    // お待ちください」状態を出す。1 tick で再評価が終われば通常選択に戻る。
    if (firstPending) {
      selectSuggestion(firstPending.id);
    }
  }, [
    activeTab,
    selectedSuggestionId,
    navigableSuggestions,
    acceptedSuggestionIds,
    rejectedSuggestionIds,
    editedSuggestions,
    autoCorrectedSuggestionIds,
    reEvaluatingSuggestionIds,
    selectSuggestion,
  ]);

  // selected な suggestion がある = 詳細展開モード
  if (selectedSuggestion) {
    return (
      <div
        className="flex flex-col gap-3"
        role="region"
        aria-label={t("region_selected_aria")}
      >
        {/* ヘッダ: 左側にカテゴリ別件数 +(上から順)、右側にナビゲーション(「N / M」+ 前/次)
            2026-05-28 ③: ヒント文言を「(優先度順)」→「(上から順)」に変更(順序を span 昇順に変更)。
            Task #22 (2026-05-25): キーボードショートカット表示(J / ↓ / K / ↑ / Esc)を **削除**。
            v1 課題スコープでは「ヘビーユーザー向け表現」が過剰と判断。キーボード機能本体
            (L207-249 の useEffect)は維持し、UI 表記のみ撤去する(DECISIONS §F)。
            Task #30 (2026-05-25): 「← 戻る」ボタンを撤去。代替動線は Esc キーと
            「全件一覧を見る」に集約。
            Task #32a (2026-05-25): ヘッダ左側にカテゴリ別件数 + 順序ヒントを追加。
              dogfood 観察「ヘッダの空きスペースに件数 + 順序表示が欲しい」に対応。
              レイアウトを justify-end から justify-between に戻し、subtle テキストで
              情報密度を上げる。category enum 値は Load-bearing(リネーム禁止)、表示語のみ
              messages JSON で「要修正 / 推奨 / 代替案」に再定義(Task #32a 修正 4)。
              色は SuggestionCard 内 CATEGORY_BADGE_CLASS を borrow せず、subtle な
              border + text-color の inline 表現で軽量化(SuggestionCard 触らない規律)。 */}
        <div className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-card/70 px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            {/* 左側: カテゴリ別件数 + 順序ヒント(上から順) */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
              {categoryCounts.error > 0 && (
                <span className="inline-flex items-center rounded border border-destructive/40 bg-destructive/5 px-1.5 py-0.5 text-destructive">
                  {t("header_count_template", {
                    label: tCategory("error"),
                    count: categoryCounts.error,
                  })}
                </span>
              )}
              {categoryCounts.convention > 0 && (
                <span className="inline-flex items-center rounded border border-amber-500/40 bg-amber-50/40 px-1.5 py-0.5 text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
                  {t("header_count_template", {
                    label: tCategory("convention"),
                    count: categoryCounts.convention,
                  })}
                </span>
              )}
              {categoryCounts.alternative > 0 && (
                <span className="inline-flex items-center rounded border border-blue-400/40 bg-blue-50/40 px-1.5 py-0.5 text-blue-800 dark:bg-blue-900/20 dark:text-blue-200">
                  {t("header_count_template", {
                    label: tCategory("alternative"),
                    count: categoryCounts.alternative,
                  })}
                </span>
              )}
              {/* 2026-05-28 ③ (上から順)ヒント: navigableSuggestions の sort 順序を一言で伝える
                  (旧: (優先度順)。順序を ES の出現順に変更したため文言も更新) */}
              {navigableSuggestions.length > 1 && (
                <span>{t("top_down_order_hint")}</span>
              )}
            </div>
            {/* 右側: ナビゲーション(N / M + 前/次) */}
            <div className="flex items-center gap-2">
              {navigableSuggestions.length > 1 && (
                <>
                  <span className="text-[10px] text-muted-foreground">
                    {selectedIndex + 1} / {navigableSuggestions.length}
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={handlePrev}
                    aria-label={t("nav_prev_aria")}
                    title={t("nav_prev_title")}
                  >
                    <ChevronLeft className="size-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={handleNext}
                    aria-label={t("nav_next_aria")}
                    title={t("nav_next_title")}
                  >
                    <ChevronRight className="size-3" />
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* 詳細表示: SuggestionCard 再利用(内部 HITL 実装は不変、dispatch §4 触らない領域)
            2026-05-25 Task #18: partial refresh の state に応じて外側ラッパで visual を被せる:
              - seed: AI が見直し中 → 上部に「影響範囲を見直しています」hint + spinner
              - pending deletion: deleted 予告 → fade out animation + 上部 banner
              - recently added: 新規追加 → fade in animation + 「新規追加」badge
              - recently updated: 更新済 → 短い highlight flash + 「更新済」badge

            2026-05-25 Task #28: key={selectedSuggestion.id} を付与し、suggestion 切替時に
            SuggestionCard を React に再 mount させる。SuggestionCard 内部の
            useState(suggestion.proposed) の初期値は mount 時のみ評価されるため、key 無しでは
            別 suggestion を選んでも編集テキストエリアの draftText が前回のまま残る不具合があった
            (dogfood 観察 2026-05-25)。同時に editing flag もリセットされ、新規 suggestion で
            inline editor は閉じた状態から始まる(spec として自然)。
            useEffect で draftText を reset する代替案より、key prop による再 mount の方が
            副作用(cleanup / dependency 配列の複雑化)が少なくシンプル。 */}
        <PartialRefreshSuggestionWrapper
          suggestionId={selectedSuggestion.id}
          isSeed={partialRefreshSeedIds.includes(selectedSuggestion.id)}
          isPendingDeletion={pendingDeletedSuggestionIds.includes(
            selectedSuggestion.id,
          )}
          isRecentlyAdded={recentlyAddedSuggestionIds.includes(
            selectedSuggestion.id,
          )}
          isRecentlyUpdated={recentlyUpdatedSuggestionIds.includes(
            selectedSuggestion.id,
          )}
          tCard={tCard}
        >
          <SuggestionCard key={selectedSuggestion.id} suggestion={selectedSuggestion} />
        </PartialRefreshSuggestionWrapper>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // selected === null: 状況に応じて placeholder / 完了画面 / 空状態を出し分ける
  // ---------------------------------------------------------------------------
  //
  // 状態分岐:
  //   1) suggestions.length === 0 (初回 done だが指摘ゼロ) → 空状態 (既存 EmptyState 流用)
  //   2) pendingCount > 0 (まだ未処理あり) → Task #30 の auto-select 強化 useEffect が
  //      即 firstPending をセットするため、本来この分岐の placeholder は瞬時に置き換わる。
  //      race condition / useEffect 不発火の極端ケースの保険として残置(L478 周辺の詳細コメント参照)。
  //   3) pendingCount === 0 (全件処理済) → 完了画面 (派生 ES 字数 + 件数サマリ + 履歴導線)
  //
  // pendingCount / derivedEsLength は上記 useMemo で算出済(hooks rule 遵守のため
  // 早期 return より上で計算している)。
  const acceptedCount = acceptedSuggestionIds.length;
  const rejectedCount = rejectedSuggestionIds.length;
  const editedCount = Object.keys(editedSuggestions).length;
  const autoCount = autoCorrectedSuggestionIds.length;
  const originalEsLength = currentEsBody.length;

  // suggestions が空: 既存 EmptyState を流用
  if (suggestions.length === 0) {
    return (
      <div
        className="flex flex-col gap-3"
        role="region"
        aria-label={t("region_list_aria")}
      >
        <SuggestionDetailEmptyState />
      </div>
    );
  }

  // 完了画面: pendingCount === 0
  if (pendingCount === 0) {
    return (
      <div
        className="flex flex-col gap-3"
        role="region"
        aria-label={t("region_completion_aria")}
      >
        <div className="rounded-md border border-emerald-500/40 bg-emerald-50/60 dark:bg-emerald-950/30 px-4 py-5 text-center">
          <CheckCircle2
            className="mx-auto mb-2 size-6 text-emerald-600 dark:text-emerald-400"
            aria-hidden
          />
          <h3 className="mb-1 text-sm font-semibold text-emerald-800 dark:text-emerald-200 text-jp">
            {t("completion_title", { count: suggestions.length })}
          </h3>
          <p className="text-[11px] text-emerald-700/80 dark:text-emerald-300/80 text-jp">
            {t("completion_subtitle")}
          </p>
          <dl className="mx-auto mt-3 flex max-w-xs flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px]">
            {autoCount > 0 && (
              <div className="flex items-center gap-1 text-emerald-700/90 dark:text-emerald-300/90">
                <dt className="text-jp">{t("completion_label_auto")}</dt>
                <dd className="font-mono">{autoCount}</dd>
              </div>
            )}
            {acceptedCount - autoCount > 0 && (
              <div className="flex items-center gap-1 text-emerald-700/90 dark:text-emerald-300/90">
                <dt className="text-jp">{t("completion_label_accepted")}</dt>
                <dd className="font-mono">{acceptedCount - autoCount}</dd>
              </div>
            )}
            {editedCount > 0 && (
              <div className="flex items-center gap-1 text-emerald-700/90 dark:text-emerald-300/90">
                <dt className="text-jp">{t("completion_label_edited")}</dt>
                <dd className="font-mono">{editedCount}</dd>
              </div>
            )}
            {rejectedCount > 0 && (
              <div className="flex items-center gap-1 text-emerald-700/90 dark:text-emerald-300/90">
                <dt className="text-jp">{t("completion_label_rejected")}</dt>
                <dd className="font-mono">{rejectedCount}</dd>
              </div>
            )}
          </dl>
          {/* 派生 ES サマリ: 字数だけ。数値スコアは出さない(Inviolable constraint) */}
          {originalEsLength > 0 && (
            <p className="mt-3 text-[11px] text-emerald-700/80 dark:text-emerald-300/80 text-jp">
              {t("completion_es_chars", {
                derived: derivedEsLength,
                original: originalEsLength,
              })}
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            {onRequestHistoryTab && (
              <Button
                variant="outline"
                size="sm"
                onClick={onRequestHistoryTab}
                aria-label={t("completion_view_history_aria")}
              >
                <Layers className="size-3" />
                <span>{t("completion_view_history")}</span>
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCompactListOpen(true)}
              aria-label={t("compact_list_aria")}
            >
              <ListChecks className="size-3" />
              <span>{t("compact_list_label")}</span>
            </Button>
          </div>
        </div>
        {compactListOpen && (
          <CompactListOverlay
            suggestions={suggestions}
            onClose={() => setCompactListOpen(false)}
          />
        )}
      </div>
    );
  }

  // pendingCount > 0 (Cmd+Z 直後 / Esc / その他 selectSuggestion(null) 経路)
  // → 自動選択中 placeholder + 「最優先から始める」手動ボタン
  //
  // Task #30 (2026-05-25): 上方の auto-select 強化 useEffect(L271 周辺)で
  // selectedSuggestionId === null && navigableSuggestions に未処理あり → 即 firstPending
  // をセットするため、本 placeholder は通常 1 tick も見えない(useEffect 発火が同期的)。
  // ただし race condition / useEffect 不発火の極端ケースに備えて UI は残置、手動 fallback
  // ボタンも保険として維持する。store の auto-select が action 内蔵設計のままなので、
  // 本 placeholder と useEffect の両方が selectSuggestion(null) 経路の二重保険になる。
  //
  // 2026-05-28 dogfood round 3 edge: 残り pending が全て再評価中(reEvaluating)の稀ケース。
  //   auto-select useEffect が「未処理かつ非再評価中」を見つけられず強制選択しない結果、
  //   本 placeholder が表示される。この時は「自動選択中…」ではなく「再評価中、お待ちください」
  //   を出す(spinner は共通)。手動「最優先から始める」ボタンは、選べる非再評価中 pending が
  //   無いため非表示にする(押しても何も選べない誤導を防ぐ)。1 tick で再評価が終われば
  //   通常の auto-select 経路に戻る。
  const selectablePending = navigableSuggestions.find((s) => {
    if (acceptedSuggestionIds.includes(s.id)) return false;
    if (rejectedSuggestionIds.includes(s.id)) return false;
    if (s.id in editedSuggestions) return false;
    if (autoCorrectedSuggestionIds.includes(s.id)) return false;
    if (reEvaluatingSuggestionIds.includes(s.id)) return false;
    return true;
  });
  // pendingCount > 0 かつ選べる非再評価中 pending が無い = 全 pending 再評価中の待ち状態。
  const allPendingReEvaluating =
    selectablePending === undefined && partialRefreshInProgress;
  return (
    <div
      className="flex flex-col gap-3"
      role="region"
      aria-label={t("region_pending_aria")}
    >
      <div
        className={cn(
          "flex flex-col items-center gap-2 rounded-md border border-dashed border-border/60 bg-muted/30 px-4 py-6 text-center",
          "text-[11px] text-muted-foreground",
        )}
        role="status"
        aria-live="polite"
      >
        <Loader2
          className="size-4 animate-spin text-primary/70"
          aria-hidden
        />
        <span className="text-jp">
          {allPendingReEvaluating
            ? t("all_reevaluating_hint")
            : t("auto_selecting_hint")}
        </span>
        {/* 全 pending 再評価中のときは手動ボタンを隠す(選べる対象が無い) */}
        {!allPendingReEvaluating && selectablePending !== undefined && (
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              // 最優先未処理 suggestion を選ぶ(store の auto-select と同等の優先度ロジック)。
              // navigableSuggestions は処理済も含む順序なので、未処理かつ非再評価中だけを優先する。
              if (selectablePending) selectSuggestion(selectablePending.id);
            }}
            aria-label={t("first_button_aria")}
            title={t("first_button_title")}
          >
            <ChevronRight className="size-3" />
            <span>{t("first_button")}</span>
          </Button>
        )}
      </div>
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setCompactListOpen(true)}
          aria-label={t("compact_list_aria")}
        >
          <ListChecks className="size-3" />
          <span>{t("compact_list_label")}</span>
        </Button>
      </div>
      {compactListOpen && (
        <CompactListOverlay
          suggestions={suggestions}
          onClose={() => setCompactListOpen(false)}
        />
      )}
    </div>
  );
}

// =============================================================================
// CompactListOverlay (2026-05-25): 全件一覧 overlay(任意展開)
// =============================================================================
// 役割: ユーザーが「指摘全体を一覧で見たい」時に右パネル上にオーバーレイ表示する。
// デフォルトは閉、ユーザーが ListChecks ボタンを押した時にだけ開く保険 UX。
// 中身は既存 SuggestionListPanel を再利用(件数 badge / alternative トグル / 自動修正済
// セクションをそのまま流用、双方向ハイライトも store 経由で機能する)。
function CompactListOverlay({
  suggestions,
  onClose,
}: {
  suggestions: Suggestion[];
  onClose: () => void;
}) {
  const t = useTranslations("suggestionDetail");
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-card/70 p-3 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-medium text-muted-foreground text-jp">
          {t("compact_list_title")}
        </h4>
        <Button
          variant="ghost"
          size="xs"
          onClick={onClose}
          aria-label={t("compact_list_close_aria")}
        >
          <X className="size-3" />
          <span>{t("compact_list_close_label")}</span>
        </Button>
      </div>
      <SuggestionListPanel suggestions={suggestions} />
    </div>
  );
}

// =============================================================================
// 空状態(suggestions が空 — 初回 done だが指摘ゼロ、または全部対応済)
// =============================================================================
export function SuggestionDetailEmptyState() {
  const t = useTranslations("suggestionDetail");
  return (
    <div className="rounded-md border border-dashed border-border/60 bg-muted/30 px-4 py-8 text-center text-xs text-muted-foreground">
      <ListChecks className="mx-auto mb-2 size-5 text-muted-foreground/60" />
      <p>{t("empty_state")}</p>
    </div>
  );
}

// =============================================================================
// 2026-05-25 Task #18: PartialRefreshSuggestionWrapper
// =============================================================================
// SuggestionCard の外側に被せる visual wrapper。partial refresh の状態に応じて
// 4 種類の表現を上乗せする(card 内部の HITL 実装は dispatch §4 で触らない領域なので、
// 外側ラッパだけで対応):
//
//   1. seed (AI が見直し中): 上部 hint banner + spinner、card は通常表示
//   2. pending deletion (削除予告): 上部 banner + fade-out animation(1.5 秒の delay 後に
//      実際に suggestions から消える、それまでは半透明で残す)
//   3. recently added (新規追加): 上部 badge + fade-in animation(0.5 秒)
//   4. recently updated (更新済): 短い highlight flash + 軽い badge(0.5 秒)
//
// 注: 同時に複数 state を持つことは通常無いが、defensive に表現を重ねる(spinner と
//     fade-out が同時に走ることはあり得ないが、UI 上はどちらも有意味)。
//
// Task #31 (2026-05-25): named export 化、SuggestionListPanel からも import 可能に。
//   詳細展開モード(SuggestionDetailPanel)と一覧モード(SuggestionListPanel の
//   visibleSuggestions + 自動修正済セクション)の両方で同じ visual を提供する。
//   採用に伴う scoped partial refresh(Task #31 修正 1)が走った時、ユーザーが
//   どのモードで見ていても影響を受ける suggestion の状態(seed loading / added /
//   updated / pendingDeletion)が視認できるようにするための named export 化。
//   内部実装(visual ロジック、animation、上部 hint banner)は無変更。
//
// Inviolable constraints:
//   - 数値スコア禁止: spinner と文言のみ、数値は出さない
//   - すべての操作は Undo 可能: pending deletion 中も Undo / 履歴 revert で取り戻せる
//     (store の autoCorrected / acceptedSuggestionIds は applyPartialResult 時点で
//      deleted 除外後の最終 set で計算されているため、revert すれば再評価で復活)
export function PartialRefreshSuggestionWrapper({
  isSeed,
  isPendingDeletion,
  isRecentlyAdded,
  isRecentlyUpdated,
  tCard,
  children,
}: {
  suggestionId: string;
  isSeed: boolean;
  isPendingDeletion: boolean;
  isRecentlyAdded: boolean;
  isRecentlyUpdated: boolean;
  tCard: ReturnType<typeof useTranslations<"suggestionCard">>;
  children: React.ReactNode;
}) {
  // 何も状態が無い場合は wrapper を当てず children を素通し(余計な div を増やさない)
  if (!isSeed && !isPendingDeletion && !isRecentlyAdded && !isRecentlyUpdated) {
    return <>{children}</>;
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        // pending deletion: 全体 fade-out + 半透明、card に「もうすぐ消える」感を演出
        isPendingDeletion && "animate-fade-out opacity-70",
        // recently added: fade-in animation、card が「降りてきた」感を演出
        isRecentlyAdded && !isPendingDeletion && "animate-fade-in",
        // recently updated: highlight flash、card content が変わったことを認識させる
        isRecentlyUpdated &&
          !isPendingDeletion &&
          !isRecentlyAdded &&
          "animate-highlight-flash",
      )}
      data-partial-refresh-state={
        isPendingDeletion
          ? "pending-deletion"
          : isSeed
            ? "seed"
            : isRecentlyAdded
              ? "added"
              : isRecentlyUpdated
                ? "updated"
                : undefined
      }
    >
      {/* seed: AI 見直し中 hint(card の上に薄い banner)
          delete / added / updated と独立して表示しうるが、典型的には deleted との重ね合わせは無い
          (seed が削除対象になるケースは AI 判断次第) */}
      {isSeed && !isPendingDeletion && (
        <div
          className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
          <span className="text-foreground/85 text-jp">
            {tCard("partial_refresh_seed_hint")}
          </span>
        </div>
      )}

      {/* pending deletion: 削除予告 banner */}
      {isPendingDeletion && (
        <div
          className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-50/60 dark:bg-amber-950/30 px-3 py-2 text-xs"
          role="status"
          aria-live="polite"
        >
          <X className="size-3 shrink-0 text-amber-700 dark:text-amber-400" />
          <span className="text-amber-800 dark:text-amber-200 text-jp">
            {tCard("partial_refresh_pending_deletion")}
          </span>
        </div>
      )}

      {/* recently added: 「新規追加」badge */}
      {isRecentlyAdded && !isPendingDeletion && (
        <div className="flex">
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-50/60 dark:bg-emerald-950/30 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300 text-jp">
            {tCard("partial_refresh_added_badge")}
          </span>
        </div>
      )}

      {/* recently updated: 「更新済」badge(added と排他的に表示) */}
      {isRecentlyUpdated && !isPendingDeletion && !isRecentlyAdded && (
        <div className="flex">
          <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary text-jp">
            {tCard("partial_refresh_updated_label")}
          </span>
        </div>
      )}

      {children}
    </div>
  );
}
