"use client";

// =============================================================================
// Phase G Step 3a: Canvas — Popover 廃止 + 双方向ハイライト
// =============================================================================
//
// Step 3a 改修:
//  - HighlightSpan の Popover を廃止 (F1.3 を上書き)。詳細表示は右ペインの
//    SuggestionListPanel(inline カード)が担う。
//  - HighlightSpan は **クリックで selectSuggestion(id)、hover で setHoveredSuggestion(id)** のみ。
//  - 双方向ハイライト: store の hoveredSuggestionId / selectedSuggestionId を購読し、
//    一致する suggestion の HighlightSpan を強調表示する。
//  - 件数 badge / alternative トグルは SuggestionListPanel のヘッダに移動。
//    Canvas 上部に残すのは「直接編集」「Undo」「Redo」のみ
//    (編集モード直結のため Canvas 直上が直感的、UX 改修 1b の流儀継承)。
//  - 文字数表示 + 「文字数を抑える」ボタンは ES 本文ブロックの上端に集約配置
//    (Task #27 で文字数を上端移動、Task #32a で「文字数を抑える」も同行に集約)。
//
// Task #27 (2026-05-25):
//  - 「再分析」ボタンを Canvas 上部ツールバーから撤去 → SummaryBar 右側に 1 つに集約。
//    Canvas 上部の高さがアクション履歴に応じて変動する問題(採用後に ES 位置が下に
//    ずれる dogfood 観察)を構造解消。
//  - 文字数 + 制限の表示を SummaryBar 右側から本 Canvas の ES 本文ブロック上端に移動。
//    ユーザー要望「文字数と制限は ES 本文のブロック内においた方が良い」「視線の上端で
//    確認したい」を反映。
//
// Task #32a (2026-05-25):
//  - 「文字数を抑える」ボタンを CardHeader 下部別行から ES 本文上端文字数表示の隣に
//    集約配置。「上限超過表示とアクションが遠い、隣接配置希望」dogfood 観察に対応。
//  - directEditMode ON/OFF 切替の layout jump を min-h-[20rem] 共通指定 + window.scrollY
//    退避 / 復元で抑制(useEffect cleanup で前 scrollY を保存、本体で setTimeout 0 復元)。
//
// Task #26 (2026-05-25):
//  - HighlightSpan / AutoCorrectedSpan クリックの toggle を撤去。既選択時 no-op、
//    そうでなければ selectSuggestion(id) でセット。
//    旧 toggle は「既選択 → null → SuggestionDetailPanel placeholder」フォールバック bug を
//    生んでいた(Task #22 で右パネル card クリック toggle を撤去した規律を Canvas にも拡張)。
//
// 責務(Step 3a 改修後):
//  - ES 本文を画面中央に大きく表示(currentEsBody 由来、accepted/edited で派生変化)
//  - 各 suggestion の original_span 位置をカテゴリ別色でハイライト
//  - ハイライトのクリック → selectSuggestion(id) → リスト側で対応カードに scroll
//  - ハイライトの hover → setHoveredSuggestion(id) → リスト側のカードが subtle 強調
//  - 上部に「直接編集」Switch / Undo / Redo(「再分析」「文字数を抑える」は別配置)
//  - 採用済 / 却下済 / 編集済 suggestion はハイライトをスキップ(派生 ES と整合)
//  - 直接編集モード中は全ハイライト一時非表示、ES 本文 contentEditable
//
// 設計判断(Step 1〜3a 通して):
//  1) **ハイライトはサーバ側で解決済の `original_span` を使う**
//  2) **重なり時は「先勝ち」非重複セグメント分解**(Phase C「最初のヒット」と整合)
//  3) **alternative デフォルト非表示**(`docs/design_v1.md` §4.4、SuggestionListPanel に移譲)
//  4) **カテゴリ別配色**(error: destructive / convention: amber / alternative: blue dotted)
//  5) **クリックで詳細を出す UI は廃止**(Step 3a で Popover を撤廃、リストが代替)
//  6) **HighlightSpan は span (inline) で実装**(テキストの流れに溶け込む)
//  7) **採用 / 却下 / 編集の即時反映**: API 呼び出しなし、store mutation のみで Canvas が即時更新
//  8) **「再分析する」ボタン (Phase G Step 2 で機能化)**: action_history が空でない時のみ表示
//  9) **Undo は直前 1 ステップのみ**
//  10) **直接編集モードの位置追従は Phase G に回す**(本実装では一時非表示で回避)
//  11) **carving by currentEsBody**: Canvas の表示元データは store.currentEsBody + getDerivedEsBody
//
// UX 改修 1 / 1b 維持:
//  12) **直接編集 ON/OFF 切替時の二重テキストバグ修正** (`contentEditable="plaintext-only"` + key)
//  13) **採用 / 編集後のハイライト位置補正** (派生 span ベース `getDerivedSpans`)
//
// UX 改修 3a / 3b 維持:
//  14) **却下時の見た目**: F2.3 の strikethrough + opacity-50 を廃止、ハイライト描画自体スキップ
//  15) **件数 badge から却下済を除外**(SuggestionListPanel 側でも同じロジック)
//  16) **文字数監視**: 派生 ES = displayEsBody.length を Canvas ヘッダに常時表示
//  17) **「文字数を抑える」モード**: 上限超過時のみ primary ボタン、ES 本文上端文字数表示の隣に配置(Task #32a)
//
// Step 3a 追加判断:
//  18) **HighlightSpan の hover/selected 強調**: store 経由で双方向ハイライト
//      - hovered: ring-1 + ring-foreground/40(subtle)
//      - selected: ring-2 + ring-primary/60 + bg 強化(明確)
//      - 両方真の場合は selected が優先(より明示的)
//  19) **件数 badge / alternative トグル / 案内テキスト「クリックで詳細」を Canvas から撤去**:
//      SuggestionListPanel が件数 badge / alternative トグルを担う。
//      案内テキストは「クリックで詳細」→「クリック / hover で右ペインと連動」に更新。
//
// Phase G 修正 (2026-05-23):
//  20) **自動 refresh デバウンス機構を完全撤去**(Step 3b-3 の autoRefreshTimer /
//      autoRefreshEnabled / autoRefreshTrigger / 「自動更新」Switch UI / アクション別
//      delay を全て撤去)。代わりに store action 内で同期的に partialRefreshTrigger を
//      +1 し、Canvas が即時 handleRefresh("balanced") を発火する設計に統一。
//      DECISIONS 2026-05-23 §1「採用 / 編集 / 却下 / Undo / Redo のたびに即座に
//      partial refresh 呼び出し」と整合(2026-05-25 統合改修で呼び出し先 LLM は
//      GPT-5.4 full に統一済)。
//
// AGENTS.md Inviolable constraints との対応(Step 3a も維持):
//  - 数値スコア禁止: 件数バッジは「個数」表現
//  - ハイライト総数 ≤ 15: API 側で suggestions ≤ 15 が保証されているため自動的に成立
//  - ES 全面書き換え禁止: Canvas に「全採用」ボタンを置かない、個別カード単位の採用のみ
//  - localStorage 不使用: store はメモリのみ
//  - すべての操作は Undo 可能: Step 2 で直前 1 ステップ undo を実装
//  - 競合通知 / 楽観的並行制御: Phase G Step 2 で実装済
//  - ユーザーは待たない: Step 2 のアクションは API 呼び出しを伴わず即座反映
//
// SSOT: lib/schema/suggestion.ts (Suggestion, OriginalSpan, Category)
//       lib/state/analyze_store.ts (selectedSuggestionId, hoveredSuggestionId,
//         showAlternatives, acceptedSuggestionIds, rejectedSuggestionIds,
//         editedSuggestions, directEditMode, currentEsBody, actionHistory,
//         getDerivedEsBody, getDerivedSpans, setHoveredSuggestion)

import * as React from "react";
import { useTranslations } from "next-intl";
import {
  appendCaptureMetaEntry,
  buildClarificationEnrichedIntent,
  buildPartialBundle,
  buildRefreshBundle,
  canRedoFromToolbar,
  canUndoFromToolbar,
  getDerivedEsBody,
  getDerivedSpans,
  isOverCharLimit,
  reconcileSpansToDisplayedText,
  useAnalyzeStore,
} from "@/lib/state/analyze_store";
// 提出後改善 #3 準備 (2026-06-09): /api/semantic-diff 応答の optional `capture_meta`。
import type { CaptureMeta } from "@/lib/llm/capture_meta";
import { callAnalyzeStream } from "@/lib/concurrency/analyze_stream";
import { openAIKeyHeader, requestOpenSettings } from "@/lib/byok";
import type { Category, DisplayPriority, Suggestion } from "@/lib/schema/suggestion";
import type { ActionHistoryEntry } from "@/lib/schema/input";

// =============================================================================
// Commit D-1 (2026-05-25): 派生 ES 本文長を外部 (SummaryBar / ResultPanel) と共有
// =============================================================================
// Canvas 内部で `displayEsBody.length` を計算しているが、SummaryBar も同じ値を
// 表示する必要があるため、helper として export(SSOT の責務統一)。
// directEditMode 中は currentEsBody 生をそのまま返す(派生計算をスキップ)。
// 2026-05-28 dogfood round 3 ⑤: bakedIds(default 空)を透過。直接編集後の通常表示でも
// 焼き込み済の二重適用を防ぐ(getDerivedEsBody と同じ規律、default 空で挙動不変)。
export function getDisplayEsLength(
  currentEsBody: string,
  suggestions: ReadonlyArray<Suggestion>,
  acceptedSuggestionIds: ReadonlyArray<string>,
  editedSuggestions: Readonly<Record<string, string>>,
  directEditMode: boolean,
  bakedIds: ReadonlyArray<string> = [],
): number {
  if (directEditMode) return currentEsBody.length;
  return getDerivedEsBody(
    currentEsBody,
    suggestions,
    acceptedSuggestionIds,
    editedSuggestions,
    bakedIds,
  ).length;
}
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Bell,
  Eye,
  FileText,
  Loader2,
  Pencil,
  Redo2,
  RotateCcw,
  Scissors,
  Settings,
  Sparkles,
  Type,
  Undo2,
  Wand2,
  X,
} from "lucide-react";

// =============================================================================
// カテゴリ別のハイライト Tailwind class
// =============================================================================
// 「ES の可読性を損なわない」を最優先。背景色は薄め、underline は実線/点線で
// カテゴリ間の見分けが視覚的に取れるようにする。
//
// Task #22 (2026-05-25): Task #21 で導入した朱系 subtle 下線(Word 校閲風)を **完全撤回**。
// 「中央 = Grammarly モデル(薄い背景色)」/「右パネル詳細 = Word 校閲風 diff」の明確な
// 分業に再構成。中央は最終提出物としての可読性を最優先、修正プロセスの可視化(取り消し線
// + 朱字)は右パネル詳細展開(SuggestionCard の DiffPair)に集中させる。
//
//   - error: destructive 系の薄背景 + 実線 underline
//   - convention: amber 薄背景 + 実線 amber underline
//   - alternative: blue 控えめ背景 + 点線 underline(控えめさを強調)
//
// DECISIONS §A「中央 Canvas: Grammarly モデルに巻き戻し」を SSOT として参照。
//
// Commit D-2 (2026-05-25) からの継承: `display_priority`(high/medium/low の文字列タグ)
// に応じて背景濃度を調整。AGENTS.md「ユーザーに見える数値スコア禁止」遵守のため、
// 内部 priority 数値(`internal_priority`)は UI で参照禁止。
const CATEGORY_HIGHLIGHT_CLASS: Record<Category, string> = {
  // error: destructive 系の薄背景 + 実線 underline
  error:
    "bg-destructive/10 underline decoration-destructive decoration-2 underline-offset-4 hover:bg-destructive/20",
  // convention: amber 薄背景 + 実線 amber underline
  convention:
    "bg-amber-100/60 dark:bg-amber-950/40 underline decoration-amber-500 decoration-2 underline-offset-4 hover:bg-amber-100/90 dark:hover:bg-amber-950/60",
  // alternative: blue 控えめ背景 + 点線 underline(控えめさを強調)
  alternative:
    "bg-blue-100/40 dark:bg-blue-950/30 underline decoration-blue-400 decoration-dotted decoration-2 underline-offset-4 hover:bg-blue-100/70 dark:hover:bg-blue-950/50",
  // v2 Phase B4 (2026-05-26): structural はハイライト skip(空文字 class、defensive 維持)。
  // 設計判断:
  //  - structural は段落 / 文単位の構造操作(段落削除 / 順番変更 / 統合 / 文移動 / 段落追加)で、
  //    文字単位の inline underline と本質的に親和しない(段落全体に下線を引くと
  //    ES 本文の可読性が著しく低下、また「順番変更 = 場所自体が動く」は inline 表示不可)。
  //  - 右パネル SuggestionListPanel で structural CountBadge + StructuralOperationBlock
  //    カード表示が担当(commit 4 で完了)。Canvas 中央は ES 本文の可読性に振り切る。
  //  - 段落単位の枠 / 矢印 / 移動先示唆等の専用 UI は v3 候補(B1 dispatch にも記載)。
  //    本 Phase は「最小実装で構造変更を表現する責務をパネルに集約」の方針を採用。
  //
  // v2 bug fix (2026-05-26): 「structural の original_span に対応するセグメントが
  //  buildSegments で空文字 class の hi セグメントとして描画される」という Phase B4 当初設計は
  //  廃止し、`getDerivedSpans`(lib/state/analyze_store.ts)側で structural を **完全 skip** する
  //  方針に変更した。理由:
  //    1. structural の `proposed` は「(段落削除:…)」のような placeholder で文字単位の置換対象でない
  //    2. 派生 ES 計算で structural を走査すると累積オフセットを狂わせ、他 (error/convention/alternative)
  //       suggestion の派生 span が ずれる
  //    3. structural 採用後に `proposed` が currentEsBody に混入する重大バグの原因にもなっていた
  //  結果: structural は Canvas 中央には何も描画されない(素のテキストとして流れるだけ、
  //   click/hover handler も付かない)。右パネル(SuggestionListPanel / SuggestionCard / StructuralOperationBlock)
  //   が structural の全 HITL 動線を担当する。空文字 class は defensive として維持。
  structural: "",
};

