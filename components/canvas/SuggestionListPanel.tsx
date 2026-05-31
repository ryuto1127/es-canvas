"use client";

// =============================================================================
// Phase G Step 3a: SuggestionListPanel — 右ペインの指摘リスト(新規)
// =============================================================================
//
// 責務:
//  - 全 suggestion を inline カードとして縦に列挙
//  - カテゴリ別件数 badge + alternative トグル をヘッダに配置
//  - 各カードに onMouseEnter/Leave (setHoveredSuggestion) で Canvas との双方向ハイライト
//  - クリック / related navigation での selected を SuggestionCard 側が処理
//  - 「再分析する」「文字数を抑える」アクションは Canvas 上部に維持(編集モード直結のため)
//
// Task #31 (2026-05-25): 一覧モードでも partial refresh の状態 visual を表示。
//   PartialRefreshSuggestionWrapper を SuggestionDetailPanel から import して、
//   visibleSuggestions / 自動修正済セクションの両方で各 SuggestionCard を wrap。
//   採用に伴う scoped partial refresh(Task #31 修正 1、acceptSuggestion 経路)が
//   走った時、影響を受ける suggestion に seed loading / added / updated /
//   pendingDeletion の visual が一覧モードでも出るようにする(詳細展開モードと等価)。
//
// 設計判断(Step 3a 新規):
//  1) **Popover 廃止 → リスト型 UI** (F1.3 を上書き): 全 suggestion を同時可視。
//     Canvas で ES 本文の文脈、右ペインで指摘詳細、両方を行き来できる。
//  2) **表示順は original_span.start 昇順** (Canvas の ES 本文と同じ走査順)。
//     ユーザーが「文章の前から後ろへ」読みながらリストも同じ順で処理できる。
//     カテゴリでフィルタしても、各カテゴリ内では同じ start 順で並ぶ。
//  3) **alternative トグル維持** — F1.x の精神(代替案は過剰提案で判断疲労を生む)。
//     デフォルト false、トグル ON で alternative カテゴリの suggestion を表示。
//     件数 badge は alternative も常時表示するが、トグル OFF 時は subtle に
//     (dimmed)、ON 時は通常トーン。
//  4) **件数 badge は未対応のみカウント** (UX3A.2 と整合): 採用 / 編集 / 却下は
//     「対応済」として件数から除外。Canvas 上部の件数 badge と完全に同じ算出ロジック。
//  5) **空状態の表現**: suggestions が空(初回 done だが指摘ゼロ、または refresh で
//     全部対応済になった等)の場合は「指摘はありません」を muted で表示。
//  6) **対応済のカードもリストに残す**: アクションフッタは「対応済」表示になるが、
//     カード自体はリスト内に残す(Undo の手がかりが消えない、ユーザーが「何を採用
//     したか」を見返せる)。Canvas のハイライトは消える(派生 ES と整合)が、
//     リスト側は履歴として可視。
//
// AGENTS.md Inviolable constraints との対応:
//  - 数値スコア禁止: 件数 badge は「個数」表現、スコアは出さない
//  - 指摘最大 15 個: API 側で保証済、リスト長も自動的に 15 以下
//  - ES 全面書き換え禁止: リストは個別カード単位、「全採用」ボタンはない
//
// SSOT: lib/state/analyze_store.ts (showAlternatives, acceptedSuggestionIds,
//         rejectedSuggestionIds, editedSuggestions, toggleAlternatives)
//       lib/schema/suggestion.ts (Suggestion, Category)

import * as React from "react";
import { useTranslations } from "next-intl";
import type { Category, Suggestion } from "@/lib/schema/suggestion";
import { useAnalyzeStore } from "@/lib/state/analyze_store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { ListChecks, RotateCcw, Wand2 } from "lucide-react";
// 2026-05-28 dogfood round 3: global 逆質問 section を撤去したため ClarificationBlock /
// ClarificationQuestion / HelpCircle の import は不要に。逆質問の描画は ClarificationSection
// に集約(SuggestionCard の named export は ClarificationSection が参照)。SuggestionCard
// 本体は引き続きリストカードとして使うため import は維持。
import { SuggestionCard } from "./SuggestionCard";
// Task #31 (2026-05-25): partial refresh 状態を一覧モードでも視覚化するため、
// SuggestionDetailPanel の named export を再利用。詳細モードと同じ visual を提供。
import { PartialRefreshSuggestionWrapper } from "./SuggestionDetailPanel";

