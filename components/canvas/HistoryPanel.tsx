"use client";

// =============================================================================
// HistoryPanel (2026-05-25): 右パネル 4 タブ目「履歴」の本体
// =============================================================================
//
// 責務:
//  - store.actionLog を時系列(新しい順)で表示
//  - 各 entry に「この操作を取り消す」ボタン(現在の status と矛盾しない最新 entry のみ active)
//  - 派生 ES の version 番号 / 相対時刻 / 対象 suggestion の category badge + snippet を表示
//
// 設計判断:
//  1) **revert 経路は store.revertSuggestionAction に一本化** —
//     per-card revert ボタン(SuggestionCard 改修)と同じ store action を呼ぶことで、
//     「履歴 revert と個別 revert で UX が違って混乱する」を構造的に排除する。
//  2) **isOutdated は表示判定のみに使う** — outdated entry は dimmed + revert disabled
//     表示。dispatch §C「Cmd+Z 維持」+「履歴 revert は別経路」と整合(任意時間軸の
//     revert は最新 status のみ取り消し可能、過去 entry は記録として残る)。
//  3) **DIRECT_EDIT の revert は v1 未対応** — esBody before/after を保持しないため、
//     revert ボタンを disabled 表示(tooltip で理由説明)。
//  4) **新しい順** — 直近の操作が最上段にあるとユーザーが迷子にならない(履歴を
//     遡るシーケンシャルな認知モデル)。
//
// AGENTS.md Inviolable constraints:
//  - 数値スコア禁止: 件数 / 字数 / version 番号 / 相対時刻のみ、スコア無し
//  - ES 全面書き換え禁止: 個別 entry の revert のみ、bulk revert なし
//  - 競合通知中間プレビューなし: revert は直接アクション(中間プレビュー無し)
//
// SSOT: lib/state/analyze_store.ts (actionLog, revertSuggestionAction)

import * as React from "react";
import { useTranslations } from "next-intl";
import {
  useAnalyzeStore,
  type ActionLogEntry,
  type StructuralActionSnapshot,
} from "@/lib/state/analyze_store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  Check,
  Edit3,
  History,
  Pencil,
  RotateCcw,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";