// Commit D-2 (2026-05-25): `display_priority` を背景濃度に反映する補助クラス。
// 既存の CATEGORY_HIGHLIGHT_CLASS の上から重ねる subtle layer。`internal_priority`
// (数値、UI 参照禁止)ではなく `display_priority`(文字列タグ、UI 渡し済の表現)を参照。
// `high` のみ追加の subtle ring(focus 強化)、`low` は背景をさらに薄く、`medium` は素のまま。
//
// Task #22 (2026-05-25): Task #21 で opacity 軸に再設計したが、背景色復帰に伴い
// Task #21 直前の ring + opacity の構成(high: ring-1 / low: opacity-80)に戻す。
const PRIORITY_BG_AUGMENT_CLASS: Record<DisplayPriority, string> = {
  // 重要度高: 既存のカテゴリ色を 1 段強める(背景濃度を増やす)
  high: "ring-1 ring-inset ring-foreground/15",
  medium: "",
  // 重要度低: 既存のカテゴリ色をさらに薄める(opacity で background のみ down、underline は維持)
  low: "opacity-80",
};

// カテゴリ別のラベルは i18n 経由(messages/<locale>.json の "category" namespace)
// 旧版: ハードコード "誤り" / "慣習" / "代替案" を CATEGORY_LABEL[Category] で引いていた
// 新版: HighlightSpan / AutoCorrectedSpan 内で useTranslations("category")(suggestion.category) を呼ぶ

// =============================================================================
// セグメント分解(派生 span ベース、UX 改修 1b 2026-05-23)
// =============================================================================
// 派生 ES 本文 (displayEsBody) を、`getDerivedSpans()` で算出した派生 span に
// 沿ってプレーン文字 / ハイライト / 自動修正 に分解する。
//
// 入力:
//  - displayEsBody: 派生 ES 本文(採用 / 編集済の置換が反映された状態)
//  - suggestions: 全 suggestion(描画対象でないものも累積オフセット計算で必要)
//  - showAlternatives: alternative カテゴリを描画するか
//  - acceptedIds / editedMap / rejectedIds: 各状態の ID 集合
//  - autoCorrectedIds: 自動修正済 ID 集合(Phase G Step 3b-1)
//
// 出力: Array<
//   { kind: "plain", text }
//   | { kind: "hi", text, suggestion }
//   | { kind: "auto", text, suggestion }
// >
//
// 走査:
//  - `getDerivedSpans()` を呼んで全 suggestion の派生 span を取得
//  - 各 span を派生 ES 本文上で順に処理し、cursor 位置を進めながら plain / hi / auto
//    セグメントを生成
//  - isApplied (採用済 / 編集済) は通常スキップだが、autoCorrectedIds に含まれる場合は
//    "auto" セグメントとして emerald 系 subtle 強調で描画(Phase G Step 3b-1)
//  - isRejected もハイライト描画をスキップ(UX 改修 3a で F2.3 を上書き、元の
//    通常テキストに戻す。Undo するとハイライト復活)
//  - alternative トグル OFF の場合は alternative カテゴリを描画スキップ、
//    ただし累積オフセット計算には含まれている(派生 span は既に正しい位置)
//
// UX 改修 1b 以前の挙動: `original_span` を直接使い、採用後に他指摘の位置がずれる
// (採用 → 文字数変化 → 後続 span の元位置はもう正しくない)構造的不備があった。
type Segment =
  | { kind: "plain"; text: string }
  | { kind: "hi"; text: string; suggestion: Suggestion }
  | { kind: "auto"; text: string; suggestion: Suggestion };

function buildSegments(
  displayEsBody: string,
  suggestions: ReadonlyArray<Suggestion>,
  showAlternatives: boolean,
  acceptedIds: ReadonlyArray<string>,
  editedMap: Readonly<Record<string, string>>,
  rejectedIds: ReadonlyArray<string>,
  // Phase G Step 3b-1: 自動修正済 ID 集合(emerald 系 subtle 強調)
  autoCorrectedIds: ReadonlyArray<string>,
  // 元 esBody の長さ(派生計算で範囲外判定に使う、currentEsBody の長さ)
  originalEsBodyLength: number,
  // 2026-05-28 dogfood round 3 ⑤: 直接編集 flatten で焼き込み済の id 集合(派生計算で完全 skip)
  bakedIds: ReadonlyArray<string> = [],
): Segment[] {
  // suggestion を id でルックアップ可能にしておく(派生 span から復元するため)
  const suggestionById = new Map(suggestions.map((s) => [s.id, s]));

  // 派生 span を取得(start 昇順、走査順)
  const rawSpans = getDerivedSpans(
    suggestions,
    acceptedIds,
    editedMap,
    rejectedIds,
    originalEsBodyLength,
    bakedIds,
  );

  // 2026-05-28 ハイライト位置ずれ(症状 B)補正: 派生 span を **表示中 ES の実テキスト**で
  // 検証・補正する additive な post-process。座標計算で位置を追う既存ロジック(座標系統一
  // bug fix 等)が unanchorable case(採用で変化したテキストを後発 pending 提案が指す等)で
  // 残す誤位置 span を、displayEsBody の実テキストにアンカーし直す / 出せないなら抑制する。
  // 正しい span(slice が一致)は素通り = 既存の正しい挙動は不変。
  // 詳細は lib/state/analyze_store.ts:reconcileSpansToDisplayedText 参照。
  const derivedSpans = reconcileSpansToDisplayedText(
    rawSpans,
    suggestions,
    displayEsBody,
    {
      acceptedIds,
      editedMap,
      autoCorrectedIds,
      // 2026-05-28 BUG #1 fix: baked id を渡し、生成的補完の対象外にする(getDerivedSpans と対称)。
      bakedIds,
      // 2026-05-29 shadow-rescue fix: 却下済 id を渡し、pending-rescue(採用済 unanchorable が
      // 隣接 pending を過剰 shadow した落ちの救済)で却下済を除外する。
      rejectedIds,
    },
  );

  const segments: Segment[] = [];
  let cursor = 0;
  for (const span of derivedSpans) {
    const suggestion = suggestionById.get(span.suggestion_id);
    if (!suggestion) continue;
    // Phase G Step 3b-1: 採用済の中でも autoCorrected は subtle 強調で描画
    const isAutoCorrected = autoCorrectedIds.includes(span.suggestion_id);
    if (span.isApplied && !isAutoCorrected) {
      // 通常の採用 / 編集済(ユーザー能動)はハイライト描画をスキップ(本文は置換済)
      continue;
    }
    // 却下済もハイライト描画をスキップ(UX 改修 3a、F2.3 を上書き)
    // 元の通常テキストに戻す。Undo すれば rejectedSuggestionIds から外れて
    // 自動的にハイライト復活する経路は維持。
    if (span.isRejected) continue;
    // alternative トグル OFF なら alternative カテゴリをスキップ(描画のみ、span 位置は維持)
    if (!showAlternatives && suggestion.category === "alternative") continue;
    // 派生 span の範囲ガード(派生 ES 本文の中に収まっているか)
    if (span.derivedStart < cursor) continue;
    if (span.derivedStart >= displayEsBody.length) continue;
    const clampedEnd = Math.min(span.derivedEnd, displayEsBody.length);
    if (clampedEnd <= span.derivedStart) continue;
    // cursor 〜 derivedStart を plain として追加
    if (span.derivedStart > cursor) {
      segments.push({
        kind: "plain",
        text: displayEsBody.slice(cursor, span.derivedStart),
      });
    }
    if (isAutoCorrected) {
      // 自動修正セグメント: emerald 系 subtle 背景 + dashed underline
      segments.push({
        kind: "auto",
        text: displayEsBody.slice(span.derivedStart, clampedEnd),
        suggestion,
      });
    } else {
      segments.push({
        kind: "hi",
        text: displayEsBody.slice(span.derivedStart, clampedEnd),
        suggestion,
      });
    }
    cursor = clampedEnd;
  }
  if (cursor < displayEsBody.length) {
    segments.push({ kind: "plain", text: displayEsBody.slice(cursor) });
  }
  return segments;
}

// =============================================================================
// Canvas top-level
// =============================================================================
//
// Step 3a 改修: props 構成は不変(charLimit + suggestions)。ES 本文は store の
// currentEsBody を直接購読する(直接編集の即時反映を Canvas 単独で完結させる)。
// 派生 ES 本文(採用 / 編集済の置換を適用したもの)は getDerivedEsBody で算出。
//
// Step 3a 変更点:
//  - 件数 badge / alternative トグルは SuggestionListPanel へ移譲(本コンポーネントから撤去)。
//  - Canvas ヘッダはタイトル + 文字数表示 + ツールバー(直接編集 / Undo / 再分析 / 削減)のみ。
//  - HighlightSpan は Popover ラップを撤廃、click / hover で store action を直接呼ぶ。
export interface CanvasProps {
  // 設問の文字数制限(任意、表示用)。`form.question.char_limit` を想定。
  charLimit?: number;
  suggestions: Suggestion[];
}

