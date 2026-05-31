"use client";

// =============================================================================
// Commit D-1 (2026-05-25): 書き込み型 UI 上部サマリーバー
// =============================================================================
//
// 責務:
//  - 全 suggestion の状態別件数(未処理 / 採用済 / 編集済 / 却下済 / 自動修正済)を
//    1 行で俯瞰可能な形で表示(Grammarly モデルの「右上に総数」UI に相当)
//  - 右側に「再分析」ボタン(triggerFullRefresh)を配置 — Task #27 (2026-05-25) で
//    Canvas 上部ツールバー / InterviewPanel stale box から 1 つに集約
//  - 「現在 X 件 未処理」を主役、それ以外は subtle で並列表示
//
// Task #27 (2026-05-25): 文字数表示は Canvas 内(ES 本文ブロック上端)に移動。
//   - 旧: 本 component の右側に「文字数 + 上限」を表示
//   - 新: Canvas の ES 本文上端に表示(ユーザー要望: 「文字数と制限は ES 本文の
//     ブロック内においた方が良い」/「視線の上端で確認したい」)
//   - 同じ位置に「再分析」ボタンを配置 — 再分析ボタンを 1 つに集約する規律。
//   - esLength / charLimit props は撤去(YAGNI、文字数表示は Canvas 所有)。
//
// 設計判断:
//  1) **AGENTS.md「ユーザーに見える数値スコア禁止」** —
//     ここで出すのは「個数 (件)」のみ。priority スコアは `display_priority` 文字列タグ
//     (high/medium/low)に限定し、数値を表示しない。
//  2) **未処理 / 採用済 / 編集済 / 却下済 / 自動修正済 を 5 種で集計** —
//     SuggestionListPanel の counts と同じ算出ロジックを共有する形にせず、
//     本 component で独立計算(各 component が「自分が表示する観点」で独立的に
//     集計するシンプルさを優先)。alternative トグル OFF 時は alternative を除外。
//  3) **「未処理 N 件 残り」を主役** — 編集の進捗感を即座に伝える表現。
//     対応済(採用 / 編集 / 却下 / 自動修正)は補助情報として並列表示。
//  4) **「指摘最大 15」表記は出さない** — Inviolable constraint だが上限値は内部
//     制約。UI は「現在の件数」のみ。
//  5) **再分析ボタンは action_history 有無に関わらず常時表示** — Canvas 上部ツールバー
//     の旧実装では action_history > 0 時にのみ可視だったが、本ボタンは右上の固定位置に
//     常駐させる方が「いつでも再分析できる」UX を素直に伝える。disabled 条件は
//     directEditMode / refreshPhase === "loading"。
//
// AGENTS.md Inviolable constraints:
//  - 数値スコア禁止: 件数 (件) のみ
//  - 指摘最大 15: API 側で保証、UI 側は count のみを表示
//  - localStorage 不使用: store 直接購読
//
// SSOT: lib/state/analyze_store.ts (acceptedSuggestionIds, rejectedSuggestionIds,
//         editedSuggestions, autoCorrectedSuggestionIds, showAlternatives,
//         triggerFullRefresh, refreshPhase, directEditMode)
//       lib/schema/suggestion.ts (Suggestion, Category)
//       DECISIONS.md [2026-05-25] Task #27 計画

import * as React from "react";
import { useTranslations } from "next-intl";
import type { Suggestion } from "@/lib/schema/suggestion";
import { useAnalyzeStore, isReanalyzeDisabled } from "@/lib/state/analyze_store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Check,
  CircleDot,
  HelpCircle,
  ListChecks,
  Loader2,
  Pencil,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";

export interface SummaryBarProps {
  suggestions: Suggestion[];
}

