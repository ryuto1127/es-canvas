"use client";

// =============================================================================
// Commit D-4 (2026-05-25): 右パネル用 面接質問パネル(stale 表示)
// 提出後改善 #1 (2026-06-09): 「質問を更新」ボタンを追加し /api/interview に初接続
// =============================================================================
//
// 責務:
//  - 面接質問(3-5 問)を right-panel コンパクトに表示
//  - is_stale = true の場合は「ES が更新された、面接質問は前の版基準」の注釈 +
//    「質問を更新」ボタン(最新 ES から /api/interview で作り直す主導線)
//
// 提出後改善 #1 (2026-06-09) の設計判断:
//  1) **/api/interview に初接続** — 旧コメントの「triggerFullRefresh で再生成される」は
//     事実誤認だった。refresh / partial はツールスキーマで interview_questions を構造的に
//     返さない(LLM は生成しない)ため、「再分析」では面接質問は更新されず is_stale が
//     true になるだけだった。本パネルから専用エンドポイント /api/interview を呼ぶ。
//  2) **stale バナー内に主導線** — is_stale のとき注釈の直下に「質問を更新」ボタンを置く。
//     非 stale 時はボタンを出さない(更新の必要がない = ノイズを避ける)。
//  3) **二重発火防止** — 自身の loading 中は無効。加えて refresh / partial が in-flight の
//     間(refreshPhase === "loading" / partialRefreshInProgress)も無効化し、理由を title で示す
//     (ES の派生本文が動いている最中に面接質問だけ作り直すと基準がずれるため)。
//  4) **missing_api_key 導線** — エラー kind を握りつぶさず保持し、鍵未設定なら「設定を開く」
//     (requestOpenSettings)を出す(2026-05-30 二重レビューと同じパターン)。
//  5) **数値スコア禁止** — 問数のみ表示(「Q1」「N 問」)、進行 / エラーは文字列のみ。
//
// ResultPanel 下部の InterviewQuestionsSection との違い:
//  - 下部 = 全体読み返し用、各 question の purpose_hint / answer_hint を詳細表示
//  - 右パネル = 編集中の参照、question 本体を主、hint は折りたたみ
//
// AGENTS.md Inviolable constraints:
//  - 数値スコア禁止: 件数のみ
//  - 面接質問 3〜5 問: サーバ側 schema 保証(クライアントで二重実装しない)
//  - localStorage 不使用(BYOK 鍵を除く): store 直接購読
//
// SSOT: lib/schema/interview.ts (InterviewQuestion, InterviewQuestions),
//       lib/state/analyze_store.ts (analysisResult, buildInterviewBundle, interviewRefresh*)
//       app/api/interview/route.ts(レスポンス形 { data: InterviewQuestions })
//       lib/byok.ts(openAIKeyHeader / requestOpenSettings)

import * as React from "react";
import { useTranslations } from "next-intl";
import type {
  InterviewQuestion,
  InterviewQuestions,
} from "@/lib/schema/interview";
import { InterviewQuestionsSchema } from "@/lib/schema/interview";
import {
  buildInterviewBundle,
  getDerivedEsBody,
  useAnalyzeStore,
} from "@/lib/state/analyze_store";
import { openAIKeyHeader, requestOpenSettings } from "@/lib/byok";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  ChevronRight,
  Crosshair,
  Lightbulb,
  Loader2,
  MessageCircleQuestion,
  RefreshCw,
  Settings,
} from "lucide-react";

export interface InterviewPanelProps {
  questions: InterviewQuestions | undefined;
}