export function Canvas({ charLimit, suggestions }: CanvasProps) {
  const t = useTranslations("canvas");
  const tCategory = useTranslations("category");
  // Task #27 (2026-05-25): ES 本文ブロック上端の文字数表示で common.char_unit を参照。
  const tCommon = useTranslations("common");
  const showAlternatives = useAnalyzeStore((s) => s.showAlternatives);
  const currentEsBody = useAnalyzeStore((s) => s.currentEsBody);
  const acceptedSuggestionIds = useAnalyzeStore((s) => s.acceptedSuggestionIds);
  const rejectedSuggestionIds = useAnalyzeStore((s) => s.rejectedSuggestionIds);
  const editedSuggestions = useAnalyzeStore((s) => s.editedSuggestions);
  // Phase G Step 3b-1 (2026-05-23): 自動修正済 id 集合を購読し、HighlightSpan 構造の
  // 中で auto セグメントを描画する判定 + バナー表示の判定に使う。
  const autoCorrectedSuggestionIds = useAnalyzeStore(
    (s) => s.autoCorrectedSuggestionIds,
  );
  const undoAllAutoCorrections = useAnalyzeStore(
    (s) => s.undoAllAutoCorrections,
  );
  const directEditMode = useAnalyzeStore((s) => s.directEditMode);
  // 2026-05-28 dogfood round 3 ⑤ 直接編集 bug fix: 直接編集 flatten で currentEsBody に
  // 焼き込み済の採用/編集 id 集合。getDerivedEsBody / getDerivedSpans に渡して二重適用を
  // 防ぐ(baked id は structural と同様に派生計算で完全 skip される)。
  const bakedSuggestionIds = useAnalyzeStore((s) => s.bakedSuggestionIds);
  const actionHistory = useAnalyzeStore((s) => s.actionHistory);
  const toggleDirectEdit = useAnalyzeStore((s) => s.toggleDirectEdit);
  const updateEsBody = useAnalyzeStore((s) => s.updateEsBody);
  // Phase G Step 3b-3 (2026-05-23): undoLastAction は undo(1) に置き換え(後方互換)。
  // 旧 subscription は削除し、新しい undo / redo を購読する。
  // Phase G 修正 (2026-05-23): 自動 refresh デバウンス機構を撤去。
  //  - 旧 autoRefreshEnabled / setAutoRefreshEnabled / autoRefreshTrigger は削除済
  //  - 代わりに partialRefreshTrigger(各 store action が即時 +1)を購読
  const undo = useAnalyzeStore((s) => s.undo);
  const redo = useAnalyzeStore((s) => s.redo);
  const redoStack = useAnalyzeStore((s) => s.redoStack);
  const partialRefreshTrigger = useAnalyzeStore((s) => s.partialRefreshTrigger);
  // 2026-05-27 エージェント的対話(AI 逆質問): refresh 経路で user_context に append する
  // enriched_intent を生成するため、回答集合を購読する(triggerReanalysisWithClarifications
  // 経路で立つ partialRefreshTrigger を観測した時に handleRefresh 内で buildClarificationEnrichedIntent
  // を呼んで bundle に渡す)。
  const clarificationAnswers = useAnalyzeStore((s) => s.clarificationAnswers);
  // 統合改修パッケージ (2026-05-25): 意味的差分判定 queue を購読。
  // 提出後改善 #2 (2026-06-09): pendingRefreshScope の selector 購読は撤去。handleRefresh は
  //   beginRefresh が返す consumedScope(store スナップショット)で scope を読むため、
  //   component 再 render を scope 変化にひも付ける必要がなくなった。
  const semanticDiffQueue = useAnalyzeStore((s) => s.semanticDiffQueue);
  const dequeueSemanticDiff = useAnalyzeStore((s) => s.dequeueSemanticDiff);
  const requestPartialRefresh = useAnalyzeStore((s) => s.requestPartialRefresh);
  // 2026-05-28 dogfood round 3 ②④: 編集して採用 → semantic-diff が「同じ」と判定して
  // refresh を skip した場合、editSuggestion が立てた reEvaluatingSuggestionIds の予測 mark を
  // 取り消す(refresh が走らないため commitPartialRefreshCleanup 等の clear が発火しない)。
  const clearReEvaluating = useAnalyzeStore((s) => s.clearReEvaluating);
  // Task #27 (2026-05-25): triggerFullRefresh は SummaryBar に移管。Canvas からは削除。
  //   - 旧: Canvas 上部ツールバーの「再分析」ボタン(action_history > 0 時のみ可視)で呼び出し
  //   - 新: SummaryBar 右側の常駐「再分析」ボタンで呼び出し(1 箇所集約)
  //   - 詳細: DECISIONS.md [2026-05-25] Task #27 計画
  const conflictNotification = useAnalyzeStore((s) => s.conflictNotification);
  const dismissConflict = useAnalyzeStore((s) => s.dismissConflict);
  const applyConflictNewVersion = useAnalyzeStore(
    (s) => s.applyConflictNewVersion,
  );

  // Phase G Step 2 (2026-05-23): 楽観的並行制御 — refresh の発火 / 進行 / エラー
  const refreshPhase = useAnalyzeStore((s) => s.refreshPhase);
  const refreshError = useAnalyzeStore((s) => s.refreshError);
  const refreshStreamingStage = useAnalyzeStore((s) => s.refreshStreamingStage);
  const beginRefresh = useAnalyzeStore((s) => s.beginRefresh);
  const setRefreshStreamingStage = useAnalyzeStore(
    (s) => s.setRefreshStreamingStage,
  );
  const applyRefreshResult = useAnalyzeStore((s) => s.applyRefreshResult);
  // Phase G Step 3b-2 (2026-05-23): partial 結果を analysisResult にマージ
  const applyPartialResult = useAnalyzeStore((s) => s.applyPartialResult);
  const setRefreshError = useAnalyzeStore((s) => s.setRefreshError);
  const finishRefresh = useAnalyzeStore((s) => s.finishRefresh);
  // 2026-05-25 Task #18: partial refresh の loading / animation UX 用 actions と state
  //  - beginPartialRefresh: stream 開始時に立てる flag(global banner + seed loading)
  //  - commitPartialRefreshCleanup: applyPartialResult 受信 1.5 秒後の cleanup(fade out 完了)
  //  - partialRefreshInProgress: global banner の表示判定用に購読
  const beginPartialRefresh = useAnalyzeStore((s) => s.beginPartialRefresh);
  const commitPartialRefreshCleanup = useAnalyzeStore(
    (s) => s.commitPartialRefreshCleanup,
  );
  const partialRefreshInProgress = useAnalyzeStore(
    (s) => s.partialRefreshInProgress,
  );
  // Phase G Step 3b-2: partial bundle 構築のため analysisResult を購読
  // (acceptedSuggestionIds / rejectedSuggestionIds / editedSuggestions は上で既に購読済)
  const analysisResult = useAnalyzeStore((s) => s.analysisResult);
  // UX 改修 3b (2026-05-23): refresh の目的(balanced / reduce_length)を購読し、
  // 進行バナーの文言と button の状態切替に使う。
  const analyzeGoal = useAnalyzeStore((s) => s.analyzeGoal);
  // refresh bundle 構築のため form / companySummary も購読
  const form = useAnalyzeStore((s) => s.form);
  const companySummary = useAnalyzeStore((s) => s.companySummary);

  // v2 dogfood UX 改善 Task B (2026-05-26): Canvas 中央の表示モード。
  //  - "edited"(default): 派生 ES + 全カテゴリのハイライト active + クリック/hover 連動
  //    + 直接編集可(従来の挙動を完全維持)
  //  - "original":         form.es_body(初回入力時の素の ES)+ ハイライト inactive
  //    + クリック/hover 連動 inactive + 直接編集 disabled(読み取り専用)
  //
  // 設計判断:
  //  - local state で十分(セッション内のみ、リロードで edited に戻る = 安全な default)
  //  - store には載せない(form.es_body は既に store に居る、トグル UI 用の派生 state を
  //    新たに追加する必要なし)
  //  - トグル切替時の scroll 位置は維持(useEffect で介入しない、自然なまま)
  const [displayMode, setDisplayMode] = React.useState<"original" | "edited">(
    "edited",
  );

  // 派生 ES 本文(採用 / 編集済を置換適用、直接編集中は currentEsBody 生)
  // v2 dogfood UX 改善 Task B: displayMode === "original" のときは form.es_body
  // (初回入力時の素の ES)を返す。directEditMode より displayMode が優先(Original
  // 中は直接編集 disable 規律)。
  const displayEsBody = React.useMemo(() => {
    if (displayMode === "original") {
      // v2 Task B: 「素朴な原文」を表示。directEditMode は Original 中 disable のため
      // 通常はここで currentEsBody は参照されない(safety net としては不要)。
      return form.es_body;
    }
    if (directEditMode) {
      // 2026-05-28 dogfood round 3 ⑤ 直接編集 bug fix: 直接編集 ON 時、toggleDirectEdit が
      // currentEsBody を **派生 ES に flatten 済**(採用を積み重ねた今の ES)。よってここで
      // currentEsBody 生を返すことが「積み重ねた ES を編集対象にする」正しい挙動になる。
      // (旧: currentEsBody は form.es_body + structural のみ = text 採用が消えた状態だった)
      return currentEsBody;
    }
    // 2026-05-28: baked(直接編集 flatten 済)id を渡して二重適用を防ぐ。直接編集後に通常
    // 表示へ戻った場合、currentEsBody には採用済が物理的に入っているため、再度の置換は不要。
    return getDerivedEsBody(
      currentEsBody,
      suggestions,
      acceptedSuggestionIds,
      editedSuggestions,
      bakedSuggestionIds,
    );
  }, [
    displayMode,
    form.es_body,
    currentEsBody,
    suggestions,
    acceptedSuggestionIds,
    editedSuggestions,
    bakedSuggestionIds,
    directEditMode,
  ]);

  // セグメント分解(派生 span ベース、UX 改修 1b)
  //   - v2 Task B (2026-05-26): displayMode === "original" 時は plain 1 件を返し、
  //     HighlightSpan / AutoCorrectedSpan を一切描画しない(全カテゴリ ハイライト inactive)
  //   - 直接編集中はハイライトを一時非表示(空配列を渡す)
  //   - それ以外は buildSegments 内で派生 span を計算し、isApplied (採用/編集済)
  //     isRejected (却下済、UX 改修 3a) と alternative トグルに基づいて描画
  //     スキップを判定する
  //   - 却下済は元の通常テキストに戻す(UX 改修 3a、F2.3 の strikethrough を撤廃)
  //   - Phase G Step 3b-1: 自動修正された箇所は emerald 系 subtle 強調で描画
  const segments = React.useMemo(() => {
    if (displayMode === "original") {
      // v2 Task B: 素のテキストを 1 plain segment として出力(クリック / hover 連動なし)
      return [{ kind: "plain" as const, text: displayEsBody }];
    }
    if (directEditMode) {
      // 直接編集中は plain 1 セグメントだけ返す(ハイライト無し)
      return [{ kind: "plain" as const, text: displayEsBody }];
    }
    // 2026-05-27 derivedSpans 座標系統一 bug fix: originalEsBodyLength = `form.es_body.length`
    // (分析時点の元 ES の長さ)を渡す。本 Canvas が前提とする「全 suggestion の `original_span`
    // は form.es_body 基準の単一座標系」を担保するため、範囲ガード `end > esBodyLength` も
    // form.es_body 基準で判定する。
    //
    // 関連修正(同 commit): `applyPartialResult` / `applyRefreshResult` /
    // `applyConflictNewVersion` で新規 suggestion を form.es_body 基準に再アンカー
    // (lib/state/analyze_store.ts:reAnchorSuggestionsToFormEsBody)。サーバ側
    // resolveOriginalSpans は派生 ES(displayEsBody)基準で indexOf 解決するため、
    // 再アンカーが無いと座標系混在で累積オフセット計算が壊れる(ハイライト境界ずれ
    // + lastEnd ガードによる span 落ち = ハイライト消失)。
    //
    // structural は派生計算から完全 skip(category === "structural" で continue)されるため
    // 累積オフセット計算とは独立して動く。
    return buildSegments(
      displayEsBody,
      suggestions,
      showAlternatives,
      acceptedSuggestionIds,
      editedSuggestions,
      rejectedSuggestionIds,
      autoCorrectedSuggestionIds,
      form.es_body.length,
      bakedSuggestionIds,
    );
  }, [
    displayMode,
    directEditMode,
    displayEsBody,
    suggestions,
    showAlternatives,
    acceptedSuggestionIds,
    editedSuggestions,
    rejectedSuggestionIds,
    autoCorrectedSuggestionIds,
    form.es_body.length,
    bakedSuggestionIds,
  ]);

  // 文字数監視は派生 ES(getDerivedEsBody の結果)= displayEsBody を基準にする。
  // Commit D-1 (2026-05-25): 文字数表示は SummaryBar に集約したが、本 Canvas 内では
  // 「文字数を抑える」ボタンの表示条件として overCharLimit が必要なため計算は維持。
  const overCharLimit = isOverCharLimit(displayEsBody.length, charLimit);

  // Phase G Step 3b-1: 自動修正バナー用の情報
  const autoCorrectedSuggestions = React.useMemo(
    () => suggestions.filter((s) => autoCorrectedSuggestionIds.includes(s.id)),
    [suggestions, autoCorrectedSuggestionIds],
  );
  const autoCorrectedCount = autoCorrectedSuggestions.length;

  // 「全て元に戻す」(Canvas バナー側) — SuggestionListPanel と同じ confirmation 経由
  const errorCategoryLabel = tCategory("error");
  const handleUndoAllAuto = React.useCallback(() => {
    if (autoCorrectedSuggestions.length === 0) return;
    const ok = window.confirm(
      t("auto_correction_undo_all_confirm", {
        count: autoCorrectedSuggestions.length,
      }),
    );
    if (!ok) return;
    undoAllAutoCorrections(
      autoCorrectedSuggestions.map((s) => {
        // SuggestionCard / SuggestionListPanel と同じサマリ形式
        const SNIPPET_LEN = 30;
        const snippet =
          s.original.length > SNIPPET_LEN
            ? s.original.slice(0, SNIPPET_LEN) + "…"
            : s.original;
        return {
          suggestion_id: s.id,
          suggestion_summary: `[${errorCategoryLabel}] ${snippet}`,
        };
      }),
    );
  }, [autoCorrectedSuggestions, undoAllAutoCorrections, t, errorCategoryLabel]);

  // ---------------------------------------------------------------------------
  // Phase G Step 2 (UX 改修 3b 2026-05-23 / Step 3b-2 2026-05-23): 「再分析する」クリックハンドラ
  // ---------------------------------------------------------------------------
  // Step 3b-2 で partial 経路に切り替え(2026-05-25 統合改修で provider 完全統一、
  // partial / refresh とも GPT-5.4 full で実装):
  //   - goal === "balanced" + analysisResult あり → **partial 経路**(GPT-5.4 で
  //     変更分のみ更新、前回評価を prompt cache で引き継ぐ、コスト + latency を大幅削減)
  //   - goal === "reduce_length" → 既存 **refresh stream(全体再分析)**(削減モードは
  //     partial では精度が落ちる可能性があるため fallback として維持)
  //   - analysisResult / overall_assessment が無い場合は防御的に refresh stream に fallback
  //
  // 楽観的並行制御の核(変更なし):
  //   1. beginRefresh({ goal }) で前の fetch を abort、新 AbortController + baseVersion を取得
  //   2. partial / refresh の bundle を組み立てる
  //   3. callAnalyzeStream(bundle, { signal, onStage }) で SSE 受信
  //   4. ok かつ kind="partial" なら applyPartialResult、kind="full" なら applyRefreshResult
  //      ng なら setRefreshError、aborted なら何もしない
  const handleRefresh = React.useCallback(
    async (goal: "balanced" | "reduce_length" = "balanced") => {
      // 2026-05-28 dogfood round 3 bug fix:「この回答で再分析」(逆質問の回答のみフロー)で
      // 早期 return してボタンが無反応になる不具合の修正。
      //   triggerReanalysisWithClarifications は actionLog にだけ push し actionHistory には
      //   push しない(store: actionLog ≠ actionHistory)。よって採用/却下/編集を一度もして
      //   いない「回答のみ」フローでは actionHistory.length === 0 のまま partialRefreshTrigger
      //   が立ち、Canvas の観測 effect → handleRefresh("balanced") に来るが、下の early-return
      //   で弾かれて何も起きなかった。有効回答(空白でない answer_text)が 1 件でもあれば
      //   再分析は意味を持つので、その場合は early-return を通す。判定式は
      //   buildClarificationEnrichedIntent / triggerReanalysisWithClarifications の filter と一致。
      const hasValidClarificationAnswers = clarificationAnswers.some(
        (a) => a.answer_text.trim().length > 0,
      );

      // balanced の早期 return ガード:操作 0 件で balanced 再分析しても無意味なため。
      // dogfood round 3 ⑦ (2026-05-28): goal === "reduce_length" の時はこの early-return を
      // 通す。reduce は「現在の派生 ES を上限内に削る」全体再分析であり、1 件も採用して
      // いない上限超過 ES でも意味を持つ(ボタン表示条件の緩和と対称)。
      // dogfood round 3 bug fix (2026-05-28): 有効な clarification 回答がある場合も通す
      // (上記「回答のみ」フロー)。balanced かつ 操作 0 件 かつ 有効回答無しのときだけ弾く。
      if (
        goal === "balanced" &&
        actionHistory.length === 0 &&
        !hasValidClarificationAnswers
      )
        return;

      // dogfood round 3 ⑦ (2026-05-28) — schema 整合の解決:
      //   refresh / partial の AnalyzeInputBundle は `action_history` に min(1) を要求する
      //   (lib/schema/input.ts。空配列は initial と区別できないため意図的に min(1))。
      //   ボタン表示条件と early-return を緩和して「未操作 + 上限超過」で reduce を起動できる
      //   ようにしたが、その状態の actionHistory は空配列なので、そのまま送ると /api/analyze の
      //   Zod 検証が 400 を返し LLM に到達しない(dispatch / DECISIONS ⑦ は「prompt 側で空履歴
      //   を処理済」としていたが、prompt 以前に schema 検証で弾かれる)。
      //   schema / api を変えない方針(dispatch 厳守)を保つため、**client 側で最小の合成
      //   action_history を 1 件供給する**。内容は「操作履歴なし・上限超過のため削減要求」を
      //   素直に述べる DIRECT_EDIT 1 件で、refresh.ts:formatActionHistory がそのまま描画する。
      //   削減モードの本来の指示(renderReduceLengthInstructions)が現在長 / 上限 / 削減目的を
      //   明示するため、この合成履歴は副次的な文脈に留まり、提案内容を歪めない。
      //   非空履歴の reduce / balanced 経路には一切影響しない(空 + reduce のときだけ合成)。
      //
      // 2026-05-28 dogfood round 3 bug fix:「回答のみ」フロー(逆質問に答えただけで採用/却下/
      //   編集を一度もしていない)でも同じ schema 整合の問題が起きる。actionHistory が空のまま
      //   partial bundle を送ると action_history min(1) で Zod 400 になる。⑦ と同じく client 側で
      //   最小の合成 1 件を供給する。clarification 回答の LLM 伝達は clarificationEnrichedIntent
      //   (下で両 bundle に渡す)が担うため、この合成 action_history は schema 充足 + 最小文脈
      //   のみに留め、提案内容を歪めない。
      //   合成を足すのは「空 かつ (reduce_length または 有効な clarification 回答あり)」のときだけ。
      //   非空 actionHistory、および clarification 無しの通常 balanced フローは一切変えない。
      const needsSyntheticHistory =
        actionHistory.length === 0 &&
        (goal === "reduce_length" || hasValidClarificationAnswers);
      const effectiveActionHistory: ActionHistoryEntry[] = needsSyntheticHistory
        ? [
            goal === "reduce_length"
              ? {
                  verb: "DIRECT_EDIT",
                  description:
                    "(操作履歴なし — 初回状態の ES が設問の上限を超過しているため、文字数削減を要求)",
                }
              : {
                  verb: "DIRECT_EDIT",
                  description: "(逆質問への回答に基づく再分析)",
                },
          ]
        : actionHistory;

      // ★ bundle に渡す es_body は **派生 ES 本文**(displayEsBody)= 採用 / 編集が反映
      //   された状態。直接編集中は currentEsBody 生がそのまま入る。これにより LLM は
      //   「現在のユーザーの ES」を見て再指摘する設計になる。
      const refreshEsBody = displayEsBody;

      const {
        abortController,
        baseVersion,
        goal: confirmedGoal,
        // 2026-05-28 並行性 fix C8: この refresh の世代 id。下の遅延 cleanup timer の
        // クロージャに焼き、commitPartialRefreshCleanup(generation) に渡す。
        generation: refreshGeneration,
        // 提出後改善 #2 (2026-06-09): この refresh が消化する pendingRefreshScope の参照。
        // 成功適用時に applyPartialResult / applyRefreshResult へ渡し、reference-equality で
        // 消化する(in-flight 中に新 scope がマージされていたら clear しない = 再評価が消えない)。
        consumedScope,
      } = beginRefresh({
        goal,
      });

      // 統合改修パッケージ (2026-05-25): pendingRefreshScope を見て partial / refresh を分岐。
      //  - scope.kind === "full" or 「再分析」ボタン経由 → goal=balanced でも refresh stream 経路
      //  - scope.kind === "scoped" + analysisResult あり → partial + 影響範囲を AI に判断させる
      //  - その他(scope=null / 旧経路の互換) → 従来の partial 経路
      // 統合改修パッケージ訂正 (2026-05-25): 構造計算(refresh_scope.ts:computeRefreshScope)
      // を撤去し、AI 判断方式に変更。サーバから LLM に渡すのは seed id / edit_before / edit_after のみ。
      //
      // 提出後改善 #2 (2026-06-09): scope の読み取りを closure の `pendingRefreshScope`
      // (render 時スナップショット)から `consumedScope`(beginRefresh が get() で原子的に
      // 捕捉した store スナップショット)に変更。これにより「この request が使う seed」と
      // 「成功時に消化する scope」が同一オブジェクトになり、render 時 staleness と
      // union マージ後の seed 取りこぼしを防ぐ(マージで膨らんだ seedIds がそのまま送られる)。
      const wantsFullRefresh =
        consumedScope !== null && consumedScope.kind === "full";

      const canUsePartial =
        confirmedGoal === "balanced" &&
        !wantsFullRefresh &&
        analysisResult !== null &&
        analysisResult.overall_assessment !== undefined;

      // AI 判断方式の seed 情報を組み立てる(scope === "scoped" のみ意味を持つ)
      let seedSuggestionIds: string[] = [];
      let seedActionType:
        | "reject"
        | "edit"
        | "direct_edit"
        | "undo"
        | "redo"
        | "manual" = "manual";
      let editBefore: string | undefined;
      let editAfter: string | undefined;
      if (
        canUsePartial &&
        consumedScope !== null &&
        consumedScope.kind === "scoped"
      ) {
        seedSuggestionIds = consumedScope.seedIds;
        // PendingRefreshScope.reason は "accept" を含むが、partial 経路では accept は発火しない。
        // 万一 reason === "accept" になっても seed_action_type schema には含まれないため、
        // "manual" にフォールバックする(防御的)。
        const reason = consumedScope.reason;
        seedActionType =
          reason === "reject" ||
          reason === "edit" ||
          reason === "direct_edit" ||
          reason === "undo" ||
          reason === "redo" ||
          reason === "manual"
            ? reason
            : "manual";
        editBefore = consumedScope.editBefore;
        editAfter = consumedScope.editAfter;
      }

      // 2026-05-27 エージェント的対話(AI 逆質問): 回答済 clarificationAnswers を
      // enriched_intent 文字列に組み立てる(回答 0 件なら空文字、build*Bundle 内で append しない
      // 経路に分岐)。analysisResult は canUsePartial の条件で null 除外済だが、refresh stream
      // 経路で null になる理論可能性に備え、空でも安全な経路で渡す(buildClarificationEnrichedIntent
      // が null 安全)。
      const clarificationEnrichedIntent = buildClarificationEnrichedIntent(
        clarificationAnswers,
        analysisResult,
      );
      // Phase G 再修正 (2026-05-24): 副次的な候補プール引数を撤去。
      const bundle = canUsePartial
        ? buildPartialBundle({
            form,
            companySummary: companySummary ?? undefined,
            esBody: refreshEsBody,
            // 2026-05-28 dogfood round 3 bug fix:「回答のみ」フローでは actionHistory が空。
            // 生 actionHistory ではなく effectiveActionHistory(空 + clarification 駆動のとき
            // 合成 1 件)を渡し、partial bundle の action_history min(1) を充足する。
            // 非空 actionHistory のときは effectiveActionHistory === actionHistory なので無影響。
            actionHistory: effectiveActionHistory,
            baseVersion,
            existingSuggestions: analysisResult!.suggestions,
            overallAssessment: analysisResult!.overall_assessment,
            acceptedSuggestionIds,
            rejectedSuggestionIds,
            editedSuggestionIds: Object.keys(editedSuggestions),
            seedSuggestionIds,
            seedActionType,
            editBefore,
            editAfter,
            clarificationEnrichedIntent,
          })
        : buildRefreshBundle({
            form,
            companySummary: companySummary ?? undefined,
            esBody: refreshEsBody,
            // 空 + reduce_length のときだけ合成 1 件、それ以外は実履歴(上の effectiveActionHistory 参照)
            actionHistory: effectiveActionHistory,
            baseVersion,
            goal: confirmedGoal,
            clarificationEnrichedIntent,
          });

      // 2026-05-25 Task #18: partial 経路の場合は loading / animation 用 flags を立てる。
      // global banner「AI が関連指摘を再評価しています」と seed 個別 loading spinner が
      // partialRefreshInProgress / partialRefreshSeedIds を購読して表示される。
      // refresh stream(canUsePartial=false)経路は既存の RefreshProgressBanner を使う。
      if (canUsePartial) {
        beginPartialRefresh(seedSuggestionIds);
      }

      const result = await callAnalyzeStream(bundle, {
        signal: abortController.signal,
        onStage: (stage) => setRefreshStreamingStage(stage),
      });

      if (result.ok) {
        if (result.kind === "partial") {
          // 提出後改善 #2 (2026-06-09): consumedScope を渡して scope を reference-equality 消化。
          // 提出後改善 #3 準備 (2026-06-09): captureMeta(あれば)を capture エントリに同梱。
          applyPartialResult(result.result, consumedScope, result.captureMeta);
          // 2026-05-25 Task #18: 1.5 秒の fade out animation 後に deleted を suggestions から
          // 実除外 + recently* / seed flags をクリア。Inviolable constraints:
          // 「すべての操作は Undo 可能」を満たすため、fade out 中も Undo / 履歴 revert で
          // 取り戻せる(applyPartialResult が autoCorrected を deleted 除外後の最終 set で
          // 計算しているため、ロジック上は既に削除済 = revert すれば再評価で復活)。
          window.setTimeout(() => {
            // 2026-05-28 並行性 fix C8: この refresh の世代を渡す。1.5 秒以内に後続 refresh が
            // 始まっていれば store 側で世代不一致 → no-op になり、後続の flags を消さない。
            commitPartialRefreshCleanup(refreshGeneration);
          }, 1500);
        } else {
          // 提出後改善 #2 (2026-06-09): consumedScope を渡して scope を reference-equality 消化。
          // 提出後改善 #3 準備 (2026-06-09): captureMeta(あれば)を capture エントリに同梱。
          applyRefreshResult(result.result, consumedScope, result.captureMeta);
        }
        // apply* が成功時に inflight / abort / phase をクリーンアップ
        // (古いバージョン破棄ケースでも no-op で抜けるが、ユーザー観測上はクリーン)
        return;
      }

      // error 経路の分岐
      if (result.error.kind === "aborted") {
        // abort = 新規 refresh への乗り換え or 編集モード遷移 or リセット
        // 何もしない(apply* / beginRefresh / startEditingMode が
        // すでに state を上書き済 or これから上書きする)
        return;
      }
      setRefreshError(result.error);
      finishRefresh();
    },
    [
      acceptedSuggestionIds,
      actionHistory,
      analysisResult,
      applyPartialResult,
      applyRefreshResult,
      beginRefresh,
      // 2026-05-25 Task #18: partial refresh の animation 用 actions
      beginPartialRefresh,
      commitPartialRefreshCleanup,
      companySummary,
      displayEsBody,
      editedSuggestions,
      finishRefresh,
      form,
      // 提出後改善 #2 (2026-06-09): pendingRefreshScope を dep から除外。handleRefresh は
      // もはや closure の pendingRefreshScope を読まず、beginRefresh が返す consumedScope
      // (store スナップショット)を使う。scope は store action の union マージで蓄積され、
      // beginRefresh が fire 時点で原子的に読み取るため、handler を scope 変化に再生成
      // する必要がない(staleness なし)。
      rejectedSuggestionIds,
      setRefreshError,
      setRefreshStreamingStage,
      // 2026-05-27 エージェント的対話(AI 逆質問): clarificationAnswers の最新値を
      // bundle build 時に参照するため dep に含める。回答更新ごとに handleRefresh
      // は再生成されるが、partialRefreshTrigger 観測 effect は trigger 値の変化を
      // ref で比較する(stale closure 防止)ため、回答だけの変化では effect 発火しない。
      clarificationAnswers,
    ],
  );

  // 直接編集モードの contentEditable は uncontrolled(input ごとに updateEsBody)。
  // React の controlled contentEditable は cursor 位置の管理が複雑なので、
  // ref で初期値だけ流し込み、onInput で textContent を吸い上げる方式に。
  //
  // バグ修正(2026-05-23 UX 改修 1):
  //  - `contentEditable="plaintext-only"` を使用し、`<br>` / `<div>` などの DOM
  //    挿入を抑止して textNode のみを保証する。これにより、ON → OFF 切替時に
  //    contentEditable で残った DOM ノードが readonly 描画と二重に見える問題を解消。
  //  - directEditMode の OFF/ON 切替で各分岐に `key` を付与し、React が確実に
  //    再 mount するよう強制(古い DOM が残らない)。
  //  - 初回 mount 時に `defaultValue` 相当として textContent を流し込む処理は
  //    そのまま維持(uncontrolled な contentEditable で初期値を反映する標準パターン)。
  const editableRef = React.useRef<HTMLDivElement>(null);
  // 直接編集 ON 時に initial value を反映(初回 mount 時 / undo 等の外部更新時)。
  // OFF 中は contentEditable 要素自体が unmount されるため、effect は走らない。
  React.useEffect(() => {
    if (!directEditMode) return;
    const el = editableRef.current;
    if (!el) return;
    // currentEsBody とエディタの textContent を同期(初回 / undo 経由の更新時)。
    // 2026-05-28 dogfood round 3 ⑤: 直接編集 ON で toggleDirectEdit が currentEsBody を
    // 派生 ES に flatten 済のため、ここで seed される textContent は「採用を積み重ねた
    // 今の ES」になる(本 bug fix の seed 修正)。
    if (el.textContent !== currentEsBody) {
      el.textContent = currentEsBody;
    }
  }, [directEditMode, currentEsBody]);

  // ---------------------------------------------------------------------------
  // Task #32a (2026-05-25): directEditMode ON/OFF 切替時の scroll 位置保持
  // ---------------------------------------------------------------------------
  // ユーザー dogfood 観察「直接編集を ON/OFF すると ES 本文の位置が大きくズレる」に対応。
  // 旧設計では、textarea(plaintext contentEditable) と span list の rendering で
  // 微妙な高さ差(line-height / 各 span の inline padding 等)が発生 + 各分岐に key を
  // 付与して remount するため、切替時に layout jump が起き window のスクロール位置が
  // 「ES 本文上端」に飛ぶ問題があった。
  //
  // 修正:
  //  1. 両分岐の wrapper に `min-h-[20rem]` を共通指定(layout jump の主因を抑制)
  //  2. directEditMode 変化前の window.scrollY を ref に退避、useEffect 内で setTimeout 0
  //     で復元(切替後の layout reflow 完了を 1 tick 待ってから scrollTo)
  //
  // 設計判断: useLayoutEffect ではなく useEffect + setTimeout 0 を採用。理由は、
  //   directEditMode 切替直後は React の再 mount + ref attach + 高さ再計算が複数 tick で
  //   行われるため、useLayoutEffect の synchronous 復元では「復元 → さらに reflow で
  //   scrollY が動く」race が起きうる。setTimeout 0 で「すべての reflow が落ち着いた
  //   最初のフレーム」に復元する方が安定する。
  const savedScrollYRef = React.useRef<number>(0);
  React.useEffect(() => {
    // この effect は directEditMode 変化のたびに発火する。
    // cleanup(prev effect の終端で呼ばれる)で「変化前」の scrollY を退避、
    // 本体で「変化後」の scrollY を復元する。
    if (typeof window === "undefined") return;
    const targetY = savedScrollYRef.current;
    const restoreTimer = window.setTimeout(() => {
      window.scrollTo(0, targetY);
    }, 0);
    return () => {
      // 次回 effect 実行直前(= directEditMode が変わる直前)に scrollY を保存
      window.clearTimeout(restoreTimer);
      savedScrollYRef.current = window.scrollY;
    };
  }, [directEditMode]);

  // ---------------------------------------------------------------------------
  // Phase G 修正 (2026-05-23): 即時 partial refresh trigger の購読
  // ---------------------------------------------------------------------------
  // store の各 action(acceptSuggestion / rejectSuggestion / editSuggestion /
  // toggleDirectEdit(OFF 差分あり)/ undo / redo / undoAutoCorrection /
  // undoAllAutoCorrections)が partialRefreshTrigger を **同期的に** +1 する。
  // Canvas は trigger の変化を useEffect で観測し、即座に handleRefresh("balanced") を
  // 発火する(デバウンスなし、setTimeout 不在)。
  //
  // 設計判断:
  //  - handleRefresh は useCallback で memoize されている。trigger 観測時の最新 state
  //    (actionHistory / displayEsBody / analysisResult 等)を参照する必要があり、
  //    handleRefresh の dependency に含まれる state が変わるたびに再生成される。
  //  - effect の dep に handleRefresh を含めると、actionHistory が増えるたびに effect が
  //    re-run されてしまい、最後に観測した trigger と同じでも fire する事故が起きる。
  //    そのため lastFiredTriggerRef で「前回 fire した trigger 値」を保持し、effect 内で
  //    比較する。新しい trigger を観測したときだけ handleRefresh を呼ぶ。
  //  - partialRefreshTrigger が変わらない場合(stale closure 含む)effect が re-run されても
  //    lastFiredTriggerRef.current === partialRefreshTrigger で no-op になる。
  const lastFiredTriggerRef = React.useRef(0);
  React.useEffect(() => {
    if (partialRefreshTrigger === 0) return;
    if (partialRefreshTrigger === lastFiredTriggerRef.current) return;
    lastFiredTriggerRef.current = partialRefreshTrigger;
    // 直接編集中・action_history 空 は race condition 防衛のため Canvas 側でも最終チェック。
    // (store 側でも updateEsBody は trigger を立てないが、actionHistory 0 のときに
    //  undo/redo が空 set で no-op になるパスでは trigger が立つ可能性があるため二重防御)。
    if (directEditMode) return;
    // 2026-05-28 dogfood round 3 bug fix:「この回答で再分析」(triggerReanalysisWithClarifications)
    // は actionHistory に push せず actionLog にだけ push して partialRefreshTrigger を立てる。
    // よって「回答のみ」フロー(採用/却下/編集を一度もしていない)では actionHistory.length === 0
    // のまま正当に trigger が立つ。有効な clarification 回答が 1 件でもあればここで弾かず
    // handleRefresh に進める(handleRefresh 内でも同じ判定で early-return を通し、空 actionHistory
    // には合成 1 件を供給して schema を充足する)。有効回答も無い空 actionHistory の trigger は
    // 従来どおり no-op(undo/redo の空 set 二重防御)。
    const hasValidClarificationAnswers = clarificationAnswers.some(
      (a) => a.answer_text.trim().length > 0,
    );
    if (actionHistory.length === 0 && !hasValidClarificationAnswers) return;
    // 統合改修パッケージ (2026-05-25): scope.kind === "full" は refresh stream 経路を強制する
    // ため goal を切替する必要があるが、handleRefresh 内部で `wantsFullRefresh` 判定して
    // 分岐するので、ここでは goal="balanced" のままで OK(scope を見て自動切替)。
    void handleRefresh("balanced");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partialRefreshTrigger]);

  // ---------------------------------------------------------------------------
  // 統合改修パッケージ (2026-05-25): 意味的差分判定 queue の購読 / 消化 effect
  // ---------------------------------------------------------------------------
  // editSuggestion / toggleDirectEdit OFF(差分あり)は store action 内で trigger を立てず、
  // 代わりに semanticDiffQueue に { before, after, seedIds, reason } を enqueue する。
  // 本 effect は queue の長さを観測し、空でなければ先頭 1 件を dequeue → /api/semantic-diff
  // を呼び、結果に応じて requestPartialRefresh を呼ぶ(または skip)。
  //
  // 設計判断:
  //  - queue は FIFO で 1 件ずつ処理(複数同時 fetch を避ける)。判定中フラグ semanticDiffBusyRef で
  //    再エントリを防ぐ。
  //  - 「同じ」と判定されたら refresh skip(trigger 立てず、reason を console.info で log のみ)。
  //  - 「異なる」と判定されたら requestPartialRefresh({ kind: "scoped", seedIds, reason }) で
  //    partial refresh を発火(seedIds が空なら全範囲 partial、空でなければ影響範囲限定モード)。
  //  - fail-safe: judgeSemanticDiff の fail-safe で「異なる」と返ってくるため、API 失敗時も
  //    refresh が走る安全側に倒れる。
  // 2026-05-28 並行性 fix C4: busy 解除後に「次件があれば再処理」を kick するための tick。
  //   旧実装は effect dep が semanticDiffQueue.length のみで、busy 中に 2 件目が積まれて
  //   length が変わっても early-return し、finally で busy=false(ref なので re-render 無し)
  //   にした後に queue 再処理を起こす state 変更が無かった → 2 件目が永久に処理されない。
  //   finally で本 tick を bump して effect を再 run させ、残件を drain する。
  const semanticDiffBusyRef = React.useRef(false);
  const [semanticDiffTick, setSemanticDiffTick] = React.useState(0);
  React.useEffect(() => {
    if (semanticDiffQueue.length === 0) return;
    if (semanticDiffBusyRef.current) return;
    semanticDiffBusyRef.current = true;
    const entry = dequeueSemanticDiff();
    if (!entry) {
      semanticDiffBusyRef.current = false;
      return;
    }
    (async () => {
      try {
        const res = await fetch("/api/semantic-diff", {
          method: "POST",
          // BYOK: localStorage の OpenAI 鍵を x-openai-key ヘッダで添える(あれば)。
          headers: { "Content-Type": "application/json", ...openAIKeyHeader() },
          body: JSON.stringify({ before: entry.before, after: entry.after }),
          // 60 秒 timeout(server maxDuration と整合、ただし 5 秒程度で完走見込み)
          signal: AbortSignal.timeout(60_000),
        });
        // fail-safe: 200 以外 / parse 失敗 は「異なる」として refresh を走らせる
        let semanticSame = false;
        let reason = "fail-safe (HTTP error)";
        if (res.ok) {
          try {
            const json = (await res.json()) as {
              data?: { semantically_same?: boolean; reason?: string };
              capture_meta?: CaptureMeta;
            };
            if (typeof json.data?.semantically_same === "boolean") {
              semanticSame = json.data.semantically_same;
              reason = json.data.reason ?? "理由情報なし";
            }
            // 提出後改善 #3 準備 (2026-06-09): semantic_diff 経路の受動計測(dev 専用
            // capture)。capture_meta が付いた応答(= 実 LLM call があった、before===after の
            // 早期判定や API error の fail-safe でない)のみ記録する。
            if (json.capture_meta) {
              appendCaptureMetaEntry("semantic_diff", json.capture_meta);
            }
          } catch {
            // parse 失敗 → fail-safe
          }
        }
        if (semanticSame) {
          console.info(
            `[semantic_diff] ${entry.reason}: skip refresh (${reason})`,
          );
          // refresh skip — trigger を立てない。
          // 2026-05-28 dogfood round 3 ②④: editSuggestion が立てた reEvaluating 予測 mark を
          // 取り消す(refresh が走らない = 予測は void。lingering すると次選択の skip が残る)。
          clearReEvaluating();
          return;
        }
        console.info(
          `[semantic_diff] ${entry.reason}: trigger partial refresh (${reason})`,
        );
        // 統合改修パッケージ訂正 (2026-05-25): 編集前後テキストを scope に保持し、
        // partial bundle 経由で AI に渡す。AI が意味的に影響範囲を判断する材料。
        requestPartialRefresh({
          kind: "scoped",
          seedIds: entry.seedIds,
          reason: entry.reason,
          editBefore: entry.before,
          editAfter: entry.after,
        });
      } catch (err) {
        // fail-safe: ネットワーク失敗 / timeout 等 → 「異なる」として refresh を走らせる
        console.warn(
          "[semantic_diff] /api/semantic-diff fetch failed (fail-safe: refresh)",
          err,
        );
        requestPartialRefresh({
          kind: "scoped",
          seedIds: entry.seedIds,
          reason: entry.reason,
          editBefore: entry.before,
          editAfter: entry.after,
        });
      } finally {
        semanticDiffBusyRef.current = false;
        // 2026-05-28 並行性 fix C4: busy が空いたことを effect に伝え、queue 残件を drain する。
        //   tick を bump して effect を 1 度再 run させる。残件があれば次の 1 件を処理し、
        //   空なら冒頭 length === 0 ガードで即 no-op。これで busy 連打でも取りこぼさない。
        setSemanticDiffTick((t) => t + 1);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [semanticDiffQueue.length, semanticDiffTick]);

  // ---------------------------------------------------------------------------
  // Phase G Step 3b-3 (2026-05-23): キーボードショートカット
  // ---------------------------------------------------------------------------
  // - Cmd/Ctrl + Z = Undo
  // - Cmd/Ctrl + Shift + Z = Redo
  //
  // platform 判定:
  //  - macOS / iOS: Meta (Cmd)
  //  - Windows / Linux: Ctrl
  //  - navigator.platform は deprecated だが、user-agent client hints は未普及で揺れがあるため
  //    シンプルに `navigator.platform.includes("Mac")` で判定(典型的な実装パターン)。
  //
  // 編集モード中(directEditMode = true)は何もしない:
  //  - contentEditable の標準 Undo / Redo (browser-native) が動くため、上書きしない。
  //  - これにより「直接編集モードで Cmd+Z = テキストの直前入力を取り消す」という直感が
  //    保たれる(モードを抜けてから Canvas 側の Undo を使う)。
  //
  // 提出後改善 #4 (2026-06-10): 入力系要素(input / textarea / contentEditable)に
  // フォーカスがある時も何もしない(SuggestionDetailPanel の J/K ハンドラと同じ
  // activeElement ガード)。旧実装は directEditMode しかガードしておらず、
  // SuggestionCard の「編集して採用」textarea や逆質問回答 textarea で入力中に
  // Cmd+Z を押すと、テキスト undo ではなく store の undo(1) が発火し、
  // preventDefault でブラウザ標準のテキスト undo まで奪っていた
  // (2026-06-09 設計レビューで confirmed)。
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 直接編集中はブラウザ標準の undo / redo に委ねる
      if (directEditMode) return;
      // 入力系にフォーカス中はブラウザ標準のテキスト undo / redo に委ねる
      const active = document.activeElement;
      if (active) {
        const tag = active.tagName.toLowerCase();
        if (tag === "input" || tag === "textarea") return;
        if (active.getAttribute("contenteditable") !== null) return;
      }
      const isMac =
        typeof navigator !== "undefined" &&
        /Mac|iPhone|iPad|iPod/.test(navigator.platform);
      const modifier = isMac ? e.metaKey : e.ctrlKey;
      if (!modifier) return;
      const otherModifier = isMac ? e.ctrlKey : e.metaKey;
      // Cmd+Z / Ctrl+Z, with mutually exclusive modifier check(Mac の Ctrl+Z は無効)
      if (e.key.toLowerCase() !== "z") return;
      if (otherModifier) return;
      // Shift 併用で Redo、なしで Undo
      if (e.shiftKey) {
        if (redoStack.length === 0) return;
        e.preventDefault();
        redo(1);
      } else {
        if (actionHistory.length === 0) return;
        e.preventDefault();
        undo(1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [directEditMode, actionHistory.length, redoStack.length, undo, redo]);

  // 競合通知モーダルの open 状態(local UI state)
  const [conflictModalOpen, setConflictModalOpen] = React.useState(false);

  return (
    <>
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="size-4 text-primary" />
              <span>{t("card_title")}</span>
            </CardTitle>
            {/* Commit D-1 (2026-05-25): 文字数表示は SummaryBar(上部)に集約。
                Canvas ヘッダは ES 本文タイトル + 操作対象が「ES 本文そのもの」であることを示す
                プレースホルダのみ残す。直接編集モード中の現在文字数は SummaryBar の値が即時更新される
                (store.currentEsBody 購読、reactive)。 */}
            <p className="text-[11px] text-muted-foreground text-jp">
              {t("description_hover")}
            </p>
          </div>

          {/* Step 3a: 件数 badge / alternative トグルは SuggestionListPanel に移譲。
              Canvas ヘッダにはツールバー(直接編集 / Undo / Redo)を直接配置。
              Phase G 修正 (2026-05-23): 「自動更新」Switch は撤去。
                採用 / 編集 / 却下 / 直接編集 OFF / Undo / Redo / 自動修正取り消しは
                すべて即時(デバウンスなし)で partial refresh を発火する設計に統一
                (DECISIONS 2026-05-23 §1 と整合)。
                - Redo: undo した操作を redo stack から再適用(Cmd/Ctrl+Shift+Z でも可)。
                - 「取り消す」→ 「Undo」にラベル変更、キーボードショートカット Cmd/Ctrl+Z。 */}
          <div className="flex flex-wrap items-center gap-2">
            {/* v2 dogfood UX 改善 Task B (2026-05-26): Original / Edited 表示トグル。
                直接編集 Switch の前に配置(視覚的に「表示モード切替 → 編集 → 元に戻す」の
                順で動作の粒度が大きい順に並ぶ)。
                - Original: 素の原文 + ハイライト inactive + 直接編集 disable
                - Edited: 派生 ES + 全カテゴリ ハイライト active + 直接編集可
                shadcn ToggleGroup は未導入のため 2 連 Button(variant: default/ghost で
                active 表現)で実装。視覚的に「2 状態切替」が伝わる形を最優先。
                Original 中は隣の Switch(直接編集)も disabled になり、編集動線を完全に塞ぐ。
                逆に直接編集 ON 中は Original/Edited トグルを disabled にする
                (2026-05-29 修正): 直接編集中に Original を押すと displayMode だけ
                original に切替わり、Original 中は直接編集 Switch が disabled なため
                directEditMode を解除できず詰まる不具合を防ぐ。直接編集を終えてから
                表示モードを切替える動線に固定する。 */}
            <div
              className="flex items-center gap-0.5 rounded-md border border-border/60 bg-muted/30 p-0.5"
              role="group"
              aria-label={t("toggle.aria_label")}
            >
              <Button
                type="button"
                variant={displayMode === "original" ? "default" : "ghost"}
                size="xs"
                onClick={() => setDisplayMode("original")}
                aria-pressed={displayMode === "original"}
                disabled={directEditMode}
                title={
                  directEditMode ? t("toggle.disabled_direct_edit_title") : undefined
                }
                className="gap-1"
              >
                <Eye className="size-3" />
                <span>{t("toggle.original")}</span>
              </Button>
              <Button
                type="button"
                variant={displayMode === "edited" ? "default" : "ghost"}
                size="xs"
                onClick={() => setDisplayMode("edited")}
                aria-pressed={displayMode === "edited"}
                disabled={directEditMode}
                title={
                  directEditMode ? t("toggle.disabled_direct_edit_title") : undefined
                }
                className="gap-1"
              >
                <Sparkles className="size-3" />
                <span>{t("toggle.edited")}</span>
              </Button>
            </div>
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none">
              <Switch
                checked={directEditMode}
                onCheckedChange={() => toggleDirectEdit()}
                aria-label={t("direct_edit_aria")}
                disabled={displayMode === "original"}
              />
              <Pencil className="size-3" />
              <span>{t("direct_edit_switch")}</span>
            </label>
            {/* G3 C3 fix (2026-05-28): 直接編集中はツールバー Undo/Redo を disable。
                キーボードショートカット側は既に `if (directEditMode) return` でガード済だが
                (ブラウザ標準の contentEditable undo に委ねる設計)、ツールバーボタンは
                disabled に directEditMode を含めていなかったため、直接編集 ON 中に押せて
                pending snapshot と履歴操作が食い違い不整合を起こしていた。
                disabled 基準をキーボードガードと同一(directEditMode 中は不可)に揃える。 */}
            <Button
              variant="ghost"
              size="xs"
              onClick={() => undo(1)}
              disabled={
                !canUndoFromToolbar({
                  directEditMode,
                  actionHistoryLength: actionHistory.length,
                })
              }
              aria-label={t("undo_aria")}
              title={
                directEditMode
                  ? t("undo_disabled_direct_edit_title")
                  : actionHistory.length === 0
                    ? t("undo_disabled_title")
                    : t("undo_enabled_title")
              }
            >
              <Undo2 className="size-3" />
              <span>{t("undo_label")}</span>
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => redo(1)}
              disabled={
                !canRedoFromToolbar({
                  directEditMode,
                  redoStackLength: redoStack.length,
                })
              }
              aria-label={t("redo_aria")}
              title={
                directEditMode
                  ? t("redo_disabled_direct_edit_title")
                  : redoStack.length === 0
                    ? t("redo_disabled_title")
                    : t("redo_enabled_title")
              }
            >
              <Redo2 className="size-3" />
              <span>{t("redo_label")}</span>
            </Button>
          </div>
        </div>

        {/* Task #32a (2026-05-25): 「文字数を抑える」ボタンは ES 本文上端の文字数表示の
            隣に移設(下記 CardContent 内 L1056 周辺)。本ヘッダの下部別行表示は撤去。
            dogfood 観察「上限超過表示と『文字数を抑える』が遠い、隣接配置希望」に対応。
            旧 Task #27 のヘッダ下部別行構造は本 Task で解体、上端集約に変更。 */}

        {/* Phase G Step 3b-1 (2026-05-23): 自動修正バナー。
            error カテゴリの suggestion が分析時点で自動的に派生 ES に適用されたことを
            ユーザーに認知させる。emerald 系 subtle トーンで「AI が安心して修正した」感を
            伝える。判断疲労を convention / alternative に集中させる UX。
            「全て元に戻す」ボタンは確認ダイアログを挟んで一括取消を実行。 */}
        {autoCorrectedCount > 0 && (
          <AutoCorrectionBanner
            count={autoCorrectedCount}
            onUndoAll={handleUndoAllAuto}
          />
        )}

        {/* Phase G Step 2: refresh の進行 / エラーバナー(控えめ表示)
            画面占有しない 1 行で、Canvas 操作は継続できる(楽観的並行制御の本質)。
            UX 改修 3b (2026-05-23): analyzeGoal を渡して banner 文言を切替。
            error 経路の onRetry は前回 goal をそのまま再試行(直前の意図を尊重)。

            2026-05-25 Task #18: partial refresh の場合は PartialRefreshBanner を別途表示。
              - refresh stream(全体再分析)= 既存 RefreshProgressBanner(refreshPhase 監視)
              - partial refresh(scoped)= 新規 PartialRefreshBanner(partialRefreshInProgress 監視)
            両者は同時には立たない(partial 経路は refreshPhase も "loading" になるが、
            partialRefreshInProgress が true の方を優先することで「AI が関連指摘を再評価」の
            文言を出す)。 */}
        {refreshPhase === "loading" && !partialRefreshInProgress && (
          <RefreshProgressBanner
            stage={refreshStreamingStage}
            goal={analyzeGoal}
          />
        )}
        {partialRefreshInProgress && <PartialRefreshBanner />}
        {refreshPhase === "error" && refreshError && (
          <RefreshErrorBanner
            error={refreshError}
            goal={analyzeGoal}
            onRetry={() => {
              void handleRefresh(analyzeGoal);
            }}
          />
        )}

        {/* Phase G Step 3b-3 (2026-05-23): 競合通知バナー。
            自動 refresh が走っている間にユーザーが別の操作を行い、応答が version 不一致に
            なった場合(楽観的並行制御の競合)、silent discard を廃止してユーザーに通知。
            「表示する」で詳細モーダル、「破棄」で現状維持。 */}
        {conflictNotification && !conflictModalOpen && (
          <ConflictNotificationBanner
            onView={() => setConflictModalOpen(true)}
            onDismiss={() => dismissConflict()}
          />
        )}
      </CardHeader>

      <CardContent>
        {/* Task #27 (2026-05-25): 文字数 + 制限を ES 本文ブロックの上端に表示。
            旧 SummaryBar 右側の表示を Canvas に移管(ユーザー要望: 「文字数と制限は ES 本文の
            ブロック内においた方が良い」「視線の上端で確認したい」)。
            Task #32a (2026-05-25): 「文字数を抑える」ボタンを本行の隣に集約。
              dogfood 観察「上限超過表示と『文字数を抑える』が遠い、隣接配置希望」に対応。
              旧 CardHeader 下部別行(Task #27 までの配置)を撤去し、視線の上端で
              「数値 → 制限 → 行動」を 1 行で読める統合表現にする。
              表示条件は旧と同じ(action_history > 0 + overCharLimit、directEditMode 中は disabled)。
            - esLength は派生 ES 本文(displayEsBody.length)を SSOT として使用。
              directEditMode 中は currentEsBody 生(getDerivedEsBody スキップ)、
              非編集中は採用 / 編集が反映された派生 ES の長さ。
            - charLimit は props 由来(form.question.char_limit、ResultPanel 経由)。
            - overCharLimit 時は destructive 色で「上限超過」を強調。
            - Type icon は SummaryBar の旧表示と同じ視覚言語を継承。
            - スタイル: text-muted-foreground + font-mono の数値表示で「メタ情報」として
              本文の読み心地を阻害しない。
            SSOT: DECISIONS.md [2026-05-25] Task #27 計画 §修正 2 + Task #32a 計画 §修正 6 */}
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <Type className="size-3 text-muted-foreground" />
          <span className="text-muted-foreground">
            <span className="font-mono font-medium text-foreground">
              {displayEsBody.length}
            </span>{" "}
            {tCommon("char_unit")}
          </span>
          {typeof charLimit === "number" && (
            <span
              className={cn(
                "rounded border px-1.5 py-0.5",
                overCharLimit
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-border/60 text-muted-foreground",
              )}
            >
              {overCharLimit
                ? t("char_over_template", {
                    limit: charLimit,
                    over: displayEsBody.length - charLimit,
                  })
                : t("char_within_template", { limit: charLimit })}
            </span>
          )}
          {/* Task #32a (2026-05-25): 「文字数を抑える」ボタンを上限超過表示の隣に集約。
              primary 強調で「上限超過状態を解消する」アクションを促進。directEditMode 中は disabled。
              dogfood round 3 ⑦ (2026-05-28): 表示条件から actionHistory.length > 0 を外し
              overCharLimit のみに。上限超過の ES は **1 件も採用していなくても**削減導線を出す
              (初期状態の長すぎる ES でも「文字数を抑える」が最初から見える + 効くようにする)。
              handleRefresh 側の early-return も reduce_length では通すよう緩和済(対称な変更)。 */}
          {overCharLimit && (
            <Button
              variant="default"
              size="xs"
              onClick={() => {
                void handleRefresh("reduce_length");
              }}
              disabled={directEditMode}
              title={
                directEditMode
                  ? t("reduce_length_disabled_direct")
                  : refreshPhase === "loading"
                    ? t("reduce_length_loading")
                    : t("reduce_length_ready")
              }
              aria-label={t("reduce_length_aria")}
            >
              {refreshPhase === "loading" && analyzeGoal === "reduce_length" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Scissors className="size-3" />
              )}
              <span>{t("reduce_length_label")}</span>
            </Button>
          )}
        </div>

        {/* ES 本文 + ハイライト or contentEditable(直接編集中)
            key を分岐ごとに付与し、React が確実に再 mount するよう強制
            (古い contentEditable の DOM ノードが残って二重表示になるのを防ぐ)。
            v2 dogfood UX 改善 Task B (2026-05-26): displayMode === "original" 中は
            contentEditable レンダリングを完全に skip し読み取り専用 div で素テキストを表示。
            これにより Original 中の編集動線(直接編集 Switch / contentEditable の input)を
            両面で塞ぐ(Switch も disabled、contentEditable も出ない)。 */}
        {directEditMode && displayMode === "edited" ? (
          <div
            key="es-body-editable"
            ref={editableRef}
            // `plaintext-only` で <br> / <div> 等の DOM 挿入を抑止し textNode のみを保証。
            // これで toggle OFF 時に contentEditable 残骸が描画に残らない。
            // React の型では `boolean | "true" | "false" | "inherit"` だが
            // ブラウザは "plaintext-only" を受け取るため、明示キャストで通す。
            contentEditable={"plaintext-only" as unknown as boolean}
            suppressContentEditableWarning
            onInput={(e) => {
              // textContent は contentEditable の最新値。改行は \n で吸い上がる
              // (plaintext-only により <br> は生成されない)ため currentEsBody と整合する。
              updateEsBody(e.currentTarget.textContent ?? "");
            }}
            className={cn(
              // Task #32a (2026-05-25): min-h-[20rem] を read/edit 両分岐で共通化、
              //   directEditMode 切替時の layout jump を抑制(scroll 位置保持と併用)。
              "text-foreground rounded-md bg-background/40 p-5 leading-loose tracking-[0.01em] whitespace-pre-wrap break-words min-h-[20rem]",
              "outline-none focus:ring-2 focus:ring-primary/30",
            )}
            aria-label={t("direct_edit_aria_es")}
          />
        ) : (
          <div
            key="es-body-readonly"
            // Task #32a (2026-05-25): min-h-[20rem] を read/edit 両分岐で共通化、
            //   directEditMode 切替時の layout jump を抑制(scroll 位置保持と併用)。
            className="text-foreground rounded-md bg-background/40 p-5 leading-loose tracking-[0.01em] whitespace-pre-wrap break-words min-h-[20rem]"
          >
            {segments.length === 0 ? (
              <span className="text-muted-foreground italic">
                {t("es_empty")}
              </span>
            ) : (
              segments.map((seg, i) => {
                if (seg.kind === "plain") {
                  return <React.Fragment key={i}>{seg.text}</React.Fragment>;
                }
                if (seg.kind === "auto") {
                  return (
                    <AutoCorrectedSpan
                      key={i}
                      text={seg.text}
                      suggestion={seg.suggestion}
                    />
                  );
                }
                return (
                  <HighlightSpan
                    key={i}
                    text={seg.text}
                    suggestion={seg.suggestion}
                  />
                );
              })
            )}
          </div>
        )}

        {/* 案内テキスト(下部、編集モードに応じて文言を変える)
            Step 3a 改修: 「クリックで詳細」を「右ペインの指摘リストと連動」に更新。
            Popover が廃止されたため、ユーザーには「指摘リストと Canvas が連動する」
            ことを伝える必要がある。
            v2 dogfood UX 改善 Task B (2026-05-26): Original 中は「読み取り専用」を明示する
            専用 hint を表示(編集 / クリック連動が無効である説明、UX clarity)。 */}
        {displayMode === "original" ? (
          <p className="mt-3 text-[11px] text-muted-foreground">
            {t("toggle.original_hint")}
          </p>
        ) : directEditMode ? (
          <p className="mt-3 text-[11px] text-muted-foreground">
            {t("hint_direct_edit")}
          </p>
        ) : (
          <p className="mt-3 text-[11px] text-muted-foreground">
            {t("hint_normal")}
          </p>
        )}
      </CardContent>
    </Card>

    {/* Phase G Step 3b-3 (2026-05-23): 競合詳細モーダル。
        バナーの「表示する」で open、3 アクション(新版を採用 / 新版を編集して採用 /
        現在の選択を維持)を提示。中間プレビューステップなし(AGENTS.md 不変制約)。 */}
    {conflictNotification && conflictModalOpen && (
      <ConflictDetailModal
        notification={conflictNotification}
        onAcceptNew={() => {
          applyConflictNewVersion();
          setConflictModalOpen(false);
        }}
        onEditNew={() => {
          // 提出後改善 #4 (2026-06-10): 「新版を採用して編集」の実体化。
          // 旧実装は「新版を採用」と完全に同一動作(applyConflictNewVersion のみ)で、
          // ボタンが 2 つあるのに違いが無い不正直な状態だった(2026-06-09 設計レビュー
          // 指摘)。Inviolable constraint「直接アクション 3 つを提示」のため 2 択化は
          // 不可、第三アクションに実体を与える:
          //   1. applyConflictNewVersion() で新版を全面適用(analysisResult /
          //      clientEsVersion / conflictNotification を先に更新)
          //   2. その後 toggleDirectEdit()(OFF → ON)で直接編集モードへ遷移。
          //      flatten は conflict 適用後の suggestions / accepted 集合を基準に
          //      行われるため、編集対象 = 新版反映済みの派生 ES になる(順序が逆だと
          //      旧 suggestions 基準の flatten になり不整合)。
          // 防御: 万一すでに直接編集中なら toggle しない(OFF にしてしまうのを防ぐ)。
          applyConflictNewVersion();
          if (!useAnalyzeStore.getState().directEditMode) {
            toggleDirectEdit();
          }
          setConflictModalOpen(false);
        }}
        onKeepCurrent={() => {
          dismissConflict();
          setConflictModalOpen(false);
        }}
        onClose={() => {
          setConflictModalOpen(false);
        }}
      />
    )}
    </>
  );
}

// =============================================================================
// Phase G Step 2: refresh の進行バナー(loading 中の控えめ表示)
// UX 改修 3b (2026-05-23): goal で文言を切替(通常 / 文字数削減モード)
// =============================================================================
// Linear / Notion 系のミニマル UX を維持するため、Canvas 全体を覆わない 1 行表現。
// refreshStreamingStage に応じて文言を切り替える(initial の LoadingDisplay と
// 同じ stage 文言を再利用、簡略化のため少し短めに)。
function RefreshProgressBanner({
  stage,
  goal,
}: {
  stage: import("@/lib/state/analyze_store").StreamingStage;
  goal: import("@/lib/state/analyze_store").AnalyzeGoal;
}) {
  const t = useTranslations("canvas");
  // refresh_progress.<goal>.<stage> namespace から動的に key を解決
  const goalKey = goal === "reduce_length" ? "reduce_length" : "balanced";
  const stageKey = stage ?? "default";
  // 該当 key が無い場合は default (canvas.refresh_progress.<goal>.default) に fallback
  const label = t(`refresh_progress.${goalKey}.${stageKey}` as const);
  return (
    <div
      className="mt-3 flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
      <span className="text-foreground/85">{label}</span>
      <span className="ml-1 text-muted-foreground">
        {t("refresh_progress_suffix")}
      </span>
    </div>
  );
}

// =============================================================================
// 2026-05-25 Task #18: Partial refresh の global banner
// =============================================================================
// 採用 / 拒否 / 編集 / 直接編集 等の操作で発火する partial refresh の進行を
// 視覚的に伝える banner。RefreshProgressBanner(全体再分析)と区別するため、
// 「AI が関連指摘を再評価しています」文言で「scoped 範囲のみ」と認識可能にする。
//
// UX:
//  - 画面上部 center に `position: fixed` で重ね表示 — flow layout を占有せず、
//    既存 UI 要素を押し下げない(2026-05-27 dogfood 修正 Task B: layout shift 解消)
//  - Loader2 spinner + 文言 + 「操作はそのまま続けられます」hint
//  - role="status" + aria-live="polite" でスクリーンリーダー対応
//  - 既存 RefreshCompletionToast(画面右下 fixed)とは位置 / 用途が分離。本 banner は
//    「進行中(処理中の継続的表示)」、toast は「完了(短時間通知)」
//
// 表示タイミング:
//  - beginPartialRefresh で立てた partialRefreshInProgress=true を購読
//  - applyPartialResult が走った瞬間に false に戻る(AI 計算は完了、deleted の fade out は
//    個別 banner で継続)
//  - 失敗 / abort 経路では setRefreshError / finishRefresh が flags を即時クリア
//
// 設計判断(2026-05-27 dogfood 修正 Task B):
//  - 修正前は Canvas 内 flow layout に挿入され、表示時に ES 本文等を押し下げて
//    layout shift(カクつき)が発生していた
//  - `fixed top-4 left-1/2 -translate-x-1/2 z-50` で画面上部 center に固定表示、
//    既存要素を一切動かさない(完全 layout-shift-free)
//  - max-w-md で長すぎず、shadow-lg で「主役」感を出す(進行中の重要表示)
function PartialRefreshBanner() {
  const t = useTranslations("canvas");
  return (
    <div
      className="fixed top-4 left-1/2 z-50 flex max-w-md -translate-x-1/2 items-center gap-2 rounded-md border border-primary/30 bg-background/95 px-3 py-2 text-xs shadow-lg backdrop-blur-sm"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
      <span className="text-foreground/85 text-jp">
        {t("partial_refresh.banner_title")}
      </span>
      <span className="ml-1 text-muted-foreground text-jp">
        {t("refresh_progress_suffix")}
      </span>
    </div>
  );
}

// =============================================================================
// Phase G Step 2: refresh のエラーバナー(致命的失敗、再試行可能)
// UX 改修 3b (2026-05-23): goal で見出しを切替(通常 / 文字数削減モード)
// =============================================================================
// 失敗しても Canvas は元の指摘を表示し続ける(楽観的並行制御の精神 — ユーザーは
// 操作を続けられる)。バナーは「再試行」ボタンで再度 refresh を発火できる導線。
function RefreshErrorBanner({
  error,
  goal,
  onRetry,
}: {
  error: { kind: string; message: string };
  goal: import("@/lib/state/analyze_store").AnalyzeGoal;
  onRetry: () => void;
}) {
  const t = useTranslations("canvas");
  const tCommon = useTranslations("common");
  const tSettings = useTranslations("settings");
  const headingLabel =
    goal === "reduce_length"
      ? t("refresh_error_heading_reduce")
      : t("refresh_error_heading_balanced");
  // BYOK: 鍵未設定エラーは親切な i18n 文言にマップ(設定パネルへ誘導)。
  const isMissingKey = error.kind === "missing_api_key";
  // BYOK: レート制限/利用枠超過(429)も親切な i18n 文言にマップ。再試行は維持。
  const isRateLimit = error.kind === "rate_limit";
  // AI 分析の検証失敗(analysis_validation)も生の技術文字列ではなく、もう一度
  // 試せば直る旨の親切な i18n 文言にマップ。再試行ボタンは下部で常時維持。
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
    <div
      className="mt-3 flex flex-wrap items-start justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs"
      role="alert"
    >
      <div className="flex min-w-0 items-start gap-2">
        <AlertTriangle className="size-3 mt-0.5 shrink-0 text-destructive" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium text-destructive">
            {isMissingKey ? tSettings("missing_key_title") : headingLabel}
          </span>
          <span className="text-muted-foreground break-words">
            {detailMessage}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {/* 鍵未設定: ワンクリックで設定パネルを開く主アクション */}
        {isMissingKey && (
          <Button size="xs" onClick={requestOpenSettings}>
            <Settings className="size-3" aria-hidden />
            {tSettings("open_settings_action")}
          </Button>
        )}
        <Button variant="outline" size="xs" onClick={onRetry}>
          {tCommon("retry")}
        </Button>
      </div>
    </div>
  );
}

// =============================================================================
// HighlightSpan — Phase G Step 3a: Popover ラップ撤廃 + 双方向ハイライト
// =============================================================================
// Step 3a 改修:
//  - Popover を撤廃。詳細表示は SuggestionListPanel が担う。
//  - クリック: selectSuggestion(id) — リスト側のカードが ring + scroll into view。
//  - hover: setHoveredSuggestion(id) — リスト側のカードが subtle 強調。
//  - リストで hover されたら(hoveredSuggestionId === id)Canvas 側のハイライトも強調。
//  - リストで選択されたら(selectedSuggestionId === id)Canvas 側のハイライトも明示強調。
//
// 視覚状態の優先順(Task #22 2026-05-25 で青系 subtle に戻す):
//  - selected が真: ring-1 + ring-primary/60(細めの青系枠)、最も明確な強調
//  - hovered が真: ring-1 + ring-foreground/40、subtle
//  - 両方真の場合: selected の見た目が優先(より明確)
//  - どちらも偽: 通常のカテゴリ色のみ
//
// Task #22 (2026-05-25): 朱系選択枠を撤回 + サイズ縮小。
//   - Task #21 で導入した `ring-2 ring-red-500/70 ring-offset-1` を `ring-1 ring-primary/60`
//     (offset 削除)に変更。隣のテキストにかぶる視覚問題を解消、採用ボタン(primary 青)と
//     整合させ「青 + 朱の混在」を完全解消。DECISIONS §B を SSOT として参照。
//
// Task #21 (2026-05-25): 「opacity 薄化撤回 + scrollIntoView 抑制」(Task #22 でも維持):
//   - Commit D-3 で導入した `hasOtherSelection` 派生 + `opacity-40 hover:opacity-70` を削除。
//     ユーザーが「選択時に他テキストが薄くなる」UX を明示拒否したため、全 span を
//     同濃度で描画し、選択中は枠(ring)のみで識別する Grammarly モデル本来の姿に戻す。
//   - selected 時の `scrollIntoView` を削除。クリック切替で Canvas 視点が動かなくなり、
//     ユーザーの「カクツキ」体験を解消(右パネル詳細だけが切り替わる)。
//
// インライン span として実装(テキストの流れに溶け込む)、role="button" で a11y。
function HighlightSpan({
  text,
  suggestion,
}: {
  text: string;
  suggestion: Suggestion;
}) {
  const t = useTranslations("canvas");
  const tCategory = useTranslations("category");
  const selectedSuggestionId = useAnalyzeStore((s) => s.selectedSuggestionId);
  const hoveredSuggestionId = useAnalyzeStore((s) => s.hoveredSuggestionId);
  const selectSuggestion = useAnalyzeStore((s) => s.selectSuggestion);
  const setHoveredSuggestion = useAnalyzeStore((s) => s.setHoveredSuggestion);
  // Task #32a (2026-05-25): クリックで指摘タブに強制移動(動線整合)
  const setActiveTab = useAnalyzeStore((s) => s.setActiveTab);

  const isSelected = selectedSuggestionId === suggestion.id;
  const isHovered = hoveredSuggestionId === suggestion.id;

  // Task #21 (2026-05-25): scrollIntoView を削除。selected 切替時の Canvas 視点移動を抑制
  // (右パネルだけが切り替わる UX、ユーザー明示拒否事項の解消)。

  // Task #26 (2026-05-25): クリック toggle を撤去 — 既選択 ID と同じなら no-op、
  // そうでなければ selectSuggestion(id) でセット。
  //   - 旧: 既選択をもう一度クリックすると `selectSuggestion(null)` で解除 →
  //     SuggestionDetailPanel が「pendingCount > 0 + selected=null」を検出して
  //     「次の指摘を自動的に選んでいます…」placeholder にフォールバックする bug
  //     (dogfood 観察 2026-05-25)。
  //   - 新: Word / Pages の一般的な「再選択しても何も起きない」動作と整合、Task #22 で
  //     右パネル card クリック toggle を撤去した規律を Canvas ハイライトにも拡張。
  //   - 選択解除動線は「右パネルの戻るボタン / Esc キー」を維持(SuggestionDetailPanel)。
  // SSOT: DECISIONS.md [2026-05-25] Task #26 計画
  //
  // Task #32a (2026-05-25): selectSuggestion(id) と同時に setActiveTab("suggestions") を
  // 併発する。ユーザーが「企業要約 / 面接質問 / 履歴」タブを開いている状態でハイライトを
  // クリックすると、指摘タブに自動切替して詳細を表示する動線整合。RightPanel.tsx 側の
  // derived 強制上書きを撤去した(Task #32a 修正 1)代替として、明示動線でのみタブ切替する。
  const handleClick = () => {
    if (isSelected) {
      // 既選択時は no-op(toggle 廃止)— ただしタブが他にある状態でクリックされた場合は、
      // ユーザーが「指摘詳細を見たい」意図と解釈してタブだけは切り替える。
      setActiveTab("suggestions");
      return;
    }
    selectSuggestion(suggestion.id);
    setActiveTab("suggestions");
  };

  // キーボード対応: Enter / Space で同じ動作
  const handleKeyDown = (e: React.KeyboardEvent<HTMLSpanElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
    }
  };

  // Commit D-2 (2026-05-25): display_priority に応じた濃度 augment(internal_priority 数値は UI 参照禁止)
  // selected / hovered の ring が強い場合は priority opacity が衝突しないよう、selected/hovered 時は priority 補正を抑える。
  const priorityAugmentClass =
    isSelected || isHovered
      ? ""
      : suggestion.display_priority
        ? PRIORITY_BG_AUGMENT_CLASS[suggestion.display_priority]
        : "";

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setHoveredSuggestion(suggestion.id)}
      onMouseLeave={() => setHoveredSuggestion(null)}
      data-suggestion-id={suggestion.id}
      className={cn(
        "cursor-pointer rounded-sm px-0.5 transition-all",
        CATEGORY_HIGHLIGHT_CLASS[suggestion.category],
        priorityAugmentClass,
        // 強調の優先順: selected > hovered > 通常
        // Task #22 (2026-05-25): selected を青系 subtle (ring-1 ring-primary/60、offset なし)に。
        // 隣テキストにかぶらないサイズで、採用ボタン(primary 青)と整合。
        isSelected
          ? "ring-1 ring-primary/60"
          : isHovered
            ? "ring-1 ring-foreground/40"
            : "",
      )}
      aria-label={t("highlight_aria_template", {
        category: tCategory(suggestion.category),
        original: suggestion.original,
      })}
      aria-pressed={isSelected}
    >
      {text}
    </span>
  );
}