export function SummaryBar({ suggestions }: SummaryBarProps) {
  const t = useTranslations("summaryBar");
  const tCommon = useTranslations("common");
  const showAlternatives = useAnalyzeStore((s) => s.showAlternatives);
  const acceptedSuggestionIds = useAnalyzeStore((s) => s.acceptedSuggestionIds);
  const rejectedSuggestionIds = useAnalyzeStore((s) => s.rejectedSuggestionIds);
  const editedSuggestions = useAnalyzeStore((s) => s.editedSuggestions);
  const autoCorrectedSuggestionIds = useAnalyzeStore(
    (s) => s.autoCorrectedSuggestionIds,
  );
  // Task #27 (2026-05-25): 再分析ボタンをここに集約(Canvas / InterviewPanel から撤去)。
  //   - triggerFullRefresh: 全範囲再分析を意思表示する store action(scope=full)
  //   - refreshPhase: loading 中は disabled + spinner、ready は Sparkles icon
  //   - directEditMode: 直接編集中は disabled(分析対象が確定しない)
  const triggerFullRefresh = useAnalyzeStore((s) => s.triggerFullRefresh);
  const refreshPhase = useAnalyzeStore((s) => s.refreshPhase);
  const directEditMode = useAnalyzeStore((s) => s.directEditMode);
  // 2026-05-27 エージェント的対話(AI 逆質問): 「この回答で再分析」ボタン用に
  // clarificationAnswers と trigger 関数を購読。
  const clarificationAnswers = useAnalyzeStore((s) => s.clarificationAnswers);
  const triggerReanalysisWithClarifications = useAnalyzeStore(
    (s) => s.triggerReanalysisWithClarifications,
  );
  const tClarification = useTranslations("clarification");
  // 2026-05-28 再分析フロー fix C5: 「再分析する」ボタン(triggerFullRefresh → balanced)が
  //   silent no-op しないよう、操作 0 件 かつ 有効 clarification 回答 0 件のとき disable する。
  //   操作有無は handleRefresh / 観測 effect の early-return と同じく actionHistory.length で判定
  //   (両者で同じ基準を使い、disable とボタン挙動を一致させる)。
  const actionHistory = useAnalyzeStore((s) => s.actionHistory);

  // 状態別件数を集計(alternative トグル OFF 時は alternative を除外)
  const counts = React.useMemo(() => {
    let pending = 0;
    let accepted = 0; // ユーザー能動的採用(autoCorrected を除外)
    let edited = 0;
    let rejected = 0;
    let autoCorrected = 0;
    for (const s of suggestions) {
      if (!showAlternatives && s.category === "alternative") continue;
      const isAuto = autoCorrectedSuggestionIds.includes(s.id);
      if (isAuto) {
        autoCorrected++;
        continue;
      }
      if (s.id in editedSuggestions) {
        edited++;
        continue;
      }
      if (acceptedSuggestionIds.includes(s.id)) {
        accepted++;
        continue;
      }
      if (rejectedSuggestionIds.includes(s.id)) {
        rejected++;
        continue;
      }
      pending++;
    }
    return { pending, accepted, edited, rejected, autoCorrected };
  }, [
    suggestions,
    showAlternatives,
    acceptedSuggestionIds,
    rejectedSuggestionIds,
    editedSuggestions,
    autoCorrectedSuggestionIds,
  ]);

  const totalCount =
    counts.pending +
    counts.accepted +
    counts.edited +
    counts.rejected +
    counts.autoCorrected;

  // 2026-05-28 再分析フロー fix C5: 「再分析する」(triggerFullRefresh → balanced)が
  //   silent no-op になる状態(操作 0 件 かつ 有効 clarification 回答 0 件)を判定。
  //   操作有無は actionHistory.length(handleRefresh / 観測 effect の early-return と同基準)。
  //   有効回答は trim 後 1 文字以上の answer_text が 1 件以上。
  const hasValidClarificationAnswers = clarificationAnswers.some(
    (a) => a.answer_text.trim().length > 0,
  );
  const reanalyzeWouldNoOp = isReanalyzeDisabled({
    hasOperations: actionHistory.length > 0,
    hasValidClarificationAnswers,
  });

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/70 px-4 py-3 text-sm"
      role="region"
      aria-label={t("region_aria")}
    >
      {/* 左: 「未処理 N 件 残り」主役 + 状態別 subtle 並列 */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="gap-1 border-primary/40 bg-primary/10 text-primary text-xs">
          <ListChecks className="size-3" />
          <span>
            {t("pending_label")} <span className="font-mono font-semibold">{counts.pending}</span>{tCommon("count_unit")}
            {totalCount > 0 && (
              <span className="ml-1 text-[10px] opacity-70">/ {t("total_label", { count: totalCount })}</span>
            )}
          </span>
        </Badge>
        {counts.accepted > 0 && (
          <SubtleStateBadge
            icon={<Check className="size-3" />}
            label={t("accepted_label")}
            count={counts.accepted}
            colorClass="border-primary/30 text-primary/80"
          />
        )}
        {counts.edited > 0 && (
          <SubtleStateBadge
            icon={<Pencil className="size-3" />}
            label={t("edited_label")}
            count={counts.edited}
            colorClass="border-amber-500/30 text-amber-700 dark:text-amber-300"
          />
        )}
        {counts.autoCorrected > 0 && (
          <SubtleStateBadge
            icon={<Wand2 className="size-3" />}
            label={t("auto_corrected_label")}
            count={counts.autoCorrected}
            colorClass="border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
          />
        )}
        {counts.rejected > 0 && (
          <SubtleStateBadge
            icon={<X className="size-3" />}
            label={t("rejected_label")}
            count={counts.rejected}
            colorClass="border-muted-foreground/30 text-muted-foreground"
          />
        )}
      </div>

      {/* 右: 再分析系ボタン群(2 つ並列)
          - 「この回答で再分析」(2026-05-27 エージェント的対話): clarificationAnswers
            に 1 件以上の有効回答がある時のみ enable。partial refresh 経路で
            user_context に enriched_intent を append して LLM 再実行。
          - 「再分析する」(Task #27): 全範囲再分析の scope=full 経路、常時表示。
          UI 配置順は左 = clarification(必要時のみ目立つ)、右 = 全体再分析(常駐) */}
      <div className="flex flex-wrap items-center gap-2">
        {/* 2026-05-27 エージェント的対話(AI 逆質問): 「この回答で再分析」ボタン
            - enable 条件: 有効回答(空文字 trim 後 > 0)が 1 件以上
            - directEditMode / refreshPhase loading では disabled(競合回避)
            - disabled hint は title attribute で伝える(支援技術にも aria-disabled で伝わる) */}
        {(() => {
          const validAnswerCount = clarificationAnswers.filter(
            (a) => a.answer_text.trim().length > 0,
          ).length;
          const hasAnswers = validAnswerCount > 0;
          const isDisabled =
            !hasAnswers || directEditMode || refreshPhase === "loading";
          // disabled ヒント文字列: 「1 件以上の回答が必要」/「再分析中」/「直接編集中」
          const hintTitle = !hasAnswers
            ? tClarification("trigger_button_disabled_hint")
            : refreshPhase === "loading"
              ? tClarification("trigger_button_loading_hint")
              : directEditMode
                ? t("reanalyze_disabled_direct")
                : tClarification("trigger_button_label");
          // 0 件時はボタン自体を表示しない(UI noise 削減)。回答 1 件以上で初めて出る。
          if (!hasAnswers) return null;
          return (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => triggerReanalysisWithClarifications()}
              disabled={isDisabled}
              title={hintTitle}
              aria-label={tClarification("trigger_button_aria")}
              aria-disabled={isDisabled ? "true" : undefined}
              className={cn(
                // ClarificationBlock と統一感のある indigo 系 subtle
                "border-indigo-400/40 text-indigo-700 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-950/30",
              )}
            >
              {refreshPhase === "loading" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <HelpCircle className="size-3" />
              )}
              <span>{tClarification("trigger_button_label")}</span>
            </Button>
          );
        })()}
        {/* 既存「再分析する」ボタン(Task #27、全範囲再分析、常駐表示)
            2026-05-28 再分析フロー fix C5: 操作 0 件 かつ 有効回答 0 件のときは disable + tooltip。
            押しても handleRefresh の balanced early-return で silent no-op になる状態を防ぐ。
            over-limit の削減は別ボタン「文字数を抑える」、clarification 回答は別ボタン
            「この回答で再分析」が担うため、この disable はそれらを巻き込まない。 */}
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => triggerFullRefresh()}
          disabled={directEditMode || refreshPhase === "loading" || reanalyzeWouldNoOp}
          title={
            directEditMode
              ? t("reanalyze_disabled_direct")
              : refreshPhase === "loading"
                ? t("reanalyze_loading")
                : reanalyzeWouldNoOp
                  ? t("reanalyze_disabled_no_changes")
                  : t("reanalyze_ready")
          }
          aria-label={t("reanalyze_aria")}
          aria-disabled={
            directEditMode || refreshPhase === "loading" || reanalyzeWouldNoOp
              ? "true"
              : undefined
          }
          className={cn(
            // Canvas Grammarly モデル(青系 subtle)と整合する border + hover 色
            "border-primary/40 text-primary hover:bg-primary/5",
          )}
        >
          {refreshPhase === "loading" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Sparkles className="size-3" />
          )}
          <span>{t("reanalyze_label")}</span>
        </Button>
      </div>
    </div>
  );
}