export function InterviewPanel({ questions }: InterviewPanelProps) {
  const t = useTranslations("interviewPanel");
  const tSettings = useTranslations("settings");

  // ---------------------------------------------------------------------------
  // 提出後改善 #1: 面接質問の再生成に必要な store 状態 / actions を購読
  // ---------------------------------------------------------------------------
  const form = useAnalyzeStore((s) => s.form);
  const companySummary = useAnalyzeStore((s) => s.companySummary);
  const analysisResult = useAnalyzeStore((s) => s.analysisResult);
  const actionHistory = useAnalyzeStore((s) => s.actionHistory);
  const acceptedSuggestionIds = useAnalyzeStore((s) => s.acceptedSuggestionIds);
  const editedSuggestions = useAnalyzeStore((s) => s.editedSuggestions);
  const bakedSuggestionIds = useAnalyzeStore((s) => s.bakedSuggestionIds);
  const currentEsBody = useAnalyzeStore((s) => s.currentEsBody);
  const directEditMode = useAnalyzeStore((s) => s.directEditMode);
  const clientEsVersion = useAnalyzeStore((s) => s.clientEsVersion);

  const interviewRefreshPhase = useAnalyzeStore((s) => s.interviewRefreshPhase);
  const interviewRefreshError = useAnalyzeStore((s) => s.interviewRefreshError);
  // 二重発火防止: refresh / partial が走っている間は面接質問の更新を無効化する。
  const refreshPhase = useAnalyzeStore((s) => s.refreshPhase);
  const partialRefreshInProgress = useAnalyzeStore(
    (s) => s.partialRefreshInProgress,
  );

  const beginInterviewRefresh = useAnalyzeStore((s) => s.beginInterviewRefresh);
  const applyInterviewQuestions = useAnalyzeStore(
    (s) => s.applyInterviewQuestions,
  );
  const setInterviewRefreshError = useAnalyzeStore(
    (s) => s.setInterviewRefreshError,
  );

  const isLoading = interviewRefreshPhase === "loading";
  // refresh / partial が in-flight の間は面接質問更新を抑止する(派生 ES が動く最中の
  // 再生成は基準がずれるため)。単純で説明可能な規則: 「他の再分析が動いていたら待つ」。
  const blockedByRefresh = refreshPhase === "loading" || partialRefreshInProgress;
  const isDisabled = isLoading || blockedByRefresh;
  // 無効理由を title/tooltip で説明する(ボタンが押せない理由を黙らせない)。
  const disabledReason = isLoading
    ? t("update_button_loading")
    : blockedByRefresh
      ? t("update_button_blocked_by_refresh")
      : undefined;

  const handleRegenerate = React.useCallback(async () => {
    // 二重ガード(UI の disabled に加えてハンドラ内でも early-return)。
    if (interviewRefreshPhase === "loading") return;
    if (refreshPhase === "loading" || partialRefreshInProgress) return;
    // analysisResult が無ければ面接質問の置換先が無い(理論上 panel は表示されない)。
    if (analysisResult === null) return;

    // refresh と同じ派生 ES 本文を算出する。直接編集中は currentEsBody 生(既に派生を
    // flatten 済)、それ以外は getDerivedEsBody で採用 / 編集を反映した本文。
    const esBody = directEditMode
      ? currentEsBody
      : getDerivedEsBody(
          currentEsBody,
          analysisResult.suggestions,
          acceptedSuggestionIds,
          editedSuggestions,
          bakedSuggestionIds,
        );

    // 派生 ES と整合させるための「現在 採用 or 編集済」id 集合。
    const liveAcceptedOrEditedIds = new Set<string>([
      ...acceptedSuggestionIds,
      ...Object.keys(editedSuggestions),
    ]);

    const bundle = buildInterviewBundle({
      form,
      companySummary: companySummary ?? undefined,
      esBody,
      actionHistory,
      baseVersion: clientEsVersion,
      liveAcceptedOrEditedIds,
    });

    beginInterviewRefresh();

    try {
      const res = await fetch("/api/interview", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...openAIKeyHeader() },
        body: JSON.stringify(bundle),
      });

      if (!res.ok) {
        // エラー body から kind を保持(握りつぶさない)。JSON でなければ unknown に倒す。
        let kind = "unknown";
        let message = res.statusText || "Request failed";
        try {
          const errBody = await res.json();
          if (errBody?.error?.kind) kind = String(errBody.error.kind);
          if (errBody?.error?.message) message = String(errBody.error.message);
        } catch {
          // body が JSON でない場合はステータステキストのまま。
        }
        setInterviewRefreshError({ kind, message });
        return;
      }

      const okBody = await res.json();
      // route は { data: InterviewQuestions } を返す。client 側でも Zod で二重検証する。
      const parsed = InterviewQuestionsSchema.safeParse(okBody?.data);
      if (!parsed.success) {
        setInterviewRefreshError({
          kind: "schema_validation",
          message: "Interview response failed client-side validation",
        });
        return;
      }
      applyInterviewQuestions(parsed.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error";
      setInterviewRefreshError({ kind: "network", message });
    }
  }, [
    interviewRefreshPhase,
    refreshPhase,
    partialRefreshInProgress,
    analysisResult,
    directEditMode,
    currentEsBody,
    acceptedSuggestionIds,
    editedSuggestions,
    bakedSuggestionIds,
    form,
    companySummary,
    actionHistory,
    clientEsVersion,
    beginInterviewRefresh,
    applyInterviewQuestions,
    setInterviewRefreshError,
  ]);

  if (!questions) {
    return (
      <div
        className="rounded-md border border-dashed border-border/60 bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground"
        role="region"
        aria-label={t("region_aria")}
      >
        <MessageCircleQuestion className="mx-auto mb-2 size-5 text-muted-foreground/60" />
        <p className="text-jp">{t("empty_message")}</p>
      </div>
    );
  }

  // missing_api_key かどうか(「設定を開く」主アクションの出し分け)。
  const errorKind = interviewRefreshError?.kind;
  const isMissingKey = errorKind === "missing_api_key";

  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-border/60 bg-card/70 p-3"
      role="region"
      aria-label={t("region_aria")}
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-sm font-medium">
          <MessageCircleQuestion className="size-4 text-primary" />
          <span>{t("title_template", { count: questions.questions.length })}</span>
        </h4>
      </div>

      {/* stale 通知 + 「質問を更新」主導線(提出後改善 #1, 2026-06-09)。
          AlertTriangle + amber box + stale_message で「stale 認知」を維持しつつ、
          注釈の直下に最新 ES から面接質問を作り直すボタンを置く。 */}
      {questions.is_stale && (
        <div
          className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-50/70 px-2.5 py-2 dark:border-amber-500/30 dark:bg-amber-950/30"
          role="status"
        >
          <div className="flex items-start gap-1.5 text-[11px]">
            <AlertTriangle
              className="size-3 mt-0.5 shrink-0 text-amber-700 dark:text-amber-400"
              aria-hidden
            />
            <span className="text-amber-900 dark:text-amber-200 text-jp">
              {t("stale_message")}
            </span>
          </div>
          <Button
            size="xs"
            variant="outline"
            onClick={handleRegenerate}
            disabled={isDisabled}
            title={disabledReason}
            className="self-start"
          >
            {isLoading ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="size-3" aria-hidden />
            )}
            {isLoading ? t("update_button_loading") : t("update_button")}
          </Button>
        </div>
      )}

      {/* 再生成エラー(致命的失敗)。missing_api_key は「設定を開く」導線を出す。 */}
      {interviewRefreshPhase === "error" && (
        <div
          className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-[11px]"
          role="alert"
        >
          <div className="flex min-w-0 items-start gap-1.5">
            <AlertTriangle className="size-3 mt-0.5 shrink-0 text-destructive" />
            <span className="text-muted-foreground break-words text-jp">
              {isMissingKey
                ? tSettings("missing_key_error")
                : t("update_error")}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {isMissingKey && (
              <Button size="xs" onClick={requestOpenSettings}>
                <Settings className="size-3" aria-hidden />
                {tSettings("open_settings_action")}
              </Button>
            )}
            <Button
              size="xs"
              variant="outline"
              onClick={handleRegenerate}
              disabled={isDisabled}
              title={disabledReason}
            >
              {t("update_button")}
            </Button>
          </div>
        </div>
      )}

      <ul className="flex flex-col gap-2.5">
        {questions.questions.map((q, i) => (
          <InterviewQuestionCard key={q.id} question={q} index={i + 1} />
        ))}
      </ul>
    </div>
  );
}