// =============================================================================
// AutoCorrectedSpan — Phase G Step 3b-1 (2026-05-23): 自動修正された箇所の subtle 強調
// =============================================================================
// 表示するテキストは「置換後の文字列」(proposed)で、emerald 系 subtle 背景 +
// 下線 dashed emerald-400 で「ここは自動修正された」ことを示す。
//
// 既存の HighlightSpan と同様に:
//  - クリックで selected トグル → SuggestionListPanel の対応カードが scroll into view
//  - hover で setHoveredSuggestion(id) → 双方向ハイライト
//  - 視覚状態: selected (primary ring) / hovered (foreground/40 ring) / 通常 (emerald subtle)
//
// 通常の HighlightSpan(error/convention/alternative)とは別表現:
//  - error の通常表示は destructive 系赤色背景だが、自動修正後は emerald 系で
//    「もう問題ない、適用済」を示す
//  - underline は dashed(実線ではない)で「変更が加えられた」感を出す
function AutoCorrectedSpan({
  text,
  suggestion,
}: {
  text: string;
  suggestion: Suggestion;
}) {
  const t = useTranslations("canvas");
  const selectedSuggestionId = useAnalyzeStore((s) => s.selectedSuggestionId);
  const hoveredSuggestionId = useAnalyzeStore((s) => s.hoveredSuggestionId);
  const selectSuggestion = useAnalyzeStore((s) => s.selectSuggestion);
  const setHoveredSuggestion = useAnalyzeStore((s) => s.setHoveredSuggestion);
  // Task #32a (2026-05-25): クリックで指摘タブに強制移動(HighlightSpan と同じ規律)
  const setActiveTab = useAnalyzeStore((s) => s.setActiveTab);

  const isSelected = selectedSuggestionId === suggestion.id;
  const isHovered = hoveredSuggestionId === suggestion.id;

  // Task #21 (2026-05-25): scrollIntoView を削除 + opacity 薄化を撤回(HighlightSpan と同じ規律)。
  // 自動修正済も Grammarly モデル(全 span 同濃度、選択枠のみで識別)に統一する。
  //
  // Task #26 (2026-05-25): クリック toggle を撤去 — HighlightSpan と同じ規律。
  //   - 既選択 ID と同じなら no-op、そうでなければ selectSuggestion(id) でセット。
  //   - 詳細根拠は HighlightSpan の handleClick コメント参照。
  //   - SSOT: DECISIONS.md [2026-05-25] Task #26 計画
  //
  // Task #32a (2026-05-25): selectSuggestion(id) と同時に setActiveTab("suggestions") を
  // 併発する(HighlightSpan と同じ動線整合規律)。詳細は HighlightSpan.handleClick コメント参照。
  const handleClick = () => {
    if (isSelected) {
      // 既選択時は no-op(toggle 廃止)。ただしタブが他にある状態でクリックされた場合は、
      // ユーザーが「指摘詳細を見たい」意図と解釈してタブだけは切り替える。
      setActiveTab("suggestions");
      return;
    }
    selectSuggestion(suggestion.id);
    setActiveTab("suggestions");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLSpanElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
    }
  };

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setHoveredSuggestion(suggestion.id)}
      onMouseLeave={() => setHoveredSuggestion(null)}
      data-suggestion-id={suggestion.id}
      className={cn(
        "cursor-pointer rounded-sm px-0.5 transition-all",
        // 自動修正済: emerald 系 subtle 背景 + dashed underline emerald-400
        // (AI が安心して修正したことを示す独自の視覚言語、Grammarly モデルの category 色とは別軸で維持)
        "bg-emerald-50 dark:bg-emerald-950/30",
        "underline decoration-emerald-500 decoration-dashed decoration-2 underline-offset-4",
        "hover:bg-emerald-100/80 dark:hover:bg-emerald-900/40",
        // 強調の優先順: selected > hovered > 通常
        // Task #22 (2026-05-25): selected を青系 subtle に戻し、HighlightSpan と整合。
        isSelected
          ? "ring-1 ring-primary/60"
          : isHovered
            ? "ring-1 ring-foreground/40"
            : "",
      )}
      aria-label={t("auto_corrected_aria_template", {
        original: suggestion.original,
        applied: text,
      })}
      aria-pressed={isSelected}
      title={t("auto_corrected_title_template", { original: suggestion.original })}
    >
      {text}
    </span>
  );
}

