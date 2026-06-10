"use client";

// =============================================================================
// Phase G Step 3a: 結果表示パネル(中央 Canvas + 右 RightPanel 構成)
// =============================================================================
//
// 構成(2026-05-25 update、上から):
//   1. エラー表示(初回分析中の loading 表示は AnalyzingOverlay へ移譲、2026-05-24)
//   2. research warning(あれば)
//   3. SummaryBar(件数 + 文字数 俯瞰)
//   4. **メインエリア**:
//      - 中央: Canvas(ES 本文 + ハイライト、Popover 廃止)
//      - 右: RightPanel(指摘 / 企業要約 / 面接質問 / 履歴 タブ)
//      - 双方向ハイライト(右 ↔ Canvas)で連動
//      - 横幅比は 60/40(lg+ で grid-cols-[3fr_2fr])
//      - sm/md は縦積み(Canvas → 右パネル)
//   5. **下部**: 総評のみ
//      - 2026-05-25 Task #17: 企業要約 / 面接質問の下部表示は削除(右パネルと重複、ユーザー dogfood で冗長判明)
//      - 総評(overall_assessment)は右パネルに無い情報なので下部に残す
//
// 2026-05-25 update(Task #17 — Commit D-4 「右パネル + 下部両立」判断の見直し):
//  - 過去判断(Commit D-4): 編集中の文脈と読み返しの文脈は別の認知モードのため二重表示を許容
//  - 現判断: ユーザー dogfood で「冗長」とのフィードバック → 右パネル一本化 + 下部は総評のみ
//  - 総評は右パネルに無い(右パネルのタブ構成: 指摘 / 企業要約 / 面接質問 / 履歴)ため下部に残す
//
// Phase F → Phase G Step 3a の主要変更:
//  - Canvas 内 Popover を廃止 → 右パネル「指摘」タブ内で詳細表示
//  - 件数 badge / alternative トグルは Canvas → 右パネルに移譲
//  - Canvas ヘッダはツールバー(直接編集 / Undo / 再分析 / 削減)のみ
//  - 双方向ハイライト state(hoveredSuggestionId)を analyze_store に追加
//
// UX 改修 1b (2026-05-23): 分析前(phase === "idle")の IdlePreview を廃止。
//
// AGENTS.md Inviolable constraints との対応:
//  - 数値スコア禁止: token_usage は表示しない、件数バッジは「個数」表現で意図明確
//  - 指摘最大 15 個: API 側で保証済、Canvas のハイライト数も自動的に 15 以下
//  - 面接質問 3〜5 問: 同上
//  - ES 全面書き換え禁止: Canvas / リストに「全採用」のような一括ボタンを置かない
//  - localStorage / DB: 全 state はメモリのみ
//
// SSOT: lib/schema/analysis.ts (AnalysisResult, OverallAssessment),
//       lib/schema/company.ts (CompanySummary),
//       lib/schema/suggestion.ts (Suggestion, Category, RationaleSource),
//       lib/schema/interview.ts (InterviewQuestions)

import * as React from "react";
import { useTranslations } from "next-intl";
import {
  useAnalyzeStore,
  isLoadingPhase,
} from "@/lib/state/analyze_store";
import type { CompanySummary } from "@/lib/schema/company";
import type { OverallAssessment } from "@/lib/schema/analysis";
import type { InterviewQuestions } from "@/lib/schema/interview";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  AlertCircle,
  Sparkles,
  TrendingUp,
  Settings,
} from "lucide-react";
import { requestOpenSettings } from "@/lib/byok";
import { Canvas } from "@/components/canvas/Canvas";
import { RightPanel } from "@/components/canvas/RightPanel";
import { SummaryBar } from "@/components/canvas/SummaryBar";
// v2 dogfood UX 改善 Task C (2026-05-26): partial refresh 完了の短時間 toast 通知
import { RefreshCompletionToast } from "@/components/canvas/RefreshCompletionToast";
import { StructuralApplyFailureToast } from "@/components/canvas/StructuralApplyFailureToast";