// =============================================================================
// InterviewQuestionCard — 各質問(右パネル コンパクト版)
// =============================================================================
// 設計:
//  - Q 番号(円形 badge) + 質問本体(主役)
//  - purpose_hint / answer_hint は <details> で折りたたみ(右パネル幅優先のため)
function InterviewQuestionCard({
  question,
  index,
}: {
  question: InterviewQuestion;
  index: number;
}) {
  const t = useTranslations("interviewPanel");
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border/60 bg-background/40 p-2.5">
      <div className="flex items-start gap-2">
        <Badge
          variant="outline"
          className={cn(
            "inline-flex size-6 shrink-0 items-center justify-center rounded-full p-0",
            "border border-primary/40 bg-primary/10 text-primary",
            "font-mono text-[10px] font-semibold",
          )}
          aria-label={t("question_aria_template", { index })}
        >
          Q{index}
        </Badge>
        <p className="mt-0.5 text-xs font-medium leading-relaxed text-foreground text-jp">
          {question.question}
        </p>
      </div>
      <details className="group">
        <summary className="flex items-center gap-1.5 cursor-pointer text-[10px] font-medium tracking-wide text-muted-foreground hover:text-foreground marker:hidden [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
          <span className="group-open:hidden">{t("expand_label")}</span>
          <span className="hidden group-open:inline">{t("collapse_label")}</span>
        </summary>
        <div className="mt-1.5 flex flex-col gap-1.5 pl-2">
          <div>
            <h6 className="mb-0.5 flex items-center gap-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              <Crosshair className="size-2.5" />
              {t("purpose_label")}
            </h6>
            <p className="text-[11px] leading-relaxed text-foreground/85 text-jp">
              {question.purpose_hint}
            </p>
          </div>
          <div>
            <h6 className="mb-0.5 flex items-center gap-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              <Lightbulb className="size-2.5" />
              {t("answer_hint_label")}
            </h6>
            <p className="text-[11px] leading-relaxed text-foreground/85 text-jp">
              {question.answer_hint}
            </p>
          </div>
        </div>
      </details>
    </li>
  );
}