// =============================================================================
// AutoCorrectionBanner — Phase G Step 3b-1 (2026-05-23)
// =============================================================================
// 分析直後に上部に表示される自動修正通知バナー。
// - 「AI が N 件の誤字を自動修正しました」の認知 + 「全て元に戻す」緊急アクション
// - emerald 系 subtle 背景で「AI が安心して修正した」感を伝える
// - 「全て元に戻す」は確認ダイアログを挟むため誤操作リスクを低減
// - SuggestionListPanel の「自動修正済」セクション(折りたたみ)と相補的:
//   - こちら(Canvas バナー)は「これがあった」を伝える認知レイヤー
//   - リスト側の details は「具体的に何があった」を確認するレイヤー
function AutoCorrectionBanner({
  count,
  onUndoAll,
}: {
  count: number;
  onUndoAll: () => void;
}) {
  const t = useTranslations("canvas");
  return (
    <div
      className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-500/40 bg-emerald-50/70 px-3 py-2 text-xs dark:border-emerald-500/30 dark:bg-emerald-950/30"
      role="status"
      aria-live="polite"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Wand2
          className="size-3.5 shrink-0 text-emerald-700 dark:text-emerald-400"
          aria-hidden
        />
        <span className="text-emerald-900 dark:text-emerald-200">
          {t("auto_correction_banner_text", { count })}
        </span>
        <span className="hidden text-[10px] text-emerald-700/70 dark:text-emerald-400/70 sm:inline">
          {t("auto_correction_banner_hint")}
        </span>
      </div>
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={onUndoAll}
        className="shrink-0 border-emerald-500/40 text-emerald-700 hover:bg-emerald-100/70 dark:text-emerald-300 dark:hover:bg-emerald-900/40"
        aria-label={t("auto_correction_undo_all_aria")}
      >
        <RotateCcw className="size-3" />
        {t("auto_correction_undo_all")}
      </Button>
    </div>
  );
}