// =============================================================================
// 相対時刻フォーマッタ(秒 / 分 / 時間 / 日)
// =============================================================================
// シンプルな自前実装。Intl.RelativeTimeFormat も使えるが、日本語ロケールでは「N 秒前」
// のような表現が標準で得られる一方、英語ロケールでも自然な表現にしたいため、
// 「single string + i18n message format」で済ます方が UX が読みやすい。
//
// 引数: ms (Date.now() に対する経過ミリ秒、now - entry.timestamp で求める)
// 戻り値: { unit: "second" | "minute" | "hour" | "day", value: number }
function getRelativeTime(ms: number): { unit: "second" | "minute" | "hour" | "day"; value: number } {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return { unit: "second", value: seconds };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { unit: "minute", value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hour", value: hours };
  const days = Math.floor(hours / 24);
  return { unit: "day", value: days };
}

// =============================================================================
// HistoryPanel — 右パネル「履歴」タブの本体
// =============================================================================
export function HistoryPanel() {
  const t = useTranslations("historyPanel");
  const tCategory = useTranslations("category");
  const actionLog = useAnalyzeStore((s) => s.actionLog);
  const revertSuggestionAction = useAnalyzeStore(
    (s) => s.revertSuggestionAction,
  );
  // 現在 status を引いて outdated 判定(防御的)。store.markOutdatedForSuggestion で
  // すでに entry.isOutdated は管理されているが、isOutdated=false + 現在 status =
  // 矛盾 の組み合わせを更に防ぐため、念のため store 側 sets も読む。
  const acceptedSuggestionIds = useAnalyzeStore((s) => s.acceptedSuggestionIds);
  const rejectedSuggestionIds = useAnalyzeStore((s) => s.rejectedSuggestionIds);
  const editedSuggestions = useAnalyzeStore((s) => s.editedSuggestions);
  const autoCorrectedSuggestionIds = useAnalyzeStore(
    (s) => s.autoCorrectedSuggestionIds,
  );

  // 表示順: 新しい順(末尾 = 最新、UI では上から新しい順)
  const sortedEntries = React.useMemo(() => {
    return actionLog.slice().reverse();
  }, [actionLog]);

  // 現在時刻(re-render で更新する、ただし高頻度 setInterval は避ける)。
  // 30 秒に 1 回 re-render で十分(秒単位の正確さは UX で重要でない)。
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  // revert ハンドラ: entry の suggestion を pending に戻す。
  // DIRECT_EDIT 用 entry は対応外(suggestionId 無し)。
  const handleRevert = React.useCallback(
    (entry: ActionLogEntry) => {
      if (!entry.suggestionId || !entry.suggestionSummary) return;
      // 確認ダイアログ(誤操作防止、shadcn AlertDialog より軽量な window.confirm)。
      // 数値スコア無し、件数 / 字数のみで状況説明。
      const ok = window.confirm(
        t("revert_confirm", {
          snippet:
            entry.suggestionOriginalSnippet ??
            entry.suggestionSummary ??
            entry.suggestionId,
        }),
      );
      if (!ok) return;
      revertSuggestionAction({
        suggestion_id: entry.suggestionId,
        suggestion_summary: entry.suggestionSummary,
        revertedFromEntryId: entry.id,
      });
    },
    [t, revertSuggestionAction],
  );

  // 空状態
  if (sortedEntries.length === 0) {
    return (
      <div
        className="flex flex-col gap-3"
        role="region"
        aria-label={t("region_aria")}
      >
        <div className="rounded-md border border-dashed border-border/60 bg-muted/30 px-4 py-8 text-center text-xs text-muted-foreground">
          <History className="mx-auto mb-2 size-5 text-muted-foreground/60" />
          <p className="text-jp">{t("empty_message")}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-3"
      role="region"
      aria-label={t("region_aria")}
    >
      <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-card/70 px-3 py-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <History className="size-4 text-primary" />
          <span>{t("title_template", { count: sortedEntries.length })}</span>
        </h3>
        <p className="text-[10px] text-muted-foreground text-jp">
          {t("subtitle")}
        </p>
      </div>

      <ul className="flex flex-col gap-2">
        {sortedEntries.map((entry) => (
          <li key={entry.id}>
            <HistoryEntryCard
              entry={entry}
              now={now}
              isCurrentlyOutdated={isEntryCurrentlyOutdated(entry, {
                acceptedSuggestionIds,
                rejectedSuggestionIds,
                editedSuggestions,
                autoCorrectedSuggestionIds,
              })}
              onRevert={() => handleRevert(entry)}
              t={t}
              tCategory={tCategory}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

// =============================================================================
// HistoryEntryCard — 1 件の操作ログ
// =============================================================================
function HistoryEntryCard({
  entry,
  now,
  isCurrentlyOutdated,
  onRevert,
  t,
  tCategory,
}: {
  entry: ActionLogEntry;
  now: number;
  isCurrentlyOutdated: boolean;
  onRevert: () => void;
  t: ReturnType<typeof useTranslations<"historyPanel">>;
  tCategory: ReturnType<typeof useTranslations<"category">>;
}) {
  const relative = getRelativeTime(now - entry.timestamp);
  // 「N 秒前」「N 分前」 などの相対時刻ラベル
  const relativeLabel = t(`time_${relative.unit}`, { value: relative.value });

  // 操作 type に応じたアイコン / ラベル / 色
  const typeMeta = getEntryTypeMeta(entry.type);
  const Icon = typeMeta.icon;

  // revert 可否判定:
  //  - DIRECT_EDIT: v1 未対応(suggestionId なし、esBody before/after も無い)
  //  - isOutdated: 後続操作で上書きされた entry → revert 不可
  //  - isCurrentlyOutdated: 現在 store status と矛盾する(同 suggestion で別の最新 entry が
  //    存在する)→ revert 不可(防御的)
  //  - reverted: 既に revert 操作の結果 → revert 不可
  const cannotRevert =
    entry.type === "direct_edit" ||
    entry.type === "reverted" ||
    entry.isOutdated ||
    isCurrentlyOutdated ||
    !entry.suggestionId ||
    !entry.suggestionSummary;

  // outdated 表示用 dim
  const dimmed = entry.isOutdated || isCurrentlyOutdated;

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border bg-card p-3 text-sm",
        "border-border/60",
        dimmed && "opacity-60",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge
            variant="outline"
            className={cn("gap-1 text-[10px]", typeMeta.badgeClass)}
          >
            <Icon className="size-3" aria-hidden />
            <span>{t(typeMeta.labelKey)}</span>
          </Badge>
          {entry.suggestionCategory && (
            <Badge variant="outline" className="text-[10px]">
              {tCategory(entry.suggestionCategory)}
            </Badge>
          )}
          {dimmed && (
            <Badge
              variant="outline"
              className="border-muted-foreground/40 bg-muted text-muted-foreground text-[10px]"
            >
              {t("outdated_badge")}
            </Badge>
          )}
        </div>
        <span className="text-[10px] text-muted-foreground" title={new Date(entry.timestamp).toLocaleString()}>
          {relativeLabel}
        </span>
      </div>

      {/* suggestion snippet or direct_edit summary
          v2 dogfood UX 改善 Task A (2026-05-26): structural 採用 entry は専用 label で
          「段落 N を削除: '冒頭…'」等の具体的操作を表示(blockquote 経由の suggestionOriginalSnippet
          は出さない、その代わりに operation 内容を i18n で構築)。 */}
      {entry.type === "direct_edit" ? (
        <p className="text-xs text-muted-foreground text-jp">
          {t("direct_edit_summary", {
            chars: entry.directEditCharCount ?? 0,
          })}
        </p>
      ) : entry.suggestionCategory === "structural" &&
        entry.structuralSnapshot ? (
        <StructuralEntryLabel snapshot={entry.structuralSnapshot} t={t} />
      ) : entry.suggestionOriginalSnippet ? (
        /* 2026-05-27 dogfood round 2 Task F: 通常 suggestion(error/convention/alternative)の
           採用 entry に「元の表現 → 採用後の表現」を併記表示。
           - proposedSnapshot が存在する accept/edited entry(structural 以外): 2 行表示
           - 存在しない他 entry(rejected / auto_corrected_undo 等): 従来通り原文のみ */
        <div className="flex flex-col gap-1">
          <blockquote className="border-l-2 border-muted-foreground/40 bg-muted/40 px-2 py-1 text-xs leading-relaxed text-jp">
            {entry.suggestionOriginalSnippet}
          </blockquote>
          {entry.proposedSnapshot && (
            <p className="border-l-2 border-primary/40 bg-primary/5 px-2 py-1 text-xs leading-relaxed text-jp">
              {t("proposed_after_prefix")}
              {entry.proposedSnapshot.proposedText}
            </p>
          )}
        </div>
      ) : null}

      {/* edited_text(EDITED 操作のみ) */}
      {entry.type === "edited" && entry.editedText && (
        <p className="rounded-sm bg-amber-100/60 dark:bg-amber-950/30 px-2 py-1 text-xs leading-relaxed text-jp">
          {t("edited_text_prefix")}
          {entry.editedText}
        </p>
      )}

      {/* undo_all 件数 */}
      {entry.type === "auto_corrected_undo_all" && entry.undoAllCount && (
        <p className="text-[10px] text-muted-foreground text-jp">
          {t("auto_undo_all_note", { count: entry.undoAllCount })}
        </p>
      )}

      <Separator className="my-0.5" />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-muted-foreground">
          {entry.suggestionId ?? "—"}
          {" · "}
          {t("es_version_label", { version: entry.esVersion })}
        </span>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={onRevert}
          disabled={cannotRevert}
          aria-label={t("revert_aria")}
          title={
            entry.type === "direct_edit"
              ? t("revert_unsupported_direct_edit")
              : dimmed
                ? t("revert_unavailable_outdated")
                : t("revert_title")
          }
        >
          <Undo2 className="size-3" />
          <span>{t("revert_button")}</span>
        </Button>
      </div>
    </div>
  );
}

// =============================================================================
// 補助関数 / 定数
// =============================================================================

// 操作 type → アイコン + ラベル翻訳キー + badge カラー
function getEntryTypeMeta(type: ActionLogEntry["type"]): {
  icon: typeof Check;
  labelKey:
    | "type_accepted"
    | "type_rejected"
    | "type_edited"
    | "type_auto_corrected_undo"
    | "type_auto_corrected_undo_all"
    | "type_direct_edit"
    | "type_reverted"
    // 2026-05-27 エージェント的対話(AI 逆質問): 回答操作の labelKey
    | "type_clarification_answered";
  badgeClass: string;
} {
  switch (type) {
    case "accepted":
      return {
        icon: Check,
        labelKey: "type_accepted",
        badgeClass: "border-primary/40 bg-primary/15 text-primary",
      };
    case "rejected":
      return {
        icon: X,
        labelKey: "type_rejected",
        badgeClass:
          "border-muted-foreground/40 bg-muted text-muted-foreground",
      };
    case "edited":
      return {
        icon: Pencil,
        labelKey: "type_edited",
        badgeClass:
          "border-amber-500/40 bg-amber-100/60 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
      };
    case "auto_corrected_undo":
      return {
        icon: RotateCcw,
        labelKey: "type_auto_corrected_undo",
        badgeClass:
          "border-emerald-500/40 bg-emerald-100/60 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200",
      };
    case "auto_corrected_undo_all":
      return {
        icon: RotateCcw,
        labelKey: "type_auto_corrected_undo_all",
        badgeClass:
          "border-emerald-500/40 bg-emerald-100/60 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200",
      };
    case "direct_edit":
      return {
        icon: Edit3,
        labelKey: "type_direct_edit",
        badgeClass:
          "border-blue-400/40 bg-blue-100/40 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300",
      };
    case "reverted":
      return {
        icon: Sparkles,
        labelKey: "type_reverted",
        badgeClass:
          "border-purple-400/40 bg-purple-100/40 text-purple-700 dark:bg-purple-950/30 dark:text-purple-300",
      };
    // 2026-05-27 エージェント的対話(AI 逆質問): 回答操作の entry meta。
    // 「逆質問への回答」は ES の構造変更ではなく文脈追加のため、purple 系 subtle で
    // 「再評価系の操作」感を統一(reverted と類似の補助操作)。
    case "clarification_answered":
      return {
        icon: Sparkles,
        labelKey: "type_clarification_answered",
        badgeClass:
          "border-indigo-400/40 bg-indigo-100/40 text-indigo-700 dark:bg-indigo-950/30 dark:text-indigo-300",
      };
  }
}

// =============================================================================
// StructuralEntryLabel — v2 dogfood UX 改善 Task A (2026-05-26)
// =============================================================================
// structural 採用 entry の操作内容を「段落 N を削除: '冒頭…'」「段落順番変更: 1・2・3 →
// 3・1・2」等の具体的なラベルで rendering する内部 component。
//
// 設計:
//  - 段落番号は **表示時に 1-based**(内部 snapshot.params の index は 0-based)
//  - operation 別に i18n key を切替(historyPanel.structural.*)
//  - reorder_paragraphs の before/after は中黒「・」区切り(両側とも 1-based)
//  - add_paragraph は target_position で before/after の i18n key を分岐
//  - preview は snapshot 時点で 30 字 truncate 済(buildStructuralSnapshot で生成)
//  - 視覚スタイルは blockquote と同じ subtle 表示(border-l-2 + bg-muted/40)で
//    既存履歴 entry と一貫性を保つ
function StructuralEntryLabel({
  snapshot,
  t,
}: {
  snapshot: StructuralActionSnapshot;
  t: ReturnType<typeof useTranslations<"historyPanel">>;
}) {
  const { params, paragraphCount, preview } = snapshot;
  let label: string;
  switch (params.operation) {
    case "delete_paragraph": {
      label = t("structural.delete_paragraph", {
        n: params.target_paragraph_index + 1,
        preview: preview ?? "",
      });
      break;
    }
    case "reorder_paragraphs": {
      const before = Array.from({ length: paragraphCount }, (_, i) =>
        String(i + 1),
      ).join("・");
      const after = params.new_order.map((i) => String(i + 1)).join("・");
      label = t("structural.reorder_paragraphs", { before, after });
      break;
    }
    case "merge_paragraphs": {
      // 表示は ES 出現順(sorted)で「N と M を統合」、indices.length が 2 を超えるケースも
      // sorted indices を中黒で結合する(label テンプレートは 2 段落想定だが、3 段落以上でも
      // ユーザーが識別可能なよう sorted list を入れる安全網)
      const sorted = [...params.target_paragraph_indices].sort((a, b) => a - b);
      label = t("structural.merge_paragraphs", {
        n: sorted[0] + 1,
        m: sorted.slice(1).map((i) => i + 1).join("・"),
      });
      break;
    }
    case "move_sentence": {
      label = t("structural.move_sentence", {
        n: params.source_paragraph_index + 1,
        m: params.target_paragraph_index + 1,
      });
      break;
    }
    case "add_paragraph": {
      const key =
        params.target_position === "before"
          ? "structural.add_paragraph_before"
          : "structural.add_paragraph_after";
      label = t(key, {
        n: params.target_paragraph_index + 1,
        preview: preview ?? "",
      });
      break;
    }
  }
  return (
    <p className="border-l-2 border-purple-400/60 bg-purple-100/40 dark:bg-purple-950/30 px-2 py-1 text-xs leading-relaxed text-jp">
      {label}
    </p>
  );
}

// entry が現時点で「最新の status と矛盾する」かを判定。
// store.markOutdatedForSuggestion で entry.isOutdated が立てられているが、念のため
// store の最新 sets と比較して二重判定する(refresh / partial merge 後の不整合への保険)。
function isEntryCurrentlyOutdated(
  entry: ActionLogEntry,
  status: {
    acceptedSuggestionIds: ReadonlyArray<string>;
    rejectedSuggestionIds: ReadonlyArray<string>;
    editedSuggestions: Readonly<Record<string, string>>;
    autoCorrectedSuggestionIds: ReadonlyArray<string>;
  },
): boolean {
  if (!entry.suggestionId) return false;
  const id = entry.suggestionId;
  // entry.type と現在 status の matching を判定
  switch (entry.type) {
    case "accepted":
      // 現在 accepted な状態でない = outdated(rejected/edited/pending 化された)
      return !status.acceptedSuggestionIds.includes(id);
    case "rejected":
      return !status.rejectedSuggestionIds.includes(id);
    case "edited":
      return !(id in status.editedSuggestions);
    case "auto_corrected_undo":
    case "auto_corrected_undo_all":
      // 自動修正取り消し直後 = rejectedSuggestionIds に含まれる
      // 現在 rejected でなければ outdated(再度採用された等)
      return !status.rejectedSuggestionIds.includes(id);
    case "reverted":
      // revert 後 = pending(どこにも属さない)
      // 現在どこかに属していれば outdated
      return (
        status.acceptedSuggestionIds.includes(id) ||
        status.rejectedSuggestionIds.includes(id) ||
        id in status.editedSuggestions ||
        status.autoCorrectedSuggestionIds.includes(id)
      );
    case "direct_edit":
      // direct_edit は suggestionId を持たない、ここに来ない
      return false;
    // 2026-05-27 エージェント的対話(AI 逆質問): 回答 entry は suggestionId を持たない
    // (clarificationSnapshot.suggestion_id は scope 判別用で、ActionLogEntry.suggestionId は
    // 設定しない)。outdated 判定の対象外 = 常に non-outdated を返す。
    case "clarification_answered":
      return false;
  }
}