// =============================================================================
// SubtleStateBadge — 状態別件数(主役以外)
// =============================================================================
function SubtleStateBadge({
  icon,
  label,
  count,
  colorClass,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  colorClass: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 text-[10px] font-medium", colorClass)}
    >
      {icon}
      <span>{label}</span>
      <span className="font-mono">{count}</span>
    </Badge>
  );
}

// =============================================================================
// CompactSelectedIndicator — 「現在 X を選択中」表示(右パネル詳細用補助、optional)
// =============================================================================
// 右パネル詳細表示時に上部に小さく「sug_XXX を表示中」を出す用途。SummaryBar とは
// 別ファイルだが、関連性が高いので同居させる。
export function CompactSelectedIndicator({
  suggestionId,
  onClear,
}: {
  suggestionId: string | null;
  onClear: () => void;
}) {
  const t = useTranslations("compactIndicator");
  if (suggestionId === null) return null;
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <CircleDot className="size-3 text-primary" />
      <span>
        {t("currently_showing")} <span className="font-mono">{suggestionId}</span>
      </span>
      <button
        type="button"
        onClick={onClear}
        className="ml-auto rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] hover:bg-muted"
        aria-label={t("back_to_list_aria")}
      >
        {t("back_to_list")}
      </button>
      <Sparkles className="size-3 text-muted-foreground/50" aria-hidden />
    </div>
  );
}