// =============================================================================
// ConflictNotificationBanner — Phase G Step 3b-3 (2026-05-23)
// =============================================================================
// 楽観的並行制御で「ユーザー操作中に届いた新しい分析結果」が version 不一致だった
// ケースを通知するバナー。Step 2 までは silent discard していたが、本 Step で
// ユーザーに選択を提示する経路に進化。
//
// 表示位置: CardHeader 内、RefreshErrorBanner と同じ層(画面占有しない控えめ表現)。
// ボタン: 「表示する」(モーダル展開)/「破棄」(silent discard と同じ動作)
function ConflictNotificationBanner({
  onView,
  onDismiss,
}: {
  onView: () => void;
  onDismiss: () => void;
}) {
  const t = useTranslations("canvas");
  const tCommon = useTranslations("common");
  return (
    <div
      className="mt-3 flex flex-wrap items-start justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-50/70 px-3 py-2 text-xs dark:border-amber-500/30 dark:bg-amber-950/30"
      role="alert"
      aria-live="polite"
    >
      <div className="flex min-w-0 items-start gap-2">
        <Bell
          className="size-3.5 mt-0.5 shrink-0 text-amber-700 dark:text-amber-400"
          aria-hidden
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium text-amber-900 dark:text-amber-200">
            {t("conflict_banner_title")}
          </span>
          <span className="text-amber-800/80 dark:text-amber-300/80">
            {t("conflict_banner_description")}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="default"
          size="xs"
          onClick={onView}
          aria-label={t("conflict_banner_view_aria")}
        >
          {tCommon("show")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onDismiss}
          aria-label={t("conflict_banner_dismiss_aria")}
          className="text-amber-800 hover:bg-amber-100/60 dark:text-amber-300 dark:hover:bg-amber-900/40"
        >
          {tCommon("dismiss")}
        </Button>
      </div>
    </div>
  );
}