// suggestion から短いサマリを作成(undoAllAutoCorrections に渡す)。
// SuggestionCard 側の buildSuggestionSummary と整合させるため、フォーマットを揃える。
// errorLabel は category.error の i18n された文字列。
function buildAutoCorrectedSummary(
  suggestion: Suggestion,
  errorLabel: string,
): string {
  const SNIPPET_LEN = 30;
  const snippet =
    suggestion.original.length > SNIPPET_LEN
      ? suggestion.original.slice(0, SNIPPET_LEN) + "…"
      : suggestion.original;
  return `[${errorLabel}] ${snippet}`;
}

// SuggestionListPanel — 右ペインのリスト本体。Canvas / 他コンポーネントから
// suggestions を props として受け取る(分析結果は ResultPanel が分岐済)。
export interface SuggestionListPanelProps {
  suggestions: Suggestion[];
}

export function SuggestionListPanel({ suggestions }: SuggestionListPanelProps) {
  const t = useTranslations("suggestionList");
  const tCategory = useTranslations("category");
  // Task #31 (2026-05-25): SuggestionDetailPanel と同じ PartialRefreshSuggestionWrapper
  // を使うため、suggestionCard 名前空間の翻訳も購読(banner 文言を共有)。
  const tCard = useTranslations("suggestionCard");
  // 2026-05-28 dogfood round 3: global 逆質問 section を撤去(ClarificationSection に集約)。
  // tClarification / globalClarificationQuestions の購読は不要に。
  const showAlternatives = useAnalyzeStore((s) => s.showAlternatives);
  const toggleAlternatives = useAnalyzeStore((s) => s.toggleAlternatives);
  const acceptedSuggestionIds = useAnalyzeStore((s) => s.acceptedSuggestionIds);
  const rejectedSuggestionIds = useAnalyzeStore((s) => s.rejectedSuggestionIds);
  const editedSuggestions = useAnalyzeStore((s) => s.editedSuggestions);
  // Phase G Step 3b-1 (2026-05-23): 自動修正済 id 集合を購読し、「自動修正済」セクション
  // と「全て元に戻す」ボタンの表示判定に使う。
  const autoCorrectedSuggestionIds = useAnalyzeStore(
    (s) => s.autoCorrectedSuggestionIds,
  );
  const undoAllAutoCorrections = useAnalyzeStore(
    (s) => s.undoAllAutoCorrections,
  );
  // Phase G Step 3b-1: selectedSuggestionId を購読し、選択された suggestion が
  // 自動修正済リストに含まれる場合は <details> を自動的に開く(scrollIntoView の
  // 到達点が closed details の中で見えない事故を防ぐ)。
  const selectedSuggestionId = useAnalyzeStore((s) => s.selectedSuggestionId);

  // Task #31 (2026-05-25): partial refresh の loading / animation 状態を購読。
  // 一覧モードの各 SuggestionCard を PartialRefreshSuggestionWrapper で囲むことで、
  // 詳細モードと同じ visual(seed banner / fade-out / fade-in / highlight flash)を提供。
  // 直接 props 伝播ではなく store 購読を採用した理由: wrapper は 1 件ごとに状態判定が
  // 必要だが、配列 includes で O(N) チェックが軽く、props 配線を全カードに伝える方が
  // 階層が深く保守コストが高い。store 購読で 4 配列を取得し includes 判定で十分高速。
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

  // カテゴリ別の未対応件数(Canvas 上部の counts と同じ算出ロジック)
  // UX3A.2: 対応済(採用 / 編集 / 却下)は件数から除外
  // Phase G Step 3b-1: 自動修正済も acceptedSuggestionIds に含まれているため自動的に除外
  // v2 Phase B4 (2026-05-26): structural を CountBadge として下段(L260 周辺)に表示。
  // 4 カテゴリすべてを集計対象に含め、CountBadge は error / convention / alternative /
  // structural の 4 種をレンダリングする(本 Phase で defensive 解除完了)。
  const counts = React.useMemo(() => {
    const c: Record<Category, number> = {
      error: 0,
      convention: 0,
      alternative: 0,
      structural: 0,
    };
    for (const s of suggestions) {
      if (acceptedSuggestionIds.includes(s.id)) continue;
      if (s.id in editedSuggestions) continue;
      if (rejectedSuggestionIds.includes(s.id)) continue;
      c[s.category]++;
    }
    return c;
  }, [suggestions, acceptedSuggestionIds, editedSuggestions, rejectedSuggestionIds]);

  // Phase G Step 3b-1: 自動修正済 suggestion を抽出(原文上の出現順 = start 昇順)
  const autoCorrectedSuggestions = React.useMemo(() => {
    return suggestions
      .filter((s) => autoCorrectedSuggestionIds.includes(s.id))
      .slice()
      .sort((a, b) => a.original_span.start - b.original_span.start);
  }, [suggestions, autoCorrectedSuggestionIds]);

  // 表示対象 suggestions:
  //  - Phase G Step 3a 以前: original_span.start 昇順(ES 本文の出現順)
  //  - Phase G Step 3b-2 〜 2026-05-27: display_priority 順(high → medium → low)+
  //    同順位内は original_span.start 昇順
  //  - 2026-05-28 dogfood round 3 ③: **original_span.start 昇順(上から順 / ES の出現順)に
  //    回帰**。短い ES では priority 並べ替えの利点が小さく、ES を上下に飛び回って読み流れが
  //    切れるため。priority は順序から外し、カードの色タグとしてのみ残す。store の
  //    pickNextPendingSuggestionId / SuggestionDetailPanel の navigableSuggestions と
  //    「上から順」方針を統一(③ の「自動選択 + 一覧順」を全経路で一貫させる)。span が同一の
  //    稀ケースは id 昇順で決定性を担保。
  //  - alternative トグル OFF なら alternative を除外
  //  - Phase G Step 3b-1: 自動修正済はメインリストから除外し別セクションへ
  // メインリストには pending / accepted (ユーザー能動) / edited / rejected のみが残る。
  const visibleSuggestions = React.useMemo(() => {
    const filtered = showAlternatives
      ? suggestions
      : suggestions.filter((s) => s.category !== "alternative");
    return filtered
      .slice()
      .filter((s) => !autoCorrectedSuggestionIds.includes(s.id))
      .sort((a, b) => {
        // 2026-05-28 ③: original_span.start 昇順(上から順)を主キー
        const spanDiff = a.original_span.start - b.original_span.start;
        if (spanDiff !== 0) return spanDiff;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
  }, [suggestions, showAlternatives, autoCorrectedSuggestionIds]);

  // <details> の open 状態を管理。
  // - デフォルト: false(閉じている、判断疲労を抑える)
  // - selectedSuggestionId が autoCorrectedSuggestionIds に含まれる時: 強制的に開く
  //   (closed のままだと scrollIntoView の到達点が見えない事故を防ぐ)
  // - ユーザーが手動で開閉した場合は userOpenedManually で記録、選択解除後はその状態を維持
  //
  // 実装: state は「ユーザーが手動で操作した最終状態」を保持し、render 時に
  // 「選択された suggestion が自動修正済リスト内に含まれる」場合は強制的に open=true
  // を return する(setState in effect を避け、純粋な derived render に倒す)。
  const [userOpenState, setUserOpenState] = React.useState(false);
  const selectedIsAutoCorrected =
    selectedSuggestionId !== null &&
    autoCorrectedSuggestionIds.includes(selectedSuggestionId);
  const autoSectionOpen = userOpenState || selectedIsAutoCorrected;

  // 「全て元に戻す」ハンドラ: 確認ダイアログを経て一括取り消し
  const errorLabel = tCategory("error");
  const handleUndoAll = React.useCallback(() => {
    if (autoCorrectedSuggestions.length === 0) return;
    // window.confirm はテスト不可能だが、CSR の標準的な確認 UX として最も軽量。
    // shadcn の AlertDialog を使うと依存が増えるが、ここは「最も誤操作の不安が大きい」
    // 行為(全件取り消し)なので簡易確認で十分。
    const ok = window.confirm(
      t("auto_section_undo_all_confirm", { count: autoCorrectedSuggestions.length }),
    );
    if (!ok) return;
    undoAllAutoCorrections(
      autoCorrectedSuggestions.map((s) => ({
        suggestion_id: s.id,
        suggestion_summary: buildAutoCorrectedSummary(s, errorLabel),
      })),
    );
  }, [autoCorrectedSuggestions, undoAllAutoCorrections, t, errorLabel]);

  return (
    <div
      className="flex flex-col gap-3"
      role="region"
      aria-label={t("region_aria")}
    >
      {/* ヘッダ: タイトル + 件数 badge 列 + alternative トグル */}
      <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-card/70 px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <ListChecks className="size-4 text-primary" />
            <span>{t("title")}</span>
          </h3>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none">
            <Switch
              checked={showAlternatives}
              onCheckedChange={() => toggleAlternatives()}
              aria-label={t("toggle_alternatives_aria")}
            />
            <span>{t("toggle_alternatives_label")}</span>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CountBadge category="error" count={counts.error} label={tCategory("error")} />
          <CountBadge category="convention" count={counts.convention} label={tCategory("convention")} />
          <CountBadge
            category="alternative"
            count={counts.alternative}
            label={tCategory("alternative")}
            dimmed={!showAlternatives}
          />
          {/* v2 Phase B4 (2026-05-26): structural CountBadge を 4 番目に追加。
              alternative トグル(showAlternatives)とは独立に常時表示(structural は
              代替案ではなく構造変更 = 別カテゴリで独立した判断対象)。 */}
          <CountBadge
            category="structural"
            count={counts.structural}
            label={tCategory("structural")}
          />
        </div>
      </div>

      {/* 2026-05-28 dogfood round 3: global 逆質問 section を **撤去**。
          逆質問は指摘タブ最上部の統一セクション(ClarificationSection、RightPanel が
          SuggestionDetailPanel の上にマウント)へ集約した。SuggestionListPanel は
          コンパクト全件一覧 overlay(CompactListOverlay)内でも再利用されるため、
          ここに global section を残すと統一セクションと二重表示になる。よって撤去。
          回答 state / 再分析の挙動は不変(ClarificationSection が ClarificationBlock を再利用)。 */}

      {/* リスト本体: 各 suggestion を inline カードで縦列挙
          Phase G Step 3b-1: 自動修正済はここに含まれず、下部の専用セクションへ */}
      {visibleSuggestions.length === 0 ? (
        <p className="rounded-md border border-border/60 bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground">
          {suggestions.length === 0
            ? t("empty_no_suggestions")
            : autoCorrectedSuggestions.length > 0 &&
                suggestions.length === autoCorrectedSuggestions.length
              ? t("empty_all_auto_corrected")
              : showAlternatives
                ? t("empty_with_alternatives")
                : t("empty_without_alternatives")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {visibleSuggestions.map((s) => (
            <li key={s.id}>
              {/* Task #31 (2026-05-25): 各 SuggestionCard を partial refresh の
                  状態 wrapper で囲み、一覧モードでも seed loading / added / updated /
                  pendingDeletion の visual を出す(詳細モードと等価)。
                  wrapper 内部実装は SuggestionDetailPanel の named export を参照。 */}
              <PartialRefreshSuggestionWrapper
                suggestionId={s.id}
                isSeed={partialRefreshSeedIds.includes(s.id)}
                isPendingDeletion={pendingDeletedSuggestionIds.includes(s.id)}
                isRecentlyAdded={recentlyAddedSuggestionIds.includes(s.id)}
                isRecentlyUpdated={recentlyUpdatedSuggestionIds.includes(s.id)}
                tCard={tCard}
              >
                <SuggestionCard suggestion={s} />
              </PartialRefreshSuggestionWrapper>
            </li>
          ))}
        </ul>
      )}

      {/* Phase G Step 3b-1: 自動修正済セクション(折りたたみ、デフォルト閉じる)
          - <details> 要素で expandable
          - デフォルトは閉じている(ユーザーがあえて開かないと邪魔にならない)
          - 件数を summary に明示
          - 「全て元に戻す」ボタン(各カード内の「元に戻す」と並列、一括 Undo) */}
      {autoCorrectedSuggestions.length > 0 && (
        <details
          open={autoSectionOpen}
          onToggle={(e) => {
            // ユーザー操作で開閉した場合、最新の open 状態を userOpenState に反映。
            // 自動展開(selectedIsAutoCorrected = true)中にユーザーが閉じても、
            // 次の選択時に再度自動で開く(意図しない閉じ込めを避ける)。
            setUserOpenState((e.currentTarget as HTMLDetailsElement).open);
          }}
          className="group rounded-md border border-emerald-500/30 bg-emerald-50/40 dark:bg-emerald-950/20"
        >
          <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs font-medium text-emerald-800 dark:text-emerald-300 marker:hidden [&::-webkit-details-marker]:hidden">
            <span className="flex items-center gap-1.5">
              <Wand2 className="size-3.5" aria-hidden />
              <span>
                {t("auto_section_label_count", { count: autoCorrectedSuggestions.length })}
              </span>
              <span className="text-[10px] font-normal text-emerald-700/70 dark:text-emerald-400/70 group-open:hidden">
                {t("auto_section_collapsed_hint")}
              </span>
            </span>
            {/* 「全て元に戻す」は summary 内のため details の toggle と競合しないよう
                stopPropagation で treeview/details ナビゲーションを保護 */}
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleUndoAll();
              }}
              className="border-emerald-500/40 text-emerald-700 hover:bg-emerald-100/60 dark:text-emerald-300 dark:hover:bg-emerald-900/40"
              aria-label={t("auto_section_undo_all_aria")}
            >
              <RotateCcw className="size-3" />
              {t("auto_section_undo_all")}
            </Button>
          </summary>
          <ul className="flex flex-col gap-2.5 px-3 pt-1 pb-3">
            {autoCorrectedSuggestions.map((s) => (
              <li key={s.id}>
                {/* Task #31 (2026-05-25): 自動修正済セクション内の SuggestionCard も
                    wrap。採用 = scoped refresh が autoCorrected の関連 id を seed に
                    含めるケース、または partial refresh 結果で error から自動修正済へ
                    昇格するケースで visual が必要。詳細モードと両セクションで同一表現。 */}
                <PartialRefreshSuggestionWrapper
                  suggestionId={s.id}
                  isSeed={partialRefreshSeedIds.includes(s.id)}
                  isPendingDeletion={pendingDeletedSuggestionIds.includes(s.id)}
                  isRecentlyAdded={recentlyAddedSuggestionIds.includes(s.id)}
                  isRecentlyUpdated={recentlyUpdatedSuggestionIds.includes(s.id)}
                  tCard={tCard}
                >
                  <SuggestionCard suggestion={s} />
                </PartialRefreshSuggestionWrapper>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// =============================================================================
// 件数 badge(Canvas 既存と同じトーンに揃える)
// =============================================================================
function CountBadge({
  category,
  count,
  label,
  dimmed,
}: {
  category: Category;
  count: number;
  label: string;
  dimmed?: boolean;
}) {
  const colorClass: Record<Category, string> = {
    error: "border-destructive/40 bg-destructive/10 text-destructive",
    convention:
      "border-amber-500/40 bg-amber-100/60 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
    alternative:
      "border-blue-400/40 bg-blue-100/40 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300",
    // v2 Phase B4 (2026-05-26): structural 専用 badge 色 — purple 系 subtle。
    // SuggestionCard.CATEGORY_BADGE_CLASS.structural と同じ色軸(purple)で整合、
    // error/convention/alternative と直交した視覚軸で「構造変更カテゴリ」を識別可能に。
    structural:
      "border-purple-400/40 bg-purple-100/40 text-purple-700 dark:bg-purple-950/30 dark:text-purple-300",
  };
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 text-[10px] font-medium",
        colorClass[category],
        dimmed && "opacity-50",
      )}
    >
      <span>{label}</span>
      <span className="font-mono">{count}</span>
    </Badge>
  );
}