// =============================================================================
// Error display
// =============================================================================
//
// 2026-05-24: 初回分析中の LoadingDisplay は AnalyzingOverlay に移譲した
// (`components/layout/AnalyzingOverlay.tsx`)。本コンポーネントは done / error の
// 結果表示のみを担当し、loading 系の表示分岐は持たない。

function ErrorDisplay({
  error,
  onRetry,
}: {
  error: { kind: string; message: string; stage?: string; retryable?: boolean };
  onRetry?: () => void;
}) {
  const t = useTranslations("result");
  const tCommon = useTranslations("common");
  const tSettings = useTranslations("settings");
  // BYOK: 鍵未設定エラーは生メッセージではなく「設定から入力できます」の親切な
  // i18n 文言にマップ(右上の設定パネルへ誘導)。
  const isMissingKey = error.kind === "missing_api_key";
  // BYOK: レート制限/利用枠超過(429)も生メッセージ("OpenAI rate limit hit")では
  // なく、何をすべきか分かる親切な i18n 文言にマップ。再試行ボタンは維持。
  const isRateLimit = error.kind === "rate_limit";
  // AI 分析の検証失敗(analysis_validation、例: original_overlap_detected)も生の技術
  // 文字列("analyze_es output failed validation after retry: ...")ではなく、もう一度
  // 試せば直る旨の親切な i18n 文言にマップ(rate_limit と同じ仕組み)。
  const isAnalysisValidation = error.kind === "analysis_validation";
  // 上記の specific 文言にマップされない kind(schema_validation / api_error / timeout /
  // unknown / agent_* 等)は、生の英語技術メッセージを UI に出さず、ジェネリックな
  // 親切文言にフォールバックする。error.kind の font-mono タグは debugging 用に残す。
  const displayMessage = isMissingKey
    ? tSettings("missing_key_error")
    : isRateLimit
      ? tSettings("rate_limit_error")
      : isAnalysisValidation
        ? tSettings("analysis_validation_error")
        : tSettings("generic_error");
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-destructive">
          {isMissingKey ? tSettings("missing_key_title") : t("error_title")}
        </CardTitle>
        <CardDescription>
          <span className="font-mono text-xs">{error.kind}</span>
          {error.stage ? (
            <span className="font-mono text-xs text-muted-foreground">
              {" "}
              / {error.stage}
            </span>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm whitespace-pre-wrap text-jp">{displayMessage}</p>
        <div className="flex flex-wrap items-center gap-2">
          {/* 鍵未設定: ワンクリックで設定パネルを開く主アクション(目立たせる) */}
          {isMissingKey && (
            <Button size="sm" onClick={requestOpenSettings}>
              <Settings className="size-4" aria-hidden />
              {tSettings("open_settings_action")}
            </Button>
          )}
          {error.retryable && onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              {tCommon("retry")}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// research のソフト失敗を結果上部に「警告」として表示
function ResearchWarning({
  error,
}: {
  error: { kind: string; message: string };
}) {
  const t = useTranslations("result");
  const tSettings = useTranslations("settings");
  // BYOK: 鍵未設定の詳細は親切な i18n 文言にマップ(設定パネルへ誘導)。
  const isMissingKey = error.kind === "missing_api_key";
  // BYOK: レート制限/利用枠超過(429)の生メッセージも親切な i18n 文言に置換
  // (分析は要約なしで継続する旨の本文は維持)。
  const isRateLimit = error.kind === "rate_limit";
  // AI 分析の検証失敗(analysis_validation)の生メッセージも親切な i18n 文言に置換。
  const isAnalysisValidation = error.kind === "analysis_validation";
  // 未マップ kind は生の英語技術メッセージではなくジェネリックな親切文言に置換。
  const detailMessage = isMissingKey
    ? tSettings("missing_key_error")
    : isRateLimit
      ? tSettings("rate_limit_error")
      : isAnalysisValidation
        ? tSettings("analysis_validation_error")
        : tSettings("generic_error");
  return (
    <Card className="border-amber-500/40 bg-amber-50/30 dark:bg-amber-950/20">
      <CardHeader>
        <CardTitle className="text-base text-jp-balance">{t("research_warning_title")}</CardTitle>
        <CardDescription>
          <span className="font-mono text-xs">{error.kind}</span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground text-jp">
          {t("research_warning_message")}
        </p>
        <p className="mt-2 text-xs text-muted-foreground text-jp">
          {t("research_warning_detail_prefix")} {detailMessage}
        </p>
        {isMissingKey && (
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={requestOpenSettings}
          >
            <Settings className="size-4" aria-hidden />
            {tSettings("open_settings_action")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// =============================================================================
// Overall assessment
// =============================================================================
//
// 2026-05-25 Task #17: 下部の CompanySummarySection / InterviewQuestionsSection を削除。
// それぞれの責務は右パネルの「企業要約」「面接質問」タブが担うため、下部表示は
// 冗長(ユーザー dogfood で確認)。総評(OverallAssessment)は右パネルに無いため
// 下部に残す。EvidenceItem helper も CompanySummarySection 専用だったため削除。

// UX 改修 3a (2026-05-23): 視覚階層強化。
// - 強み: emerald 系 accent line + TrendingUp icon + green ドット bullet
// - 改善余地: amber 系 accent line + AlertCircle icon + amber ドット bullet
// - 保たれた個性: blue 系 accent line + Sparkles icon + 引用風スタイル
// Linear / Notion 系のミニマル & 洗練を継承(過剰装飾は避ける、subtle なアクセントのみ)。
function OverallAssessmentSection({
  assessment,
}: {
  assessment: OverallAssessment;
}) {
  const t = useTranslations("result");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          {t("overall_title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <p className="text-sm leading-relaxed text-jp">{assessment.summary}</p>

        {assessment.strengths.length > 0 && (
          <AssessmentBlock
            kind="strength"
            title={t("strengths_label")}
            icon={<TrendingUp className="size-3.5" />}
            items={assessment.strengths}
          />
        )}

        {assessment.weaknesses.length > 0 && (
          <AssessmentBlock
            kind="weakness"
            title={t("weaknesses_label")}
            icon={<AlertCircle className="size-3.5" />}
            items={assessment.weaknesses}
          />
        )}

        <Separator />

        {/* preserved_voice_note: HITL 哲学の中核 — 個性保護。
            blue 系 accent + Sparkles icon + 引用風スタイルで「AI が触れなかった
            ユーザーの個性」を視覚的に区別する。 */}
        <VoiceNoteBlock note={assessment.preserved_voice_note} />
      </CardContent>
    </Card>
  );
}

// =============================================================================
// AssessmentBlock — 強み / 改善余地の共通レイアウト
// =============================================================================
// 左の accent line(2px、対応色)+ icon + 日本語ラベル ヘッダー、
// 中身は カラードット bullet 付きの ul。Linear / Notion のミニマル accent。
function AssessmentBlock({
  kind,
  title,
  icon,
  items,
}: {
  kind: "strength" | "weakness";
  title: string;
  icon: React.ReactNode;
  items: ReadonlyArray<string>;
}) {
  const accentBorderClass =
    kind === "strength" ? "border-emerald-500/60" : "border-amber-500/60";
  const labelTextClass =
    kind === "strength"
      ? "text-emerald-700 dark:text-emerald-400"
      : "text-amber-700 dark:text-amber-400";
  const dotClass =
    kind === "strength"
      ? "bg-emerald-500 dark:bg-emerald-400"
      : "bg-amber-500 dark:bg-amber-400";

  return (
    <div className={cn("border-l-2 pl-3", accentBorderClass)}>
      <h4
        className={cn(
          "mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide",
          labelTextClass,
        )}
      >
        {icon}
        {title}
      </h4>
      <ul className="flex flex-col gap-1.5">
        {items.map((item, i) => (
          <li
            key={i}
            className="relative flex gap-2 pl-1 text-sm leading-relaxed"
          >
            <span
              className={cn(
                "mt-1.5 size-1.5 shrink-0 rounded-full",
                dotClass,
              )}
              aria-hidden
            />
            <span className="text-jp">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// =============================================================================
// VoiceNoteBlock — 保たれた個性(HITL 哲学の中核)
// =============================================================================
// blue 系 accent + Sparkles icon + 引用風の subtle スタイル。
// 「AI が触れなかったユーザー固有の表現 / 強み」を視覚的に特別扱いし、
// ユーザーが「自分の個性が保たれた」と直感的に認知できるよう設計。
function VoiceNoteBlock({ note }: { note: string }) {
  const t = useTranslations("result");
  return (
    <div className="border-l-2 border-blue-500/60 pl-3">
      <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-blue-700 dark:text-blue-400">
        <Sparkles className="size-3.5" />
        {t("voice_note_label")}
      </h4>
      <p className="rounded-md bg-blue-50/60 dark:bg-blue-950/30 px-3 py-2 text-sm leading-relaxed italic text-foreground/90 text-jp">
        {note}
      </p>
    </div>
  );
}

// =============================================================================
// ResultPanel — top-level
// =============================================================================
//
// UX 改修 1b: 分析前(phase === "idle")の IdlePreview を廃止。
// MainArea が単一カラム表示で InputForm のみを出し、ResultPanel は呼ばれない。
// 万一 idle で呼ばれた場合は null を返す(従来の preview card は不要)。
export function ResultPanel() {
  const phase = useAnalyzeStore((s) => s.phase);
  const companySummary = useAnalyzeStore((s) => s.companySummary);
  const analysisResult = useAnalyzeStore((s) => s.analysisResult);
  const researchError = useAnalyzeStore((s) => s.researchError);
  const analyzeError = useAnalyzeStore((s) => s.analyzeError);
  const resetSession = useAnalyzeStore((s) => s.resetSession);
  // Canvas に渡す文字数制限(form から購読)。
  // ES 本文(esBody)は Phase F Step 2 で Canvas が store.currentEsBody を
  // 直接購読する構造に変更したため、ここでは props として渡さない。
  const charLimitStr = useAnalyzeStore((s) => s.form.char_limit);
  const charLimit = Number(charLimitStr);
  const charLimitForCanvas = Number.isFinite(charLimit) && charLimit > 0
    ? charLimit
    : undefined;

  // idle 時は何も表示しない(MainArea が ResultPanel を呼ばない設計、保険として null)
  if (phase === "idle") {
    return null;
  }

  // 2026-05-24: 初回分析中(researching / analyzing)の loading 表示は
  // AnalyzingOverlay(components/layout/AnalyzingOverlay.tsx)に集約された。
  // 本コンポーネントは loading 中も「null を返す」(MainArea も loading 時には
  // ResultPanel をマウントしない設計)。保険として isLoadingPhase でも null を返す。
  if (isLoadingPhase(phase)) {
    return null;
  }

  if (phase === "error" && analyzeError) {
    return (
      <div className="flex flex-col gap-4">
        {researchError && <ResearchWarning error={researchError} />}
        <ErrorDisplay
          error={analyzeError}
          onRetry={analyzeError.retryable ? resetSession : undefined}
        />
      </div>
    );
  }

  if (phase === "done" && analysisResult) {
    // Task #27 (2026-05-25): SummaryBar から文字数表示を撤去 → Canvas 内 ES 本文ブロック
    // 上端に移動。SummaryBar には件数集計と「再分析」ボタンのみが残り、esLength props は
    // 不要になった。getDisplayEsLength helper は Canvas 内部で `displayEsBody.length` を
    // 直接使う形で SSOT を維持(getDerivedEsBody → 派生 ES 本文長)、ResultPanel での
    // 計算は冗長になるため撤去。
    return <ResultPanelDoneLayout
      researchError={researchError}
      analysisResult={analysisResult}
      companySummary={companySummary}
      charLimit={charLimitForCanvas}
    />;
  }

  // この分岐に来ることは型的にはあり得るが、UX 上は出ない(phase=done なら必ず result がある)
  return null;
}

// =============================================================================
// Commit D-1 (2026-05-25): 書き込み型 UI(Grammarly モデル)レイアウト
// =============================================================================
// 構成(上から):
//  1. research warning(あれば)
//  2. SummaryBar(件数 + 文字数 俯瞰、Grammarly の上部メトリクスバー相当)
//  3. メインエリア(grid):
//     - 中央: Canvas(ES 本文 + inline ハイライト、主役)
//     - 右: SuggestionDetailPanel(selected があれば 1 件詳細、無ければ一覧)
//  4. 下部補助: 総評 / 企業要約 / 面接質問 を縦積み
//
// レイアウト比は中央 3fr : 右 2fr(60/40)。
// sm/md は縦積み(Canvas → 詳細 → 補助)。
function ResultPanelDoneLayout({
  researchError,
  analysisResult,
  companySummary,
  charLimit,
}: {
  researchError: { kind: string; message: string } | null;
  analysisResult: import("@/lib/schema/analysis").AnalysisResult;
  companySummary: CompanySummary | null;
  charLimit?: number;
}) {
  return (
    <div className="flex flex-col gap-5">
      {researchError && <ResearchWarning error={researchError} />}

      {/* 上部サマリーバー(件数の俯瞰 + 再分析ボタン)
          Task #27 (2026-05-25): 文字数表示は Canvas 内 ES 本文ブロック上端に移動 →
            SummaryBar には esLength / charLimit props は渡さない。
            代わりに SummaryBar 右側に「再分析」ボタンが集約された(Canvas / InterviewPanel
            から撤去、1 つに集約)。 */}
      <SummaryBar suggestions={analysisResult.suggestions} />

      {/* メインエリア: 中央 ES + 右パネル(指摘 / 企業要約 / 面接質問 タブ)
          lg+ で grid 3fr_2fr、sm/md は縦積み(Canvas → 右パネル)
          Commit D-4 (2026-05-25): 右パネルを SuggestionDetailPanel から RightPanel に拡張、
          3 タブ(指摘 / 企業要約 / 面接質問)を統合。selectedSuggestionId が立った時は
          「指摘」タブを強制 active(ハイライトクリックの導線整合) */}
      <MainSection
        suggestions={analysisResult.suggestions}
        companySummary={companySummary}
        interviewQuestions={analysisResult.interview_questions}
        charLimit={charLimit}
      />

      {/* 下部: 総評のみ
          2026-05-25 Task #17: Commit D-4 で「右パネル + 下部両立」を採用していたが、
          ユーザー dogfood で「右パネルで企業要約と面接質問は完結している、下部は冗長」と
          フィードバック。企業要約 / 面接質問の下部表示は削除し、右パネル(タブ)に一本化。
          総評(overall_assessment)は右パネルに無い独立した俯瞰情報のため下部に残す。 */}
      <OverallAssessmentSection
        assessment={analysisResult.overall_assessment}
      />

      {/* v2 dogfood UX 改善 Task C (2026-05-26): partial refresh 完了の短時間 toast 通知。
          fixed positioned のため JSX 配置順は visual position に影響しない(画面右下に
          固定表示)。store の refreshCompletedAt timestamp 変化で 3 秒間表示 → 自動消失。
          全分析(refresh stream)完了時は AnalyzingOverlay 終了で十分通知済のため、
          store 側で partial refresh 経路のみ refreshCompletedAt を set する設計
          (applyRefreshResult / applyConflictNewVersion では立てない)。 */}
      <RefreshCompletionToast />

      {/* 提出後改善 #4 (2026-06-10): structural 採用が現在の本文に適用できなかった
          (防御的 no-op)ときのエラートーン toast。状態は何も変更されず suggestion は
          PENDING のまま、という事実をユーザーに正直に通知する。fixed positioned のため
          JSX 配置順は visual position に影響しない(画面右下に固定表示)。 */}
      <StructuralApplyFailureToast />
    </div>
  );
}

// =============================================================================
// MainSection — メインエリア(Canvas + RightPanel)
// =============================================================================
// useTranslations("result") を使うため別関数に切り出し(aria-label の i18n)。
function MainSection({
  suggestions,
  companySummary,
  interviewQuestions,
  charLimit,
}: {
  suggestions: import("@/lib/schema/suggestion").Suggestion[];
  companySummary: CompanySummary | null;
  interviewQuestions: InterviewQuestions | undefined;
  charLimit?: number;
}) {
  const t = useTranslations("result");
  return (
    <section
      aria-label={t("main_section_aria")}
      className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start"
    >
      <Canvas charLimit={charLimit} suggestions={suggestions} />
      <RightPanel
        suggestions={suggestions}
        companySummary={companySummary}
        interviewQuestions={interviewQuestions}
      />
    </section>
  );
}