// =============================================================================
// ConflictDetailModal — Phase G Step 3b-3 (2026-05-23)
// =============================================================================
// 競合通知の詳細表示モーダル。差分サマリ(更新 / 削除 / 追加の件数)+ 3 直接アクション。
//
// AGENTS.md 不変制約「競合通知は中間プレビューステップなし、直接アクション 3 つ」:
//  - 「新版を採用」: applyConflictNewVersion(全面マージ)
//  - 「新版を採用して編集」: applyConflictNewVersion で全面マージした後、
//    toggleDirectEdit で直接編集モードへ遷移(提出後改善 #4、2026-06-10 で実体化。
//    旧実装は「新版を採用」と同一動作だった)
//  - 「現在の選択を維持」: dismissConflict(silent discard と同等の最終結果)
//
// 設計判断: shadcn の Dialog 依存を増やさない簡易モーダル(固定オーバーレイ + 中央配置)。
// shadcn AlertDialog を使う案もあったが、本 Step では shadcn add で追加せず素朴な
// fixed div + click outside で close。AGENTS.md 通り「依存追加は sparring に相談」。
function ConflictDetailModal({
  notification,
  onAcceptNew,
  onEditNew,
  onKeepCurrent,
  onClose,
}: {
  notification: import("@/lib/state/analyze_store").ConflictNotification;
  onAcceptNew: () => void;
  onEditNew: () => void;
  onKeepCurrent: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("canvas");
  // 差分サマリの計算: partial 経路は updated/deleted/added が直接わかる、full 経路は
  // 新旧 suggestions の集合差から類推する。
  let updatedCount = 0;
  let deletedCount = 0;
  let addedCount = 0;
  if (notification.type === "partial") {
    updatedCount = notification.newResult.updated.length;
    deletedCount = notification.newResult.deleted.length;
    addedCount = notification.newResult.added.length;
  } else {
    const prevIds = new Set(
      notification.previousSuggestions.map((s) => s.id),
    );
    const newIds = new Set(notification.newResult.suggestions.map((s) => s.id));
    for (const s of notification.newResult.suggestions) {
      if (prevIds.has(s.id)) updatedCount++;
      else addedCount++;
    }
    for (const s of notification.previousSuggestions) {
      if (!newIds.has(s.id)) deletedCount++;
    }
  }

  // Escape キーでモーダル閉じる(close = キャンセル相当、conflictNotification は維持)
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-modal-title"
      onClick={(e) => {
        // 背景クリックで close(Escape と同等の挙動、conflict は破棄しない)
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl rounded-lg border border-border bg-card shadow-lg">
        {/* ヘッダ */}
        <div className="flex items-start justify-between gap-3 border-b border-border/60 p-4">
          <div className="flex items-start gap-2">
            <Bell className="size-5 mt-0.5 shrink-0 text-amber-600" aria-hidden />
            <div className="flex flex-col gap-1">
              <h2
                id="conflict-modal-title"
                className="text-sm font-semibold text-foreground"
              >
                {t("conflict_modal_title")}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t("conflict_modal_description")}
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onClose}
            aria-label={t("conflict_modal_close_aria")}
            className="shrink-0"
          >
            <X className="size-4" />
          </Button>
        </div>

        {/* 差分サマリ */}
        <div className="border-b border-border/60 p-4">
          <p className="mb-2 text-xs text-muted-foreground">
            {t("conflict_modal_diff_label")}
          </p>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="rounded border border-amber-500/40 bg-amber-100/60 px-2 py-0.5 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
              {t("conflict_modal_diff_updated", { count: updatedCount })}
            </span>
            <span className="rounded border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-destructive">
              {t("conflict_modal_diff_deleted", { count: deletedCount })}
            </span>
            <span className="rounded border border-primary/40 bg-primary/10 px-2 py-0.5 text-primary">
              {t("conflict_modal_diff_added", { count: addedCount })}
            </span>
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            {t("conflict_modal_diff_note")}
          </p>
        </div>

        {/* 直接アクション 3 つ(AGENTS.md 不変制約) */}
        <div className="flex flex-col gap-2 p-4">
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={onAcceptNew}
            aria-label={t("conflict_modal_accept_new_aria")}
            className="w-full justify-start"
          >
            <span className="font-medium">{t("conflict_modal_accept_new")}</span>
            <span className="text-xs opacity-80">
              {t("conflict_modal_accept_new_desc")}
            </span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onEditNew}
            aria-label={t("conflict_modal_edit_new_aria")}
            className="w-full justify-start"
          >
            <span className="font-medium">{t("conflict_modal_edit_new")}</span>
            <span className="text-xs opacity-80">
              {t("conflict_modal_edit_new_desc")}
            </span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onKeepCurrent}
            aria-label={t("conflict_modal_keep_current_aria")}
            className="w-full justify-start"
          >
            <span className="font-medium">{t("conflict_modal_keep_current")}</span>
            <span className="text-xs opacity-80">
              {t("conflict_modal_keep_current_desc")}
            </span>
          </Button>
        </div>
      </div>
    </div>
  );
}
