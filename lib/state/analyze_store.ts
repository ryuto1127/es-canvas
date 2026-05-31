"use client";

// =============================================================================
// Phase E: 分析セッション state — Zustand store
// =============================================================================
//
// 責務:
//  - 入力フォーム値(ES 本体 / 設問 / 文字数 / 企業URL / 添削条件 / ユーザー文脈)
//  - /api/research → /api/analyze 連鎖の loading / phase 表示
//  - CompanySummary / AnalysisResult / エラーの保持
//
// 設計判断:
//  1) **persist しない**。AGENTS.md「Out of scope」より localStorage / DB は v1 スコープ外。
//     全 state はメモリのみ。リロードで消える。
//  2) **入力 state は AnalyzeInputBundleInitial 形に直接寄せる**(F.7 命名揺れ解消)。
//     旧 InputBundle(editing_condition 単数)は経由しない。API 送信時に再構築する手間が消える。
//  3) **phase は loading 中の細分化**("idle" | "researching" | "analyzing" | "done" | "error")
//     ボタン label と progress 表現が phase に直接連動。Phase E のフォーム disable も `isLoading()` derived 関数で判定。
//  4) **アクションは粒度小さく**(setField / startAnalysis / reset / setError 等)。Phase G で
//     楽観的並行制御 + accept/edit/reject アクションを追加するときに、既存 actions を壊さない構造。
//  5) **research 失敗時は company_summary を undefined で続行**。エラーは別フィールド
//     `researchError` に文字列で持ち、結果表示で「企業要約取得失敗、要約なしで分析」と注記表示。
//
// AGENTS.md Inviolable constraints との対応:
//  - 数値スコア禁止: state には保持しない(token_usage / metadata は型上保持できるが UI に出さない)
//  - ユーザーは待たない: Phase E は loading 中 disable で妥協。Phase G で楽観的並行制御。
//  - localStorage / DB / 認証は v1 スコープ外: persist 一切なし
//
// SSOT: lib/schema/input.ts (AnalyzeInputBundleInitial, EditingPreset),
//       lib/schema/company.ts (CompanySummary), lib/schema/analysis.ts (AnalysisResult)

import { create } from "zustand";
import type { CompanySummary } from "@/lib/schema/company";
import type {
  AnalysisResult,
  PartialAnalysisResult,
} from "@/lib/schema/analysis";
import type {
  ActionHistoryEntry,
  AnalyzeInputBundleInitial,
  AnalyzeInputBundlePartial,
  AnalyzeInputBundleRefresh,
  EditingPreset,
} from "@/lib/schema/input";
// v2 Phase B3 (2026-05-26): structural カテゴリ採用時の派生 ES 生成
// (client side 機械適用、AI hallucination 回避)。
import { applyStructuralOperation } from "@/lib/state/structural_ops";
// v2 bug fix (2026-05-26): 派生 ES / 派生 span 計算で structural を除外するために
// category 型を参照する(structural の proposed は placeholder で、置換用文字列ではない)。
// 2026-05-27 derivedSpans 座標系統一 bug fix: partial refresh / refresh の結果に含まれる
// updated / added / suggestions の original_span を form.es_body 基準に再アンカーするため
// Suggestion 型を参照する(reAnchorSuggestionsToFormEsBody)。
import type { Category, Suggestion } from "@/lib/schema/suggestion";
// v2 dogfood UX 改善 Task A (2026-05-26): ActionLogEntry に structural snapshot を保存
// するため StructuralOperationParams 型を参照(load-bearing field `structural_params`、
// schema 側で discriminated union 定義済)。
import type { StructuralOperationParams } from "@/lib/schema/suggestion";
// 2026-05-27 エージェント的対話(AI 逆質問): question 本文を引くため
// ClarificationQuestion 型を参照(lib/schema/clarification.ts)。
// 2026-05-28 dogfood: enriched_intent ヘッダの SSOT 定数を value import
// (buildClarificationEnrichedIntent で使用、prompt builder 側の検知と同期)。
import type { ClarificationQuestion } from "@/lib/schema/clarification";
import {
  CLARIFICATION_ENRICHED_INTENT_HEADER,
  clarificationIdentity,
} from "@/lib/schema/clarification";

// -----------------------------------------------------------------------------
// Form state — フォームの素の入力値
// -----------------------------------------------------------------------------
// `AnalyzeInputBundleInitial` は API 境界の正規形だが、フォームでは:
//  - char_limit は string(<input type=number> の素の値、空文字を許容)で持ち、送信時に Number 化
//  - company_url は空文字許容(送信時に null/undefined に変換)
// の小さな違いがある。送信時に buildAnalyzeBundle で変換する。
//
// FormState の構造は AnalyzeInputBundleInitial に対応するが、入力中の不完全な値を
// 許容するため string-loose(数値も string)で持つ。
//
// Phase E 拡張(2026-05-23): 企業情報を 3 タブ(URL / 企業名 / 自由テキスト)に拡張。
// `company_input_type` が現在選択中のタブ、`company_url` / `company_name` / `company_freetext`
// は各タブの入力(独立 state、タブ切り替えで値は消えない)。送信時に input_type に応じて
// 1 つだけを /api/research に渡す。
export type CompanyInputType = "url" | "name" | "freetext";

export interface FormState {
  es_body: string;
  question_text: string;
  // <input type=number> の value は string("400" / "" / "100" など)。送信時に parseInt。
  char_limit: string;
  // 企業情報入力(3 タブ)
  company_input_type: CompanyInputType;
  // URL タブの値。空文字 = 未入力扱い。
  company_url: string;
  // 企業名タブの値。1〜100 字。
  company_name: string;
  // 自由テキストタブの値。20〜4000 字(20字未満は LLM 整形不能、4000字超はコスト爆発)。
  company_freetext: string;
  preset: EditingPreset;
  free_text: string;
  user_context: string;
}

const DEFAULT_FORM: FormState = {
  es_body: "",
  question_text: "",
  char_limit: "400",
  company_input_type: "url",
  company_url: "",
  company_name: "",
  company_freetext: "",
  preset: "バランス",
  free_text: "",
  user_context: "",
};

// -----------------------------------------------------------------------------
// Phase: 連鎖の進行段階
// -----------------------------------------------------------------------------
//   idle:         初期 / reset 直後
//   researching:  /api/research 呼び出し中(URL が入力されたときのみこの phase に入る)
//   analyzing:    /api/analyze 呼び出し中
//   done:         AnalysisResult を受け取った
//   error:        どこかで致命的エラー(/api/analyze 失敗)
//
// /api/research が失敗しても /api/analyze は続行するため、research 失敗で error には入らない
// (researchError 文字列だけ立てて analyzing に進む)。
//
// Phase G Step 1 (2026-05-23): analyzing の中で SSE streaming の中間進捗を表現するため
// streamingStage state を別に持たせる(phase は粗いまま、streamingStage が細かい進行)。
export type AnalyzePhase = "idle" | "researching" | "analyzing" | "done" | "error";

// -----------------------------------------------------------------------------
// Streaming stage (Phase G Step 1, 2026-05-23): SSE 受信の細かい進行
// -----------------------------------------------------------------------------
// phase === "analyzing" の間、SSE の各 event を受けて細分化したラベルを LoadingDisplay
// が表示する。phase 自体は粗い 5 段階のまま維持(他のロジックが依存しているため)。
//
// state 値:
//   - null:        streaming 未開始(initial 経路で SSE 接続前 or refresh / 旧 JSON 経路)
//   - "started":   SSE 接続済、最初の event 受信前 〜 thinking 開始前
//   - "thinking":  extended thinking の partial を受信中
//   - "generating": tool_use の partial JSON を受信中(指摘を生成中)
//   - "retrying":  検証エラー → リトライ発火、再 streaming 中
//   - "finalizing": completed event の Zod 検証中(瞬間的)
export type StreamingStage =
  | null
  | "started"
  | "thinking"
  | "generating"
  | "retrying"
  | "finalizing";

// -----------------------------------------------------------------------------
// Refresh phase (Phase G Step 2, 2026-05-23): refresh だけの並行進行を別軸で管理
// -----------------------------------------------------------------------------
// 「ユーザーは待たない」を構造で実現するため、refresh は **phase とは独立** に進む。
// phase は idle / researching / analyzing / done / error の 5 状態のままだが、
// done 中に refresh を発火しても phase は done を維持する(Canvas は表示し続ける、
// 操作も許容する)。代わりに refreshPhase が "loading" / "idle" / "error" のいずれかを
// 取り、控えめなバナーで進行状況を見せる。
//
// 値:
//   - "idle":     refresh 未実行(初期 / 完了直後)
//   - "loading":  refresh 実行中(SSE streaming 含む)
//   - "error":    最後の refresh が失敗した(controlled 失敗 = LLM 検証エラー等)
//
// 注: 「古いバージョンの応答を破棄した」ケースは error ではなく成功裏に discard する
// (refreshPhase は再度 loading に上書きされる、UI には何も出さない)。
export type RefreshPhase = "idle" | "loading" | "error";

// -----------------------------------------------------------------------------
// Conflict notification (Phase G Step 3b-3, 2026-05-23)
// -----------------------------------------------------------------------------
// 「自動 refresh の応答が version 整合 NG だった」ケースを silent discard せず、
// ユーザーに「新しい分析結果がありますが、現在の操作と競合しています」と伝える。
//
// 表示動線:
//  1. トーストバナー(右上 / Canvas ヘッダ)で「新しい分析結果があります」を通知
//  2. 「表示する」クリック → モーダルで詳細表示 + 直接アクション 3 つ
//     - 新版を採用: discardConflict + applyPartialResult を強制実行(version 整合チェックスキップ)
//     - 新版を編集して採用: 新 suggestions を表示状態にしつつユーザー個別判断可
//     - 現在の選択を維持: 破棄(silent discard 相当の最終形)
//  3. 「破棄」クリック → discardConflict のみ(現状動作と同じ)
//
// 設計判断(G3B3.x):
//  - silent discard を残しつつ、conflictNotification state を別軸で立てる構造は採らない。
//    silent discard を **完全に廃止** し、version 不一致 = conflictNotification に保存する。
//    理由: 「ユーザーに見えない discard」が散らばると debug 困難、Phase H で運用観察できない。
//  - `type` は "partial" のみで初期化(refresh stream の version 不一致はまずないが、将来
//    "full" を扱う場合に extend する余地を残す型構造)。
//  - previousResult / newResult を両方保持して差分計算可能にする(モーダルで「現在の指摘
//    リスト」と「新しい指摘リスト」を並べて表示)。
//  - previousSuggestions は notification 発火時点の analysisResult.suggestions の snapshot。
export type ConflictNotification =
  | {
      type: "partial";
      // 競合した新しい partial 結果(整合性 NG だったが、ユーザーが採用を選べる)
      newResult: PartialAnalysisResult;
      // 競合発生時点の analysisResult.suggestions の snapshot(差分表示用)
      previousSuggestions: import("@/lib/schema/suggestion").Suggestion[];
      // 競合発生時点の overall_assessment(差分表示用、新版に切り替える際の fallback)
      previousOverallAssessment:
        | import("@/lib/schema/analysis").OverallAssessment
        | undefined;
      // 検出時刻(同 session 内で複数発生時の順序保持。1 つだけ持つ設計のため最新で上書き)
      detectedAt: number;
      // 検出時の version 情報(debug + ユーザー説明用)
      receivedEsStateVersion: number;
      expectedEsStateVersion: number;
    }
  | {
      type: "full";
      // 競合した新しい full 結果(reduce_length 経路 or partial fallback で発生)
      newResult: AnalysisResult;
      previousSuggestions: import("@/lib/schema/suggestion").Suggestion[];
      previousOverallAssessment:
        | import("@/lib/schema/analysis").OverallAssessment
        | undefined;
      detectedAt: number;
      receivedEsStateVersion: number;
      expectedEsStateVersion: number;
    };

// -----------------------------------------------------------------------------
// Analyze goal (UX 改修 3b, 2026-05-23): refresh の目的フラグ
// -----------------------------------------------------------------------------
// refresh を「通常モード」と「文字数削減モード」のどちらで動かしているかを保持。
// UI(RefreshProgressBanner の文言切替)とサーバへの送信(buildRefreshBundle の goal)
// の両方で参照する。balanced は既存挙動と同じ。
//
// 値:
//   - "balanced":      通常の再分析(指摘の精度・網羅性重視、既存挙動)
//   - "reduce_length": 文字数削減モード(派生 ES が上限超過時の追加削減提案)
export type AnalyzeGoal = "balanced" | "reduce_length";

// -----------------------------------------------------------------------------
// Right panel active tab (Task #32a, 2026-05-25): 右パネルのアクティブタブ
// -----------------------------------------------------------------------------
// `RightPanel` の 4 タブ(指摘 / 企業要約 / 面接質問 / 履歴)のうち、現在表示中の
// タブを示す ID 値。初期値は `"suggestions"`(指摘がメインのため常に最初に表示)。
//
// Task #32a (2026-05-25): 旧設計の `RightPanel.tsx` 内 `useState<TabValue>` +
// `selectedSuggestionId !== null` での強制上書きを撤去するために store に格上げ。
// 旧設計では「`selectedSuggestionId` が立つと derived で `"suggestions"` を返す」
// ロジックが、Task #30 の自動選択強化(`selectedSuggestionId` が常に立つ)と
// 衝突して「企業要約 / 面接質問」タブクリックが効かない bug が発生した。
//
// 設計判断:
//  - store 中心の既存設計(Tab state を store に置く)に整合させる
//    (Context は採らない、既存設計の維持)
//  - 動線整合のため、`Canvas.tsx` の `HighlightSpan` / `AutoCorrectedSpan` の
//    onClick で `selectSuggestion(id)` 直後に `setActiveTab("suggestions")` を
//    併発する(明示動線でのタブ切替、ユーザーが指摘詳細を見たいときの整合)
//  - `SuggestionDetailPanel.tsx` の Task #30 auto-select useEffect は
//    `activeTab === "suggestions"` のときのみ走らせる(他タブ表示中は
//    auto-select を抑止し、Cmd+Z 等の経路で意図せず指摘タブに飛ばされない)
//
// 値: "suggestions"(指摘)/ "company"(企業要約)/ "interview"(面接質問)/ "history"(履歴)
//
// 注: `RightPanel.tsx` 内の `TabValue` 型は本型と同じ union を独立して定義していたが、
// Task #32a で本ファイル側を SSOT とし、`RightPanel.tsx` 側は本 export を import する。
export type TabValue = "suggestions" | "company" | "interview" | "history";

// -----------------------------------------------------------------------------
// ActionLogEntry (2026-05-25): UI 用の rich 操作ログ(parallel to actionHistory)
// -----------------------------------------------------------------------------
// `actionHistory` は LLM の refresh API に送るための load-bearing 形(verb 判別ユニオン、
// suggestion_id + suggestion_summary のみ)。`actionLog` は UI 表示 / revert 用に
// **並行で持つ別 state** で、suggestion のカテゴリ / 短文 / 編集テキスト / timestamp /
// ES 本文 before-after(DIRECT_EDIT 用)など UI に必要な情報を保持する。
//
// 設計判断:
//  1) actionHistory に新規 field を足さない理由: schema が refresh / partial API の
//     入力形として load-bearing(Zod 検証 + 防衛三段で LLM に投入される文字列形)。
//     timestamp 等を含めると LLM プロンプトの「文字列構造」に余計な情報が混ざる、
//     few-shot 学習 prompt との整合が崩れる。
//  2) 1:1 同期: 各操作 action(acceptSuggestion / rejectSuggestion / editSuggestion /
//     toggleDirectEdit / undoAutoCorrection / revertSuggestionAction)で actionHistory に
//     entry を push する時、同じ操作 1 件につき actionLog にも対応 entry を push する。
//     順序を完全一致させる(N 番目の actionHistory ↔ N 番目の actionLog が同一操作)。
//  3) revert 機構: actionLog entry 1 件には `id`(UUID)を持ち、HistoryPanel から
//     「この操作を取り消す」クリック時にこの id で参照する。store の
//     `revertSuggestionAction(suggestionId)` が status を pending に戻し、PENDING entry を
//     actionHistory + actionLog 両方に push する(per-card revert と history revert は
//     同じ経路、dispatch §C「既存の Undo stack と互換」を満たす)。
//  4) DIRECT_EDIT の revert: ES 本文の before/after を保持しないと revert できないため、
//     v1 では DIRECT_EDIT の revert は **対応しない**(HistoryPanel の該当 entry の
//     revert ボタンを disabled 表示)。Undo / Redo stack の DIRECT_EDIT 挙動と同じ規律
//     (DECISIONS L1347-1353)。v2 で esBodyBefore / esBodyAfter を持たせる候補。
//  5) startEditingMode 時の snapshot: actionLog も保存する(編集モードキャンセルで完全
//     restore できるよう)。snapshot に追加することで Inviolable constraint「すべての
//     操作は Undo 可能」を編集モードキャンセル経路でも保つ。
export type ActionLogEntryType =
  | "accepted"
  | "rejected"
  | "edited"
  | "auto_corrected_undo" // 自動修正の個別取り消し(undoAutoCorrection)
  | "auto_corrected_undo_all" // 自動修正の一括取り消し(undoAllAutoCorrections)
  | "direct_edit"
  | "reverted" // history / card 経由で過去操作を取り消した
  // 2026-05-27 エージェント的対話(AI 逆質問): 質問への回答操作。clarificationSnapshot に
  // question_id / question_text / answer_text / scope を保持し、HistoryPanel で「Q: …」
  // 「A: …」表示用に参照する。
  | "clarification_answered";

// 2026-05-27 エージェント的対話(AI 逆質問): ユーザーが入力した回答 1 件。
// 同 session 内のメモリ保持(localStorage 不使用、v1 スコープ)。partial refresh の
// 再発火時に enriched_intent として user_context に append される。
//
// scope:
//  - "suggestion": 特定 suggestion に紐づく質問への回答(suggestion_id 必須)
//  - "global":     AnalyzeResult.global_clarification_questions への回答(suggestion_id なし)
//
// question_id は ClarificationQuestion.id と一致。1 question = 1 ClarificationAnswer の規律
// (同じ question_id への重複回答は最新値で上書き、`updateClarificationAnswer` 内で処理)。
export interface ClarificationAnswer {
  question_id: string;
  answer_text: string;
  answered_at: number; // Date.now() の timestamp
  scope: "suggestion" | "global";
  // scope === "suggestion" の場合のみ set される suggestion id(ClarificationQuestion を
  // 引くために必要、merge 経路で suggestion が消えた場合 cleanup の判定に使う)
  suggestion_id?: string;
}

// v2 dogfood UX 改善 Task A (2026-05-26): structural 採用時の履歴詳細表示用 snapshot。
// HistoryPanel が「段落 N を削除: '冒頭…'」「段落順番変更: 1・2・3 → 3・1・2」等の
// 具体的な操作内容を rendering するために必要な情報を、accept 時点でフリーズして保存する。
//
// 設計判断:
//  - load-bearing でない命名(`structuralSnapshot`)で追加 — schema/prompt 経路には流さず、
//    UI 専用の rich 表示メタ。AGENTS.md「追加は可」(L65)。
//  - paragraph 番号は 1-based に変換せず内部 0-based のまま保存し、表示時に +1 する規律。
//    既存 schema(`target_paragraph_index` 等)が 0-based であり、整合を保つ。
//  - 冒頭プレビューは snapshot 時点で **計算済文字列** として保存(30 字 truncate 済)。
//    後の編集で原文段落が変化しても履歴表示は壊れない(dispatch §「注意事項」)。
//  - 各 operation 別の派生情報(削除対象段落の冒頭、新規段落の冒頭等)はここに集約。
//  - `params` には `StructuralOperationParams` discriminated union をそのまま保存。
export interface StructuralActionSnapshot {
  // operation 種別(`params.operation` と同値、ルックアップ高速化のため複製保持)
  operation: StructuralOperationParams["operation"];
  // applyStructuralOperation に渡した params 一式(後から段落番号等を再描画する根拠)
  params: StructuralOperationParams;
  // accept 時点の段落数(`currentEsBodyBefore.split(/\n\n+/)` で算出)。
  // reorder_paragraphs の「old order = 1・2・…・N」表示で必要。
  paragraphCount: number;
  // operation 別の冒頭プレビュー(30 字、超過は末尾 "…")
  //  - delete_paragraph: 削除対象段落の先頭
  //  - add_paragraph: new_content の先頭
  //  - reorder_paragraphs / merge_paragraphs / move_sentence: undefined(label に preview 不要)
  preview?: string;
}

// 2026-05-28 dogfood round 3 ⑤ 直接編集 bug fix: 直接編集の Undo/Redo で「採用を積み重ねた
// 状態」を完全復元するための state 一式 snapshot。
//
// 背景(旧挙動の問題):
//  - 旧 DIRECT_EDIT undo は `currentEsBody = form.es_body` にリセットするだけで、
//    text 採用 / 編集 / 自動修正の集合(acceptedSuggestionIds 等)を復元しなかった。
//    = AGENTS.md Inviolable constraint「すべての操作は Undo 可能」が実質破れていた
//    (直接編集前に積み重ねた採用判断が Undo で戻らない)。
//
// 設計判断:
//  - load-bearing でない命名(`DirectEditStateSnapshot`)で追加 — schema / prompt 経路には
//    流さず、UI / store 内部の Undo 復元専用 snapshot。AGENTS.md「追加は可」(L65)。
//  - 直接編集 ON の瞬間(flatten 直前)に「before」を、OFF の瞬間に「after」を保持する。
//    undo は before に、redo は after に復元することで直接編集を 1 操作として完全に
//    巻き戻し / 再適用できる(structural の currentEsBodyBefore 巻き戻しと同じ精神を
//    「派生 ES + 採用集合 + baked 集合」全体に拡張したもの)。
//  - bakedSuggestionIds を含めるのが要点: flatten で「採用済テキストを currentEsBody に
//    焼き込んだ」事実を表す baked 集合も snapshot しないと、undo 後に getDerivedEsBody が
//    二重適用してしまう。
export interface DirectEditStateSnapshot {
  currentEsBody: string;
  acceptedSuggestionIds: string[];
  rejectedSuggestionIds: string[];
  editedSuggestions: Record<string, string>;
  autoCorrectedSuggestionIds: string[];
  bakedSuggestionIds: string[];
}

export interface ActionLogEntry {
  // 一意 id(UUID v4 想定、history panel での参照に使う)
  id: string;
  // 操作種別(UI のアイコン / ラベル切替に使う)
  type: ActionLogEntryType;
  // ES の最新版番号(操作完了直後の clientEsVersion)。デバッグ + history panel 表示用
  esVersion: number;
  // タイムスタンプ(Date.now()、相対時刻表示 「N 秒前」 計算用)
  timestamp: number;
  // 対象 suggestion 情報(type === "direct_edit" の時は undefined)
  suggestionId?: string;
  // v2 Phase B1 (2026-05-26) → B3 (2026-05-26) 本実装:
  // Suggestion.category の literal union 拡張に追従。
  // HistoryPanel(tCategory(entry.suggestionCategory))は messages/* に structural key
  // 追加されるまで next-intl の key-fallback で `"structural"` 文字列をそのまま表示する
  // (B4 で structural i18n key 追加予定)。本 B3 では store の structural 採用処理 +
  // Undo/Redo の currentEsBody 巻き戻しを本実装、structural 専用 history panel UI は B4。
  suggestionCategory?: "error" | "convention" | "alternative" | "structural";
  suggestionOriginalSnippet?: string; // 30 字程度の冒頭抜粋
  suggestionSummary?: string;
  // edited 操作のみ
  editedText?: string;
  // direct_edit 操作のみ(派生 ES 本文 = currentEsBody スナップショット)
  directEditCharCount?: number;
  // 2026-05-28 dogfood round 3 ⑤: type === "direct_edit" のときのみ set。
  // 直接編集 ON 直前(before)/ OFF 時点(after)の積み重ね state 一式。
  //  - undo: before に復元(積み重ねた採用 + baked + 編集前 currentEsBody に戻す)
  //  - redo: after に復元(直接編集後の本文 + baked 集合を再適用)
  // 旧挙動(form.es_body リセット)を置き換え、「すべての操作は Undo 可能」を実体化する。
  directEditSnapshot?: {
    before: DirectEditStateSnapshot;
    after: DirectEditStateSnapshot;
  };
  // reverted 操作で「どの entry を revert したか」(history panel の 関連表示用)
  revertedFromEntryId?: string;
  // G3 C6 fix (2026-05-28): revert(「この操作を取り消す」= pending 戻し)直前の
  // 該当 suggestion の status snapshot。Undo の per-entry 復元用(既存 currentEsBodyBefore /
  // directEditSnapshot と同型の内部 snapshot、schema 型 ActionHistoryEntry には流さない)。
  //
  // 背景: revertSuggestionAction は該当 id を accepted/rejected/edited/auto の全集合から
  //   外して PENDING entry を積むが、undo の case "PENDING" は no-op だったため、その後
  //   ツールバー Undo しても元の採用/却下/編集状態に戻らなかった(Codex 独立レビュー C6)。
  //
  // type === "reverted" のときのみ set される。undo: 本 snapshot から元 status を復元、
  // redo: 再度 revert(全集合から外す)を適用 = undo/redo 対称。
  //  - wasAccepted/wasRejected/wasAuto: revert 前にその集合に属していたか
  //  - editedText: revert 前に編集テキストがあれば保持(undefined = 編集状態でなかった)
  revertSnapshot?: {
    wasAccepted: boolean;
    wasRejected: boolean;
    wasAuto: boolean;
    editedText?: string;
  };
  // 自動修正の一括取り消しの場合の対象件数
  undoAllCount?: number;
  // 2026-05-30 N5: REJECTED 系 entry(type === "rejected" / "auto_corrected_undo" /
  // "auto_corrected_undo_all")を生成した **却下時点で** 「この suggestion が自動修正対象
  // (category === "error")だったか」を snapshot 保存する。
  //
  // 背景: undo の case "REJECTED" は元々 **現在の** analysisResult.suggestions から
  //   category === "error" を再導出して accepted + autoCorrected への復元可否を判定して
  //   いた。間に refresh が走って analysisResult が差し替わると、その id が消滅 / 再分類
  //   され、復元状態がずれた(自動修正だったのに pending のままになる等)。
  //   却下時点の真実を snapshot に固定し、undo はライブ result を見ずこれを読む。
  // C6 revertSnapshot / structural の currentEsBodyBefore と同じ「操作時点 snapshot」精神。
  // undefined = 旧 entry(snapshot 未保存)→ undo 側で従来挙動(ライブ result 参照)に fallback。
  rejectedWasAutoError?: boolean;
  // G3 C7 fix (2026-05-28): 1 回のユーザー操作が複数 entry を生む bulk 操作の group id。
  // 「全て元に戻す」(undoAllAutoCorrections)は autoCorrected の件数分 REJECTED entry を
  // 積むが、ツールバー Undo は常に undo(1) のため 1 回で 1 件しか戻らなかった
  // (Codex 独立レビュー C7)。同一 group の連続 entry を undo/redo が 1 単位として
  // まとめて処理できるよう、bulk 生成時に全 entry へ同じ groupId を付与する。
  // schema 型 ActionHistoryEntry には流さない内部メタ(undo の境界拡張にのみ使用)。
  groupId?: string;
  // この entry が後続の操作で「上書きされた / 取り消された」フラグ。
  // history panel で「old entry はグレーアウト」「revert ボタン disabled」にする判定用。
  isOutdated?: boolean;
  // v2 Phase B3 (2026-05-26): structural 採用直前の currentEsBody スナップショット。
  // structural 採用は client side で applyStructuralOperation により派生 ES を生成する
  // (B3 で導入)。Undo 時にこの snapshot から巻き戻し、Redo 時に同じ suggestion を再適用する。
  // schema 型 ActionHistoryEntry(lib/schema/input.ts、API 境界)は touch せず、
  // store 内部型 ActionLogEntry に snapshot を持たせる設計(redoLogStack 経路で参照可能)。
  // type === "accepted" かつ suggestionCategory === "structural" のときのみ set される。
  currentEsBodyBefore?: string;
  // v2 dogfood UX 改善 Task A (2026-05-26): structural 採用時の履歴詳細表示用 snapshot。
  // HistoryPanel が「段落 N を削除: '冒頭…'」等の具体的操作を rendering するための rich 情報。
  // type === "accepted" かつ suggestionCategory === "structural" + structural_params 存在時のみ set。
  // 既存 currentEsBodyBefore とは独立の追加 field(後者は Undo の巻き戻し用、本 field は表示用)。
  structuralSnapshot?: StructuralActionSnapshot;
  // 2026-05-27 dogfood round 2 Task F: 通常 suggestion(error/convention/alternative)採用時の
  // 履歴詳細表示用 snapshot。HistoryPanel で「元の表現 → 採用後の表現」を併記表示するための
  // 軽量 snapshot。
  //  - originalText: accept 時点の suggestion.original 冒頭 30 字(超過時は末尾 "…")
  //  - proposedText: accept 時点の suggestion.proposed 冒頭 30 字(編集して採用なら editedText 由来)
  // load-bearing でない命名(表示専用、既存 structuralSnapshot と並ぶ pattern)。
  // type === "accepted" / "edited" + suggestionCategory !== "structural" のときのみ set される
  // (structural は structuralSnapshot 経路で別表示、本 field は通常 suggestion 専用)。
  proposedSnapshot?: {
    originalText: string;
    proposedText: string;
  };
  // 2026-05-27 エージェント的対話(AI 逆質問): 質問への回答 snapshot(HistoryPanel 表示用)。
  // type === "clarification_answered" のときのみ set される。
  //  - question_id: ClarificationQuestion.id(対応する質問特定用)
  //  - question_text: 回答時の question 本文(後で suggestion が消えても履歴表示が壊れない)
  //  - answer_text: ユーザーの回答(原文ママ、HistoryPanel で表示)
  //  - scope: "suggestion" or "global"
  //  - suggestion_id: scope === "suggestion" のみ set
  clarificationSnapshot?: {
    question_id: string;
    question_text: string;
    answer_text: string;
    scope: "suggestion" | "global";
    suggestion_id?: string;
  };
}

// -----------------------------------------------------------------------------
// PendingRefreshScope (統合改修パッケージ 2026-05-25): 動的 HITL の影響範囲指定
// 統合改修パッケージ訂正 (2026-05-25): 構造計算(refresh_scope.ts:computeRefreshScope)
// から AI 判断方式に変更。store は seed 情報を保持するだけで、影響範囲のフィルタは
// LLM の意味理解に任せる。
// -----------------------------------------------------------------------------
// rejectSuggestion / editSuggestion / direct edit / triggerFullRefresh の各 action が
// 「次の partial refresh で何を再評価するか」の scope 情報を保持する。
//
// 値の意味:
//  - kind: "scoped"        : 影響範囲を AI に判断させる partial 経路
//  - kind: "full"          : 影響範囲を限定せず全体再分析(refresh stream 経路)
//
// scoped の場合、partial bundle に渡すフィールド:
//  - seed_suggestion_ids: 直前にユーザーが拒否/編集した指摘 id(reject/edit で 1 件、
//                         direct_edit / undo / redo / 「再分析」ボタンでは空配列)
//  - seed_action_type: 操作の種類(prompt 文言調整に使う)
//  - edit_before / edit_after: edit / direct_edit のときの編集前後テキスト
//
// Canvas が partialRefreshTrigger 観測時に本 field を読んで分岐する:
//  - kind: "scoped" → partial bundle に seed 情報を渡す
//  - kind: "full"   → buildRefreshBundle で全体再分析(refresh stream 経路)
export interface PendingRefreshScope {
  kind: "scoped" | "full";
  seedIds: string[];
  // Task #31 (2026-05-25): `accept_with_related` を追加。
  //   採用した suggestion に `related_suggestion_ids` がある時のみ scoped partial refresh を
  //   発火する経路の reason。reason: "accept" は v1 で未使用だが将来的な「採用=常に scoped」
  //   採用に備えて enum に残す(現状の挙動は reject / edit / direct_edit /
  //   accept_with_related / undo / redo / manual のいずれかで分岐)。
  reason:
    | "accept"
    | "accept_with_related"
    | "reject"
    | "edit"
    | "direct_edit"
    | "undo"
    | "redo"
    | "manual";
  // edit / direct_edit 経路では編集前後テキストを保持(partial bundle に渡す)。
  // 他の経路では undefined(prompt 側で「編集差分なし」として扱う)。
  editBefore?: string;
  editAfter?: string;
}

// -----------------------------------------------------------------------------
// Server error shape — /api/* の error レスポンスを正規化
// -----------------------------------------------------------------------------
// /api/research と /api/analyze は共通フォーマット:
//   { error: { kind, message, stage?, retryable? } }
export interface ServerError {
  kind: string;
  message: string;
  stage?: string;
  retryable?: boolean;
  // HTTP status を併記(UI でリトライ可否判定の補助)
  status?: number;
}

// -----------------------------------------------------------------------------
// Capture log (2026-05-28 dogfood round 3 / 提出ドキュメント支援 — dev 専用)
// -----------------------------------------------------------------------------
// 提出ドキュメント用に「AI の実際の出力」を録画と一貫した形で採取するための
// **dev 専用** in-memory ログ。`docs/dispatch/2026-05-28-capture-utility.md` が SSOT。
//
// 設計判断(なぜこの形か):
//  1) **prompt / schema / tool / llm / API のロジックは一切変えない**。結果受領 action が
//     既に store に書いた結果を「読むだけ」。capture は副作用ゼロの観測層。
//  2) **dev gate**: append は `process.env.NODE_ENV === "development"` のときだけ実行
//     (production では完全 no-op)。保存 UI(`components/dev/CaptureLogButton.tsx`)も
//     同じ gate で production build から非 render。AGENTS.md「localStorage / DB / 認証は
//     v1 スコープ外」+ 本体の persistence なし方針を壊さない。
//  3) **in-memory(module-level array)を選択。sessionStorage / localStorage は使わない**。
//     理由:
//       - localStorage: 本体が「永続化しない」方針(AGENTS.md Out of scope)。dev 専用
//         capture でも localStorage を持ち込むと「永続化なし」の構造的一貫性が崩れる。
//       - sessionStorage: リロードで消えないが、本ユーティリティの運用は「録画しながら
//         分析 → 各 ES の後 or 最後に 1 クリック保存」。録画中にリロードする運用は想定せず、
//         リロード耐性のための serialize/parse コストと「dev だけの揮発バッファ」という
//         単純さのトレードオフで in-memory を採る(dispatch §「in-memory はリロードで消える。
//         各 ES 後 or 最後に保存する運用前提」と整合)。
//  4) **kind は 4 種を型として定義するが、現状 UI から発火するのは initial / partial /
//     refresh の 3 種のみ**。`/api/interview` 独立エンドポイントは存在するが、現状フロント
//     (components/app)から fetch する経路が無く、面接質問は initial 分析 `/api/analyze` の
//     結果に `interview_questions` として同梱され `setAnalysisResult` 経由で store に入る。
//     よって "interview" kind は将来 interview 単独経路が UI に追加されたとき用の予約値で、
//     本実装では使われない(report / DECISIONS に明記)。
//
// 採取内容(dispatch §「採取する内容」):
//  - timestamp / kind / esLabel(form.es_body 冒頭 20 字)
//  - input: その時点の **store / form の実状態**(Canvas が refresh で送る合成 action_history
//    ではなく、ユーザーの素の form + 操作集合 + 派生 ES)
//  - output: 受領した結果オブジェクト全体(= 反映後の analysisResult、指摘・カテゴリ・
//    元/提案・rationale・rationale_source・internal_priority・逆質問・structural_params・
//    企業要約・面接質問を欠落なく持つ)+ 反映後の companySummary
export type CaptureKind = "initial" | "partial" | "refresh" | "interview";

// capture 1 件。output は反映後の analysisResult をそのまま埋め込む(欠落させない)。
export interface CaptureLogEntry {
  timestamp: number;
  kind: CaptureKind;
  // form.es_body の冒頭 20 字程度(どの ES の出力か人が判別するためのラベル)
  esLabel: string;
  // その時点の入力概要 — ユーザーの実状態(form + 操作集合 + 派生 ES)
  input: {
    es_body: string;
    question_text: string;
    char_limit: string;
    company_input_type: CompanyInputType;
    company_url: string;
    company_name: string;
    company_freetext: string;
    preset: EditingPreset;
    free_text: string;
    user_context: string;
    // 操作集合 — partial / refresh で「どんな操作の後の結果か」を再構成するための実状態
    clientEsVersion: number;
    actionHistory: ActionHistoryEntry[];
    acceptedSuggestionIds: string[];
    rejectedSuggestionIds: string[];
    editedSuggestions: Record<string, string>;
    autoCorrectedSuggestionIds: string[];
    clarificationAnswers: ClarificationAnswer[];
    // 派生 ES(採用 / 編集 / 直接編集を適用した「今表示されている ES」)
    derivedEsBody: string;
  };
  // 反映後の結果オブジェクト全体(AnalysisResult / 企業要約)。null は理論上発生しないが
  // 型安全のため許容(append は analysisResult 反映後にのみ呼ぶ)。
  output: {
    analysisResult: AnalysisResult | null;
    companySummary: CompanySummary | null;
  };
}

// module-level の in-memory バッファ。production でも array 自体は存在するが、
// appendCaptureLog が dev gate で push しないため常に空のまま(no-op)。
const captureLog: CaptureLogEntry[] = [];

// 現在の capture ログ snapshot を返す(保存 UI が読む)。配列はコピーして返し、
// 呼び出し側からの破壊的変更を防ぐ。
export function getCaptureLog(): CaptureLogEntry[] {
  return captureLog.slice();
}

// capture ログを空にする(保存後に呼ぶ任意操作。UI からは現状未使用だが API として公開)。
export function clearCaptureLog(): void {
  captureLog.length = 0;
}

// 結果受領 action の末尾から呼ばれる append ヘルパ。
//  - **dev gate**: NODE_ENV !== "development" のときは即 return(production no-op)。
//  - `state` は append 時点(= set 反映後)に呼び出し側が get() した最新 store。
//  - 派生 ES は getDerivedEsBody を最新 state から計算する(関数は本ファイル下部で
//    export 済、hoisting されるため定義順に依存しない)。
function appendCaptureLog(kind: CaptureKind, state: AnalyzeStore): void {
  if (process.env.NODE_ENV !== "development") return;
  const { form, analysisResult } = state;
  const esLabel = form.es_body.slice(0, 20);
  const derivedEsBody = analysisResult
    ? getDerivedEsBody(
        state.currentEsBody,
        analysisResult.suggestions,
        state.acceptedSuggestionIds,
        state.editedSuggestions,
        state.bakedSuggestionIds,
      )
    : state.currentEsBody;
  captureLog.push({
    timestamp: Date.now(),
    kind,
    esLabel,
    input: {
      es_body: form.es_body,
      question_text: form.question_text,
      char_limit: form.char_limit,
      company_input_type: form.company_input_type,
      company_url: form.company_url,
      company_name: form.company_name,
      company_freetext: form.company_freetext,
      preset: form.preset,
      free_text: form.free_text,
      user_context: form.user_context,
      clientEsVersion: state.clientEsVersion,
      actionHistory: state.actionHistory,
      acceptedSuggestionIds: state.acceptedSuggestionIds,
      rejectedSuggestionIds: state.rejectedSuggestionIds,
      editedSuggestions: state.editedSuggestions,
      autoCorrectedSuggestionIds: state.autoCorrectedSuggestionIds,
      clarificationAnswers: state.clarificationAnswers,
      derivedEsBody,
    },
    output: {
      analysisResult,
      companySummary: state.companySummary,
    },
  });
}

// -----------------------------------------------------------------------------
// Store interface
// -----------------------------------------------------------------------------
export interface AnalyzeStore {
  // フォーム入力
  form: FormState;
  setField: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  resetForm: () => void;

  // 進行
  phase: AnalyzePhase;
  // Phase G Step 1: SSE streaming 中の細分化 stage(phase === "analyzing" の間のみ
  // 意味を持つ、それ以外は null)。LoadingDisplay が文言を切り替えるために購読する。
  streamingStage: StreamingStage;
  // research 失敗時のソフトエラー(致命的ではない、分析は続行する)
  researchError: ServerError | null;
  // /api/analyze 致命的エラー
  analyzeError: ServerError | null;

  // 結果
  companySummary: CompanySummary | null;
  analysisResult: AnalysisResult | null;

  // ---------------------------------------------------------------------------
  // Canvas UI 用 state (Phase F Step 1 追加)
  // ---------------------------------------------------------------------------
  // 現在「選択中」(クリックで明示選択)の指摘 ID。null = 何も選択していない。
  // Phase G Step 3a 以前: Popover の controlled open ソース。
  // Phase G Step 3a 以降: SuggestionListPanel と Canvas 両方の強調表示の
  // ソース(border ring + 強アクセント色)、related_suggestion_ids 経由の
  // navigate の到達点(スクロール into view)。
  selectedSuggestionId: string | null;
  // ---------------------------------------------------------------------------
  // Canvas UI 用 state (Phase G Step 3a 追加 2026-05-23)
  // ---------------------------------------------------------------------------
  // 現在「カーソル hover 中」の指摘 ID。null = どこにも hover していない。
  // 双方向ハイライト(リスト ↔ Canvas)のソース。selected と概念が違う:
  //   - selected: クリックで明示、明確な ring + 強アクセント、navigate の到達点
  //   - hovered:  一時的、subtle な強調(背景ライト or border)、カーソルが
  //               離れたら null へ
  // SuggestionListPanel のカードの onMouseEnter/Leave、Canvas の HighlightSpan
  // の onMouseEnter/Leave、両方が同じ store action を叩く。それぞれの component
  // が hoveredSuggestionId === id でハイライトを判定する。
  hoveredSuggestionId: string | null;
  // alternative カテゴリのハイライト表示トグル。
  // 初期値 false(`docs/design_v1.md` §4.4「過剰提案による判断疲労を避ける」)。
  showAlternatives: boolean;

  // ---------------------------------------------------------------------------
  // Canvas UI 用 state (Phase F Step 2 追加)
  // ---------------------------------------------------------------------------
  // 採用済 suggestion ID 集合(順序問わず)。Canvas はこの ID をスキップして
  // ハイライト描画(該当箇所は proposed に置換済のためハイライトとして残す意味なし)。
  // Phase G Step 3b-1 (2026-05-23): 自動修正された error カテゴリの id もここに含む
  // (派生計算は同じ経路で proposed 適用)。autoCorrectedSuggestionIds で別途
  // 「自動 か ユーザー操作 か」を区別する。
  acceptedSuggestionIds: string[];
  // 却下済 suggestion ID 集合。Canvas はこの ID を strikethrough + muted で描画。
  rejectedSuggestionIds: string[];
  // 編集して採用された suggestion の編集後テキスト。Canvas は ID をスキップし、
  // ES 本文生成時に該当 span を編集後テキストで置換。
  editedSuggestions: Record<string, string>;
  // ---------------------------------------------------------------------------
  // Canvas UI 用 state (Phase G Step 3b-1 追加 2026-05-23)
  // ---------------------------------------------------------------------------
  // 自動修正された error カテゴリの suggestion id 集合。
  //
  // 設計判断:
  //  - acceptedSuggestionIds と **両方に含まれる**(派生計算では同じ「採用扱い」)。
  //    別 state にするのは「自動修正 vs ユーザー能動的採用」を UI で区別するため。
  //  - 自動修正は **action_history に記録しない**(LLM の出力結果を action として
  //    記録すると、refresh 時に LLM 自身の指摘が「ユーザーの操作」として送り返される
  //    循環参照になる)。代わりに setAnalysisResult が分析結果から直接 error を
  //    抽出して acceptedSuggestionIds + autoCorrectedSuggestionIds に展開する。
  //  - 個別「元に戻す」(undoAutoCorrection): 通常の「却下」として扱い、
  //    rejectedSuggestionIds に追加 + action_history に REJECTED entry を追加。
  //    これによりユーザーの「自動修正取り消し」も既存の Undo 経路で取り消せる。
  //  - 「全て元に戻す」(undoAllAutoCorrections): 上記を一括で行う。
  //
  // ライフサイクル:
  //  - setAnalysisResult で result.suggestions から error を抽出して初期化
  //  - applyRefreshResult でも再評価(refresh 結果に新規 error があれば自動修正)
  //  - startAnalysis / resetSession で空配列にリセット
  //  - startEditingMode 時に snapshot に保存、cancelEditingMode で復元
  autoCorrectedSuggestionIds: string[];
  // 直接編集モード(contentEditable)。true の間はハイライト一時非表示。
  directEditMode: boolean;
  // 「Canvas に表示する ES 本文」のソース。初期は form.es_body と同じ、
  // 直接編集モードや採用置換で変化していく。Canvas 表示の元データ。
  // 採用済 / 編集済 suggestion の proposed 置換は getDerivedEsBody で算出する派生値。
  currentEsBody: string;
  // 2026-05-28 dogfood round 3 ⑤ 直接編集 bug fix: 「currentEsBody に既に物理的に
  // 焼き込まれた(flatten 済)テキスト採用 / 編集」の suggestion id 集合。
  //
  // 役割:
  //  - 直接編集 ON の瞬間に派生 ES(getDerivedEsBody)を currentEsBody に flatten し、
  //    その時点で適用済だった text 採用 / 編集の id をここに入れる。
  //  - getDerivedEsBody / getDerivedSpans は baked な id を **structural と同様に skip**
  //    する(置換も累積オフセット更新も span 出力もしない)。これにより flatten 後に
  //    採用済を **二重適用しない**(form.es_body 基準 span を flatten 後テキストに当てると
  //    破損するのを防ぐ)。
  //  - status 表示(SuggestionCard の「採用済」)は acceptedSuggestionIds を読むため維持される
  //    (baked かどうかは表示に影響しない、派生計算のみに効く)。
  //
  // 設計判断: structural 採用が currentEsBody に焼き込まれて getDerivedEsBody から
  //  category === "structural" continue で除外されるのと同じ機構を、直接編集 flatten 時の
  //  text 採用にも適用する localized「baked set」方式。詳細は DECISIONS
  //  `[2026-05-28] 直接編集 派生 ES bug fix 実装結果` 参照。
  bakedSuggestionIds: string[];
  // 2026-05-28 dogfood round 3 ⑤: 直接編集 ON 〜 OFF 間に保持する transient snapshot。
  //  - ON で { snapshot: 編集前 state 一式, baselineBody: flatten 直後の派生 ES } を set。
  //  - OFF で baselineBody と currentEsBody を比較して「実際に編集したか」を判定:
  //    * 変化なし → flatten を巻き戻して null に戻す(DIRECT_EDIT entry を作らない)
  //    * 変化あり → DIRECT_EDIT entry に before/after snapshot を載せて null に戻す
  // session reset / 編集モード遷移で null。actionHistory には載らない揮発的 state。
  directEditPending: {
    snapshot: DirectEditStateSnapshot;
    baselineBody: string;
  } | null;
  // 操作履歴。Phase G の /api/analyze refresh で送る配列。
  // schema は lib/schema/input.ts:ActionHistoryEntrySchema(verb 判別ユニオン)に準拠。
  actionHistory: ActionHistoryEntry[];
  // 2026-05-25: UI 用の rich 操作ログ(actionHistory と並行、1:1 同期)。
  // 履歴 review / revert UI(右パネル「履歴」タブ + 個別カードの revert ボタン)で参照。
  // 詳細は ActionLogEntry の JSDoc 参照。
  actionLog: ActionLogEntry[];
  // 2026-05-25: actionLog 用 redo stack(redoStack: ActionHistoryEntry[] と並行)。
  // undo で actionLog から pop した entry をここに保存、redo で再 push する。
  // 新規操作で redoStack と一緒に clear される。
  redoLogStack: ActionLogEntry[];

  // ---------------------------------------------------------------------------
  // 楽観的並行制御 (Phase G Step 2 追加 2026-05-23)
  // ---------------------------------------------------------------------------
  // 設計の骨格(`docs/design_v1.md` §4.3 §5.1 + `docs/decisions_so_far.md`):
  //  - `clientEsVersion` がクライアント側で監視する「ES の現状バージョン」。
  //    操作のたびに increment。initial 分析完了時に 0 にリセット(setAnalysisResult)。
  //  - `inflightRefreshVersion` は「今 fetching 中の refresh が、どのバージョンを基準に
  //    リクエストしたか」を覚える(基準 = current_es_version)。応答の `es_state_version` が
  //    `inflightRefreshVersion + 1` と一致しなければ「古い基準で投げた refresh」として破棄。
  //  - `refreshAbortController` は前の refresh の AbortController。新規発火時に abort()。
  //  - `refreshPhase` は refresh の進行ラベル(idle / loading / error)。
  //  - `refreshError` は refresh 致命的エラー(ServerError 形)。
  //  - `refreshStreamingStage` は SSE 進行の細分化ラベル(initial と同じ StreamingStage 型)。
  //
  // 操作の increment タイミング(decisions_so_far.md の「動的 HITL 実装方針」と整合):
  //  - acceptSuggestion / editSuggestion / rejectSuggestion: 操作で 1 つの「採用 / 編集 /
  //    却下」が確定 → ES 派生表示が変わる → version 進める
  //  - toggleDirectEdit(ON → OFF で hasChange あり): 直接編集が DIRECT_EDIT entry として
  //    記録される瞬間に version 進める(編集中の typing では進めない、SSOT は action_history
  //    の発生時点)
  //  - undoLastAction: 直前 1 ステップを取り消す = ES が以前の状態に戻る → version 進める
  //    (元に戻ったが、サーバから見ると「履歴に新たな差分が積まれた」状態として扱う方が
  //    refresh 発火の整合が取りやすい)
  clientEsVersion: number;
  inflightRefreshVersion: number | null;
  refreshAbortController: AbortController | null;
  refreshPhase: RefreshPhase;
  refreshError: ServerError | null;
  refreshStreamingStage: StreamingStage;
  // UX 改修 3b (2026-05-23): 進行中(または直前)の refresh の目的フラグ。
  //   - "balanced":      通常の再分析(既存挙動)
  //   - "reduce_length": 文字数削減モード
  // beginRefresh の引数で渡し、refresh 完了 / abort / error 終端まで保持する。
  // RefreshProgressBanner はこの値で文言を切り替える(削減モード時は「文字数を
  // 抑える提案を生成しています」)。
  analyzeGoal: AnalyzeGoal;

  // ---------------------------------------------------------------------------
  // 即時 partial refresh trigger + redoStack + 競合通知 (Phase G 修正 2026-05-23)
  // ---------------------------------------------------------------------------
  // 即時 partial refresh trigger:
  //  - 採用 / 編集 / 却下 / 直接編集 OFF(差分あり) / Undo / Redo / 自動修正取り消し
  //    のたびに `partialRefreshTrigger` を **同期的に +1**(デバウンスなし)。
  //  - typing 中(updateEsBody)は trigger を立てない(direct edit OFF で 1 回まとめる)。
  //  - Canvas が trigger を購読し、useEffect 内で handleRefresh("balanced") を発火。
  //  - 「自動 refresh デバウンス」は本フェーズで完全撤去(DECISIONS 2026-05-23 §1
  //    「採用 / 編集 / 却下 / Undo / Redo のたびに **即座に** Sonnet 呼び出し」と整合)。
  //  - HITL 主体性は「逐次 1 件生成」+「pool 枯渇時に added = []」で表現する(自動更新
  //    ON/OFF Switch は不要、提案は常に「次の 1 件だけ」に絞られるため)。
  //
  // redo stack: 任意ステップ遡行を許容(undoLastAction の単発から、undo(steps) / redo(steps) へ)。
  //  - undoStack は既存 actionHistory を再利用(別 state を立てない、後方互換)
  //  - redoStack は undo で退避された entry を一時保持。新規操作で clear(慣例)。
  //
  // 競合通知: silent discard を廃止し、ユーザーが選べる経路を用意。詳細は ConflictNotification 型。
  // Phase G 修正: 即時 partial refresh トリガーカウンタ(setTimeout なし、同期 +1)。
  partialRefreshTrigger: number;
  // 統合改修パッケージ (2026-05-25): 動的 HITL の影響範囲 seed 群。
  //  - rejectSuggestion / editSuggestion / direct edit OFF(差分あり)が値を set
  //  - 全体再分析(triggerFullRefresh)が kind: "full" を set(部分 refresh モードを無効化)
  //  - 統合改修パッケージ訂正 (2026-05-25): Canvas は partialRefreshTrigger 観測時に
  //    本 field の seed 情報を partial bundle にそのまま渡す(構造計算なし、AI 判断方式)
  //  - acceptSuggestion / undo / redo 等は本 field を変更しない(scope を維持)
  //
  // 設計判断:
  //  - reject = seed = この id 1 件、edit = seed = この id 1 件
  //  - direct edit = seed = なし(編集前後テキストを保持して LLM が意味的に判断)
  //  - 「再分析」ボタン = kind: "full" で全体再分析(refresh stream 経路)
  //  - 値は最新の trigger 発火時の seed のみ保持(累積しない、新規操作で上書き)
  pendingRefreshScope: PendingRefreshScope | null;
  // 統合改修パッケージ (2026-05-25): 意味的差分判定の queue。
  //  - editSuggestion / toggleDirectEdit OFF(差分あり)が enqueue する
  //  - Canvas が effect で取り出して /api/semantic-diff → 結果が「異なる」なら requestPartialRefresh
  //  - 順序を保ったまま 1 件ずつ消化(FIFO)。複数操作の処理を直列化する。
  //  - 通常は 0-1 件、ユーザーが急いで連続操作すると 2-3 件に膨らむ可能性あり
  semanticDiffQueue: SemanticDiffPendingEntry[];

  // ---------------------------------------------------------------------------
  // Partial refresh の loading / animation UX (2026-05-25 Task #18)
  // ---------------------------------------------------------------------------
  // partial refresh stream の段階的可視化用 state。AI 応答の遅延中に「何が変わるか」を
  // ユーザーが追えるようにするための UX 層。LLM 経路 (applyPartialResult の merge) は
  // 既存のまま、UI が読み取って表示する派生情報を 4 つ追加する:
  //
  //  - partialRefreshInProgress: partial refresh stream が走っている間 true。
  //    beginRefresh + scope.kind === "scoped" で立て、applyPartialResult / abort /
  //    setRefreshError で false に戻す。Canvas が global banner「AI が関連指摘を再評価
  //    しています」を出す condition。
  //  - partialRefreshSeedIds: stream 中に「見直し対象として AI に投げた」suggestion id 群。
  //    pendingRefreshScope.seedIds のコピー(scope 自体は version 整合で他の経路でも
  //    使われるため、seed の loading 表示用に別 field を立てる)。stream 完了で空配列に戻す。
  //  - pendingDeletedSuggestionIds: applyPartialResult 受信時に deleted と判明した
  //    suggestion id 群。**即座に suggestions から消さず**、ここに保持して 1.5 秒の
  //    fade out animation 後にまとめて suggestions から除外する(commitPartialRefreshCleanup
  //    が削除を確定)。ユーザーが「なぜ消えたか」を理解する時間を確保する設計。
  //  - recentlyAddedSuggestionIds / recentlyUpdatedSuggestionIds: applyPartialResult で
  //    新規 / 更新と判明した suggestion id 群。0.5 秒の fade in / highlight animation 用に
  //    UI が読み取る。commitPartialRefreshCleanup でクリア。
  //
  // 設計判断:
  //  - 「partial refresh 中の毎指摘 dim」は不採用 — overkill / 視覚 noise(DECISIONS 参照)
  //  - 「AI streaming で 1 件ずつ apply」は v2 候補(SSE 化が必要、現状の SSE は完了通知のみ)
  //  - 既存 applyPartialResult の merge ロジックは破壊しない方針 — deleted は merge 時に
  //    suggestions から除外せず、別 field に控える形に変更(commitPartialRefreshCleanup
  //    が後追いで suggestions を更新)。recentlyAdded / Updated は新規追加 field なので
  //    既存挙動には影響しない。
  //
  // Inviolable constraints:
  //  - 数値スコア禁止: animation / loading は文字列 + アイコンのみ、スコア数値は出さない
  //  - すべての操作は Undo 可能: fade out 中も Undo / 履歴 revert で取り戻せる
  //  - 楽観的並行制御: animation 中もユーザーは新しい操作可、衝突は既存の競合通知で扱う
  partialRefreshInProgress: boolean;
  partialRefreshSeedIds: string[];
  pendingDeletedSuggestionIds: string[];
  recentlyAddedSuggestionIds: string[];
  recentlyUpdatedSuggestionIds: string[];
  // ---------------------------------------------------------------------------
  // partialRefreshGeneration (2026-05-28 並行性 fix C8)
  // ---------------------------------------------------------------------------
  // 「どの世代の refresh か」を識別する単調増加カウンタ。beginRefresh が呼ばれるたび +1。
  // applyPartialResult 後に Canvas が仕掛ける 1.5 秒遅延 cleanup timer が、後続の partial
  // refresh が立てた animation flags / pendingDeleted を誤って消す競合(C8)を防ぐ:
  //   - 旧: timer は引数なしで「現在の state」を消すため、partial A の遅延 cleanup が
  //     1.5 秒以内に完了した後続 partial B の flags を巻き込んで消しうる。
  //   - 新: timer のクロージャに beginRefresh が返した generation を焼き、cleanup 実行時に
  //     現在 generation と一致するときだけ実行(不一致 = より新しい refresh が始まっている
  //     = no-op)。
  // 値の意味は世代比較のみ。UI に数値を出さない(内部 state)。
  partialRefreshGeneration: number;
  // ---------------------------------------------------------------------------
  // reEvaluatingSuggestionIds (2026-05-28 dogfood round 3 ②④)
  // ---------------------------------------------------------------------------
  // 「採用 / 拒否 / 編集の操作に伴って再評価で変わりそうな指摘」の id 群を、AI 応答前
  // (in-flight)から予測して保持する UI 専用 state。schema / prompt / tool 経路には
  // 一切流さない(AGENTS.md「Load-bearing field names: 追加は可」の範囲、load-bearing
  // でない内部命名)。
  //
  //  - 値: scoped partial refresh の seed 群 + 各 seed の `related_suggestion_ids`
  //    (`analysisResult.suggestions` から lookup)の union。
  //  - set: acceptSuggestion(accept_with_related 経路)/ rejectSuggestion /
  //    editSuggestion が scoped refresh を要求する時点で算出。
  //  - clear: commitPartialRefreshCleanup / finishRefresh / setRefreshError /
  //    refresh abort / startAnalysis / resetSession / 編集モード遷移(refresh が終わる
  //    / セッションが変わる全経路)。
  //
  // 用途は 2 つ:
  //  ② skip: pickNextPendingSuggestionId の excludeIds に渡し、再評価中の指摘を次の
  //     自動選択から外す(変わる前のものを見せて考えさせない)。
  //  ④ badge: SuggestionCard が `id ∈ reEvaluatingSuggestionIds && partialRefreshInProgress`
  //     のとき「再評価中…」を表示。応答後は partialRefreshInProgress が false 化して
  //     badge が消え、既存の recentlyUpdatedSuggestionIds(fade animation)に引き継ぐ
  //     (二重表示回避: partialRefreshInProgress が dual-display guard)。
  //
  // client-side 予測の限界(ユーザー開示済 / DECISIONS 記録済): どの指摘が再評価で
  // 変わるかは AI 応答まで完全には不明(影響範囲を AI に判断させる設計)。client で予測
  // できるのは「操作した指摘の related_suggestion_ids」のみ。related に宣言されない変化は
  // 応答後の recentlyUpdatedSuggestionIds で反映する(既存経路)。予測できるものだけ
  // 控えめに mark する方針(ユーザー要望「されていないならそのままでいい」)。
  reEvaluatingSuggestionIds: string[];
  // Phase G Step 3b-3: undo した entry を保持する stack。新規操作で clear。
  redoStack: ActionHistoryEntry[];
  // Phase G Step 3b-3: 競合通知(silent discard 廃止)。1 つだけ保持(新規発生で上書き)。
  conflictNotification: ConflictNotification | null;

  // ---------------------------------------------------------------------------
  // v2 dogfood UX 改善 Task C (2026-05-26): partial refresh 完了通知 toast 用 state
  // ---------------------------------------------------------------------------
  // partial refresh が正常に完了した時刻(Date.now() の timestamp)を保持。
  // RefreshCompletionToast component がこの値を購読し、null 以外なら 3 秒間
  // 「指摘が更新されました」toast を表示する。3 秒後に clearRefreshCompletedAt()
  // で null に戻す。
  //
  // 設計判断:
  //  - number(timestamp)で「同 refresh の重複表示防止 + 連続 refresh で再表示」両立。
  //    boolean だと連続 refresh の 2 回目が「既に true」のままで useEffect が再発火しない。
  //    timestamp は毎回新しい値になるため useEffect dependency として確実に動く。
  //  - applyPartialResult の **成功 return 経路でのみ** set される。version mismatch
  //    (conflictNotification 経路)では立てない、また applyRefreshResult(全分析経路)
  //    でも立てない(全分析完了は AnalyzingOverlay の終了で十分通知済、dispatch §「注意事項」)。
  //  - reset 系(startAnalysis / resetSession)で null に戻す。
  refreshCompletedAt: number | null;

  // ---------------------------------------------------------------------------
  // エージェント的対話(AI 逆質問) (2026-05-27)
  // ---------------------------------------------------------------------------
  // AI が分析時 / partial refresh 時に出した clarification_questions に対する
  // ユーザー回答の集合。session 内のみ保持(localStorage 不使用、AGENTS.md
  // 「localStorage / DB / 認証は v1 スコープ外」)。
  //
  // 同 session 中、ES 編集中はずっと保持される。partial refresh 経路で
  // suggestions が入れ替わって対応 question_id が消えた場合、applyPartialResult /
  // applyRefreshResult / applyConflictNewVersion で「消えた question_id への回答」を
  // filter で除去する(デッドリンク回答が enriched_intent に残ると LLM 混乱)。
  //
  // 設計判断:
  //  - load-bearing でない命名(`clarificationAnswers`)で内部命名、LLM 出力構造には影響なし
  //  - 各 entry は question_id でユニーク(同 question_id への複数回答は最新で上書き、
  //    updateClarificationAnswer で処理)
  //  - reset 系(startAnalysis / resetSession / startEditingMode / cancelEditingMode)
  //    で空配列に戻す(編集 snapshot にも保存しない、session 単位の揮発状態)
  clarificationAnswers: ClarificationAnswer[];

  // ---------------------------------------------------------------------------
  // 右パネル アクティブタブ (Task #32a, 2026-05-25)
  // ---------------------------------------------------------------------------
  // `RightPanel` の 4 タブ(指摘 / 企業要約 / 面接質問 / 履歴)の現在表示中タブ ID。
  // 旧設計(RightPanel.tsx 内 useState + derived 強制上書き)を store に格上げし、
  // タブクリック bug を構造解消する。詳細は本ファイル上部の `TabValue` 型 JSDoc 参照。
  activeTab: TabValue;

  // ---------------------------------------------------------------------------
  // 編集モードのスナップショット (UX 改修 1b 追加 2026-05-23)
  // ---------------------------------------------------------------------------
  // InputSummaryBar の「編集する」を押した瞬間に form と分析結果 / Canvas 状態を
  // 退避する。「戻る」を押したらこのスナップショットから完全 restore する。
  //
  // null = 編集モードではない(通常の idle / done 状態)
  // 値あり = 編集モード(form 編集中、戻るで restore できる)
  //
  // フィールド:
  //  - form: 編集前の form 値(キャンセル時に restore)
  //  - analysisResult / companySummary / researchError: 結果一式
  //  - Step 2 state: 採用 / 却下 / 編集マップ / 直接編集 / currentEsBody /
  //    actionHistory のすべて(完全な session 状態を保持)
  //
  // 編集モードの開始 / 終了 / キャンセルは startEditingMode / cancelEditingMode
  // で管理(下記 actions)。
  editingSnapshot: EditingSnapshot | null;

  // アクション(分析セッション全体の制御)
  startAnalysis: () => void;
  setResearching: () => void;
  setAnalyzing: () => void;
  setCompanySummary: (summary: CompanySummary) => void;
  setAnalysisResult: (result: AnalysisResult) => void;
  setResearchError: (err: ServerError) => void;
  setAnalyzeError: (err: ServerError) => void;
  // Phase G Step 1: streaming stage 更新(InputForm の SSE 受信ループから呼ばれる)
  setStreamingStage: (stage: StreamingStage) => void;
  resetSession: () => void;

  // Canvas UI 用 actions (Phase F Step 1 追加)
  selectSuggestion: (id: string | null) => void;
  // Phase G Step 3a (2026-05-23): hover 連動の単一エントリ。
  // SuggestionListPanel のカードと Canvas の HighlightSpan の両方から呼ばれる。
  // 同じ id を立てれば双方向の強調が同期する(片方が hover 中、他方が visual な
  // 連動を見せる)。null は hover 解除。
  setHoveredSuggestion: (id: string | null) => void;
  toggleAlternatives: () => void;
  setShowAlternatives: (show: boolean) => void;
  // Task #32a (2026-05-25): 右パネルのアクティブタブを変更する。
  // 呼び出し側:
  //   - RightPanel.tsx の `<Tabs onValueChange>`(ユーザー手動切替)
  //   - Canvas.tsx の `HighlightSpan` / `AutoCorrectedSpan` onClick
  //     (明示動線で指摘タブに強制移動、ユーザーが ES 上のハイライトを
  //     クリックして指摘詳細を確認したい意図に整合)
  //   - SuggestionDetailPanel.tsx の完了画面「履歴を見る」ボタン
  //     (`onRequestHistoryTab` の置き換えにも使用可能)
  setActiveTab: (tab: TabValue) => void;

  // ---------------------------------------------------------------------------
  // Canvas UI 用 actions (Phase F Step 2 追加)
  // ---------------------------------------------------------------------------
  // 採用 / 却下 / 編集して採用 — 各々 actionHistory に entry を append し、
  // 該当 ID 集合・編集マップに反映する。Canvas はこれらの state から
  // ハイライト描画と ES 本文派生を行う。
  acceptSuggestion: (suggestion: AcceptSuggestionInput) => void;
  rejectSuggestion: (suggestion: RejectSuggestionInput) => void;
  editSuggestion: (suggestion: EditSuggestionInput) => void;
  // 直接編集モードのトグル / ES 本文の更新。
  // toggleDirectEdit(false → true)では何もしない(編集開始)。
  // toggleDirectEdit(true → false)では directEditCommit を呼んだ後と同等
  //   = currentEsBody が以前と異なれば actionHistory に DIRECT_EDIT entry を append。
  // updateEsBody は contentEditable の input 中に呼ばれるストア更新(history は append しない)。
  toggleDirectEdit: () => void;
  updateEsBody: (newBody: string) => void;
  // 直前の actionHistory entry を 1 つ取り消す。
  // Phase G Step 3b-3 (2026-05-23): 内部で undo(1) を呼ぶ薄いラッパに変更(後方互換)。
  undoLastAction: () => void;

  // ---------------------------------------------------------------------------
  // Canvas UI 用 actions (Phase G Step 3b-3 追加 2026-05-23)
  // ---------------------------------------------------------------------------
  // 任意ステップの遡行(steps 件を一気に pop して redoStack に push、state を巻き戻し)。
  // steps 省略時は 1。actionHistory が空 or steps <= 0 のときは no-op。
  // 既存 undoLastAction の挙動を保証するため、内部の per-entry revert ロジックは
  // 既存 undoLastAction と完全に同じ規律で動く(REJECTED の「元 auto」復元判定含む)。
  // 各 entry を巻き戻すたびに clientEsVersion を +1(履歴の追加 = 1 回の操作の規律)、
  // ただし複数 step 一括の場合も合計 +1 とする(1 ユーザー操作 = 1 version の規律)。
  undo: (steps?: number) => void;
  // 任意ステップの再適用。redoStack の末尾から steps 件を pop して actionHistory に push、
  // state を再適用する。redoStack が空 or steps <= 0 のときは no-op。
  // 新規操作(acceptSuggestion 等)で redoStack は clear される慣例のため、redo は
  // 「Undo の直後にだけ可能」な揮発的な操作。
  redo: (steps?: number) => void;

  // ---------------------------------------------------------------------------
  // 履歴 review / revert (2026-05-25 追加)
  // ---------------------------------------------------------------------------
  // 任意の suggestion の現在 status を pending に戻す。per-card revert ボタン + 履歴タブの
  // 「この操作を取り消す」両方が呼ぶ共通エントリ。
  //
  // 規律:
  //  - 該当 suggestion を acceptedSuggestionIds / rejectedSuggestionIds / editedSuggestions /
  //    autoCorrectedSuggestionIds から全て除外
  //  - actionHistory に PENDING entry を append(LLM が「ユーザーが過去の判断を取り消した」
  //    と読める形)
  //  - actionLog に type: "reverted" entry を append、`revertedFromEntryId` で履歴 entry を
  //    指す(history panel で「この操作は取り消された」表示の判定用、対象 entry の
  //    `isOutdated` を true に立てる)
  //  - clientEsVersion +1(refresh 整合)
  //  - 影響範囲限定 partial refresh を発火(scoped、seed = この id、reason = "manual")
  //
  // 引数:
  //  - suggestion_id: 対象 suggestion
  //  - revertedFromEntryId: 取り消し元の actionLog entry id(history panel から呼ぶ時)。
  //    per-card revert からは undefined(「最新の status を pending に戻す」意図)。
  revertSuggestionAction: (input: {
    suggestion_id: string;
    suggestion_summary: string;
    revertedFromEntryId?: string;
  }) => void;

  // ---------------------------------------------------------------------------
  // 動的 HITL refresh trigger actions (統合改修パッケージ 2026-05-25)
  // ---------------------------------------------------------------------------
  // 統合改修パッケージで動的 HITL を完全設計化したことに伴い、各 action 経路が partial refresh を
  // 発火する方法を以下のように整理:
  //   - acceptSuggestion:    trigger を立てない(採用 = AI と一致、refresh skip)
  //   - rejectSuggestion:    requestPartialRefresh({ kind: "scoped", seedIds: [id], reason: "reject" }) を内部で呼ぶ
  //   - editSuggestion:      Canvas で judgeSemanticDiff を経由した後、Canvas が requestPartialRefresh を呼ぶ
  //   - toggleDirectEdit:    OFF + 差分あり時、Canvas が judgeSemanticDiff を経由してから requestPartialRefresh を呼ぶ
  //   - undo / redo:         requestPartialRefresh({ kind: "scoped", seedIds: [], reason: "undo/redo" }) を内部で呼ぶ
  //   - 「再分析」ボタン:     triggerFullRefresh() を呼ぶ(影響範囲 = full、refresh stream 経路)
  //
  // 既存の partialRefreshTrigger は維持(後方互換)。新規 action `requestPartialRefresh` /
  // `triggerFullRefresh` は内部で partialRefreshTrigger +1 + pendingRefreshScope を set する。
  // Canvas は partialRefreshTrigger 観測時に pendingRefreshScope を読んで分岐する。

  // requestPartialRefresh: scoped partial refresh を要求(seedIds は seed 群)。
  //  - reason は log / debug 用(scope の起点を明示)
  //  - 内部で partialRefreshTrigger +1 + pendingRefreshScope を set
  //  - Canvas が trigger 観測 → pendingRefreshScope を読む → computeRefreshScope → partial bundle
  requestPartialRefresh: (scope: PendingRefreshScope) => void;

  // triggerFullRefresh: 全体再分析を要求(「再分析」ボタン用、保険経路)。
  //  - 内部で partialRefreshTrigger +1 + pendingRefreshScope = { kind: "full", seedIds: [], reason: "manual" }
  //  - Canvas が trigger 観測 → kind === "full" を見て buildRefreshBundle(refresh stream 経路)を選ぶ
  //  - 「再分析」ボタン以外ではこの action を呼ばない(action_history の蓄積を温存する整合)
  triggerFullRefresh: () => void;

  // enqueueSemanticDiff: 意味的差分判定の queue に 1 entry を push。
  //  - editSuggestion / toggleDirectEdit(OFF 差分あり)が呼ぶ
  //  - Canvas が semanticDiffQueue を購読 → 先頭を取り出して /api/semantic-diff を呼ぶ
  enqueueSemanticDiff: (entry: SemanticDiffPendingEntry) => void;

  // dequeueSemanticDiff: 意味的差分判定の queue の先頭 1 件を取り出す(consume)。
  //  - Canvas が /api/semantic-diff の呼び出し前にこの action を呼んで 1 件を consume
  //  - 返り値は consume した entry(空なら undefined を返す)
  dequeueSemanticDiff: () => SemanticDiffPendingEntry | undefined;

  // ---------------------------------------------------------------------------
  // 即時 partial refresh trigger (Phase G 修正 2026-05-23)
  // ---------------------------------------------------------------------------
  // partialRefreshTrigger は store action 内で同期的に +1 される(action 関数の中で
  // `state.partialRefreshTrigger + 1` をそのまま set)。setTimeout / デバウンスは
  // 介在せず、Canvas が trigger 値の変化を useEffect で観測した時点で即座に
  // handleRefresh を発火する。
  //
  // 設計判断:
  //  - store からは fetch を呼ばない(SSOT は Canvas)。trigger カウンタ +1 のみ。
  //  - Canvas が `useEffect(() => fire(), [partialRefreshTrigger])` で 1 度だけ fire。
  //  - 既存 ref(lastFiredTriggerRef)で「同じ trigger 値での重複発火」を防ぐ規律を維持。
  //
  // この field は前段の `partialRefreshTrigger: number` で宣言済(actions 配列としては不要)。

  // ---------------------------------------------------------------------------
  // 競合通知 actions (Phase G Step 3b-3 追加 2026-05-23)
  // ---------------------------------------------------------------------------
  // setConflictNotification: applyPartialResult / applyRefreshResult が version 不一致を
  //   検知した時に呼ばれる(silent discard の代わり)。1 つだけ保持(新規発生で上書き)。
  setConflictNotification: (notification: ConflictNotification) => void;
  // dismissConflict: 「破棄」または「現在の選択を維持」で呼ぶ(silent discard と同じ動作)。
  dismissConflict: () => void;
  // applyConflictNewVersion: 「新版を採用」で呼ぶ。conflictNotification.newResult を
  //   強制適用(version 整合チェックをスキップして merge を実行)。
  applyConflictNewVersion: () => void;

  // ---------------------------------------------------------------------------
  // v2 dogfood UX 改善 Task C (2026-05-26): partial refresh 完了 toast 操作
  // ---------------------------------------------------------------------------
  // clearRefreshCompletedAt: RefreshCompletionToast の 3 秒タイマー満了時に呼ぶ。
  //   refreshCompletedAt を null に戻し、toast を画面から消す。
  clearRefreshCompletedAt: () => void;

  // ---------------------------------------------------------------------------
  // Canvas UI 用 actions (Phase G Step 3b-1 追加 2026-05-23)
  // ---------------------------------------------------------------------------
  // 個別「元に戻す」 — 自動修正された error 1 件をユーザーが意図的に却下する。
  //  - autoCorrectedSuggestionIds と acceptedSuggestionIds から該当 id を削除
  //  - rejectedSuggestionIds に追加(却下扱いで派生 ES の置換は外れる)
  //  - action_history に REJECTED entry を追加(通常の却下操作と同じ形)
  //  - clientEsVersion +1(refresh 整合性の規律維持)
  undoAutoCorrection: (input: {
    suggestion_id: string;
    suggestion_summary: string;
  }) => void;
  // 「全て元に戻す」 — 現在の autoCorrectedSuggestionIds をすべて一括で却下に切替。
  //  - 内部的に各 id に対して undoAutoCorrection と同じ処理を行う(action_history も
  //    1 件ずつ REJECTED entry を append)
  //  - clientEsVersion は最終的に +N(N = 一括取り消し件数)とせず、ひとまとめに +1。
  //    1 回のユーザー操作 = 1 version の規律(refresh 整合性のため)。
  undoAllAutoCorrections: (
    inputs: ReadonlyArray<{
      suggestion_id: string;
      suggestion_summary: string;
    }>,
  ) => void;

  // ---------------------------------------------------------------------------
  // 楽観的並行制御 actions (Phase G Step 2 追加 2026-05-23)
  // ---------------------------------------------------------------------------
  // beginRefresh: 新規 refresh 発火の準備。前の AbortController があれば abort、
  //               新規 AbortController を生成、inflightRefreshVersion を立てて返す。
  //               呼び出し側(Canvas の「再分析する」 click handler)は戻り値の
  //               { abortController, baseVersion } を使って fetch を投げる。
  //               UX 改修 3b: options.goal で削減モードを指定可能(省略時 "balanced")。
  // setRefreshStreamingStage: SSE 受信ループから細分化進捗を更新(initial の
  //               setStreamingStage と対称、別 state)。
  // applyRefreshResult: SSE が completed event を受けたら呼ぶ。サーバの es_state_version が
  //               inflightRefreshVersion + 1 と一致するなら採用、そうでなければ破棄。
  //               採用時は analysisResult を更新、interview_questions.is_stale を true に
  //               明示(refresh では再生成しないため)。
  // setRefreshError: 致命的 refresh エラー(LLMError 系等)を記録、refreshPhase = "error"。
  //               「古い応答を破棄した」のは setRefreshError ではない(silent discard、
  //               UI に出さない)— 設計判断 G2.6 と整合。
  // finishRefresh: refresh の終端処理(成功 / 失敗 / abort いずれの経路でも呼ぶ、
  //               refreshAbortController / inflightRefreshVersion を null に戻す)。
  beginRefresh: (options?: { goal?: AnalyzeGoal }) => {
    abortController: AbortController;
    baseVersion: number;
    goal: AnalyzeGoal;
    // 2026-05-28 並行性 fix C8: この refresh の世代 id。Canvas が partial cleanup timer の
    // クロージャに焼いて commitPartialRefreshCleanup(generation) に渡す。
    generation: number;
  };
  setRefreshStreamingStage: (stage: StreamingStage) => void;
  applyRefreshResult: (result: AnalysisResult) => void;
  // Phase G Step 3b-2 (2026-05-23): partial 結果を既存 analysisResult にマージ。
  // 楽観的並行制御の version 整合は applyRefreshResult と同じ規律。merge ロジックは
  // updated/deleted/added 経路で既存 suggestions セットを更新する。
  // 2026-05-25 Task #18: partialRefreshInProgress == true の場合は deleted を即除外せず
  // pendingDeletedSuggestionIds に控える(fade out animation 用)。
  applyPartialResult: (result: PartialAnalysisResult) => void;
  setRefreshError: (err: ServerError) => void;
  finishRefresh: () => void;
  // 2026-05-25 Task #18: partial refresh stream の begin / cleanup。
  //  - beginPartialRefresh: Canvas が partial 経路を選んだ時に呼ぶ。partialRefreshInProgress を
  //    true に立て、seedIds を partialRefreshSeedIds にコピーする(UI が seed loading 表示用)。
  //  - commitPartialRefreshCleanup: applyPartialResult 受信後 1.5 秒で呼ぶ。pendingDeleted を
  //    suggestions から実際に除外 + recently flags をクリア。fade out / fade in animation が
  //    visual に終わった時点で UI の状態を最終 set に揃える。
  beginPartialRefresh: (seedIds: string[]) => void;
  // 2026-05-28 並行性 fix C8: generation 引数で世代ガード。beginRefresh が返した generation を
  // 渡し、現在 generation と一致する(= この cleanup を仕掛けた refresh が最新)ときだけ実行。
  commitPartialRefreshCleanup: (generation: number) => void;
  // 2026-05-28 dogfood round 3 ②④: reEvaluatingSuggestionIds を空配列に戻す。
  //   主に編集して採用 → semantic-diff が「同じ」と判定して refresh を skip した経路で、
  //   Canvas が予測 mark を取り消すために呼ぶ(lingering 防止)。lifecycle の他の clear 点
  //   (commitPartialRefreshCleanup / finishRefresh / setRefreshError / startAnalysis /
  //   resetSession / 編集モード遷移)は各 set() 内で inline にクリアする。
  clearReEvaluating: () => void;

  // ---------------------------------------------------------------------------
  // エージェント的対話(AI 逆質問)actions (2026-05-27)
  // ---------------------------------------------------------------------------
  // updateClarificationAnswer: 回答 textarea の onChange(debounce 推奨)で呼ぶ。
  //   既存 entry あれば更新、なければ追加。空文字の場合は当該 entry を除去
  //   (textarea を空にした時の clean-up と統一動作)。
  updateClarificationAnswer: (args: {
    question_id: string;
    suggestion_id?: string;
    scope: "suggestion" | "global";
    answer_text: string;
  }) => void;
  // clearClarificationAnswer: 個別削除(明示クリア用、textarea 空にする以外の経路)。
  // 2026-05-29: question_id 単独では集約リスト全体で一意でない(suggestion ごとに q_001
  // から振られる)ため、複合キー(scope + suggestion_id + question_id)で照合する。
  clearClarificationAnswer: (args: {
    question_id: string;
    suggestion_id?: string;
    scope: "suggestion" | "global";
  }) => void;
  // triggerReanalysisWithClarifications: 「この回答で再分析」ボタンの実体。
  //   clarificationAnswers の text を「[逆質問への回答]\nQ: …\nA: …」形式で組み立て、
  //   ActionLogEntry に "clarification_answered" を per-answer push してから、
  //   既存 partial refresh 経路に scope=manual で投入する。enriched_intent は
  //   bundle build 時に user_context に append される(buildPartialBundle 経路)。
  //   回答済 question_id がない場合は no-op(UI 側 disable と二重ガード)。
  triggerReanalysisWithClarifications: () => void;

  // ---------------------------------------------------------------------------
  // 編集モード用 actions (UX 改修 1b 追加 2026-05-23)
  // ---------------------------------------------------------------------------
  // 編集モード開始: 現在の form / 分析結果 / Canvas 状態を一括 snapshot した上で
  // session を idle に戻す(InputForm が再表示される)。
  startEditingMode: () => void;
  // 編集キャンセル: snapshot から完全 restore(form / 結果 / Canvas 状態すべて
  // 編集前に戻る、session は done に復帰、action_history も保持)。
  cancelEditingMode: () => void;
}

// -----------------------------------------------------------------------------
// アクション入力型
// -----------------------------------------------------------------------------
// schema の ACCEPTED / REJECTED / EDITED 形に直接対応する最小フィールド。
// call site(SuggestionCard)が Suggestion から組み立てる。
// 採用 / 編集の ES 本文置換は getDerivedEsBody が AnalysisResult.suggestions から
// 復元するため、action 入力に original_span / original / proposed を持たない。
export interface AcceptSuggestionInput {
  suggestion_id: string;
  suggestion_summary: string;
}
export interface RejectSuggestionInput {
  suggestion_id: string;
  suggestion_summary: string;
}
export interface EditSuggestionInput {
  suggestion_id: string;
  suggestion_summary: string;
  edited_text: string;
}

// 統合改修パッケージ (2026-05-25): 動的 HITL の意味的差分判定 queue 1 entry。
//  - editSuggestion / toggleDirectEdit OFF(差分あり)が enqueue する
//  - Canvas が effect で 1 件ずつ取り出して /api/semantic-diff を呼び、結果に応じて
//    requestPartialRefresh を発火する
//  - reason は seed の起点を明示(log + debug 用)
export interface SemanticDiffPendingEntry {
  /** 判定する before 文字列(編集前) */
  before: string;
  /** 判定する after 文字列(ユーザーが採用 / 編集 / 直接編集した最終) */
  after: string;
  /** scope を構成する seed id 群(空配列なら scope = 全範囲) */
  seedIds: string[];
  /** 操作の起点(log 用) */
  reason: "edit" | "direct_edit";
}

// G3 C7 fix (2026-05-28): undo/redo の pop 件数を group 境界まで拡張する pure helper。
//
// 背景: 「全て元に戻す」(undoAllAutoCorrections)は autoCorrected の件数分 REJECTED entry
//   を積むが、ツールバー Undo は常に undo(1)。1 回で 1 件しか戻らず「一括操作 = 1 回の Undo
//   で全部戻る」という期待を裏切っていた(Codex 独立レビュー C7)。
//
// 解決: bulk 生成時に全 entry へ同一 groupId を付与し(actionLog 側)、undo/redo の pop で
//   「境界が同一 group を分断する」場合に pop 件数を group の端まで拡張する。これにより
//   ツールバー Undo 1 回で bulk 全件がまとまって戻る。redo も同じ拡張で対称になる。
//
// 引数:
//  - logFromOldestToNewest: actionLog(または redoLogStack)。actionHistory と 1:1 index 同期。
//  - requestedPop: 呼び出し側が要求した pop 件数(undo(1) / redo(1) なら 1)。既に
//    Math.min(steps, length) でクランプ済の値を渡す前提。
//
// 戻り値: 拡張後の pop 件数(末尾から数えた件数)。境界 entry が group の途中を割らない
//   場合は requestedPop をそのまま返す(group 無しの通常 entry / 単体操作は不変)。
//
// 注意: 「末尾側(新しい方)」は pop に必ず含まれるため拡張は「先頭側(古い方)」へのみ行う。
//   同一 group は bulk 生成時に連続して積まれる前提(間に別操作が挟まらない)。
export function expandPopCountToGroupBoundary(
  logFromOldestToNewest: ReadonlyArray<{ groupId?: string }>,
  requestedPop: number,
): number {
  const len = logFromOldestToNewest.length;
  if (requestedPop <= 0 || requestedPop >= len) return Math.max(0, Math.min(requestedPop, len));
  // 境界 = pop に含まれる最古 entry の index。
  const boundaryIndex = len - requestedPop;
  const boundaryEntry = logFromOldestToNewest[boundaryIndex];
  const groupId = boundaryEntry?.groupId;
  if (groupId === undefined) return requestedPop;
  // 境界より 1 つ古い entry が同じ group なら group が分断されている → 古い方へ拡張。
  let pop = requestedPop;
  let i = boundaryIndex - 1;
  while (i >= 0 && logFromOldestToNewest[i]?.groupId === groupId) {
    pop += 1;
    i -= 1;
  }
  return pop;
}

// 統合改修パッケージ (2026-05-25): action_history entries の集合から「影響範囲の seed
// 候補となる suggestion id」を抽出する pure helper。
//
// undo / redo の処理対象 entries を渡すと、ACCEPTED / REJECTED / EDITED 経路の
// suggestion_id を集めて返す(DIRECT_EDIT / PENDING は seed が無いため除外)。
//
// 設計判断:
//  - 重複は除去(Set 経由)
//  - 順序は undo / redo の処理順を保持(古い → 新しい)
//  - 結果が空配列なら影響範囲限定モードは無効化(全範囲 partial として動く)
function collectSeedIdsFromEntries(
  entries: ReadonlyArray<ActionHistoryEntry>,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    if (
      entry.verb === "ACCEPTED" ||
      entry.verb === "REJECTED" ||
      entry.verb === "EDITED" ||
      entry.verb === "PENDING"
    ) {
      const id = entry.suggestion_id;
      if (!seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    }
  }
  return result;
}

// =============================================================================
// generateActionLogId (2026-05-25): actionLog entry の一意 id を生成
// =============================================================================
// crypto.randomUUID は modern browsers (Chrome 92+, Safari 15.4+, FF 95+) + Node 19+
// で標準利用可能。Next.js 16 + 当アプリ対象環境は問題なし。
// 古いブラウザ向け fallback として Math.random ベースの簡易 id 生成を後段で提供する
// (本実装は production 利用前提のため fallback を持つ)。
function generateActionLogId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // fallback: timestamp + Math.random(unique enough for UI ref in same session)
  return `log_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// =============================================================================
// buildSuggestionSnippet (2026-05-25): actionLog entry の suggestionOriginalSnippet を作成
// =============================================================================
// SuggestionCard.tsx の buildSuggestionSummary と同じフォーマットに揃える(30 字程度)。
function buildSuggestionSnippet(original: string, max = 30): string {
  if (original.length <= max) return original;
  return original.slice(0, max) + "…";
}

// =============================================================================
// buildStructuralSnapshot (v2 dogfood UX 改善 Task A, 2026-05-26)
// =============================================================================
// structural 採用時の ActionLogEntry に保存する snapshot を生成する pure helper。
//
// 入力:
//  - currentEsBodyBefore: accept 時点の currentEsBody(applyStructuralOperation の入力)
//  - params: 適用する StructuralOperationParams(discriminated union)
//
// 出力: StructuralActionSnapshot
//
// 設計:
//  - 段落分割は applyStructuralOperation と同じ `\n\n+` split を使う(structural_ops.ts L73 と整合)
//  - 段落 trim はせず取得した raw 段落から冒頭抽出(applyStructuralOperation との整合性、
//    実際の段落構造に忠実に表示)
//  - preview は operation 別に意味のあるものだけ生成、他は undefined
//  - paragraphCount は accept 時点の段落数(reorder の old order 表示で必要)
//  - 不正 params(index 範囲外等)で applyStructuralOperation が no-op になるケースでも
//    snapshot は **取れる範囲で生成**(preview のみ undefined になる可能性、エラーは投げない)
function buildStructuralSnapshot(
  currentEsBodyBefore: string,
  params: StructuralOperationParams,
): StructuralActionSnapshot {
  const paragraphs = currentEsBodyBefore.split(/\n\n+/);
  const paragraphCount = paragraphs.length;
  let preview: string | undefined;
  switch (params.operation) {
    case "delete_paragraph": {
      const idx = params.target_paragraph_index;
      if (idx >= 0 && idx < paragraphs.length) {
        preview = buildSuggestionSnippet(paragraphs[idx]);
      }
      break;
    }
    case "add_paragraph": {
      preview = buildSuggestionSnippet(params.new_content);
      break;
    }
    case "reorder_paragraphs":
    case "merge_paragraphs":
    case "move_sentence":
      // これらは label に preview を持たない(段落番号で十分認識可能)
      preview = undefined;
      break;
  }
  return {
    operation: params.operation,
    params,
    paragraphCount,
    preview,
  };
}

// =============================================================================
// markOutdatedForSuggestion (2026-05-25): 同 suggestion の過去 entry を isOutdated に
// =============================================================================
// 新規操作(accept / reject / edit / revert)が起きると、同 suggestion の過去 entry は
// 「現在の status とは矛盾する古い記録」になる。history panel で見たときに「上書き済」
// と分かるよう、過去 entry の isOutdated を true にマークする。revert ボタンも disabled に。
//
// 設計判断:
//  - 全 entry を線形走査(履歴件数は通常 1-30 件のため O(n) で十分)
//  - isOutdated は表示判定のみに使う(state ロジックには影響しない)
//  - reverted entry も outdated になる(revert そのものが新しい操作で上書きされたケース)
function markOutdatedForSuggestion(
  log: ReadonlyArray<ActionLogEntry>,
  suggestionId: string,
): ActionLogEntry[] {
  return log.map((entry) => {
    if (entry.suggestionId === suggestionId && !entry.isOutdated) {
      return { ...entry, isOutdated: true };
    }
    return entry;
  });
}

// =============================================================================
// pickNextPendingSuggestionId (2026-05-25): 1 件詳細展開モードの自動遷移用 helper
// =============================================================================
// 役割: 初回分析完了 / 採用 / 拒否 / 編集 / 自動修正取り消しのたびに「次の未処理
// suggestion」を自動的に選択し、ユーザーが手動で「次の指摘」ボタンを押す手間を
// 減らす(リズム重視)。
//
// 「未処理」の定義(dispatch §1):
//   acceptedSuggestionIds / rejectedSuggestionIds / editedSuggestions
//   のいずれにも含まれない suggestion(= pending かつ未自動修正)。
//   alternative カテゴリは含めない(showAlternatives=false がデフォルトのため、
//   ユーザーが alternative を見たい時は明示トグル経由で見る前提)。
//
// 優先順位(2026-05-28 dogfood round 3 ③ で変更 — 上から順 / ES の出現順):
//   1) original_span.start 昇順(原文上の出現順)を **主キー**
//   2) tiebreak は id 昇順(span が同一の稀ケースで決定性を保つ)
//   旧実装(〜2026-05-27)は display_priority 降順を主キーにしていたが、短い ES では
//   priority 並べ替えの利点が小さく、ES を上下に飛び回って読み流れが切れるため、
//   「上から順」(ユーザー dogfood round 3 ③)に変更。display_priority は順序計算から
//   外し、カードの色タグとしてのみ残す(順序と表示の分離、priority field 自体はリネーム
//   / 削除しない)。詳細根拠は DECISIONS [2026-05-28] dogfood round 3 ②③④ 実装結果。
//
// 戻り値: 次の未処理 suggestion の id、または null(全部処理済み / 全部 exclude)。
//
// 設計判断:
//  - SuggestionDetailPanel の navigableSuggestions ロジックとは別物として実装。
//    navigableSuggestions は「処理済も含めた全件を巡回する順序」(status を跨いでも
//    順番に巡れる)。一方こちらは「次の未処理を選ぶ」用途で、処理済を巡回しない。
//  - excludeIds を引数で受けることで「直前に操作した id」+「再評価中の id 群
//    (reEvaluatingSuggestionIds)」を次回候補から除外できる(② 再評価中スキップ:
//    変わりそうな指摘を、変わる前にユーザーへ見せて考えさせない)。acceptSuggestion 等の
//    set() 内ではまだ acceptedSuggestionIds に反映前のため、excludeIds で渡す。
//  - showAlternatives も渡すことで「alternative トグルが OFF なら alternative を
//    候補から外す」挙動を担保する。
export function pickNextPendingSuggestionId(args: {
  suggestions: ReadonlyArray<import("@/lib/schema/suggestion").Suggestion>;
  acceptedSuggestionIds: ReadonlyArray<string>;
  rejectedSuggestionIds: ReadonlyArray<string>;
  editedSuggestions: Readonly<Record<string, string>>;
  autoCorrectedSuggestionIds: ReadonlyArray<string>;
  showAlternatives: boolean;
  excludeIds?: ReadonlyArray<string>;
}): string | null {
  const {
    suggestions,
    acceptedSuggestionIds,
    rejectedSuggestionIds,
    editedSuggestions,
    autoCorrectedSuggestionIds,
    showAlternatives,
    excludeIds = [],
  } = args;
  const acceptedSet = new Set(acceptedSuggestionIds);
  const rejectedSet = new Set(rejectedSuggestionIds);
  const autoSet = new Set(autoCorrectedSuggestionIds);
  const excludeSet = new Set(excludeIds);
  const pending = suggestions.filter((s) => {
    if (excludeSet.has(s.id)) return false;
    if (acceptedSet.has(s.id)) return false;
    if (rejectedSet.has(s.id)) return false;
    if (s.id in editedSuggestions) return false;
    if (autoSet.has(s.id)) return false;
    if (!showAlternatives && s.category === "alternative") return false;
    return true;
  });
  if (pending.length === 0) return null;
  // 2026-05-28 dogfood round 3 ③: original_span.start 昇順を主キー(上から順)。
  // span が同一の稀ケースは id 昇順で決定性を担保(priority は順序に使わない)。
  pending.sort((a, b) => {
    const spanDiff = a.original_span.start - b.original_span.start;
    if (spanDiff !== 0) return spanDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return pending[0].id;
}

// =============================================================================
// computeReEvaluatingIds (2026-05-28 dogfood round 3 ②④)
// =============================================================================
// scoped partial refresh の seed 群から「再評価で変わりそうな指摘」の id 集合を算出する。
// = seed 群 + 各 seed の `related_suggestion_ids`(suggestions から lookup)の union。
//
//  - `related_suggestion_ids` は load-bearing field(読み取りのみ、リネーム禁止)。
//  - seed 自身も含める(reject した指摘自身も「再評価対象」= AI が rationale 等を見直す)。
//  - 重複は Set で除去。順序は問わない(skip / badge 判定はいずれも membership test)。
//
// client-side 予測の限界: related に宣言されない変化は予測不能。応答後の
// recentlyUpdatedSuggestionIds で反映する(本関数のスコープ外)。
export function computeReEvaluatingIds(
  seedIds: ReadonlyArray<string>,
  suggestions: ReadonlyArray<
    import("@/lib/schema/suggestion").Suggestion
  >,
): string[] {
  const result = new Set<string>(seedIds);
  const byId = new Map(suggestions.map((s) => [s.id, s] as const));
  for (const seedId of seedIds) {
    const seed = byId.get(seedId);
    if (!seed) continue;
    for (const relatedId of seed.related_suggestion_ids ?? []) {
      result.add(relatedId);
    }
  }
  return Array.from(result);
}

// =============================================================================
// shouldApplyRefreshResult (2026-05-28 並行性 fix C1)
// =============================================================================
// refresh / partial 応答を「採用」するか「競合(conflict)」扱いにするかの純粋判定。
// applyRefreshResult / applyPartialResult が version mismatch 分岐で共有する。
//
// 楽観的並行制御の往復整合は従来「receivedEsStateVersion === inflightRefreshVersion + 1」
// だけで判定していたが、これは **不完全** だった:
//   - beginRefresh 時点: inflightRefreshVersion = clientEsVersion(送信時の基準 = 例 5)
//   - AI 呼び出し中にユーザーが「clientEsVersion は進むが新 refresh を起こさない操作」
//     (related なし採用 = acceptSuggestion の no-related 経路。clientEsVersion を無条件 +1
//      するが partialRefreshTrigger は立てない)をすると clientEsVersion は 6 に進む。
//   - サーバは元の v5 本文を基準に分析し es_state_version = 6 を返す。
//   - 旧判定: 6 === 5 + 1 → 一致 → 採用 = **古い本文前提の結果が競合扱いにならず反映**。
//
// 修正: 採用条件に「inflight 開始から clientEsVersion が進んでいない」
//   (clientEsVersion === inflightRefreshVersion)も要求する。進んでいたら conflict。
//
// 通常フロー(refresh 中にユーザー操作なし)で false-positive 競合にならない理由:
//   - beginRefresh: inflightRefreshVersion = clientEsVersion(例 5)。
//   - 結果適用自体は clientEsVersion を進めない(applyRefreshResult / applyPartialResult の
//     採用時は clientEsVersion = result.es_state_version の **同期**であって increment ではない。
//     しかもこの同期は採用が確定した後に行われる)。よって判定時点では clientEsVersion は
//     beginRefresh 時点の値(5)のまま = inflightRefreshVersion(5)と一致 → 採用。
//
// inflightRefreshVersion === null は「進行中の refresh が無い」= 採用基準が存在しない
// = conflict(古い経路の応答が遅れて届いた等)。
export function shouldApplyRefreshResult(args: {
  inflightRefreshVersion: number | null;
  clientEsVersion: number;
  receivedEsStateVersion: number;
}): boolean {
  const { inflightRefreshVersion, clientEsVersion, receivedEsStateVersion } =
    args;
  if (inflightRefreshVersion === null) return false;
  // 往復整合: 送信基準 + 1 == 受領バージョン
  if (receivedEsStateVersion !== inflightRefreshVersion + 1) return false;
  // C1: inflight 開始から clientEsVersion が進んでいないこと
  if (clientEsVersion !== inflightRefreshVersion) return false;
  return true;
}

// =============================================================================
// isReanalyzeDisabled (2026-05-28 再分析フロー fix C5)
// =============================================================================
// SummaryBar の「再分析する」ボタン(triggerFullRefresh → goal=balanced 経路)を
// disable すべきかの純粋判定。
//
// 背景: 採用 / 却下 / 編集も clarification 回答も無い状態(actionHistory 空 + 有効回答 0)で
// 「再分析する」を押すと、handleRefresh / 観測 effect の balanced early-return
// (actionHistory.length === 0 && !hasValidClarificationAnswers)で弾かれ silent no-op に
// なる(押せるのに何も起きない = 壊れて見える)。これを UI 側で disable + tooltip にして
// feedback し、無駄な LLM 呼び出しも避ける。
//
// disable 条件 = 操作 0 件 かつ 有効 clarification 回答 0 件。
//   - 操作あり → enable(従来どおり通常の再分析が走る)。
//   - 有効 clarification 回答あり → enable(handleRefresh の balanced early-return を
//     clarification 経路が通す。e5b3ede fix)。
//
// over-limit の扱い(dispatch 文言との差分を report で明記):
//   dispatch C5 の推奨 disable 条件は「操作0 かつ 非over-limit かつ 回答なし」で、
//   over-limit のときは「再分析する」を enable のままにする想定だった。しかし
//   「再分析する」ボタンは goal=balanced 固定であり、over-limit + 操作0 + balanced は
//   handleRefresh の early-return(over-limit を見ていない)で必ず無反応になる。
//   よって over-limit のとき enable にすると silent no-op が残り、dispatch の最優先目標
//   「ボタンが silent に no-op しないこと」に反する。over-limit の削減導線は別ボタン
//   「文字数を抑える」(handleRefresh("reduce_length"))が担保するため、ここでは
//   over-limit を disable 条件に含めず(over-limit でも操作0+回答なしなら disable)、
//   silent no-op を構造的に撲滅する。clarification 経路の「この回答で再分析」も別ボタン。
export function isReanalyzeDisabled(args: {
  hasOperations: boolean;
  hasValidClarificationAnswers: boolean;
}): boolean {
  const { hasOperations, hasValidClarificationAnswers } = args;
  return !hasOperations && !hasValidClarificationAnswers;
}

// -----------------------------------------------------------------------------
// G3 C3 fix (2026-05-28): ツールバー Undo/Redo の disabled 判定(純粋関数)
// -----------------------------------------------------------------------------
// 背景: キーボードショートカット側は `if (directEditMode) return` で直接編集中の
//   Undo/Redo を既にガードしていた(contentEditable のブラウザ標準 undo に委ねる設計)。
//   しかしツールバーボタンは disabled に directEditMode を含めず、提案採用 → 直接編集 ON →
//   ツールバー Undo → 直接編集 OFF の経路で direct-edit pending snapshot と履歴操作が
//   食い違い、状態不整合を起こしていた(Codex 独立レビュー C3)。
//
// 本 helper は「ツールバー Undo/Redo が押せるか」をキーボードガードと同一基準で定義する。
//   - directEditMode 中は両方 disabled(キーボードと同基準)
//   - それ以外は履歴 / redo スタックの有無で判定(従来挙動)
// Canvas.tsx のツールバーボタンと本 helper を同じ規則に保ち、ユニットテストでは本 helper を
// assert する(component render を触らずに C3 の不変条件を構造で担保する)。
export function canUndoFromToolbar(args: {
  directEditMode: boolean;
  actionHistoryLength: number;
}): boolean {
  return !args.directEditMode && args.actionHistoryLength > 0;
}

export function canRedoFromToolbar(args: {
  directEditMode: boolean;
  redoStackLength: number;
}): boolean {
  return !args.directEditMode && args.redoStackLength > 0;
}

// -----------------------------------------------------------------------------
// 編集モード snapshot (UX 改修 1b 追加 2026-05-23)
// Phase G Step 2 で clientEsVersion を含める(refresh の往復整合性を編集モード復帰後も維持)
// -----------------------------------------------------------------------------
// 「編集する」を押した瞬間の完全な session 状態を保持。「戻る」で全 restore する。
//
// 設計: form と分析結果系を別キーで分けることで、restore 時に「どちらだけ戻す」
// のような分岐を入れずに済む(snapshot 持っていれば全部戻す、なければ noop)。
//
// Phase G Step 2 追加フィールド:
//  - clientEsVersion: 編集モード開始時点の version。restore 時に同じ値に戻す。
//    snapshot に保存しないと、編集モード中の resetSession で 0 に戻り、cancel 経路の
//    refresh 整合性が破綻する(refresh の baseVersion がずれて応答が常に discard)。
//  - refresh の inflight 系(refreshAbortController / inflightRefreshVersion /
//    refreshPhase / refreshError / refreshStreamingStage)は snapshot に **保存しない**。
//    startEditingMode 時に進行中の refresh は abort で消える、編集モード中は refresh を
//    動かさない設計。cancel 経路でも refresh は初期化された状態に戻す。
export interface EditingSnapshot {
  form: FormState;
  phase: AnalyzePhase;
  researchError: ServerError | null;
  analyzeError: ServerError | null;
  companySummary: CompanySummary | null;
  analysisResult: AnalysisResult | null;
  selectedSuggestionId: string | null;
  showAlternatives: boolean;
  acceptedSuggestionIds: string[];
  rejectedSuggestionIds: string[];
  editedSuggestions: Record<string, string>;
  // Phase G Step 3b-1 (2026-05-23): 編集モード復帰後も自動修正の見え方を保つため
  // snapshot に保存(空配列でも明示的に持つ、null と区別)。
  autoCorrectedSuggestionIds: string[];
  directEditMode: boolean;
  currentEsBody: string;
  // 2026-05-28 dogfood round 3 ⑤: baked 集合も編集モード snapshot に保存(cancel 復帰で
  // 派生計算の二重適用回避状態を完全 restore)。
  bakedSuggestionIds: string[];
  actionHistory: ActionHistoryEntry[];
  // 2026-05-25: UI 用 rich 操作ログも編集モード snapshot に保存(cancel 経路で完全 restore)
  actionLog: ActionLogEntry[];
  // Phase G Step 2: 編集モード復帰後の refresh 整合性のため、version も保存
  clientEsVersion: number;
}

// -----------------------------------------------------------------------------
// Step 2 リセット時の初期値(startAnalysis / resetSession の両方で同じ初期化を行う)
// Phase G Step 3b-1 (2026-05-23): autoCorrectedSuggestionIds も同期的にリセット。
// Phase G Step 3b-3 (2026-05-23): redoStack も同期的にリセット(新規セッションで redo 不可)。
// -----------------------------------------------------------------------------
const STEP2_RESET_STATE = {
  acceptedSuggestionIds: [] as string[],
  rejectedSuggestionIds: [] as string[],
  editedSuggestions: {} as Record<string, string>,
  autoCorrectedSuggestionIds: [] as string[],
  directEditMode: false,
  currentEsBody: "",
  actionHistory: [] as ActionHistoryEntry[],
  redoStack: [] as ActionHistoryEntry[],
  // 2026-05-25: UI 用 rich 操作ログ(actionHistory と並行、1:1 対応で同じ長さを維持)
  actionLog: [] as ActionLogEntry[],
  // 2026-05-25: undo/redo の整合のための actionLog 用 redo stack(actionHistory.redoStack と並行)
  redoLogStack: [] as ActionLogEntry[],
  // 2026-05-28 dogfood round 3 ⑤ 直接編集 bug fix: baked 集合 / 直接編集 pending snapshot も
  // 新規セッション / 編集モード遷移でリセット(直接編集の積み重ね状態は session 単位)。
  bakedSuggestionIds: [] as string[],
  directEditPending: null as {
    snapshot: DirectEditStateSnapshot;
    baselineBody: string;
  } | null,
};

// -----------------------------------------------------------------------------
// Phase G Step 2 リセット時の初期値(refresh 並行制御 state を一括初期化)
// UX 改修 3b (2026-05-23): analyzeGoal も balanced で初期化
// -----------------------------------------------------------------------------
const REFRESH_RESET_STATE = {
  // initial 分析完了時 / セッションリセット時は 0 から数え直す。
  // 採用 / 却下 / 編集 / 直接編集 / undo のたびに +1 され、refresh の基準として使う。
  clientEsVersion: 0,
  inflightRefreshVersion: null as number | null,
  refreshAbortController: null as AbortController | null,
  refreshPhase: "idle" as RefreshPhase,
  refreshError: null as ServerError | null,
  refreshStreamingStage: null as StreamingStage,
  // UX 改修 3b: 初期 / リセット時は通常モード。beginRefresh が削減モードを
  // 指定したら "reduce_length" に切り替わり、finishRefresh / next beginRefresh の
  // 起点で "balanced" に戻す(明示的にリセットしない場合は前回の値を保持)。
  analyzeGoal: "balanced" as AnalyzeGoal,
};

// -----------------------------------------------------------------------------
// Store factory
// -----------------------------------------------------------------------------
// Phase G Step 2: `get` 引数を受け取って beginRefresh / 他で getState 相当の参照を
// 行えるようにする(zustand の標準 API、circular ref を回避できる)。
export const useAnalyzeStore = create<AnalyzeStore>((set, get) => ({
  form: { ...DEFAULT_FORM },
  setField: (key, value) =>
    set((s) => ({ form: { ...s.form, [key]: value } })),
  resetForm: () => set({ form: { ...DEFAULT_FORM } }),

  phase: "idle",
  streamingStage: null,
  researchError: null,
  analyzeError: null,
  companySummary: null,
  analysisResult: null,
  selectedSuggestionId: null,
  // Phase G Step 3a: hover 連動 state は session を跨ぐ意味がない(マウス位置は
  // 揮発的)ため、startAnalysis / resetSession / 編集モード遷移すべてで null に
  // 戻す。下記 set 内でも明示クリア。
  hoveredSuggestionId: null,
  showAlternatives: false,
  editingSnapshot: null,

  // Task #32a (2026-05-25): 右パネルのアクティブタブ初期値。
  // 指摘がメインなので常に最初に "suggestions" を表示。startAnalysis / resetSession
  // 時もここに戻す(新規分析後は指摘から始める動線が自然)。
  activeTab: "suggestions" as TabValue,

  // Phase G 修正 (2026-05-23): 即時 partial refresh trigger + 競合通知 の初期 state
  // 統合改修パッケージ (2026-05-25): pendingRefreshScope も初期 null。
  partialRefreshTrigger: 0,
  pendingRefreshScope: null,
  semanticDiffQueue: [] as SemanticDiffPendingEntry[],
  conflictNotification: null,
  // v2 dogfood UX 改善 Task C (2026-05-26): partial refresh 完了 toast 用 timestamp(初期 null)
  refreshCompletedAt: null,
  // 2026-05-27 エージェント的対話(AI 逆質問): clarification 回答の集合(初期空)
  clarificationAnswers: [] as ClarificationAnswer[],

  // 2026-05-25 Task #18: partial refresh の loading / animation UX 用 state(初期は休止状態)
  partialRefreshInProgress: false,
  partialRefreshSeedIds: [] as string[],
  pendingDeletedSuggestionIds: [] as string[],
  recentlyAddedSuggestionIds: [] as string[],
  recentlyUpdatedSuggestionIds: [] as string[],
  // 2026-05-28 並行性 fix C8: refresh 世代カウンタ(初期 0、beginRefresh で +1)
  partialRefreshGeneration: 0,
  // 2026-05-28 dogfood round 3 ②④: 再評価で変わりそうな指摘の id 群(初期空)
  reEvaluatingSuggestionIds: [] as string[],

  // Step 2 初期 state(下記 actions が変化させる)
  // Phase G Step 3b-3 (2026-05-23): redoStack も STEP2_RESET_STATE に含まれる(セッション開始で空配列)
  ...STEP2_RESET_STATE,
  // Phase G Step 2: refresh 並行制御 state(下記 refresh actions が変化させる)
  ...REFRESH_RESET_STATE,

  // startAnalysis: 分析開始ボタン押下時に呼ぶ。前回の結果とエラーをクリアし、phase を
  // researching または analyzing に先送りするのは呼び出し側(URL の有無で分岐)。
  // ここでは「前回状態を破棄して loading 系へ向かう準備」だけ行う。
  // selectedSuggestionId / showAlternatives もリセット(前回の Popover が開いたままや
  // alternative トグルが ON のまま新規分析に持ち込まれる事故を防ぐ)。
  // Step 2 で追加した状態(採用 / 却下 / 編集 / 直接編集 / actionHistory)もリセット
  // する。`currentEsBody` は呼び出し側(InputForm)が es_body を渡してくる前提で、
  // ここでは空文字に戻す(setAnalysisResult が後段で currentEsBody を form.es_body
  // で再初期化する)。
  startAnalysis: () =>
    set((s) => {
      // 新規セッションに入る前に、進行中の refresh があれば abort する。
      // これがないと、前回 done で発火していた refresh が背後で生き残り、新セッション
      // 開始後に「古い応答」が降ってきて新セッションの state を破壊し得る。
      if (s.refreshAbortController) {
        try {
          s.refreshAbortController.abort();
        } catch {
          // abort 二重呼びの DOMException は無視
        }
      }
      // Phase G 修正 (2026-05-23): 自動 refresh デバウンス機構は撤去済(setTimeout 不在)。
      // 新セッション開始時は partialRefreshTrigger / 競合通知 をリセット。
      return {
        researchError: null,
        analyzeError: null,
        companySummary: null,
        analysisResult: null,
        streamingStage: null,
        selectedSuggestionId: null,
        hoveredSuggestionId: null,
        showAlternatives: false,
        // 「分析開始」は新規セッションのため、編集モード snapshot も捨てる
        // (戻る経路を断ち、ユーザーは編集後の form で新規分析へ進む)
        editingSnapshot: null,
        // Task #32a (2026-05-25): 右パネルのアクティブタブを "suggestions" に戻す
        // (新規分析の動線は指摘から始めるのが自然)
        activeTab: "suggestions" as TabValue,
        // Phase G 修正: 即時 partial refresh trigger を 0 に戻し、競合通知もリセット
        // 統合改修パッケージ (2026-05-25): pendingRefreshScope / semanticDiffQueue もリセット
        partialRefreshTrigger: 0,
        pendingRefreshScope: null,
        semanticDiffQueue: [],
        conflictNotification: null,
        // v2 dogfood UX 改善 Task C (2026-05-26): partial refresh 完了 toast の timestamp もリセット
        refreshCompletedAt: null,
        // 2026-05-27 エージェント的対話(AI 逆質問): 回答も session 単位の揮発状態として
        // リセット系で空配列に戻す(新規分析 / セッション全リセット / 編集モード遷移は
        // すべて回答コンテキストを破棄する)
        clarificationAnswers: [],
        // 2026-05-25 Task #18: partial refresh animation 用 state もリセット
        partialRefreshInProgress: false,
        partialRefreshSeedIds: [],
        pendingDeletedSuggestionIds: [],
        recentlyAddedSuggestionIds: [],
        recentlyUpdatedSuggestionIds: [],
        // 2026-05-28 dogfood round 3 ②④: 新規分析開始で再評価中 mark をリセット
        reEvaluatingSuggestionIds: [],
        ...STEP2_RESET_STATE,
        ...REFRESH_RESET_STATE,
      };
    }),

  setResearching: () => set({ phase: "researching" }),
  setAnalyzing: () => set({ phase: "analyzing" }),
  setCompanySummary: (summary) => set({ companySummary: summary }),
  // 分析完了時に currentEsBody を form.es_body で初期化する。これにより、
  // Canvas は currentEsBody を表示元データに使い、採用・編集・直接編集で派生変化
  // していく構造になる。form.es_body は入力フォームの最新値、currentEsBody は
  // 「分析開始時点の ES + その後のユーザー編集」を保持する別流路。
  // Phase G Step 1: streamingStage は完了時に null に戻す(SSE 終了の合図)。
  // Phase G Step 2: 楽観的並行制御の起点として clientEsVersion を result.es_state_version
  //   で初期化する(initial では typically 0 が返る、refresh の起点として使う)。
  // Phase G Step 3b-1 (2026-05-23): error カテゴリの自動修正を初期化時に適用。
  //   - result.suggestions から category === "error" を抽出
  //   - それらの id を acceptedSuggestionIds + autoCorrectedSuggestionIds に追加
  //   - rejectedSuggestionIds / editedSuggestions には触れない(初期状態は空)
  //   - action_history には記録しない(LLM の出力結果のため、循環参照を避ける)
  //   - 派生 ES(getDerivedEsBody)は acceptedSuggestionIds を読むため自動的に
  //     error の proposed が適用された状態で表示される
  setAnalysisResult: (result) => {
    set((s) => {
      const autoIds = result.suggestions
        .filter((sug) => sug.category === "error")
        .map((sug) => sug.id);
      // 2026-05-25 (1 件詳細展開モード): 初回分析完了時に最優先未処理 suggestion を
      // 自動選択する。これにより SuggestionDetailPanel が即座に詳細表示に入る
      // (一覧 fallback を経由しない、リズム重視)。
      // 自動修正(autoIds)は除外(派生 ES に既に反映済 → ユーザー判断不要)。
      const nextSelectedId = pickNextPendingSuggestionId({
        suggestions: result.suggestions,
        acceptedSuggestionIds: autoIds,
        rejectedSuggestionIds: [],
        editedSuggestions: {},
        autoCorrectedSuggestionIds: autoIds,
        showAlternatives: s.showAlternatives,
      });
      return {
        phase: "done",
        streamingStage: null,
        analysisResult: result,
        currentEsBody: s.form.es_body,
        clientEsVersion: result.es_state_version,
        // 自動修正: error の id を accepted と autoCorrected の両方に展開
        acceptedSuggestionIds: autoIds,
        autoCorrectedSuggestionIds: autoIds,
        // 1 件詳細展開モード自動選択
        selectedSuggestionId: nextSelectedId,
      };
    });
    // 2026-05-28 capture(dev 専用): 初回分析結果を反映後に記録。
    // setAnalysisResult は常に analysisResult を更新するため無条件 append でよい。
    // appendCaptureLog 内部で dev gate(production no-op)。
    appendCaptureLog("initial", get());
  },

  // research 失敗は phase を変えない(後続の setAnalyzing が phase を進める)
  setResearchError: (err) => set({ researchError: err }),
  // analyze 失敗は致命的、phase を error に固定。streamingStage も null へ。
  setAnalyzeError: (err) =>
    set({ phase: "error", streamingStage: null, analyzeError: err }),

  // Phase G Step 1: SSE 受信ループから細分化進捗を更新
  setStreamingStage: (stage) => set({ streamingStage: stage }),

  resetSession: () =>
    set((s) => {
      // 進行中の refresh があれば abort してから state を捨てる(startAnalysis と同じ規律)。
      if (s.refreshAbortController) {
        try {
          s.refreshAbortController.abort();
        } catch {
          // 二重 abort の DOMException は無視
        }
      }
      // Phase G 修正 (2026-05-23): 自動 refresh デバウンス機構は撤去済(setTimeout 不在)。
      return {
        phase: "idle",
        streamingStage: null,
        researchError: null,
        analyzeError: null,
        companySummary: null,
        analysisResult: null,
        selectedSuggestionId: null,
        hoveredSuggestionId: null,
        showAlternatives: false,
        // resetSession は session 完全リセット(編集モード snapshot も含めて全部捨てる)
        editingSnapshot: null,
        // Task #32a (2026-05-25): 右パネルのアクティブタブを "suggestions" に戻す
        // (新セッションの起点は指摘から、startAnalysis と同じ規律)
        activeTab: "suggestions" as TabValue,
        // Phase G 修正: 即時 partial refresh trigger を 0 に戻し、競合通知もリセット
        // 統合改修パッケージ (2026-05-25): pendingRefreshScope / semanticDiffQueue もリセット
        partialRefreshTrigger: 0,
        pendingRefreshScope: null,
        semanticDiffQueue: [],
        conflictNotification: null,
        // v2 dogfood UX 改善 Task C (2026-05-26): partial refresh 完了 toast の timestamp もリセット
        refreshCompletedAt: null,
        // 2026-05-27 エージェント的対話(AI 逆質問): 回答も session 単位の揮発状態として
        // リセット系で空配列に戻す(新規分析 / セッション全リセット / 編集モード遷移は
        // すべて回答コンテキストを破棄する)
        clarificationAnswers: [],
        // 2026-05-25 Task #18: partial refresh animation 用 state もリセット
        partialRefreshInProgress: false,
        partialRefreshSeedIds: [],
        pendingDeletedSuggestionIds: [],
        recentlyAddedSuggestionIds: [],
        recentlyUpdatedSuggestionIds: [],
        // 2026-05-28 dogfood round 3 ②④: セッション全リセットで再評価中 mark もリセット
        reEvaluatingSuggestionIds: [],
        ...STEP2_RESET_STATE,
        ...REFRESH_RESET_STATE,
      };
    }),

  // Canvas UI 用 actions (Phase F Step 1)
  selectSuggestion: (id) => set({ selectedSuggestionId: id }),
  // Phase G Step 3a (2026-05-23): hover 連動 action。SuggestionListPanel と
  // Canvas の HighlightSpan の両方が呼び出すエントリ。hover の主体・客体は
  // 同一の state に集約されているため、一方から立てた id が他方の視覚連動を
  // 即座にトリガーできる。
  setHoveredSuggestion: (id) => set({ hoveredSuggestionId: id }),
  toggleAlternatives: () =>
    set((s) => ({ showAlternatives: !s.showAlternatives })),
  setShowAlternatives: (show) => set({ showAlternatives: show }),
  // Task #32a (2026-05-25): 右パネルのアクティブタブを変更する最小実装。
  // 詳細は AnalyzeStore.activeTab / TabValue の JSDoc 参照。
  setActiveTab: (tab) => set({ activeTab: tab }),

  // ---------------------------------------------------------------------------
  // Canvas UI 用 actions (Phase F Step 2)
  // ---------------------------------------------------------------------------
  // 採用: ACCEPTED entry を append、acceptedSuggestionIds に追加、Popover を閉じる。
  // ES 本文の派生計算は getDerivedEsBody(コンポーネント側)で行う。
  // Phase G Step 2: clientEsVersion +1(refresh 発火時の基準として、操作確定で必ず進める)。
  // Phase G Step 3b-1 (2026-05-23): 既に accepted な id が autoCorrected にもある場合、
  //   ユーザーが「採用」ボタンを押した時点で「ユーザー能動的採用」に切り替えるため、
  //   autoCorrectedSuggestionIds からは外す(action_history に ACCEPTED を残す)。
  //   この経路は SuggestionCard の通常の「採用」ボタン経由でも、自動修正済 status の
  //   カードが採用ボタンを再表示しないため通常は発火しないが、防御的に整合性を保つ。
  // Task #31 (2026-05-25): 採用に伴う partial refresh trigger を導入。
  //   - 関連あり(`related_suggestion_ids.length > 0`)= scope = [採用 id, ...関連 ids] で
  //     scoped partial refresh を発火(reason: "accept_with_related")
  //   - 関連なし = 従来通り skip(AI コスト 0、判断疲労 0)
  //   Day 7 README の差別化軸「AI が必要な最小範囲だけ動く設計」を **関連 ID 単位の最小スコープ**
  //   として再解釈。dogfood で「関連あり指摘の採用後に他方が更新されない」観察への直接対応。
  acceptSuggestion: (input) => {
    set((s) => {
      // 既に accepted で、かつ auto-corrected ではない場合は完全な no-op(二重採用ガード)
      const alreadyAccepted = s.acceptedSuggestionIds.includes(
        input.suggestion_id,
      );
      const wasAutoCorrected = s.autoCorrectedSuggestionIds.includes(
        input.suggestion_id,
      );
      if (alreadyAccepted && !wasAutoCorrected) {
        return {};
      }
      const entry: ActionHistoryEntry = {
        verb: "ACCEPTED",
        suggestion_id: input.suggestion_id,
        suggestion_summary: input.suggestion_summary,
      };
      // rejected 集合から除外(却下を取り消して採用に切り替えるケースに対応)。
      const rejectedSuggestionIds = s.rejectedSuggestionIds.filter(
        (id) => id !== input.suggestion_id,
      );
      // auto-corrected から外す(ユーザー能動的採用に格上げ)
      const autoCorrectedSuggestionIds = s.autoCorrectedSuggestionIds.filter(
        (id) => id !== input.suggestion_id,
      );
      // acceptedSuggestionIds への追加は重複を避ける(既に accepted なら再追加しない)
      const acceptedSuggestionIds = alreadyAccepted
        ? s.acceptedSuggestionIds
        : [...s.acceptedSuggestionIds, input.suggestion_id];
      // 2026-05-25: targetSuggestion を pickNext より前に lookup(actionLog snapshot +
      // 2026-05-28 dogfood round 3 ②④ の reEvaluating 算出に使う)。
      // suggestion メタ(category / original snippet)をスナップショットして保持し、
      // 後で analysisResult が refresh で入れ替わっても履歴表示が正しく見えるようにする。
      const targetSuggestion = s.analysisResult?.suggestions.find(
        (sug) => sug.id === input.suggestion_id,
      );
      // 2026-05-28 dogfood round 3 ②④: 採用に伴う scoped refresh の判定を pickNext より前に行う。
      // accept は「関連あり時のみ」scoped refresh を発火する(関連なしは refresh skip = 何も
      // 再評価されない)。reEvaluating = seed(採用 id)+ 関連 ids の union(関連あり時のみ非空)。
      // `related_suggestion_ids` は load-bearing field(読み取りのみ)。
      const relatedIds = targetSuggestion?.related_suggestion_ids ?? [];
      const shouldTriggerScopedRefresh = relatedIds.length > 0;
      const reEvaluatingIds = shouldTriggerScopedRefresh
        ? computeReEvaluatingIds(
            [input.suggestion_id, ...relatedIds],
            s.analysisResult?.suggestions ?? [],
          )
        : [];
      // 2026-05-25 (1 件詳細展開モード): 採用直後に「次の未処理 suggestion」を自動選択。
      // ユーザーが「次の指摘」ボタンを押す手間を減らし、リズムよく判断できる UX。
      // 自身の id (= 採用したばかり) は excludeIds で除外する(set 内では新 state が
      // まだ反映されていないため、新 accepted リストを構築してから渡す)。
      // 2026-05-28 dogfood round 3 ②: 再評価で変わりそうな指摘(reEvaluatingIds)も
      // excludeIds に含め、次の自動選択から外す(変わる前のものを見せて考えさせない)。
      const nextSelectedId = pickNextPendingSuggestionId({
        suggestions: s.analysisResult?.suggestions ?? [],
        acceptedSuggestionIds,
        rejectedSuggestionIds,
        editedSuggestions: s.editedSuggestions,
        autoCorrectedSuggestionIds,
        showAlternatives: s.showAlternatives,
        excludeIds: reEvaluatingIds,
      });
      // v2 Phase B3 (2026-05-26): structural 採用時の派生 ES 機械生成 + snapshot 取得。
      // structural は AI ではなく client side で applyStructuralOperation を適用し、
      // currentEsBody を更新する。Undo で巻き戻すため snapshot を ActionLogEntry に持たせる。
      // 不正 params / 不正 index の場合 applyStructuralOperation は元 esBody を返す(no-op)
      // ため、currentEsBody が変わらないケースもありうる(防御的に snapshot は常に取る)。
      //
      // 2026-05-30 N4 調査メモ(座標系の整合性、reconcile が吸収していることを確認済):
      //   structural 採用で段落順 / 内容が変わると currentEsBody が、非 structural 指摘の
      //   original_span(form.es_body 基準、reAnchorSuggestionsToFormEsBody で単一座標系に
      //   揃えている)と文字位置で乖離する。これにより raw span(getDerivedSpans)は
      //   reorder/delete 後の displayEsBody 上で誤位置を指す。
      //   ただし Canvas の buildSegments は raw span を必ず reconcileSpansToDisplayedText
      //   (lib/state/analyze_store.ts)に通し、suggestion.original を displayEsBody から
      //   再 locate して貼り直す / 出せなければ抑制する。検証(段落 reorder / delete / 同一
      //   テキスト複数出現の曖昧ケース)で、隣接する非 structural ハイライトはいずれも正しい
      //   位置に再アンカーされることを確認した(本文は常に正しい、reconcile が drift を吸収)。
      //   よって座標系の投機的改修(getDerivedEsBody / reAnchor / reconcile の構造変更)は
      //   行わない。README 既知事項「まれにハイライトがずれる(本文は常に正しい)」の最後の
      //   緩衝として reconcile が機能している。
      const isStructural =
        targetSuggestion?.category === "structural" &&
        targetSuggestion.structural_params !== undefined;
      const currentEsBodyBefore = s.currentEsBody;
      const newCurrentEsBody = isStructural
        ? applyStructuralOperation(
            s.currentEsBody,
            // optional の存在を上で narrow 済(targetSuggestion.structural_params !== undefined)
            targetSuggestion.structural_params!,
          )
        : s.currentEsBody;
      // v2 dogfood UX 改善 Task A (2026-05-26): structural 採用時、HistoryPanel が
      // 「段落 N を削除: '冒頭…'」等の具体的操作を rendering できるよう snapshot を生成。
      // 既存 currentEsBodyBefore(Undo 用)とは独立の追加 field(display 専用)。
      const structuralSnapshot =
        isStructural && targetSuggestion?.structural_params !== undefined
          ? buildStructuralSnapshot(
              currentEsBodyBefore,
              targetSuggestion.structural_params,
            )
          : undefined;
      // 2026-05-27 dogfood round 2 Task F: 通常 suggestion(error/convention/alternative)採用時、
      // HistoryPanel で「元の表現 → 採用後の表現」を併記表示するための snapshot。
      // structural は structuralSnapshot 経路で別表示するため本 field は省略。
      const proposedSnapshot =
        !isStructural && targetSuggestion
          ? {
              originalText: buildSuggestionSnippet(targetSuggestion.original),
              proposedText: buildSuggestionSnippet(targetSuggestion.proposed),
            }
          : undefined;
      const logEntry: ActionLogEntry = {
        id: generateActionLogId(),
        type: "accepted",
        esVersion: s.clientEsVersion + 1,
        timestamp: Date.now(),
        suggestionId: input.suggestion_id,
        suggestionCategory: targetSuggestion?.category,
        suggestionOriginalSnippet: targetSuggestion
          ? buildSuggestionSnippet(targetSuggestion.original)
          : undefined,
        suggestionSummary: input.suggestion_summary,
        // structural 採用時のみ snapshot を持つ(Undo の per-entry 巻き戻し参照用)
        ...(isStructural && { currentEsBodyBefore }),
        // v2 dogfood UX 改善 Task A (2026-05-26): HistoryPanel 用の rich display snapshot
        ...(structuralSnapshot !== undefined && { structuralSnapshot }),
        // 2026-05-27 dogfood round 2 Task F: 通常 suggestion 採用時の display snapshot
        ...(proposedSnapshot !== undefined && { proposedSnapshot }),
      };
      // 同 suggestion の過去 entry を isOutdated にマーク(後発の操作で上書きされた表示)
      const actionLog = markOutdatedForSuggestion(
        s.actionLog,
        input.suggestion_id,
      );
      // Task #31 (2026-05-25): 採用した suggestion に `related_suggestion_ids` がある場合のみ
      // 関連 ID 単位の scoped partial refresh を発火。AI が「採用に伴って既存の関連指摘の
      // 内容(rationale / proposed / overlap warning など)を更新すべきか」を意味的に判断する。
      // relatedIds / shouldTriggerScopedRefresh / reEvaluatingIds は pickNext より前で算出済
      // (2026-05-28 dogfood round 3 ②④、excludeIds に reEvaluating を渡すため)。
      // 統合改修パッケージ (2026-05-25) → Task #31 (2026-05-25) 改修:
      //   - 採用 + 関連なし = refresh skip(従来通り、AI コスト 0、判断疲労 0)
      //   - 採用 + 関連あり = scope = [採用 id, ...関連 ids] で partial refresh
      // Day 7 README の差別化軸「AI が必要な最小範囲だけ動く設計」の核心実装。
      // 「最小範囲」を **関連 ID 単位の最小スコープ** として再解釈(関連なしは引き続き完全 skip、
      // 関連ありでも全体再分析にはせず seed = 採用 id + 関連 ids に限定)。
      return {
        acceptedSuggestionIds,
        rejectedSuggestionIds,
        autoCorrectedSuggestionIds,
        actionHistory: [...s.actionHistory, entry],
        actionLog: [...actionLog, logEntry],
        // Phase G Step 3b-3: 新規操作 → redoStack を clear(慣例)
        // 2026-05-25: actionLog 用 redoLogStack も同期 clear(1:1 整合維持)
        redoStack: [],
        redoLogStack: [],
        // 1 件詳細展開モード自動遷移(null になっても OK = 完了画面表示の signal)
        selectedSuggestionId: nextSelectedId,
        clientEsVersion: s.clientEsVersion + 1,
        // v2 Phase B3 (2026-05-26): structural 採用時のみ currentEsBody を機械適用後で
        // 更新。他カテゴリでは無変更(error の自動修正は別経路、convention/alternative
        // は派生 ES に直接適用しない)。
        currentEsBody: newCurrentEsBody,
        // Task #31 (2026-05-25): 関連あり時のみ trigger を立て、関連なしは従来通り skip。
        // 関連なしのケースでは pendingRefreshScope / partialRefreshTrigger を変更しないため、
        // 前回 scope は温存される(他経路の影響を受けない、純粋な partial reuse)。
        // 2026-05-28 dogfood round 3 ②④: 関連あり時のみ reEvaluatingSuggestionIds を set。
        // 関連なしは scoped refresh skip = 何も再評価されないため空のまま(reEvaluating も無変更)。
        ...(shouldTriggerScopedRefresh && {
          partialRefreshTrigger: s.partialRefreshTrigger + 1,
          pendingRefreshScope: {
            kind: "scoped" as const,
            seedIds: [input.suggestion_id, ...relatedIds],
            reason: "accept_with_related" as const,
          },
          reEvaluatingSuggestionIds: reEvaluatingIds,
        }),
      };
    });
  },

  // 却下: REJECTED entry を append、rejectedSuggestionIds に追加、Popover を閉じる。
  // ES 本文は変更しない(却下は「指摘を採用しない」だけ、原文は保持)。
  // Phase G Step 2: ES 本文は変わらないが、refresh の意図(LLM への「この方向は不要」
  //   シグナル)としては有意義なため version を進める。
  // Phase G Step 3b-1 (2026-05-23): 自動修正された error を通常 reject 経路で
  //   却下するケースも対応。autoCorrectedSuggestionIds からも該当 id を除く
  //   (UI 上「自動修正済 status」が「却下済 status」に切り替わる)。
  rejectSuggestion: (input) => {
    set((s) => {
      if (s.rejectedSuggestionIds.includes(input.suggestion_id)) {
        return {};
      }
      const entry: ActionHistoryEntry = {
        verb: "REJECTED",
        suggestion_id: input.suggestion_id,
        suggestion_summary: input.suggestion_summary,
      };
      // 採用済 → 却下に切り替えるケース: accepted/edited 集合から除外。
      const acceptedSuggestionIds = s.acceptedSuggestionIds.filter(
        (id) => id !== input.suggestion_id,
      );
      const editedSuggestions = { ...s.editedSuggestions };
      delete editedSuggestions[input.suggestion_id];
      // Phase G Step 3b-1: 自動修正済を直接 reject する経路にも対応
      const autoCorrectedSuggestionIds = s.autoCorrectedSuggestionIds.filter(
        (id) => id !== input.suggestion_id,
      );
      const rejectedSuggestionIds = [
        ...s.rejectedSuggestionIds,
        input.suggestion_id,
      ];
      // 2026-05-25: targetSuggestion を pickNext より前に lookup(2026-05-28 ②④ の
      // reEvaluating 算出 + actionLog snapshot に使う)。
      const targetSuggestion = s.analysisResult?.suggestions.find(
        (sug) => sug.id === input.suggestion_id,
      );
      // 2026-05-28 dogfood round 3 ②④: 拒否は常に scoped refresh を発火する(seed = この id)。
      // reEvaluating = 拒否した id + その related_suggestion_ids の union。
      // (拒否で AI が「この方向は不要」を受けて関連指摘の rationale 等を見直す可能性がある範囲)
      const reEvaluatingIds = computeReEvaluatingIds(
        [input.suggestion_id],
        s.analysisResult?.suggestions ?? [],
      );
      // 2026-05-25 (1 件詳細展開モード): 拒否直後も「次の未処理 suggestion」を自動選択。
      // 2026-05-28 ②: 再評価中の id 群(reEvaluatingIds)を excludeIds で次の自動選択から外す。
      const nextSelectedId = pickNextPendingSuggestionId({
        suggestions: s.analysisResult?.suggestions ?? [],
        acceptedSuggestionIds,
        rejectedSuggestionIds,
        editedSuggestions,
        autoCorrectedSuggestionIds,
        showAlternatives: s.showAlternatives,
        excludeIds: reEvaluatingIds,
      });
      // 2026-05-25: actionLog 1:1 同期
      const logEntry: ActionLogEntry = {
        id: generateActionLogId(),
        type: "rejected",
        esVersion: s.clientEsVersion + 1,
        timestamp: Date.now(),
        suggestionId: input.suggestion_id,
        suggestionCategory: targetSuggestion?.category,
        suggestionOriginalSnippet: targetSuggestion
          ? buildSuggestionSnippet(targetSuggestion.original)
          : undefined,
        suggestionSummary: input.suggestion_summary,
        // 2026-05-30 N5: 却下時点で自動修正対象だったかを snapshot(undo の復元判定用)。
        rejectedWasAutoError: targetSuggestion?.category === "error",
      };
      const actionLog = markOutdatedForSuggestion(
        s.actionLog,
        input.suggestion_id,
      );
      return {
        rejectedSuggestionIds,
        acceptedSuggestionIds,
        editedSuggestions,
        autoCorrectedSuggestionIds,
        actionHistory: [...s.actionHistory, entry],
        actionLog: [...actionLog, logEntry],
        // Phase G Step 3b-3: 新規操作 → redoStack を clear
        // 2026-05-25: actionLog 用 redoLogStack も同期 clear
        redoStack: [],
        redoLogStack: [],
        selectedSuggestionId: nextSelectedId,
        clientEsVersion: s.clientEsVersion + 1,
        // 統合改修パッケージ (2026-05-25): 拒否は AI とユーザーのズレが確定
        //  → 影響範囲限定モードで partial refresh を発火(scoped、seed = この id)。
        // pendingRefreshScope に scope を保存して trigger を +1。
        partialRefreshTrigger: s.partialRefreshTrigger + 1,
        pendingRefreshScope: {
          kind: "scoped",
          seedIds: [input.suggestion_id],
          reason: "reject",
        },
        // 2026-05-28 dogfood round 3 ④: 再評価中の指摘群を mark(badge 表示用)。
        reEvaluatingSuggestionIds: reEvaluatingIds,
      };
    });
  },

  // 編集して採用: EDITED entry を append、editedSuggestions に保存、Popover を閉じる。
  // ES 本文の派生計算は getDerivedEsBody でで行う(該当 span を edited_text で置換)。
  // Phase G Step 2: clientEsVersion +1(EDITED は ES 派生表示を変えるので必ず進める)。
  // Phase G Step 3b-1 (2026-05-23): 自動修正された error をユーザーが「編集して採用」
  //   に切り替えた場合、autoCorrectedSuggestionIds からも除外(編集済 status が
  //   自動修正済 status を上書きする — ユーザーの明示的編集が優先)。
  editSuggestion: (input) => {
    set((s) => {
      const entry: ActionHistoryEntry = {
        verb: "EDITED",
        suggestion_id: input.suggestion_id,
        suggestion_summary: input.suggestion_summary,
        edited_text: input.edited_text,
      };
      // accepted / rejected から除外(編集して採用は accepted の上位状態と扱う)。
      const acceptedSuggestionIds = s.acceptedSuggestionIds.filter(
        (id) => id !== input.suggestion_id,
      );
      const rejectedSuggestionIds = s.rejectedSuggestionIds.filter(
        (id) => id !== input.suggestion_id,
      );
      // Phase G Step 3b-1: 自動修正済からも除外(ユーザーの明示編集が優先)
      const autoCorrectedSuggestionIds = s.autoCorrectedSuggestionIds.filter(
        (id) => id !== input.suggestion_id,
      );
      // 統合改修パッケージ (2026-05-25): 編集して採用は意味的差分判定を経由する必要あり。
      // semanticDiffQueue に「before(該当 suggestion の proposed)/ after(ユーザー編集テキスト)」を
      // enqueue する。Canvas effect が dequeue して /api/semantic-diff を呼び、結果に応じて
      // requestPartialRefresh / skip を決定する。store action 自体は trigger を立てない。
      const targetSuggestion = s.analysisResult?.suggestions.find(
        (sug) => sug.id === input.suggestion_id,
      );
      const beforeText = targetSuggestion?.proposed ?? "";
      const diffEntry: SemanticDiffPendingEntry = {
        before: beforeText,
        after: input.edited_text,
        seedIds: [input.suggestion_id],
        reason: "edit",
      };
      const editedSuggestions = {
        ...s.editedSuggestions,
        [input.suggestion_id]: input.edited_text,
      };
      // 2026-05-28 dogfood round 3 ②④: 編集して採用は semantic-diff 判定を経由して scoped
      // refresh が走りうる(seed = この id)。reEvaluating = 編集した id + その
      // related_suggestion_ids の union を予測 set。
      // 注: semantic-diff が「同じ」と判定して refresh を skip した場合、Canvas の skip 経路で
      //     clearReEvaluating() が呼ばれて予測を取り消す(lingering 防止)。badge は
      //     `&& partialRefreshInProgress` ゲートのため、refresh が走らなければそもそも出ない。
      const reEvaluatingIds = computeReEvaluatingIds(
        [input.suggestion_id],
        s.analysisResult?.suggestions ?? [],
      );
      // 2026-05-25 (1 件詳細展開モード): 編集して採用直後も「次の未処理 suggestion」を自動選択。
      // 2026-05-28 ②: 再評価中の id 群(reEvaluatingIds)を excludeIds で次の自動選択から外す。
      const nextSelectedId = pickNextPendingSuggestionId({
        suggestions: s.analysisResult?.suggestions ?? [],
        acceptedSuggestionIds,
        rejectedSuggestionIds,
        editedSuggestions,
        autoCorrectedSuggestionIds,
        showAlternatives: s.showAlternatives,
        excludeIds: reEvaluatingIds,
      });
      // 2026-05-27 dogfood round 2 Task F: 編集して採用時の proposedSnapshot。
      // dispatch §「詳細仕様」: 「accept 時点の proposed 冒頭 30 字(編集して採用なら編集後)」
      // = proposedText には input.edited_text(ユーザーが編集した最終文字列)を使う。
      // structural は editSuggestion 経路を通らない(structural の編集 UI なし)が、防御的に
      // category check を入れる。
      const isStructuralEdit = targetSuggestion?.category === "structural";
      const proposedSnapshot =
        !isStructuralEdit && targetSuggestion
          ? {
              originalText: buildSuggestionSnippet(targetSuggestion.original),
              proposedText: buildSuggestionSnippet(input.edited_text),
            }
          : undefined;
      // 2026-05-25: actionLog 1:1 同期
      const logEntry: ActionLogEntry = {
        id: generateActionLogId(),
        type: "edited",
        esVersion: s.clientEsVersion + 1,
        timestamp: Date.now(),
        suggestionId: input.suggestion_id,
        suggestionCategory: targetSuggestion?.category,
        suggestionOriginalSnippet: targetSuggestion
          ? buildSuggestionSnippet(targetSuggestion.original)
          : undefined,
        suggestionSummary: input.suggestion_summary,
        editedText: input.edited_text,
        // 2026-05-27 dogfood round 2 Task F: HistoryPanel 用の display snapshot
        ...(proposedSnapshot !== undefined && { proposedSnapshot }),
      };
      const actionLog = markOutdatedForSuggestion(
        s.actionLog,
        input.suggestion_id,
      );
      return {
        editedSuggestions,
        acceptedSuggestionIds,
        rejectedSuggestionIds,
        autoCorrectedSuggestionIds,
        actionHistory: [...s.actionHistory, entry],
        actionLog: [...actionLog, logEntry],
        // Phase G Step 3b-3: 新規操作 → redoStack を clear
        // 2026-05-25: actionLog 用 redoLogStack も同期 clear
        redoStack: [],
        redoLogStack: [],
        selectedSuggestionId: nextSelectedId,
        clientEsVersion: s.clientEsVersion + 1,
        semanticDiffQueue: [...s.semanticDiffQueue, diffEntry],
        // 2026-05-28 dogfood round 3 ④: 再評価中の指摘群を mark(badge は refresh 開始後に出る)。
        // semantic-diff skip 時は Canvas が clearReEvaluating() で取り消す。
        reEvaluatingSuggestionIds: reEvaluatingIds,
      };
    });
  },

  // 直接編集モードのトグル。
  //
  // 2026-05-28 dogfood round 3 ⑤ 直接編集 bug fix(本 fix の中核):
  //  - OFF → ON: 編集欄に「採用を積み重ねた今の ES(派生 ES)」を出すため、
  //    getDerivedEsBody で派生 ES を計算して currentEsBody に **flatten** する。
  //    その時点で適用済だった text 採用 / 編集の id を bakedSuggestionIds に入れ、
  //    以降 getDerivedEsBody が二重適用しないようにする(structural は元から
  //    currentEsBody に焼き込み済なので bake 対象外、category skip で除外される)。
  //    flatten 直前の積み重ね state 一式 + flatten 後の baseline を directEditPending に退避。
  //  - ON → OFF: baseline(flatten 直後の派生 ES)と currentEsBody を比較し、
  //    * 変化なし(ユーザーが何も編集しなかった)→ flatten を **巻き戻し**、
  //      directEditPending を破棄、DIRECT_EDIT entry も作らない(no-op に見せる)。
  //    * 変化あり → DIRECT_EDIT entry に before/after snapshot を載せて append。
  //      意味的差分判定の before は **baseline(編集前の派生 ES)**、after は編集後 currentEsBody。
  //      これにより「積み重ねた ES からの直接編集」が正しい before/after 基準で評価される。
  //
  // 連続編集は「Switch ON→OFF 単位」で 1 entry に集約。精緻な「タイプごとに entry」
  // は実用上ノイズが多く、Phase G の動的 HITL の入力としても粒度が粗い方が扱いやすい。
  toggleDirectEdit: () => {
    set((s) => {
      if (!s.directEditMode) {
        // OFF → ON: 派生 ES を currentEsBody に flatten + baked 集合を確定 + 退避 snapshot。
        const suggestions = s.analysisResult?.suggestions ?? [];
        // 現時点で「適用済」(派生 ES に乗っている)text 採用 / 編集の id。
        // structural は currentEsBody に既に焼き込み済 + getDerivedEsBody で skip されるため
        // bake 集合に入れる必要はない(category skip で除外される)。
        const appliedTextIds = Array.from(
          new Set([
            ...s.acceptedSuggestionIds,
            ...Object.keys(s.editedSuggestions),
          ]),
        ).filter((id) => {
          const sug = suggestions.find((x) => x.id === id);
          // suggestion が見つからない(refresh で消えた等)場合も bake 対象に含める
          // (currentEsBody に焼き込まれた可能性があり、二重適用回避側に倒すのが安全)。
          return sug?.category !== "structural";
        });
        // 既存の baked(過去の直接編集で焼き込み済)も維持して union。
        const newBaked = Array.from(
          new Set([...s.bakedSuggestionIds, ...appliedTextIds]),
        );
        // flatten: 現在の currentEsBody(form.es_body + structural + 過去 baked 反映済)に
        // 残りの text 採用 / 編集を上乗せした派生 ES を算出。bake 済 id は skip される。
        const flattenedBody = getDerivedEsBody(
          s.currentEsBody,
          suggestions,
          s.acceptedSuggestionIds,
          s.editedSuggestions,
          s.bakedSuggestionIds,
        );
        const snapshot: DirectEditStateSnapshot = {
          currentEsBody: s.currentEsBody,
          acceptedSuggestionIds: [...s.acceptedSuggestionIds],
          rejectedSuggestionIds: [...s.rejectedSuggestionIds],
          editedSuggestions: { ...s.editedSuggestions },
          autoCorrectedSuggestionIds: [...s.autoCorrectedSuggestionIds],
          bakedSuggestionIds: [...s.bakedSuggestionIds],
        };
        return {
          directEditMode: true,
          currentEsBody: flattenedBody,
          bakedSuggestionIds: newBaked,
          directEditPending: { snapshot, baselineBody: flattenedBody },
        };
      }
      // ON → OFF。
      const pending = s.directEditPending;
      // 防御: pending が無い異常系(ON を経由せず OFF が呼ばれた等)は旧来同様
      // form.es_body 比較に fallback(壊さない最小挙動)。
      const baselineBody = pending?.baselineBody ?? s.form.es_body;
      const hasChange = s.currentEsBody !== baselineBody;
      if (!hasChange) {
        // 編集なし: flatten を巻き戻して pending を破棄。DIRECT_EDIT entry は作らない。
        if (pending) {
          return {
            directEditMode: false,
            currentEsBody: pending.snapshot.currentEsBody,
            bakedSuggestionIds: [...pending.snapshot.bakedSuggestionIds],
            directEditPending: null,
          };
        }
        return { directEditMode: false, directEditPending: null };
      }
      // 編集あり: DIRECT_EDIT entry を append + 即時 partial refresh(意味的差分判定経由)。
      const description = `直接編集(${s.currentEsBody.length} 字)`;
      const entry: ActionHistoryEntry = {
        verb: "DIRECT_EDIT",
        description,
      };
      // 統合改修パッケージ (2026-05-25): direct edit OFF も意味的差分判定を経由する。
      // 2026-05-28 dogfood round 3 ⑤: before を **baseline(編集前の派生 ES)** にする。
      // 旧実装は before = form.es_body(原文)で、採用を積み重ねた状態を無視していた。
      // 積み重ねた ES からの直接編集の差分を正しく評価するため baseline を渡す。
      const diffEntry: SemanticDiffPendingEntry = {
        before: baselineBody,
        after: s.currentEsBody,
        seedIds: [],
        reason: "direct_edit",
      };
      // before/after の積み重ね state 一式を snapshot に載せる(undo/redo で完全復元)。
      const beforeSnapshot: DirectEditStateSnapshot = pending
        ? pending.snapshot
        : {
            // pending 欠落の防御 fallback(理論上不到達)。
            currentEsBody: s.form.es_body,
            acceptedSuggestionIds: [...s.acceptedSuggestionIds],
            rejectedSuggestionIds: [...s.rejectedSuggestionIds],
            editedSuggestions: { ...s.editedSuggestions },
            autoCorrectedSuggestionIds: [...s.autoCorrectedSuggestionIds],
            bakedSuggestionIds: s.bakedSuggestionIds.filter(
              (id) =>
                !s.acceptedSuggestionIds.includes(id) &&
                !(id in s.editedSuggestions),
            ),
          };
      const afterSnapshot: DirectEditStateSnapshot = {
        currentEsBody: s.currentEsBody,
        acceptedSuggestionIds: [...s.acceptedSuggestionIds],
        rejectedSuggestionIds: [...s.rejectedSuggestionIds],
        editedSuggestions: { ...s.editedSuggestions },
        autoCorrectedSuggestionIds: [...s.autoCorrectedSuggestionIds],
        bakedSuggestionIds: [...s.bakedSuggestionIds],
      };
      // 2026-05-25: actionLog 1:1 同期(direct_edit 用)
      const logEntry: ActionLogEntry = {
        id: generateActionLogId(),
        type: "direct_edit",
        esVersion: s.clientEsVersion + 1,
        timestamp: Date.now(),
        directEditCharCount: s.currentEsBody.length,
        directEditSnapshot: { before: beforeSnapshot, after: afterSnapshot },
      };
      return {
        directEditMode: false,
        directEditPending: null,
        actionHistory: [...s.actionHistory, entry],
        actionLog: [...s.actionLog, logEntry],
        // Phase G Step 3b-3: 新規操作 → redoStack を clear
        // 2026-05-25: actionLog 用 redoLogStack も同期 clear
        redoStack: [],
        redoLogStack: [],
        clientEsVersion: s.clientEsVersion + 1,
        semanticDiffQueue: [...s.semanticDiffQueue, diffEntry],
      };
    });
  },

  // updateEsBody: 直接編集中の contentEditable 入力ごとに呼ばれる。history は
  // append しない(toggle OFF 時に 1 entry にまとめる)。
  // Phase G 修正 (2026-05-23): typing 中は partialRefreshTrigger を **立てない**。
  // direct edit OFF で 1 回まとめて refresh する設計のため、typing 1 回ごとの refresh は不要。
  updateEsBody: (newBody) => {
    set({ currentEsBody: newBody });
  },

  // Phase G Step 3b-3 (2026-05-23): 既存 undoLastAction は undo(1) の薄いラッパに変更。
  // 後方互換のため API は維持。内部で undo(1) を呼び、自動 refresh のデバウンス予約も
  // 同じ経路を辿る。
  undoLastAction: () => {
    get().undo(1);
  },

  // undo: 任意ステップの遡行。
  //   - steps 件を actionHistory の末尾から pop、各 entry を redoStack に push
  //   - 各 entry を per-entry revert ロジック(既存 undoLastAction と完全に同じ)で巻き戻し
  //   - clientEsVersion は合計 +1(1 回のユーザー操作 = 1 version の規律、refresh 整合)
  //   - 自動 refresh のデバウンス予約(3000ms)を発火
  undo: (steps = 1) => {
    if (steps <= 0) return;
    let didChange = false;
    set((s) => {
      if (s.actionHistory.length === 0) return {};
      const requestedPop = Math.min(steps, s.actionHistory.length);
      // G3 C7 fix (2026-05-28): bulk(同一 groupId)を 1 単位として戻すため、pop 件数を
      // group 境界まで拡張する。actionLog は actionHistory と 1:1 同期のため、拡張後の
      // 件数は両方に同じく適用される。group なし / 単体操作は requestedPop のまま不変。
      const popCount = expandPopCountToGroupBoundary(s.actionLog, requestedPop);
      const remaining = s.actionHistory.slice(0, s.actionHistory.length - popCount);
      // 末尾から popCount 件を取得(最新が末尾、古い順に redoStack へ積む = redo は LIFO)
      const popped = s.actionHistory.slice(s.actionHistory.length - popCount);
      // v2 Phase B3 (2026-05-26): actionLog 側も同数 slice、ACCEPTED の structural snapshot
      // 参照用に逆順 traverse 中で対応 entry を引く(actionHistory と actionLog は 1:1 同期)。
      const poppedLogForUndo = s.actionLog.slice(s.actionLog.length - popCount);
      // 巻き戻しは「最新 entry から順に」処理する(同じ id への複数操作で正しい状態に戻る)
      // 処理対象の各 entry を逆順 traverse、state delta を蓄積していく。
      let acceptedSuggestionIds = s.acceptedSuggestionIds;
      let rejectedSuggestionIds = s.rejectedSuggestionIds;
      let editedSuggestions = { ...s.editedSuggestions };
      let autoCorrectedSuggestionIds = s.autoCorrectedSuggestionIds;
      let currentEsBody = s.currentEsBody;
      // 2026-05-28 dogfood round 3 ⑤: 直接編集 undo で baked 集合も巻き戻すため可変ローカル化。
      let bakedSuggestionIds = s.bakedSuggestionIds;
      for (let i = popped.length - 1; i >= 0; i--) {
        const entry = popped[i];
        switch (entry.verb) {
          case "ACCEPTED": {
            acceptedSuggestionIds = acceptedSuggestionIds.filter(
              (id) => id !== entry.suggestion_id,
            );
            // v2 Phase B3 (2026-05-26): structural 採用の undo で派生 ES を巻き戻す。
            // 対応する poppedLogForUndo entry(同 index = actionLog と actionHistory が
            // 1:1 同期されている前提)から currentEsBodyBefore snapshot を取得。
            // structural 以外の suggestion / 古い entry(snapshot 未保存)では undefined
            // のため currentEsBody は変えない(従来挙動維持)。
            const correspondingLog = poppedLogForUndo[i];
            if (
              correspondingLog?.suggestionCategory === "structural" &&
              correspondingLog.currentEsBodyBefore !== undefined &&
              correspondingLog.suggestionId === entry.suggestion_id
            ) {
              currentEsBody = correspondingLog.currentEsBodyBefore;
            }
            break;
          }
          case "REJECTED": {
            // Phase G Step 3b-1: 自動修正取り消し(undoAutoCorrection)も REJECTED entry を
            //   生成するため、却下対象が自動修正(category === "error")だったなら undo で
            //   accepted + autoCorrected に復元する。
            // 2026-05-30 N5: 判定を **却下時点 snapshot**(correspondingLog.rejectedWasAutoError)
            //   に切り替える。旧実装は **現在の** analysisResult から category を再導出して
            //   いたため、間に refresh が走って result が差し替わると id 消滅 / 再分類で
            //   復元状態がずれた(自動修正だったのに pending のまま等)。snapshot を真とし、
            //   ライブ result は参照しない。snapshot 未保存の旧 entry のみ従来挙動へ fallback。
            const correspondingRejectLog = poppedLogForUndo[i];
            const isAutoErrorId =
              correspondingRejectLog?.suggestionId === entry.suggestion_id &&
              correspondingRejectLog?.rejectedWasAutoError !== undefined
                ? correspondingRejectLog.rejectedWasAutoError
                : s.analysisResult?.suggestions.some(
                    (sug) =>
                      sug.id === entry.suggestion_id &&
                      sug.category === "error",
                  );
            rejectedSuggestionIds = rejectedSuggestionIds.filter(
              (id) => id !== entry.suggestion_id,
            );
            if (isAutoErrorId) {
              if (!acceptedSuggestionIds.includes(entry.suggestion_id)) {
                acceptedSuggestionIds = [
                  ...acceptedSuggestionIds,
                  entry.suggestion_id,
                ];
              }
              if (!autoCorrectedSuggestionIds.includes(entry.suggestion_id)) {
                autoCorrectedSuggestionIds = [
                  ...autoCorrectedSuggestionIds,
                  entry.suggestion_id,
                ];
              }
            }
            break;
          }
          case "EDITED":
            delete editedSuggestions[entry.suggestion_id];
            break;
          case "DIRECT_EDIT": {
            // 2026-05-28 dogfood round 3 ⑤ 直接編集 bug fix:
            // 旧実装は currentEsBody = form.es_body にリセットするだけで、積み重ねた
            // 採用 / 編集 / baked 集合を復元せず「すべての操作は Undo 可能」を実質破っていた。
            // 修正後: 対応する actionLog entry の directEditSnapshot.before に復元する
            // (currentEsBody + accepted/rejected/edited/auto + baked 一式)。
            const correspondingLog = poppedLogForUndo[i];
            const before = correspondingLog?.directEditSnapshot?.before;
            if (before) {
              currentEsBody = before.currentEsBody;
              acceptedSuggestionIds = [...before.acceptedSuggestionIds];
              rejectedSuggestionIds = [...before.rejectedSuggestionIds];
              editedSuggestions = { ...before.editedSuggestions };
              autoCorrectedSuggestionIds = [...before.autoCorrectedSuggestionIds];
              bakedSuggestionIds = [...before.bakedSuggestionIds];
            } else {
              // 旧 entry(snapshot 未保存)への後方互換 fallback: 従来挙動(form.es_body 戻し)。
              currentEsBody = s.form.es_body;
            }
            break;
          }
          case "PENDING": {
            // G3 C6 fix (2026-05-28): revert(pending 戻し)の undo は元 status を復元する。
            // 旧実装は no-op で、「この操作を取り消す」→ ツールバー Undo しても元の採用/却下/
            // 編集状態に戻らなかった(Codex 独立レビュー C6)。
            // 対応する actionLog entry(type === "reverted")の revertSnapshot から復元する。
            // revert は全集合から id を外しているため、まず該当 id を全集合から外した状態に
            // 正規化してから、snapshot が示す元集合へ戻す(冪等・順序非依存)。
            const correspondingLog = poppedLogForUndo[i];
            const snap = correspondingLog?.revertSnapshot;
            if (snap) {
              acceptedSuggestionIds = acceptedSuggestionIds.filter(
                (id) => id !== entry.suggestion_id,
              );
              rejectedSuggestionIds = rejectedSuggestionIds.filter(
                (id) => id !== entry.suggestion_id,
              );
              autoCorrectedSuggestionIds = autoCorrectedSuggestionIds.filter(
                (id) => id !== entry.suggestion_id,
              );
              delete editedSuggestions[entry.suggestion_id];
              if (snap.editedText !== undefined) {
                editedSuggestions[entry.suggestion_id] = snap.editedText;
              }
              if (snap.wasAccepted) {
                acceptedSuggestionIds = [
                  ...acceptedSuggestionIds,
                  entry.suggestion_id,
                ];
              }
              if (snap.wasRejected) {
                rejectedSuggestionIds = [
                  ...rejectedSuggestionIds,
                  entry.suggestion_id,
                ];
              }
              if (snap.wasAuto) {
                autoCorrectedSuggestionIds = [
                  ...autoCorrectedSuggestionIds,
                  entry.suggestion_id,
                ];
              }
            }
            // snapshot 未保存の旧 entry は従来挙動(no-op)を維持(後方互換)。
            break;
          }
          default:
            // 状態変更なし(history と redoStack のみ動く)
            break;
        }
      }
      didChange = true;
      // 2026-05-25: actionLog も同数 pop して redoLogStack に積む(1:1 整合維持)
      const remainingLog = s.actionLog.slice(0, s.actionLog.length - popCount);
      const poppedLog = s.actionLog.slice(s.actionLog.length - popCount);
      return {
        acceptedSuggestionIds,
        rejectedSuggestionIds,
        editedSuggestions,
        autoCorrectedSuggestionIds,
        currentEsBody,
        // 2026-05-28 dogfood round 3 ⑤: baked 集合も巻き戻し結果を反映。
        bakedSuggestionIds,
        actionHistory: remaining,
        // redo は LIFO、新しい entry が末尾。popped は古い→新しい順なので、そのまま
        // 末尾に concat すれば LIFO スタックとして機能する(redo の pop は末尾から)。
        redoStack: [...s.redoStack, ...popped],
        actionLog: remainingLog,
        redoLogStack: [...s.redoLogStack, ...poppedLog],
        clientEsVersion: s.clientEsVersion + 1,
        // 統合改修パッケージ (2026-05-25): Undo は「やっぱり違う」のシグナル → 影響範囲限定 partial を発火。
        //   seedIds は popped 内の reject / edit 対象を抽出(undo した変更が再評価範囲の起点になる)。
        partialRefreshTrigger: s.partialRefreshTrigger + 1,
        pendingRefreshScope: {
          kind: "scoped",
          seedIds: collectSeedIdsFromEntries(popped),
          reason: "undo",
        },
      };
    });
    // didChange は将来の用途のため保持(本リファクタで使われていない)
    void didChange;
  },

  // redo: 任意ステップの再適用。redoStack の末尾(最新)から steps 件を pop、
  //   actionHistory に push、state を re-apply する。
  //   acceptSuggestion 等の per-action re-apply ロジックを inline で再現する。
  redo: (steps = 1) => {
    if (steps <= 0) return;
    let didChange = false;
    set((s) => {
      if (s.redoStack.length === 0) return {};
      const requestedPop = Math.min(steps, s.redoStack.length);
      // G3 C7 fix (2026-05-28): bulk(同一 groupId)を 1 単位として redo するため、redoLogStack
      // 側の group 境界まで pop 件数を拡張(undo の拡張と対称)。redoStack と redoLogStack は
      // 1:1 同期のため拡張後件数は両方に適用される。group なし / 単体操作は不変。
      const popCount = expandPopCountToGroupBoundary(
        s.redoLogStack,
        requestedPop,
      );
      const popped = s.redoStack.slice(s.redoStack.length - popCount);
      const remaining = s.redoStack.slice(0, s.redoStack.length - popCount);
      // popped は古い→新しい順(undo で末尾に積んだ順そのまま)。
      // 再適用は「古い entry から順に」進めれば良い(undo が最新から戻したのと逆順)。
      // 2026-05-25: redoLogStack も同数 pop。popped[i] と 1:1 対応(同 index)。
      const poppedLogForRedo = s.redoLogStack.slice(
        s.redoLogStack.length - popCount,
      );
      let acceptedSuggestionIds = s.acceptedSuggestionIds;
      let rejectedSuggestionIds = s.rejectedSuggestionIds;
      let editedSuggestions = { ...s.editedSuggestions };
      let autoCorrectedSuggestionIds = s.autoCorrectedSuggestionIds;
      // currentEsBody:
      //  - 2026-05-28 dogfood round 3 ⑤: DIRECT_EDIT の redo は directEditSnapshot.after に
      //    復元(undo/redo を対称化、「すべての操作は Undo 可能」を redo 側でも完結)。
      //  - v2 Phase B3 (2026-05-26): structural ACCEPTED の redo では analysisResult から
      //    suggestion を引いて applyStructuralOperation を再適用(snapshot を持たないため
      //    再計算、純粋関数なので同 input → 同 output が保証される)
      let currentEsBody = s.currentEsBody;
      // 2026-05-28 dogfood round 3 ⑤: 直接編集 redo で baked 集合も再適用するため可変ローカル化。
      let bakedSuggestionIds = s.bakedSuggestionIds;
      const newHistory = [...s.actionHistory];
      for (let i = 0; i < popped.length; i++) {
        const entry = popped[i];
        switch (entry.verb) {
          case "ACCEPTED": {
            // acceptSuggestion の re-apply 相当: 既存 reject / auto から外し accepted に
            rejectedSuggestionIds = rejectedSuggestionIds.filter(
              (id) => id !== entry.suggestion_id,
            );
            autoCorrectedSuggestionIds = autoCorrectedSuggestionIds.filter(
              (id) => id !== entry.suggestion_id,
            );
            if (!acceptedSuggestionIds.includes(entry.suggestion_id)) {
              acceptedSuggestionIds = [
                ...acceptedSuggestionIds,
                entry.suggestion_id,
              ];
            }
            // v2 Phase B3 (2026-05-26): structural の redo は派生 ES を再適用。
            // 純粋関数なので同 input → 同 output、snapshot 持たずに再計算で復元可能。
            // analysisResult が refresh で入れ替わっている場合 suggestion が見つからない
            // 可能性があるが、その場合は no-op(currentEsBody を変えない、防御的)。
            const targetSuggestion = s.analysisResult?.suggestions.find(
              (sug) => sug.id === entry.suggestion_id,
            );
            if (
              targetSuggestion?.category === "structural" &&
              targetSuggestion.structural_params !== undefined
            ) {
              currentEsBody = applyStructuralOperation(
                currentEsBody,
                targetSuggestion.structural_params,
              );
            }
            break;
          }
          case "REJECTED":
            // rejectSuggestion の re-apply 相当: accepted / edited / auto から外し rejected に
            acceptedSuggestionIds = acceptedSuggestionIds.filter(
              (id) => id !== entry.suggestion_id,
            );
            delete editedSuggestions[entry.suggestion_id];
            autoCorrectedSuggestionIds = autoCorrectedSuggestionIds.filter(
              (id) => id !== entry.suggestion_id,
            );
            if (!rejectedSuggestionIds.includes(entry.suggestion_id)) {
              rejectedSuggestionIds = [
                ...rejectedSuggestionIds,
                entry.suggestion_id,
              ];
            }
            break;
          case "EDITED":
            // editSuggestion の re-apply 相当: accepted / rejected / auto から外し edited に
            acceptedSuggestionIds = acceptedSuggestionIds.filter(
              (id) => id !== entry.suggestion_id,
            );
            rejectedSuggestionIds = rejectedSuggestionIds.filter(
              (id) => id !== entry.suggestion_id,
            );
            autoCorrectedSuggestionIds = autoCorrectedSuggestionIds.filter(
              (id) => id !== entry.suggestion_id,
            );
            editedSuggestions[entry.suggestion_id] = entry.edited_text;
            break;
          case "DIRECT_EDIT": {
            // 2026-05-28 dogfood round 3 ⑤ 直接編集 bug fix:
            // 旧実装は redo で何もしなかった(undo は form.es_body に戻すだけだった)。
            // 修正後: 対応する actionLog entry の directEditSnapshot.after に復元
            // (currentEsBody + accepted/rejected/edited/auto + baked 一式)。undo と対称。
            const correspondingLog = poppedLogForRedo[i];
            const after = correspondingLog?.directEditSnapshot?.after;
            if (after) {
              currentEsBody = after.currentEsBody;
              acceptedSuggestionIds = [...after.acceptedSuggestionIds];
              rejectedSuggestionIds = [...after.rejectedSuggestionIds];
              editedSuggestions = { ...after.editedSuggestions };
              autoCorrectedSuggestionIds = [...after.autoCorrectedSuggestionIds];
              bakedSuggestionIds = [...after.bakedSuggestionIds];
            }
            // after 欠落の旧 entry は従来通り何もしない(後方互換 fallback)。
            break;
          }
          case "PENDING": {
            // G3 C6 fix (2026-05-28): revert(pending 戻し)の redo は再度 revert を適用する
            // (= 該当 id を全集合から外す = pending 状態)。undo の復元と対称。
            // revertSnapshot の有無に関わらず「pending = どこにも属さない」へ正規化すればよい。
            const correspondingLog = poppedLogForRedo[i];
            if (correspondingLog?.revertSnapshot) {
              acceptedSuggestionIds = acceptedSuggestionIds.filter(
                (id) => id !== entry.suggestion_id,
              );
              rejectedSuggestionIds = rejectedSuggestionIds.filter(
                (id) => id !== entry.suggestion_id,
              );
              autoCorrectedSuggestionIds = autoCorrectedSuggestionIds.filter(
                (id) => id !== entry.suggestion_id,
              );
              delete editedSuggestions[entry.suggestion_id];
            }
            // snapshot 未保存の旧 entry は従来挙動(no-op)を維持(後方互換)。
            break;
          }
          default:
            break;
        }
        newHistory.push(entry);
      }
      didChange = true;
      // 2026-05-25: actionLog 用 redoLogStack も同数 pop して actionLog に push(1:1 整合維持)。
      // 2026-05-28 dogfood round 3 ⑤: pop 済 poppedLogForRedo を再利用(上で slice 済)。
      const remainingLog = s.redoLogStack.slice(0, s.redoLogStack.length - popCount);
      return {
        acceptedSuggestionIds,
        rejectedSuggestionIds,
        editedSuggestions,
        autoCorrectedSuggestionIds,
        currentEsBody,
        // 2026-05-28 dogfood round 3 ⑤: baked 集合も再適用結果を反映。
        bakedSuggestionIds,
        actionHistory: newHistory,
        redoStack: remaining,
        actionLog: [...s.actionLog, ...poppedLogForRedo],
        redoLogStack: remainingLog,
        clientEsVersion: s.clientEsVersion + 1,
        // 統合改修パッケージ (2026-05-25): Redo は「やっぱりこちら」のシグナル → 影響範囲限定 partial。
        partialRefreshTrigger: s.partialRefreshTrigger + 1,
        pendingRefreshScope: {
          kind: "scoped",
          seedIds: collectSeedIdsFromEntries(popped),
          reason: "redo",
        },
      };
    });
    void didChange;
  },

  // ---------------------------------------------------------------------------
  // 自動修正の Undo actions (Phase G Step 3b-1 追加)
  // ---------------------------------------------------------------------------
  // 個別「元に戻す」: 1 件の自動修正を却下に切り替える。
  //   - autoCorrectedSuggestionIds から該当 id を削除
  //   - acceptedSuggestionIds から該当 id を削除(派生 ES の置換を外す)
  //   - rejectedSuggestionIds に該当 id を追加(却下扱い)
  //   - action_history に REJECTED entry を追加(通常の却下と同じ形)
  //   - clientEsVersion +1(操作確定で必ず進める、refresh 整合性)
  undoAutoCorrection: (input) => {
    let didChange = false;
    set((s) => {
      // 該当 id が autoCorrectedSuggestionIds に無ければ no-op(防御的)
      if (!s.autoCorrectedSuggestionIds.includes(input.suggestion_id)) {
        return {};
      }
      didChange = true;
      const entry: ActionHistoryEntry = {
        verb: "REJECTED",
        suggestion_id: input.suggestion_id,
        suggestion_summary: input.suggestion_summary,
      };
      // 2026-05-25: actionLog 1:1 同期(auto_corrected_undo として区別)
      const targetSuggestion = s.analysisResult?.suggestions.find(
        (sug) => sug.id === input.suggestion_id,
      );
      const logEntry: ActionLogEntry = {
        id: generateActionLogId(),
        type: "auto_corrected_undo",
        esVersion: s.clientEsVersion + 1,
        timestamp: Date.now(),
        suggestionId: input.suggestion_id,
        suggestionCategory: targetSuggestion?.category,
        suggestionOriginalSnippet: targetSuggestion
          ? buildSuggestionSnippet(targetSuggestion.original)
          : undefined,
        suggestionSummary: input.suggestion_summary,
        // 2026-05-30 N5: 自動修正取り消し = 対象は自動修正(error)だったことを snapshot 固定。
        // (undoAutoCorrection は autoCorrectedSuggestionIds = error のみを対象とするため真)
        rejectedWasAutoError: true,
      };
      const actionLog = markOutdatedForSuggestion(
        s.actionLog,
        input.suggestion_id,
      );
      return {
        autoCorrectedSuggestionIds: s.autoCorrectedSuggestionIds.filter(
          (id) => id !== input.suggestion_id,
        ),
        acceptedSuggestionIds: s.acceptedSuggestionIds.filter(
          (id) => id !== input.suggestion_id,
        ),
        rejectedSuggestionIds: s.rejectedSuggestionIds.includes(
          input.suggestion_id,
        )
          ? s.rejectedSuggestionIds
          : [...s.rejectedSuggestionIds, input.suggestion_id],
        actionHistory: [...s.actionHistory, entry],
        actionLog: [...actionLog, logEntry],
        // Phase G Step 3b-3: 新規操作 → redoStack を clear
        // 2026-05-25: actionLog 用 redoLogStack も同期 clear
        redoStack: [],
        redoLogStack: [],
        clientEsVersion: s.clientEsVersion + 1,
        // 統合改修パッケージ (2026-05-25): 自動修正取り消しは reject 相当 → 影響範囲限定 partial。
        partialRefreshTrigger: s.partialRefreshTrigger + 1,
        pendingRefreshScope: {
          kind: "scoped",
          seedIds: [input.suggestion_id],
          reason: "reject",
        },
      };
    });
    void didChange;
  },

  // 「全て元に戻す」: 現在の autoCorrectedSuggestionIds を一括で却下に切り替える。
  //   - 1 回のユーザー操作 = 1 version の規律のため、ループ内で +1 せず最後に +1
  //   - action_history には各 id ごとに REJECTED entry を追加(個別 undo と整合)
  //   - 入力は呼び出し側(Canvas / Banner)が組み立てる:
  //     inputs = autoCorrectedSuggestionIds.map(id => ({ suggestion_id, suggestion_summary }))
  undoAllAutoCorrections: (inputs) => {
    let didChange = false;
    set((s) => {
      if (inputs.length === 0) return {};
      // 全 input の id 集合(SET)を作って一括操作
      const idsToUndo = new Set(inputs.map((i) => i.suggestion_id));
      // 実際に auto-corrected の中にあるもののみ処理(防御的)
      const validInputs = inputs.filter((i) =>
        s.autoCorrectedSuggestionIds.includes(i.suggestion_id),
      );
      if (validInputs.length === 0) return {};
      didChange = true;
      const entries: ActionHistoryEntry[] = validInputs.map((i) => ({
        verb: "REJECTED",
        suggestion_id: i.suggestion_id,
        suggestion_summary: i.suggestion_summary,
      }));
      // rejected 集合に追加(既存と union、重複除外)
      const newRejected = Array.from(
        new Set([
          ...s.rejectedSuggestionIds,
          ...validInputs.map((i) => i.suggestion_id),
        ]),
      );
      // 2026-05-25: actionLog 1:1 同期 — 一括取り消しは個別 entry × N(同 timestamp / esVersion)
      // 各 entry を type: "auto_corrected_undo_all" とし、undoAllCount で件数を保持
      // (history panel で「一括取り消し操作の一部」と分かるよう)。
      const now = Date.now();
      const nextEsVersion = s.clientEsVersion + 1;
      // G3 C7 fix (2026-05-28): bulk 全 entry に同一 groupId を付与。undo/redo が
      // 同一 group の連続 entry を 1 単位としてまとめて処理する(Undo 1 回で全件復元)。
      const bulkGroupId = generateActionLogId();
      const logEntries: ActionLogEntry[] = validInputs.map((i) => {
        const target = s.analysisResult?.suggestions.find(
          (sug) => sug.id === i.suggestion_id,
        );
        return {
          id: generateActionLogId(),
          type: "auto_corrected_undo_all" as const,
          esVersion: nextEsVersion,
          timestamp: now,
          suggestionId: i.suggestion_id,
          suggestionCategory: target?.category,
          suggestionOriginalSnippet: target
            ? buildSuggestionSnippet(target.original)
            : undefined,
          suggestionSummary: i.suggestion_summary,
          undoAllCount: validInputs.length,
          groupId: bulkGroupId,
          // 2026-05-30 N5: 一括取り消しも対象は自動修正(error)。snapshot 固定。
          rejectedWasAutoError: true,
        };
      });
      // 個別 outdated マーク(複数の suggestion を一括で)
      let actionLog = s.actionLog;
      for (const i of validInputs) {
        actionLog = markOutdatedForSuggestion(actionLog, i.suggestion_id);
      }
      return {
        autoCorrectedSuggestionIds: s.autoCorrectedSuggestionIds.filter(
          (id) => !idsToUndo.has(id),
        ),
        acceptedSuggestionIds: s.acceptedSuggestionIds.filter(
          (id) => !idsToUndo.has(id),
        ),
        rejectedSuggestionIds: newRejected,
        actionHistory: [...s.actionHistory, ...entries],
        actionLog: [...actionLog, ...logEntries],
        // Phase G Step 3b-3: 新規操作 → redoStack を clear
        // 2026-05-25: actionLog 用 redoLogStack も同期 clear
        redoStack: [],
        redoLogStack: [],
        clientEsVersion: s.clientEsVersion + 1,
        // 統合改修パッケージ (2026-05-25): 一括取り消しは複数 seed → 影響範囲限定 partial。
        partialRefreshTrigger: s.partialRefreshTrigger + 1,
        pendingRefreshScope: {
          kind: "scoped",
          seedIds: validInputs.map((i) => i.suggestion_id),
          reason: "reject",
        },
      };
    });
    void didChange;
  },

  // ---------------------------------------------------------------------------
  // 履歴 review / revert action (2026-05-25 追加)
  // ---------------------------------------------------------------------------
  // 任意の suggestion を現在 status から pending に戻す。per-card revert ボタン +
  // 履歴タブの「この操作を取り消す」両方が呼ぶ共通エントリ。
  //
  // 実装ロジック:
  //  1) 該当 id を acceptedSuggestionIds / rejectedSuggestionIds / editedSuggestions /
  //     autoCorrectedSuggestionIds の **すべての集合** から除外(pending = どこにも属さない状態)
  //  2) actionHistory に PENDING entry を append(LLM が「ユーザーが過去判断を取り消した」と
  //     読める形)。PENDING verb は ActionHistoryAcceptedRejectedSchema で許容済。
  //  3) actionLog に type: "reverted" entry を append、revertedFromEntryId で関連 entry を指す
  //  4) markOutdatedForSuggestion で過去 entry をマーク
  //  5) selectedSuggestionId を該当 id にする(revert 直後に該当 suggestion の詳細表示に切替)。
  //     これにより per-card revert(対象カードの真上から呼ぶ)+ history revert(中央に該当を
  //     表示する)両方で「revert した対象が見える」UX になる
  //  6) clientEsVersion +1 + 影響範囲限定 partial refresh を発火(reason = "manual"、AI に
  //     「ユーザーがこの id を再評価したい」と伝える)
  revertSuggestionAction: (input) => {
    set((s) => {
      const id = input.suggestion_id;
      // 防御: どの集合にも属さない = 既に pending → no-op
      const wasAccepted = s.acceptedSuggestionIds.includes(id);
      const wasRejected = s.rejectedSuggestionIds.includes(id);
      const wasEdited = id in s.editedSuggestions;
      const wasAuto = s.autoCorrectedSuggestionIds.includes(id);
      if (!wasAccepted && !wasRejected && !wasEdited && !wasAuto) {
        return {};
      }
      // G3 C6 fix (2026-05-28): revert 前の編集テキストを snapshot に残す(undo 復元用)。
      const priorEditedText = wasEdited ? s.editedSuggestions[id] : undefined;
      const acceptedSuggestionIds = s.acceptedSuggestionIds.filter(
        (x) => x !== id,
      );
      const rejectedSuggestionIds = s.rejectedSuggestionIds.filter(
        (x) => x !== id,
      );
      const editedSuggestions = { ...s.editedSuggestions };
      delete editedSuggestions[id];
      const autoCorrectedSuggestionIds = s.autoCorrectedSuggestionIds.filter(
        (x) => x !== id,
      );
      // actionHistory: PENDING entry を追加(LLM が読む形)
      const historyEntry: ActionHistoryEntry = {
        verb: "PENDING",
        suggestion_id: id,
        suggestion_summary: input.suggestion_summary,
      };
      // actionLog: type: "reverted" entry を追加
      const target = s.analysisResult?.suggestions.find((sug) => sug.id === id);
      const logEntry: ActionLogEntry = {
        id: generateActionLogId(),
        type: "reverted",
        esVersion: s.clientEsVersion + 1,
        timestamp: Date.now(),
        suggestionId: id,
        suggestionCategory: target?.category,
        suggestionOriginalSnippet: target
          ? buildSuggestionSnippet(target.original)
          : undefined,
        suggestionSummary: input.suggestion_summary,
        revertedFromEntryId: input.revertedFromEntryId,
        // G3 C6 fix (2026-05-28): revert 前 status を snapshot。undo で本 snapshot から復元、
        // redo で再 revert(undo/redo 対称)。
        revertSnapshot: {
          wasAccepted,
          wasRejected,
          wasAuto,
          editedText: priorEditedText,
        },
      };
      const actionLog = markOutdatedForSuggestion(s.actionLog, id);
      return {
        acceptedSuggestionIds,
        rejectedSuggestionIds,
        editedSuggestions,
        autoCorrectedSuggestionIds,
        actionHistory: [...s.actionHistory, historyEntry],
        actionLog: [...actionLog, logEntry],
        // 新規操作 → redoStack を clear
        // 2026-05-25: actionLog 用 redoLogStack も同期 clear
        redoStack: [],
        redoLogStack: [],
        // revert 直後は対象 suggestion を選択(per-card revert / history revert 両経路で
        // ユーザーに対象が見える、判断疲労を抑える)
        selectedSuggestionId: id,
        clientEsVersion: s.clientEsVersion + 1,
        // 影響範囲限定 partial refresh を発火(AI に「ユーザーがこの id を再評価したい」と伝える)
        partialRefreshTrigger: s.partialRefreshTrigger + 1,
        pendingRefreshScope: {
          kind: "scoped",
          seedIds: [id],
          reason: "manual",
        },
      };
    });
  },

  // ---------------------------------------------------------------------------
  // 楽観的並行制御 actions (Phase G Step 2 追加)
  // ---------------------------------------------------------------------------
  // beginRefresh: 新規 refresh 発火の準備。前の AbortController があれば abort、
  //   新規 AbortController を生成、inflightRefreshVersion を立てて返す。
  //   呼び出し側(Canvas の「再分析する」 click handler)は戻り値の
  //   { abortController, baseVersion } を fetch / callRefreshStream に渡す。
  //
  // 注: zustand の set() は同期的に state を更新するが、戻り値を返せない。
  //   そのため beginRefresh は内部で AbortController と baseVersion を生成し、
  //   set() で state にも記録しつつ、関数の戻り値として呼び出し側にも返す
  //   (二重管理だが、AbortController はオブジェクト参照なので state と返り値は
  //   常に同じ参照になる)。
  beginRefresh: (options) => {
    // zustand の `get` で現在 state を取得(circular ref を避ける標準パターン)。
    const state = get();

    // 前の AbortController があれば abort(複数 refresh の並行発火を防ぐ)
    if (state.refreshAbortController) {
      try {
        state.refreshAbortController.abort();
      } catch {
        // 二重 abort の DOMException は無視
      }
    }

    const abortController = new AbortController();
    const baseVersion = state.clientEsVersion;
    // UX 改修 3b: goal 指定がなければ "balanced"(既存呼び出しの後方互換)
    const goal: AnalyzeGoal = options?.goal ?? "balanced";
    // 2026-05-28 並行性 fix C8: 世代を 1 つ進める。partial cleanup timer が後続 refresh の
    // flags を消す競合を防ぐため、Canvas は本戻り値の generation を timer に焼く。
    const generation = state.partialRefreshGeneration + 1;

    set({
      refreshAbortController: abortController,
      inflightRefreshVersion: baseVersion,
      refreshPhase: "loading",
      refreshError: null,
      refreshStreamingStage: "started",
      analyzeGoal: goal,
      partialRefreshGeneration: generation,
    });

    return { abortController, baseVersion, goal, generation };
  },

  // setRefreshStreamingStage: SSE 受信ループから細分化進捗を更新(initial の
  //   setStreamingStage と対称、別 state)。
  setRefreshStreamingStage: (stage) => set({ refreshStreamingStage: stage }),

  // applyRefreshResult: SSE が completed event を受けたら呼ぶ。
  //  - サーバの es_state_version が inflightRefreshVersion + 1 と一致するなら採用
  //    (= 「投げた基準バージョン」と「帰ってきた次バージョン」が往復で一致)
  //  - 一致しなければ「古い応答」として静かに破棄(refreshError は立てない、UI も
  //    変えない、refreshPhase は次の beginRefresh が "loading" に上書きするまで
  //    そのまま)
  //
  // 採用時:
  //  - analysisResult を更新
  //  - clientEsVersion を result.es_state_version に同期(以降の操作はこの値から +1)
  //  - 既存の採用 / 却下 / 編集マップは保持(refresh は ES + suggestions を入れ替える
  //    が、ユーザーの operations 系状態はそのまま、Canvas が新 suggestions の id に
  //    対して同じ操作を再表現する設計)
  //  - interview_questions が undefined のケース(refresh では LLM が生成しない)では
  //    既存の analysisResult.interview_questions が「古い ES バージョン基準」になる
  //    ため、is_stale を true に更新する(Phase H で /api/interview を呼ぶ判断材料)
  //  - refreshPhase = "idle"、refreshStreamingStage = null
  // Phase G Step 3b-1 (2026-05-23): refresh 結果の error カテゴリも自動修正対象。
  //   - 新規 result.suggestions から error を抽出
  //   - ユーザーが明示的に却下/編集していない id のみを自動修正
  //     (rejectedSuggestionIds と editedSuggestions に含まれない id)
  //   - これにより、ユーザーが意図的に取り消した自動修正は refresh 後も尊重される
  //   - autoCorrectedSuggestionIds は新規 result の error id で置き換え(古い id の
  //     残骸を残さない、refresh は新 suggestions セットで開始するため)
  //   - acceptedSuggestionIds は既存のユーザー操作(明示採用)に新規 auto error を
  //     マージ(union、重複は除外)
  applyRefreshResult: (result) => {
    // 2026-05-28 capture(dev 専用): set 前の analysisResult 参照を保持。set 後に参照が
    // 変わっていれば「結果が反映された」= append。version mismatch(conflictNotification 経路)
    // では analysisResult を更新しないため参照が同一 → append されない(意図通り)。
    const prevResult = get().analysisResult;
    set((s) => {
      // 楽観的並行制御 — Phase G Step 3b-3 (2026-05-23): silent discard を廃止し、
      // version 不一致は conflictNotification("full" 種別) に保存してユーザーに選ばせる。
      // 2026-05-28 並行性 fix C1: 判定を shouldApplyRefreshResult に集約。
      //   往復整合(received === inflightBase + 1)に加え「inflight 開始から
      //   clientEsVersion が進んでいない(clientEsVersion === inflightRefreshVersion)」も
      //   要求する。AI 呼び出し中に related なし採用等で clientEsVersion だけ進むと、
      //   古い本文前提の応答が往復整合だけ満たして誤って反映される不具合の修正。
      if (
        !shouldApplyRefreshResult({
          inflightRefreshVersion: s.inflightRefreshVersion,
          clientEsVersion: s.clientEsVersion,
          receivedEsStateVersion: result.es_state_version,
        })
      ) {
        console.info(
          "[analyze_store] applyRefreshResult: version mismatch → conflict notification",
          JSON.stringify({
            inflightBase: s.inflightRefreshVersion,
            receivedVersion: result.es_state_version,
            currentClientVersion: s.clientEsVersion,
          }),
        );
        return {
          conflictNotification: {
            type: "full",
            newResult: result,
            previousSuggestions: s.analysisResult?.suggestions ?? [],
            previousOverallAssessment: s.analysisResult?.overall_assessment,
            detectedAt: Date.now(),
            receivedEsStateVersion: result.es_state_version,
            expectedEsStateVersion:
              s.inflightRefreshVersion !== null
                ? s.inflightRefreshVersion + 1
                : -1,
          },
          inflightRefreshVersion: null,
          refreshAbortController: null,
          refreshPhase: "idle",
          refreshError: null,
          refreshStreamingStage: null,
        };
      }

      // 採用: refresh では interview_questions が undefined のため、既存の
      //   analysisResult.interview_questions を保持しつつ is_stale を true に更新する。
      //   refresh が interview_questions を返した場合は素直にそれを採用(将来の互換性)。
      const previousIQ = s.analysisResult?.interview_questions;
      const nextInterviewQuestions = result.interview_questions
        ? result.interview_questions
        : previousIQ
          ? { ...previousIQ, is_stale: true }
          : undefined;

      // 2026-05-27 derivedSpans 座標系統一 bug fix: applyPartialResult と同様、refresh
      // 結果の suggestions も displayEsBody(派生 ES)基準で resolveOriginalSpans されて
      // いるため、form.es_body 基準に再アンカーする。これにより
      // `analysisResult.suggestions` 全体を form.es_body 基準の単一座標系に揃える。
      // reAnchorSuggestionsToFormEsBody のコメント + DECISIONS [2026-05-27] derivedSpans
      // 座標系統一 実装結果 を参照。
      const reAnchoredSuggestions = reAnchorSuggestionsToFormEsBody(
        s.form.es_body,
        result.suggestions,
      );

      // Phase G 再修正 (2026-05-24): 副次的な候補プール構造を撤去。refresh は全面再分析の
      // 経路として、merge 後の interview_questions の is_stale 更新のみ行う。
      const mergedResult = {
        ...result,
        suggestions: reAnchoredSuggestions,
        interview_questions: nextInterviewQuestions,
      };

      // Phase G Step 3b-1: error の自動修正を refresh 結果でも実行。
      // ただし「ユーザーが明示的に却下/編集した id」はそのままユーザーの意図を尊重。
      // 新規 result.suggestions の error の中から、ユーザー操作を受けていないものを
      // 抽出して自動修正対象とする。
      const newErrorIds = reAnchoredSuggestions
        .filter((sug) => sug.category === "error")
        .map((sug) => sug.id);
      const autoCorrectedIds = newErrorIds.filter(
        (id) =>
          !s.rejectedSuggestionIds.includes(id) && !(id in s.editedSuggestions),
      );
      // acceptedSuggestionIds は既存ユーザー操作(明示採用)+ 新規 auto error を union
      // 重複除外のため Set 経由
      const mergedAccepted = Array.from(
        new Set([...s.acceptedSuggestionIds, ...autoCorrectedIds]),
      );

      // 2026-05-27 エージェント的対話(AI 逆質問): refresh で新 suggestions / global に
      // 存在しない質問への回答を filter で除外(applyPartialResult と同じ規律)。
      // 2026-05-29: question_id 単独だと別 suggestion の同名 q_001 が生き残り、デッドリンク
      // 回答が残ってしまう。複合キー(scope + suggestion_id + question_id)で照合する。
      const newQuestionKeys = new Set<string>();
      for (const sug of reAnchoredSuggestions) {
        for (const q of sug.clarification_questions ?? []) {
          newQuestionKeys.add(
            clarificationIdentity({
              scope: "suggestion",
              suggestion_id: sug.id,
              question_id: q.id,
            }),
          );
        }
      }
      for (const q of result.global_clarification_questions ?? []) {
        newQuestionKeys.add(
          clarificationIdentity({ scope: "global", question_id: q.id }),
        );
      }
      const filteredClarificationAnswers = s.clarificationAnswers.filter((a) =>
        newQuestionKeys.has(
          clarificationIdentity({
            scope: a.scope,
            suggestion_id: a.suggestion_id,
            question_id: a.question_id,
          }),
        ),
      );

      return {
        analysisResult: mergedResult,
        clientEsVersion: result.es_state_version,
        inflightRefreshVersion: null,
        refreshAbortController: null,
        refreshPhase: "idle",
        refreshError: null,
        refreshStreamingStage: null,
        // refresh が新規 suggestions を返したとき、選択中の Popover は古い suggestion
        // を指しているかもしれない → 安全側に倒して閉じる。
        selectedSuggestionId: null,
        // Phase G Step 3a: 同様に hover も新 suggestions を指す可能性があるため
        // refresh 完了時にクリアする(ユーザーが意図せず古い id を hover し続ける事故を防ぐ)
        hoveredSuggestionId: null,
        // Phase G Step 3b-1: 自動修正の再評価
        acceptedSuggestionIds: mergedAccepted,
        autoCorrectedSuggestionIds: autoCorrectedIds,
        // 2026-05-27 エージェント的対話(AI 逆質問): デッドリンク回答 cleanup
        clarificationAnswers: filteredClarificationAnswers,
      };
    });
    // 2026-05-28 capture(dev 専用): 結果が実際に反映された(analysisResult 参照が変わった)
    // ときだけ全体再分析の出力を記録。conflict 分岐では参照不変のため append されない。
    if (get().analysisResult !== prevResult) {
      appendCaptureLog("refresh", get());
    }
  },

  // ---------------------------------------------------------------------------
  // applyPartialResult — Phase G Step 3b-2 (2026-05-23)
  // ---------------------------------------------------------------------------
  // partial update の結果を既存 analysisResult にマージする。
  //
  // 楽観的並行制御:
  //  - applyRefreshResult と同じ規律。`inflightRefreshVersion + 1 === result.es_state_version`
  //    でなければ「古い応答」として silent 破棄(refreshError は立てない)。
  //
  // merge ロジック:
  //  - updated: 既存 suggestions に同 id があれば差し替え、無ければ追加
  //    (refine で「updated[].id は existing にあること」を保証しているが、防御的に存在
  //    しないケースは追加扱いとしておく)
  //  - deleted: 既存 suggestions から該当 id を除外
  //  - added: 既存 suggestions に追加
  //  - overall_assessment: optional、provided なら更新、なければ既存維持
  //  - 合計が > 15 件になった場合は防御的に slice(refine で守れているはずだが安全網)
  //
  // 自動修正の再評価(refresh と同じ規律):
  //  - 新 suggestions セットの error カテゴリを抽出
  //  - ユーザーが明示却下 / 編集した id は除外(尊重)
  //  - autoCorrectedSuggestionIds を更新、acceptedSuggestionIds に union
  //
  // selected / hovered のクリア:
  //  - refresh と同じ精神。partial では「変わってない id」も多いが、安全側で null へ。
  //
  // interview_questions:
  //  - partial 結果は interview_questions を返さない(load-bearing field 維持)。既存
  //    analysisResult.interview_questions の is_stale = true に更新する(refresh と同様)。
  applyPartialResult: (result) => {
    // 2026-05-28 capture(dev 専用): set 前の analysisResult 参照を保持。set 後に参照が
    // 変わっていれば append。version mismatch / overall_assessment 不在(return {})では
    // analysisResult 不変 → append されない(意図通り)。
    const prevResult = get().analysisResult;
    set((s) => {
      // 楽観的並行制御 — Phase G Step 3b-3 (2026-05-23): silent discard を廃止し、
      // version 不一致は conflictNotification に保存してユーザーに選ばせる。
      // 2026-05-28 並行性 fix C1: applyRefreshResult と対称に shouldApplyRefreshResult へ集約。
      //   clientEsVersion === inflightRefreshVersion(inflight 開始から進んでいない)も要求。
      if (
        !shouldApplyRefreshResult({
          inflightRefreshVersion: s.inflightRefreshVersion,
          clientEsVersion: s.clientEsVersion,
          receivedEsStateVersion: result.es_state_version,
        })
      ) {
        console.info(
          "[analyze_store] applyPartialResult: version mismatch → conflict notification",
          JSON.stringify({
            inflightBase: s.inflightRefreshVersion,
            receivedVersion: result.es_state_version,
            currentClientVersion: s.clientEsVersion,
          }),
        );
        // conflictNotification を立てて UI に通知。refresh の inflight 系は cleanup
        // (新しい trigger で次の refresh を受け入れられる状態に戻す)。
        return {
          conflictNotification: {
            type: "partial",
            newResult: result,
            previousSuggestions: s.analysisResult?.suggestions ?? [],
            previousOverallAssessment: s.analysisResult?.overall_assessment,
            detectedAt: Date.now(),
            receivedEsStateVersion: result.es_state_version,
            expectedEsStateVersion:
              s.inflightRefreshVersion !== null
                ? s.inflightRefreshVersion + 1
                : -1,
          },
          inflightRefreshVersion: null,
          refreshAbortController: null,
          refreshPhase: "idle",
          refreshError: null,
          refreshStreamingStage: null,
        };
      }

      // 既存 suggestions に対する merge
      const existing = s.analysisResult?.suggestions ?? [];
      const deletedSet = new Set(result.deleted);

      // 2026-05-27 derivedSpans 座標系統一 bug fix: サーバ側 resolveOriginalSpans は
      // displayEsBody(派生 ES)に対して indexOf 解決するため、partial 応答の updated /
      // added は displayEsBody 基準の `original_span` を持つ。既存 suggestion は form.es_body
      // 基準で merge すると座標系が混在し、Canvas の累積オフセット計算が壊れる。
      // merge 前に form.es_body 基準へ再アンカーすることで `analysisResult.suggestions`
      // 全体を単一座標系に揃える。lib/state/analyze_store.ts:reAnchorSuggestionsToFormEsBody
      // のコメント + DECISIONS [2026-05-27] derivedSpans 座標系統一 実装結果 を参照。
      const reAnchoredUpdated = reAnchorSuggestionsToFormEsBody(
        s.form.es_body,
        result.updated,
      );
      const reAnchoredAdded = reAnchorSuggestionsToFormEsBody(
        s.form.es_body,
        result.added,
      );
      const updatedById = new Map(reAnchoredUpdated.map((u) => [u.id, u]));

      // 2026-05-25 Task #18: partial refresh の animation 制御。
      //  - partialRefreshInProgress が true の間は deleted を suggestions に **残す** ことで
      //    fade out animation を可能にする(UI が pendingDeletedSuggestionIds を読んで
      //    視覚的に「もうすぐ消える」と区別表示)。実削除は commitPartialRefreshCleanup が行う。
      //  - false の場合(直接 API 呼び出し等の経路)は従来通り即時 deleted を除外する。
      //
      // 注: acceptedSuggestionIds / autoCorrectedSuggestionIds の計算は **deleted 除外後の
      //     最終 set** で行う(deleted は「ユーザー意図に合わせて削除すべき」を意味するので、
      //     残しても auto-correct / accepted 状態は持たせない)。UI の animation 用に
      //     suggestions に物理的に残るだけで、ロジック上は削除されたものと扱う。
      const animatingPartialRefresh = s.partialRefreshInProgress;

      // ロジック用の最終 set(deleted 完全除外)
      const finalSuggestions = [
        ...existing.filter(
          (sug) => !deletedSet.has(sug.id) && !updatedById.has(sug.id),
        ),
        ...reAnchoredUpdated,
        ...reAnchoredAdded,
      ];
      const trimmedFinalSuggestions =
        finalSuggestions.length > 15
          ? finalSuggestions.slice(0, 15)
          : finalSuggestions;

      // UI 表示用 set(animation 中は deleted も含めて表示)
      const displaySuggestions = animatingPartialRefresh
        ? [
            ...existing.filter((sug) => !updatedById.has(sug.id)),
            ...reAnchoredUpdated,
            ...reAnchoredAdded,
          ]
        : trimmedFinalSuggestions;
      // animation 中の表示 set は deleted を残すため 15 件超過の可能性が増えるが、
      // commitPartialRefreshCleanup で最終 set に切り替わるため、暫定的には slice しない
      // (UI 側は fade out 中の演出として全件見せる)。

      // interview_questions: 既存を is_stale=true に更新(refresh と同様)
      const previousIQ = s.analysisResult?.interview_questions;
      const nextInterviewQuestions = previousIQ
        ? { ...previousIQ, is_stale: true }
        : undefined;

      // overall_assessment: partial が任意で更新、なければ既存維持
      const previousAssessment = s.analysisResult?.overall_assessment;
      const mergedAssessment =
        result.overall_assessment ?? previousAssessment;
      if (!mergedAssessment) {
        // 既存もなし + partial も提供なしは異常(initial が走っていれば必ず存在する)。
        // 防御的に silent discard。
        console.warn(
          "[analyze_store] applyPartialResult: overall_assessment missing in both new and existing analysisResult",
        );
        return {};
      }

      // Phase G 再修正 (2026-05-24): 副次的な候補プール構造を撤去。partial 結果の
      // merge では既存 suggestion の updated / deleted / added(最大 1)を反映するのみ。

      // 2026-05-27 エージェント的対話(AI 逆質問): partial 結果の global_clarification_questions
      // を採用(なければ undefined、PartialAnalysisResult 上は optional)。既存 result の global は
      // 「最新応答が優先」規律で捨てる(回答済 question_id への回答は filter 経路で残るが、
      // ベース質問本文は新応答に揃える)。
      const partialResultGlobalQs =
        result.global_clarification_questions ?? undefined;

      // 既存 result の他フィールドは partial では更新されない(metadata は新規取得)
      const mergedResult: AnalysisResult = {
        es_state_version: result.es_state_version,
        overall_assessment: mergedAssessment,
        suggestions: displaySuggestions,
        interview_questions: nextInterviewQuestions,
        metadata: result.metadata,
        ...(partialResultGlobalQs !== undefined && {
          global_clarification_questions: partialResultGlobalQs,
        }),
      };

      // 自動修正の再評価(refresh と同じ規律)。**deleted 除外後の最終 set** で計算する。
      const newErrorIds = trimmedFinalSuggestions
        .filter((sug) => sug.category === "error")
        .map((sug) => sug.id);
      const autoCorrectedIds = newErrorIds.filter(
        (id) =>
          !s.rejectedSuggestionIds.includes(id) &&
          !(id in s.editedSuggestions),
      );
      const mergedAccepted = Array.from(
        new Set([...s.acceptedSuggestionIds, ...autoCorrectedIds]),
      );

      // 2026-05-25 Task #18: animation 用の派生 state を set。
      //  - partialRefreshInProgress = false: global banner「AI が関連指摘を再評価しています」
      //    は消える(AI 計算は終わった)。deleted の fade out は個別 banner で続く。
      //  - pendingDeletedSuggestionIds / recentlyAdded / recentlyUpdated: 1.5 / 0.5 秒後の
      //    commitPartialRefreshCleanup でクリアされるまで保持。
      const animationPatch = animatingPartialRefresh
        ? {
            partialRefreshInProgress: false,
            pendingDeletedSuggestionIds: [...result.deleted],
            recentlyAddedSuggestionIds: result.added.map((a) => a.id),
            recentlyUpdatedSuggestionIds: result.updated.map((u) => u.id),
          }
        : {};

      // 2026-05-27 Task C+D (3): partial refresh 完了時の selectedSuggestionId 解決。
      // 修正前は無条件で null に reset していたため、ユーザーが見ていた suggestion が
      // refresh 後の auto-select 経路で別 suggestion に切替わる動線になっていた
      // (dogfood で「見ていたボックスが勝手に変わる」と発覚)。
      //
      // 新規 logic:
      //  1. 現在 selectedSuggestionId が refresh 後 suggestions list(最終 set =
      //     trimmedFinalSuggestions、deleted 除外後)に存在 → **維持**
      //  2. 存在しない(deleted で消えた or updated で id 変わった)場合:
      //     a. updated 配列に同 id があれば(id 変わらず内容更新)→ 同 id 維持
      //        (※ updated は同 id で内容のみ変更、id 変わるケースは added/deleted 経路)
      //     b. それ以外は null(default の auto-select 経路に任せる)
      //
      // 設計判断:
      //  - displaySuggestions(animation 中は deleted も残す表示用 set)ではなく
      //    trimmedFinalSuggestions(最終 set)で判定 = animation 中の deleted を
      //    selected のまま維持すると、fade out 完了で id 消失時に selected が宙ぶらに
      //    なる + UX 上「消える suggestion を見続ける」は不自然
      //  - 「前後の近い id」「同 category / 同 original_span 重複」への遷移ロジックは
      //    本 commit では実装しない(複雑度に対する UX 価値が見合わない、null fallback
      //    で auto-select 経路に任せる方が結果として優先順位 priority 順)
      const currentSelectedId = s.selectedSuggestionId;
      const finalSuggestionIds = new Set(trimmedFinalSuggestions.map((sug) => sug.id));
      const nextSelectedId =
        currentSelectedId !== null && finalSuggestionIds.has(currentSelectedId)
          ? currentSelectedId
          : null;

      // 2026-05-27 エージェント的対話(AI 逆質問): 新 suggestions / global に存在しない
      // 質問への回答を filter で除外(デッドリンク回答が enriched_intent に残ると
      // LLM 混乱)。merge 後の displaySuggestions ではなく trimmedFinalSuggestions(最終 set)を
      // 基準に判定する。global_clarification_questions も新 result の値で再判定。
      // 2026-05-29: question_id 単独だと別 suggestion の同名 q_001 が生き残り、デッドリンク
      // 回答が残ってしまう。複合キー(scope + suggestion_id + question_id)で照合する。
      const newQuestionKeys = new Set<string>();
      for (const sug of trimmedFinalSuggestions) {
        for (const q of sug.clarification_questions ?? []) {
          newQuestionKeys.add(
            clarificationIdentity({
              scope: "suggestion",
              suggestion_id: sug.id,
              question_id: q.id,
            }),
          );
        }
      }
      // 注: AIPartialAnalysisOutput は global_clarification_questions を optional で持つが、
      // PartialAnalysisResult / partial result の表現にも反映される(本ファイル冒頭の type 経路)。
      // refresh では merge 経路で「既存に質問を残すか」「新規 only か」の選択がある。本実装では
      // 新 result の global を採用(既存は捨てる)= shape 上 type 整合と「最新応答が優先」規律。
      const newGlobalQs =
        ("global_clarification_questions" in result &&
          result.global_clarification_questions) ||
        [];
      for (const q of newGlobalQs) {
        newQuestionKeys.add(
          clarificationIdentity({ scope: "global", question_id: q.id }),
        );
      }
      const filteredClarificationAnswers = s.clarificationAnswers.filter((a) =>
        newQuestionKeys.has(
          clarificationIdentity({
            scope: a.scope,
            suggestion_id: a.suggestion_id,
            question_id: a.question_id,
          }),
        ),
      );

      return {
        analysisResult: mergedResult,
        clientEsVersion: result.es_state_version,
        inflightRefreshVersion: null,
        refreshAbortController: null,
        refreshPhase: "idle",
        refreshError: null,
        refreshStreamingStage: null,
        selectedSuggestionId: nextSelectedId,
        hoveredSuggestionId: null,
        acceptedSuggestionIds: mergedAccepted,
        autoCorrectedSuggestionIds: autoCorrectedIds,
        // 2026-05-27 エージェント的対話(AI 逆質問): 消えた question_id への回答を filter
        clarificationAnswers: filteredClarificationAnswers,
        // v2 dogfood UX 改善 Task C (2026-05-26): partial refresh 完了の timestamp を set。
        // RefreshCompletionToast が購読して「指摘が更新されました」を 3 秒間表示する。
        // version mismatch(conflictNotification 経路、上記 early return)では set されず、
        // applyRefreshResult(全分析経路)でも set しない(後者は AnalyzingOverlay 終了で
        // 完了が伝わるため重複通知を避ける、dispatch §「注意事項」)。
        refreshCompletedAt: Date.now(),
        ...animationPatch,
      };
    });
    // 2026-05-28 capture(dev 専用): partial 結果が反映された(analysisResult 参照が変わった)
    // ときだけ記録。conflict 分岐 / overall_assessment 不在の早期 return では参照不変。
    if (get().analysisResult !== prevResult) {
      appendCaptureLog("partial", get());
    }
  },

  // 2026-05-25 Task #18: partial refresh の loading / animation UX 用 actions
  // ---------------------------------------------------------------------------
  // beginPartialRefresh: Canvas が partial 経路を選んだ stream 開始時に呼ぶ。
  //   - partialRefreshInProgress = true(global banner「AI が関連指摘を再評価しています」が出る)
  //   - partialRefreshSeedIds = seedIds(seed suggestion 上で個別 loading spinner を表示)
  //   - これら 2 つは applyPartialResult / commitPartialRefreshCleanup / abort / error 経路で
  //     段階的に解除される
  beginPartialRefresh: (seedIds) =>
    set({
      partialRefreshInProgress: true,
      partialRefreshSeedIds: [...seedIds],
      // 既存の pending* / recently* は残骸を持ち越さないように都度クリア
      pendingDeletedSuggestionIds: [],
      recentlyAddedSuggestionIds: [],
      recentlyUpdatedSuggestionIds: [],
    }),

  // commitPartialRefreshCleanup: applyPartialResult 受信から 1.5 秒後に Canvas が呼ぶ。
  //   - pendingDeletedSuggestionIds の id を suggestions から **実際に除外**(fade out 完了)
  //   - recentlyAdded / recentlyUpdated / partialRefreshSeedIds をすべてクリア(animation 完了)
  //   - 注: partialRefreshInProgress は applyPartialResult 内で既に false 化済(global banner は
  //     即時消失、deleted の fade out は個別 banner で続く設計)
  //
  // ロジック整合:
  //  - suggestions から削除する際、autoCorrectedSuggestionIds / acceptedSuggestionIds の
  //    再計算は不要(applyPartialResult の時点で deleted 除外後の最終 set で計算済、UI 表示
  //    用にだけ残していた deleted id を抜くだけ)。
  //  - 安全網: 15 件超過 slice は applyPartialResult で省略していたので、ここでも省略
  //    (除外後は必ず 15 件以下になる、refine で守られている)。
  //  - 並行性: 新規 partial refresh が走り出した場合は beginPartialRefresh が pendingDeleted /
  //    recently* をクリアするので、本 cleanup が遅延 fire しても no-op に近い動作(deleted の
  //    実除外は applyPartialResult が新規 set を作る時点で実現される)。
  commitPartialRefreshCleanup: (generation) =>
    set((s) => {
      // 2026-05-28 並行性 fix C8: 世代ガード。この cleanup を仕掛けた refresh
      // (generation)より新しい refresh が始まっている(s.partialRefreshGeneration が
      // 進んでいる)場合は no-op。これにより partial A の 1.5 秒遅延 cleanup が、1.5 秒
      // 以内に完了した後続 partial B の animation flags / pendingDeleted を誤って消す
      // 競合を防ぐ(B 自身の cleanup timer が B の generation で正しく実行される)。
      if (generation !== s.partialRefreshGeneration) {
        return {};
      }
      if (
        s.pendingDeletedSuggestionIds.length === 0 &&
        s.recentlyAddedSuggestionIds.length === 0 &&
        s.recentlyUpdatedSuggestionIds.length === 0 &&
        s.partialRefreshSeedIds.length === 0 &&
        // 2026-05-28 dogfood round 3 ②④: reEvaluating も早期 return の判定に含める。
        // refresh が added/updated/deleted を 1 件も生まなかった稀ケースでも reEvaluating を
        // 確実にクリアするため(lingering 防止 — 本経路が partial-success の唯一の clear 点)。
        s.reEvaluatingSuggestionIds.length === 0
      ) {
        // 何もすることなし(beginPartialRefresh が先に走った / 2 回目の cleanup 等)
        return {};
      }
      const deletedSet = new Set(s.pendingDeletedSuggestionIds);
      const previousResult = s.analysisResult;
      if (!previousResult) {
        // 分析結果が無い状況で cleanup が走るのは想定外、念のため flags のみクリア
        return {
          partialRefreshSeedIds: [],
          pendingDeletedSuggestionIds: [],
          recentlyAddedSuggestionIds: [],
          recentlyUpdatedSuggestionIds: [],
          // 2026-05-28 dogfood round 3 ②④
          reEvaluatingSuggestionIds: [],
        };
      }
      const cleanedSuggestions = previousResult.suggestions.filter(
        (sug) => !deletedSet.has(sug.id),
      );
      return {
        analysisResult: {
          ...previousResult,
          suggestions: cleanedSuggestions,
        },
        partialRefreshSeedIds: [],
        pendingDeletedSuggestionIds: [],
        recentlyAddedSuggestionIds: [],
        recentlyUpdatedSuggestionIds: [],
        // 2026-05-28 dogfood round 3 ②④: in-flight 予測 mark をクリア。応答後は
        // recentlyUpdatedSuggestionIds(上の clear 前に既に fade animation 済)に役割が移る。
        reEvaluatingSuggestionIds: [],
      };
    }),

  // setRefreshError: 致命的 refresh エラー(LLMError 系等)を記録、refreshPhase = "error"。
  //   「古い応答を破棄した」のは setRefreshError ではない(silent discard、UI に出さない)
  //   — 設計判断 G2.6 と整合。
  setRefreshError: (err) =>
    set({
      refreshError: err,
      refreshPhase: "error",
      refreshStreamingStage: null,
      // 2026-05-25 Task #18: partial refresh 中のエラーは banner / seed loading を即時クリア。
      // partial refresh の途中で error が出た場合、UI に残骸の loading 表示があると混乱を招く
      // ため、animation 系 state は cleanup と同じく全クリア。
      partialRefreshInProgress: false,
      partialRefreshSeedIds: [],
      pendingDeletedSuggestionIds: [],
      recentlyAddedSuggestionIds: [],
      recentlyUpdatedSuggestionIds: [],
      // 2026-05-28 dogfood round 3 ②④: error 時も再評価中 mark をクリア(badge / skip を解除)。
      reEvaluatingSuggestionIds: [],
      // refresh は失敗しても session 全体を error には落とさない(楽観的並行制御 — ユーザー
      // は待たない、Canvas の操作は維持する)。inflightRefreshVersion / abortController
      // は finishRefresh で消す(失敗 → ユーザーが再度トリガーするまで refreshPhase=error
      // のまま表示)。
    }),

  // finishRefresh: refresh の終端処理(成功 / 失敗 / abort いずれの経路でも呼ぶ)。
  //   inflightRefreshVersion / abortController を null に戻す共通処理。
  //   applyRefreshResult が成功時にこれと同じ後処理をやっているが、エラー / abort 経路
  //   でも呼べるよう独立した action として置く。
  //   注: analyzeGoal は finishRefresh では reset しない(error バナーで「文字数を抑える
  //   モード中だった」のような表示を維持するため。次の beginRefresh で上書きされる)。
  finishRefresh: () =>
    set({
      refreshAbortController: null,
      inflightRefreshVersion: null,
      refreshStreamingStage: null,
      // 2026-05-25 Task #18: abort / 終端時に partial refresh の UI 状態も合わせてクリアする。
      // beginPartialRefresh で立てた flags が残骸として残ると、次の操作が混乱するため。
      // 通常の正常終了経路は applyPartialResult → setTimeout(commitPartialRefreshCleanup) で
      // 段階的に解除されるが、abort / version mismatch / setRefreshError 経路では
      // ここで一気にクリアする(applyPartialResult が走り切らないケースのフォールバック)。
      partialRefreshInProgress: false,
      partialRefreshSeedIds: [],
      pendingDeletedSuggestionIds: [],
      recentlyAddedSuggestionIds: [],
      recentlyUpdatedSuggestionIds: [],
      // 2026-05-28 dogfood round 3 ②④: abort / 終端時も再評価中 mark をクリア。
      reEvaluatingSuggestionIds: [],
    }),

  // 2026-05-28 dogfood round 3 ②④: clearReEvaluating
  //   編集して採用 → semantic-diff が「同じ」と判定して refresh を skip した経路で、
  //   Canvas が呼んで予測 mark を取り消す(refresh が走らないため他の clear 点が発火しない)。
  //   no-op ガード: 既に空なら set しない(無駄な re-render を避ける)。
  clearReEvaluating: () =>
    set((s) =>
      s.reEvaluatingSuggestionIds.length === 0
        ? {}
        : { reEvaluatingSuggestionIds: [] },
    ),

  // ---------------------------------------------------------------------------
  // 即時 partial refresh trigger (Phase G 修正 2026-05-23)
  // ---------------------------------------------------------------------------
  // 自動 refresh デバウンス機構(scheduleAutoRefresh / cancelAutoRefresh /
  // setAutoRefreshEnabled / autoRefreshTimer / autoRefreshEnabled / autoRefreshTrigger)は
  // 本フェーズで完全撤去。
  //
  // 代わりに各 action(acceptSuggestion / rejectSuggestion / editSuggestion /
  // toggleDirectEdit(OFF 差分あり)/ undo / redo / undoAutoCorrection /
  // undoAllAutoCorrections / applyConflictNewVersion)の末尾で **同期的に**
  // partialRefreshTrigger を +1 する。Canvas が useEffect で観測して handleRefresh
  // ("balanced") を即時発火する経路に統一。
  //
  // DECISIONS 2026-05-23 §1「採用 / 編集 / 却下 / Undo / Redo のたびに即座に
  // Sonnet 呼び出し、デバウンスなし」と完全に整合。

  // ---------------------------------------------------------------------------
  // 動的 HITL refresh trigger actions (統合改修パッケージ 2026-05-25)
  // ---------------------------------------------------------------------------
  // requestPartialRefresh: 影響範囲限定 partial を要求する低レベル action。
  //  - editSuggestion / toggleDirectEdit OFF 経路で Canvas が呼ぶ(意味的差分判定の後)
  //  - 他の経路(reject / undo / redo / undoAutoCorrection 等)からも直接 set される代替経路
  //  - 内部で partialRefreshTrigger +1 + pendingRefreshScope を set
  //  - clientEsVersion は変更しない(対応する action 経路で既に +1 されているため)
  requestPartialRefresh: (scope) =>
    set((s) => ({
      partialRefreshTrigger: s.partialRefreshTrigger + 1,
      pendingRefreshScope: scope,
    })),

  // triggerFullRefresh: 「再分析」ボタン用、全体再分析を要求する高レベル action。
  //  - 影響範囲限定モードを無効化(kind: "full")
  //  - Canvas は scope.kind === "full" を見て refresh stream(全体)経路を選ぶ
  //  - clientEsVersion は変更しない(ユーザー操作ではなく明示的な再分析要求)
  triggerFullRefresh: () =>
    set((s) => ({
      partialRefreshTrigger: s.partialRefreshTrigger + 1,
      pendingRefreshScope: {
        kind: "full",
        seedIds: [],
        reason: "manual",
      },
    })),

  // enqueueSemanticDiff: 意味的差分判定の queue に 1 entry を push(主に他コンポーネントから
  // 呼ぶための公開 action、editSuggestion / toggleDirectEdit は内部で直接 set している)。
  enqueueSemanticDiff: (entry) =>
    set((s) => ({
      semanticDiffQueue: [...s.semanticDiffQueue, entry],
    })),

  // dequeueSemanticDiff: queue の先頭 1 件を consume して返す。
  //  - 空 queue では undefined を返し、state は変更しない
  //  - 非同期処理の前に consume することで「ダブル処理」を防ぐ
  dequeueSemanticDiff: () => {
    const current = get().semanticDiffQueue;
    if (current.length === 0) return undefined;
    const [head, ...rest] = current;
    set({ semanticDiffQueue: rest });
    return head;
  },

  // ---------------------------------------------------------------------------
  // 競合通知 actions (Phase G Step 3b-3 追加 2026-05-23)
  // ---------------------------------------------------------------------------
  setConflictNotification: (notification) =>
    set({ conflictNotification: notification }),

  // 「破棄」or「現在の選択を維持」: silent discard と同じ動作。conflict を消すだけ。
  dismissConflict: () => set({ conflictNotification: null }),

  // ---------------------------------------------------------------------------
  // エージェント的対話(AI 逆質問)actions (2026-05-27)
  // ---------------------------------------------------------------------------
  // updateClarificationAnswer: 回答 textarea の onChange で呼ぶ。
  //  - answer_text が空(trim 後 0 字): 当該 entry を除去(未回答状態に戻す)
  //  - 既存 entry あり: answer_text + answered_at を更新(scope / suggestion_id は維持)
  //  - 既存なし: 新規追加
  // **partial refresh trigger は立てない**(回答中に毎回 LLM 呼ぶのは判断疲労 + コスト大、
  // ユーザーが明示「これで再分析」ボタンを押した時のみ refresh する規律)。
  updateClarificationAnswer: ({ question_id, suggestion_id, scope, answer_text }) =>
    set((s) => {
      // 2026-05-29: 集約リスト全体で question_id は一意でない(suggestion ごとに振られる)。
      // 複合キー(scope + suggestion_id + question_id)で照合し、別 suggestion の同名
      // question_id への回答が混線しないようにする。
      const targetKey = clarificationIdentity({ scope, suggestion_id, question_id });
      const trimmed = answer_text.trim();
      if (trimmed.length === 0) {
        // 空回答は entry 自体を除去(textarea を空にした時の clean-up)
        return {
          clarificationAnswers: s.clarificationAnswers.filter(
            (a) =>
              clarificationIdentity({
                scope: a.scope,
                suggestion_id: a.suggestion_id,
                question_id: a.question_id,
              }) !== targetKey,
          ),
        };
      }
      const existingIdx = s.clarificationAnswers.findIndex(
        (a) =>
          clarificationIdentity({
            scope: a.scope,
            suggestion_id: a.suggestion_id,
            question_id: a.question_id,
          }) === targetKey,
      );
      const updatedEntry: ClarificationAnswer = {
        question_id,
        answer_text,
        answered_at: Date.now(),
        scope,
        ...(suggestion_id !== undefined && { suggestion_id }),
      };
      if (existingIdx >= 0) {
        // 既存更新(immutable copy で entry 入れ替え)
        const next = [...s.clarificationAnswers];
        next[existingIdx] = updatedEntry;
        return { clarificationAnswers: next };
      }
      // 新規追加(配列末尾、表示順序は scope / 時系列の両軸で UI 側がソート)
      return {
        clarificationAnswers: [...s.clarificationAnswers, updatedEntry],
      };
    }),

  // clearClarificationAnswer: 明示クリア(削除ボタン等の経路、現状未使用だが API として用意)
  // 2026-05-29: 複合キー照合(update と対称、別 suggestion の同名 question_id を巻き込まない)。
  clearClarificationAnswer: ({ question_id, suggestion_id, scope }) =>
    set((s) => {
      const targetKey = clarificationIdentity({ scope, suggestion_id, question_id });
      return {
        clarificationAnswers: s.clarificationAnswers.filter(
          (a) =>
            clarificationIdentity({
              scope: a.scope,
              suggestion_id: a.suggestion_id,
              question_id: a.question_id,
            }) !== targetKey,
        ),
      };
    }),

  // triggerReanalysisWithClarifications: 「この回答で再分析」ボタンの実体。
  //  1. 回答済 entry を取り出し(空文字は updateClarificationAnswer 経路で既に除去済)
  //  2. ActionLogEntry に "clarification_answered" を per-answer push
  //     (clarificationSnapshot に question_text 含めて履歴表示用に保存)
  //  3. requestPartialRefresh({ kind: "scoped", seedIds: [], reason: "manual" }) を発火
  //     enriched_intent は buildPartialBundle 経路で user_context に append される
  //     (本 action 自体は state mutation + trigger +1 のみ、bundle 構築は Canvas 経路)
  //  4. ボタン disable と二重ガード: 1 件以上の回答が無い場合は no-op
  triggerReanalysisWithClarifications: () => {
    const state = get();
    const validAnswers = state.clarificationAnswers.filter(
      (a) => a.answer_text.trim().length > 0,
    );
    if (validAnswers.length === 0) return; // 二重ガード、UI 側で disable 済

    // 質問本文の lookup: analysisResult から suggestions[].clarification_questions と
    // global_clarification_questions を走査して複合キー → ClarificationQuestion を引く。
    // 2026-05-29: question_id 単独だと別 suggestion の同名 q_001 が上書きし合い、回答が
    // 取り違えた質問本文に紐づく。複合キー(scope + suggestion_id + question_id)で keying し、
    // 回答(ClarificationAnswer)も同じ複合キーで引く。
    // 既に refresh で消えた question_id は filter で除外(applyPartialResult 経路で
    // 通常クリアされるが、念のため二重防御で「見つからなければ skip」)。
    const questionsByKey = new Map<string, ClarificationQuestion>();
    const result = state.analysisResult;
    if (result !== null) {
      for (const sug of result.suggestions) {
        for (const q of sug.clarification_questions ?? []) {
          questionsByKey.set(
            clarificationIdentity({
              scope: "suggestion",
              suggestion_id: sug.id,
              question_id: q.id,
            }),
            q,
          );
        }
      }
      for (const q of result.global_clarification_questions ?? []) {
        questionsByKey.set(
          clarificationIdentity({ scope: "global", question_id: q.id }),
          q,
        );
      }
    }

    // ActionLogEntry の per-answer push。timestamp / esVersion は共通(1 操作 = 1 version の
    // 規律、複数回答も 1 回の「再分析トリガー」として扱う)。
    const now = Date.now();
    const nextEsVersion = state.clientEsVersion + 1;
    const logEntries: ActionLogEntry[] = validAnswers.flatMap((ans) => {
      const q = questionsByKey.get(
        clarificationIdentity({
          scope: ans.scope,
          suggestion_id: ans.suggestion_id,
          question_id: ans.question_id,
        }),
      );
      // 質問本文が引けない場合は履歴 entry を skip(デッドリンク回答)。
      // refresh で suggestion が消えた直後等の edge case。
      if (!q) return [];
      const entry: ActionLogEntry = {
        id: generateActionLogId(),
        type: "clarification_answered",
        esVersion: nextEsVersion,
        timestamp: now,
        // clarification_answered は suggestion_id を持たないため suggestionId 未 set。
        // HistoryPanel は clarificationSnapshot を参照して rendering する。
        clarificationSnapshot: {
          question_id: ans.question_id,
          question_text: q.question,
          answer_text: ans.answer_text,
          scope: ans.scope,
          ...(ans.suggestion_id !== undefined && { suggestion_id: ans.suggestion_id }),
        },
      };
      return [entry];
    });

    // partial refresh trigger + scope を立てて、Canvas が観測 → handleRefresh を発火する。
    // scope は manual(「再分析」ボタンと同等の意味的扱い、seed は空配列で全範囲再評価)。
    // user_context への append は buildPartialBundle 経路で行う(本 action では state のみ更新)。
    set((s) => ({
      actionLog: [...s.actionLog, ...logEntries],
      // 新規操作 → redo は破棄(慣例、既存 action と整合)
      redoStack: [],
      redoLogStack: [],
      clientEsVersion: nextEsVersion,
      partialRefreshTrigger: s.partialRefreshTrigger + 1,
      pendingRefreshScope: {
        kind: "scoped",
        seedIds: [],
        reason: "manual",
      },
    }));
  },

  // v2 dogfood UX 改善 Task C (2026-05-26): partial refresh 完了 toast の自動消失。
  // RefreshCompletionToast component が setTimeout 3000ms 経過後に呼ぶ。
  // 連続 refresh の 2 回目で applyPartialResult が新しい timestamp を立てると、
  // toast component の useEffect が再発火して新タイマーを開始 + 表示継続できる。
  clearRefreshCompletedAt: () => set({ refreshCompletedAt: null }),

  // 「新版を採用」: conflictNotification.newResult を強制的に merge する。
  //   version 整合チェックをスキップして apply 系のロジックを直接実行する形にする。
  //   設計判断: applyPartialResult / applyRefreshResult の version チェック分岐を
  //   迂回する別関数として実装(既存 action のシグネチャを変えない、規律維持)。
  //   - type === "partial": newResult.updated/deleted/added を既存 suggestions と merge
  //   - type === "full":    newResult.suggestions で既存 suggestions を全置換
  applyConflictNewVersion: () => {
    // 2026-05-28 capture(dev 専用): set 前の analysisResult 参照 + 競合種別を保持。
    // 「新版を採用」で結果が反映されたとき(参照が変わったとき)だけ記録する。
    // conflict.type → kind マップ: partial → "partial" / full → "refresh"。
    // conflict が null / overall_assessment 不在の早期 return では analysisResult 不変。
    const prevResult = get().analysisResult;
    const conflictKind: CaptureKind =
      get().conflictNotification?.type === "full" ? "refresh" : "partial";
    set((s) => {
      const conflict = s.conflictNotification;
      if (!conflict) return {};
      if (conflict.type === "partial") {
        // partial merge ロジック(applyPartialResult の merge 部と同じ)
        const result = conflict.newResult;
        const existing = s.analysisResult?.suggestions ?? [];
        const deletedSet = new Set(result.deleted);
        // 2026-05-27 derivedSpans 座標系統一 bug fix: applyPartialResult と同様、
        // 新規 updated / added は displayEsBody 基準で resolveOriginalSpans されているため
        // form.es_body 基準へ再アンカーする。merge 経路は別だが座標系の問題は同型。
        const reAnchoredUpdated = reAnchorSuggestionsToFormEsBody(
          s.form.es_body,
          result.updated,
        );
        const reAnchoredAdded = reAnchorSuggestionsToFormEsBody(
          s.form.es_body,
          result.added,
        );
        const updatedById = new Map(reAnchoredUpdated.map((u) => [u.id, u]));
        const newSuggestions = [
          ...existing.filter(
            (sug) => !deletedSet.has(sug.id) && !updatedById.has(sug.id),
          ),
          ...reAnchoredUpdated,
          ...reAnchoredAdded,
        ];
        const trimmedSuggestions =
          newSuggestions.length > 15
            ? newSuggestions.slice(0, 15)
            : newSuggestions;
        const previousIQ = s.analysisResult?.interview_questions;
        const nextInterviewQuestions = previousIQ
          ? { ...previousIQ, is_stale: true }
          : undefined;
        const previousAssessment = s.analysisResult?.overall_assessment;
        const mergedAssessment =
          result.overall_assessment ?? previousAssessment;
        if (!mergedAssessment) {
          // overall_assessment 不在は applyPartialResult と同じく異常扱い、破棄のみ
          return { conflictNotification: null };
        }
        // Phase G 再修正 (2026-05-24): 副次的な候補プール構造を撤去。
        // 2026-05-27 エージェント的対話: partial の global_clarification_questions を採用
        const partialGlobalQs = result.global_clarification_questions ?? undefined;
        const mergedResult: AnalysisResult = {
          es_state_version: result.es_state_version,
          overall_assessment: mergedAssessment,
          suggestions: trimmedSuggestions,
          interview_questions: nextInterviewQuestions,
          metadata: result.metadata,
          ...(partialGlobalQs !== undefined && {
            global_clarification_questions: partialGlobalQs,
          }),
        };
        // 自動修正再評価
        const newErrorIds = trimmedSuggestions
          .filter((sug) => sug.category === "error")
          .map((sug) => sug.id);
        const autoCorrectedIds = newErrorIds.filter(
          (id) =>
            !s.rejectedSuggestionIds.includes(id) &&
            !(id in s.editedSuggestions),
        );
        const mergedAccepted = Array.from(
          new Set([...s.acceptedSuggestionIds, ...autoCorrectedIds]),
        );
        // 2026-05-27 エージェント的対話: 新 set に存在しない質問への回答を filter
        // 2026-05-29: 複合キー(scope + suggestion_id + question_id)で照合(別 suggestion の
        // 同名 q_001 が生き残ってデッドリンク回答が残るのを防ぐ)。
        const newQuestionKeys = new Set<string>();
        for (const sug of trimmedSuggestions) {
          for (const q of sug.clarification_questions ?? []) {
            newQuestionKeys.add(
              clarificationIdentity({
                scope: "suggestion",
                suggestion_id: sug.id,
                question_id: q.id,
              }),
            );
          }
        }
        for (const q of partialGlobalQs ?? []) {
          newQuestionKeys.add(
            clarificationIdentity({ scope: "global", question_id: q.id }),
          );
        }
        const filteredClarificationAnswers = s.clarificationAnswers.filter((a) =>
          newQuestionKeys.has(
            clarificationIdentity({
              scope: a.scope,
              suggestion_id: a.suggestion_id,
              question_id: a.question_id,
            }),
          ),
        );
        return {
          analysisResult: mergedResult,
          clientEsVersion: result.es_state_version,
          inflightRefreshVersion: null,
          refreshAbortController: null,
          refreshPhase: "idle",
          refreshError: null,
          refreshStreamingStage: null,
          selectedSuggestionId: null,
          hoveredSuggestionId: null,
          acceptedSuggestionIds: mergedAccepted,
          autoCorrectedSuggestionIds: autoCorrectedIds,
          conflictNotification: null,
          clarificationAnswers: filteredClarificationAnswers,
        };
      }
      // type === "full" 経路: applyRefreshResult の merge と同じ
      const result = conflict.newResult;
      const previousIQ = s.analysisResult?.interview_questions;
      const nextInterviewQuestions = result.interview_questions
        ? result.interview_questions
        : previousIQ
          ? { ...previousIQ, is_stale: true }
          : undefined;
      // 2026-05-27 derivedSpans 座標系統一 bug fix: applyRefreshResult と同様、
      // full 結果も displayEsBody 基準で resolveOriginalSpans されているため form.es_body
      // 基準へ再アンカーする。
      const reAnchoredFullSuggestions = reAnchorSuggestionsToFormEsBody(
        s.form.es_body,
        result.suggestions,
      );
      // Phase G 再修正 (2026-05-24): 副次的な候補プール構造を撤去。
      const mergedResult: AnalysisResult = {
        ...result,
        suggestions: reAnchoredFullSuggestions,
        interview_questions: nextInterviewQuestions,
      };
      const newErrorIds = reAnchoredFullSuggestions
        .filter((sug) => sug.category === "error")
        .map((sug) => sug.id);
      const autoCorrectedIds = newErrorIds.filter(
        (id) =>
          !s.rejectedSuggestionIds.includes(id) && !(id in s.editedSuggestions),
      );
      const mergedAccepted = Array.from(
        new Set([...s.acceptedSuggestionIds, ...autoCorrectedIds]),
      );
      // 2026-05-27 エージェント的対話: full 経路でも質問整合チェック
      // 2026-05-29: 複合キー(scope + suggestion_id + question_id)で照合。
      const newQuestionKeysFull = new Set<string>();
      for (const sug of reAnchoredFullSuggestions) {
        for (const q of sug.clarification_questions ?? []) {
          newQuestionKeysFull.add(
            clarificationIdentity({
              scope: "suggestion",
              suggestion_id: sug.id,
              question_id: q.id,
            }),
          );
        }
      }
      for (const q of result.global_clarification_questions ?? []) {
        newQuestionKeysFull.add(
          clarificationIdentity({ scope: "global", question_id: q.id }),
        );
      }
      const filteredClarificationAnswersFull = s.clarificationAnswers.filter((a) =>
        newQuestionKeysFull.has(
          clarificationIdentity({
            scope: a.scope,
            suggestion_id: a.suggestion_id,
            question_id: a.question_id,
          }),
        ),
      );
      return {
        analysisResult: mergedResult,
        clientEsVersion: result.es_state_version,
        inflightRefreshVersion: null,
        refreshAbortController: null,
        refreshPhase: "idle",
        refreshError: null,
        refreshStreamingStage: null,
        selectedSuggestionId: null,
        hoveredSuggestionId: null,
        acceptedSuggestionIds: mergedAccepted,
        autoCorrectedSuggestionIds: autoCorrectedIds,
        conflictNotification: null,
        clarificationAnswers: filteredClarificationAnswersFull,
      };
    });
    // 2026-05-28 capture(dev 専用): 新版採用で結果が反映された(analysisResult 参照が
    // 変わった)ときだけ記録。partial 採用 → "partial"、full 採用 → "refresh"。
    if (get().analysisResult !== prevResult) {
      appendCaptureLog(conflictKind, get());
    }
  },

  // ---------------------------------------------------------------------------
  // 編集モード用 actions (UX 改修 1b 追加)
  // ---------------------------------------------------------------------------
  // startEditingMode: 現在の form / 結果 / Canvas 状態を一括 snapshot して、
  // session を idle に戻す(InputForm が再表示される)。
  // 「戻る」を押されたら snapshot から完全 restore する。
  // 既に snapshot がある場合(編集中に再度押されるケースは UI 上想定しないが)
  // は上書きしない(直前の snapshot を保持し、戻る経路を維持)。
  startEditingMode: () =>
    set((s) => {
      if (s.editingSnapshot !== null) {
        // 既に編集モードなら何もしない(snapshot を上書きしない)
        return {};
      }
      // Phase G Step 2: 進行中の refresh があれば abort(編集モード中は refresh を
      // 動かさない設計、cancel 経路でも refresh 初期化された状態に戻す)。
      if (s.refreshAbortController) {
        try {
          s.refreshAbortController.abort();
        } catch {
          // 二重 abort の DOMException は無視
        }
      }
      // Phase G 修正 (2026-05-23): 自動 refresh デバウンス機構は撤去済(setTimeout 不在)。
      const snapshot: EditingSnapshot = {
        form: { ...s.form },
        phase: s.phase,
        researchError: s.researchError,
        analyzeError: s.analyzeError,
        companySummary: s.companySummary,
        analysisResult: s.analysisResult,
        selectedSuggestionId: s.selectedSuggestionId,
        showAlternatives: s.showAlternatives,
        acceptedSuggestionIds: [...s.acceptedSuggestionIds],
        rejectedSuggestionIds: [...s.rejectedSuggestionIds],
        editedSuggestions: { ...s.editedSuggestions },
        // Phase G Step 3b-1: 自動修正の見え方も snapshot に保存
        autoCorrectedSuggestionIds: [...s.autoCorrectedSuggestionIds],
        directEditMode: s.directEditMode,
        currentEsBody: s.currentEsBody,
        // 2026-05-28 dogfood round 3 ⑤: baked 集合も保存
        bakedSuggestionIds: [...s.bakedSuggestionIds],
        actionHistory: [...s.actionHistory],
        // 2026-05-25: actionLog も snapshot 保存(cancel で完全 restore)
        actionLog: [...s.actionLog],
        clientEsVersion: s.clientEsVersion,
      };
      return {
        editingSnapshot: snapshot,
        // session を idle に戻す。phase / 結果 / Canvas state を一旦リセット
        // (snapshot に退避済、戻るで全 restore できる)。
        phase: "idle",
        // Phase G Step 1: 編集モードでは streaming は走っていない(done から入る前提)、
        // 念のため null に明示リセット。
        streamingStage: null,
        researchError: null,
        analyzeError: null,
        companySummary: null,
        analysisResult: null,
        selectedSuggestionId: null,
        hoveredSuggestionId: null,
        showAlternatives: false,
        // Phase G 修正 (2026-05-23): 即時 partial refresh trigger / 競合通知 もリセット
        // 統合改修パッケージ (2026-05-25): pendingRefreshScope / semanticDiffQueue もリセット
        partialRefreshTrigger: 0,
        pendingRefreshScope: null,
        semanticDiffQueue: [],
        conflictNotification: null,
        // v2 dogfood UX 改善 Task C (2026-05-26): partial refresh 完了 toast の timestamp もリセット
        refreshCompletedAt: null,
        // 2026-05-27 エージェント的対話(AI 逆質問): 回答も session 単位の揮発状態として
        // リセット系で空配列に戻す(新規分析 / セッション全リセット / 編集モード遷移は
        // すべて回答コンテキストを破棄する)
        clarificationAnswers: [],
        // 2026-05-25 Task #18: partial refresh animation 用 state もリセット
        partialRefreshInProgress: false,
        partialRefreshSeedIds: [],
        pendingDeletedSuggestionIds: [],
        recentlyAddedSuggestionIds: [],
        recentlyUpdatedSuggestionIds: [],
        // 2026-05-28 dogfood round 3 ②④: 編集モード遷移で再評価中 mark もリセット
        reEvaluatingSuggestionIds: [],
        ...STEP2_RESET_STATE,
        // Phase G Step 2: 編集モード中は refresh state も初期化(復帰時に snapshot から
        // clientEsVersion を戻す、inflight 系は init)
        ...REFRESH_RESET_STATE,
      };
    }),

  // cancelEditingMode: snapshot から完全 restore。form / 結果 / Canvas 状態すべて
  // 編集前に戻す。snapshot 自体は restore 完了後に null へ。
  cancelEditingMode: () =>
    set((s) => {
      if (s.editingSnapshot === null) {
        // snapshot 無し = 編集モードではない → no-op
        return {};
      }
      const snap = s.editingSnapshot;
      return {
        form: { ...snap.form },
        phase: snap.phase,
        // Phase G Step 1: streaming は snapshot に保存していない(編集モード中は走らない)。
        // restore 時に null で初期化することで、cancel 直前の偶発的な streamingStage 残骸を弾く。
        streamingStage: null,
        researchError: snap.researchError,
        analyzeError: snap.analyzeError,
        companySummary: snap.companySummary,
        analysisResult: snap.analysisResult,
        selectedSuggestionId: snap.selectedSuggestionId,
        // Phase G Step 3a: hover state は揮発的なため snapshot に保存しない。
        // cancel 復帰直後はカーソルがどこにも乗っていない初期状態として扱う。
        hoveredSuggestionId: null,
        showAlternatives: snap.showAlternatives,
        acceptedSuggestionIds: [...snap.acceptedSuggestionIds],
        rejectedSuggestionIds: [...snap.rejectedSuggestionIds],
        editedSuggestions: { ...snap.editedSuggestions },
        // Phase G Step 3b-1: 自動修正の見え方も復元
        autoCorrectedSuggestionIds: [...snap.autoCorrectedSuggestionIds],
        directEditMode: snap.directEditMode,
        currentEsBody: snap.currentEsBody,
        // 2026-05-28 dogfood round 3 ⑤: baked 集合も復元(snapshot に含まれる)。
        // directEditPending は揮発的・編集モード遷移で破棄(STEP2_RESET_STATE / 下記で null)。
        bakedSuggestionIds: [...snap.bakedSuggestionIds],
        actionHistory: [...snap.actionHistory],
        // 2026-05-25: actionLog も snapshot から restore
        actionLog: [...snap.actionLog],
        editingSnapshot: null,
        // Phase G Step 2: clientEsVersion を snapshot から復元(refresh の整合性を維持)。
        // refresh inflight 系は完全初期化(編集モード中に動かしていないため、復帰後も
        // ユーザーが新たに「再分析する」を押すまで refresh は走らない)。
        clientEsVersion: snap.clientEsVersion,
        inflightRefreshVersion: null,
        refreshAbortController: null,
        refreshPhase: "idle",
        refreshError: null,
        refreshStreamingStage: null,
        // Phase G 修正 (2026-05-23): 即時 partial refresh trigger / 競合通知 / redoStack も初期化
        // (redoStack は snapshot に含まれないため、cancel 復帰時は空配列に。
        //  snapshot 化時点の redoStack は揮発的、復帰後も redo 不可で問題なし)。
        // 統合改修パッケージ (2026-05-25): pendingRefreshScope / semanticDiffQueue も復帰時にリセット。
        partialRefreshTrigger: 0,
        pendingRefreshScope: null,
        semanticDiffQueue: [],
        conflictNotification: null,
        // v2 dogfood UX 改善 Task C (2026-05-26): partial refresh 完了 toast の timestamp も復帰時にリセット
        refreshCompletedAt: null,
        // 2026-05-27 エージェント的対話(AI 逆質問): 編集モードキャンセル復帰でも回答リセット。
        // 復帰先の analysisResult は cancel 前の snapshot に戻るが、ユーザーの回答コンテキスト
        // は揮発状態として捨てる(snapshot 取り扱いを増やさない簡素な設計)
        clarificationAnswers: [],
        // 2026-05-25 Task #18: partial refresh animation 用 state もリセット
        partialRefreshInProgress: false,
        partialRefreshSeedIds: [],
        pendingDeletedSuggestionIds: [],
        recentlyAddedSuggestionIds: [],
        recentlyUpdatedSuggestionIds: [],
        // 2026-05-28 dogfood round 3 ②④: 編集モードキャンセル復帰でも再評価中 mark をリセット
        reEvaluatingSuggestionIds: [],
        redoStack: [],
        // 2026-05-25: redoLogStack も復帰時にリセット(snapshot に含まれないため、復帰後 redo 不可)
        redoLogStack: [],
        // 2026-05-28 dogfood round 3 ⑤: 直接編集 pending snapshot は揮発的、復帰時に破棄。
        directEditPending: null,
      };
    }),
}));

// -----------------------------------------------------------------------------
// Derived helpers
// -----------------------------------------------------------------------------

// loading 中(researching または analyzing)。フォーム disable に使う。
export function isLoadingPhase(phase: AnalyzePhase): boolean {
  return phase === "researching" || phase === "analyzing";
}

// 必須項目が埋まっているかを判定。「分析開始」ボタン enable の条件。
//   es_body: 非空(空でなければ OK。下限文字数は撤廃 2026-05-29)
//   question_text: 非空(同上。「自己PR」のような短い正当な設問をブロックしない)
//   char_limit: 任意(空欄 = 制限なしで valid。入力するなら正の整数のみ)
//   preset: 必ず選択済(default あり)
//
// 2026-05-29 改修(下限緩和): 入力の最低文字数を撤廃。以前は es_body 50 字 /
// question 5 字を下限にしていたが、「自己PR」(4 字)等の正当な設問がブロックされる
// 問題があった。下限は「空でないこと」に統一。
//
// 2026-05-29 改修(char_limit 任意化): 文字数制限の無い設問もあるため char_limit を
// 任意入力にする。空欄 = 制限なし(valid。プロンプトに上限の記述を注入しない、
// 超過警告もカウンタの上限表示も出さない)。入力する場合のみ正の整数を要求する
// (カウンタが動くため)。旧 50〜2000 の範囲ゲートは撤廃(下限・上限とも)。
// es_body 上限(8000)は schema(lib/schema/input.ts)側の安全弁として据え置き。
//
// 2026-05-29 修正(上限チェック追加): 以前は下限(非空)のみを見ており、8001 字超でも
// 「分析開始」ボタンが有効なまま送信され、送信直後に client Zod(es_body.max(8000))で
// 落ちて generic 寄りのエラーになっていた。schema と同基準で上限を弾く。
// 基準は schema(es_body.max(8000))が検証する値と合わせ、buildAnalyzeBundle が
// 渡す raw な form.es_body の length(trim しない)で判定する。
export function isFormValid(form: FormState): boolean {
  if (form.es_body.trim().length < 1) return false;
  if (form.es_body.length > 8000) return false;
  if (form.question_text.trim().length < 1) return false;
  // char_limit が空文字 / 空白のみなら「制限なし」として valid(任意)。
  const raw = form.char_limit.trim();
  if (raw.length > 0) {
    // 非空なら正の整数のみ(範囲ゲートなし)。
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// Derived ES 本文 / 派生 span(Canvas 表示用)
// -----------------------------------------------------------------------------
// `getDerivedEsBody` と `getDerivedSpans` は **同じ採用 / 編集状態** から派生する
// 一対のビューで、内部では同じソート順・同じ累積オフセット計算ロジック
// (`computeDerivedView`)を共有する。
//
// UX 改修 1b (2026-05-23): 採用 / 編集で文字数が変化すると、後続 suggestion の
// `original_span` は「元の文字列(分析時点)」を基準にしているため、表示用には
// 累積オフセットを足し込んだ「派生 span」が必要になる。これを `getDerivedSpans`
// として公開し、Canvas の `buildSegments` がこの派生 span を使うことで、
// 採用後も他指摘のハイライト位置が正しく追従する。
//
// 置換戦略(getDerivedEsBody):
//  - suggestion を `original_span.start` 昇順で走査し、累積オフセットを足しつつ
//    本文の前から順に置換適用していく(後ろから走査する従来方式から変更)。
//  - 昇順走査にすることで `getDerivedSpans` と同じ走査順を共有でき、派生 span
//    の計算と一貫した結果が得られる。
//  - 重なる span(F1.1 と同じ「先勝ち」精神)は、`start` 昇順の中で先に処理
//    されたものを優先。同 start なら end 降順(長い方を先に取る)。
//  - directEditMode 中(currentEsBody は contentEditable の最新)は、original_span
//    が無効化されている可能性がある。Step 2 では「直接編集中は置換しない」運用とし、
//    呼び出し側(Canvas)が directEditMode = true のときは置換前の currentEsBody を
//    そのまま表示する設計にする(getDerivedSpans も同様、呼び出し側が判断)。

// 派生 span(Canvas 表示で使う、累積オフセットを足し込んだ後の span 位置)。
// isApplied = true の場合、本文は既に proposed / edited に置換済のため、
// 元の original 範囲はもう存在しない(Canvas はハイライト描画をスキップする)。
// isRejected = true は「却下済」。UX 改修 3a (2026-05-23) で Canvas は
// ハイライト描画自体をスキップする(F2.3 の strikethrough + opacity-50 は廃止、
// 元の通常テキストに戻す。Undo すれば rejectedIds から外れて自動復活)。
export interface DerivedSpan {
  suggestion_id: string;
  derivedStart: number;
  derivedEnd: number;
  isApplied: boolean;
  isRejected: boolean;
}

// 内部: suggestion を走査順に並べる純関数。
// `getDerivedEsBody` / `getDerivedSpans` の両方が同じ順序で処理することで、
// 派生本文と派生 span の整合性を構造で保証する。
//
// v2 bug fix (2026-05-26): `category` を必須プロパティに追加。`structural` カテゴリの
// suggestion は `proposed` が「(段落削除:冒頭の宣言文段落を取り除き、直接エピソードに
// 入る)」のような placeholder(operation 説明文)で、文字単位の置換対象ではない。
// 採用時の派生 ES への適用は `applyStructuralOperation`(client side 機械適用、Phase B3)で
// 完結し、ここでは category を見て structural を区別する責務がある。
// 詳細は `getDerivedEsBody` / `getDerivedSpans` のコメント参照。
// 2026-05-28 unanchorable-accept APPLY bug fix: `original`(optional)を追加。
// getDerivedEsBody の APPLY 2-pass(後述)で、採用提案が baseline の `original_span` 位置に
// 当たらない(= unanchorable)場合に「現在の派生テキストから `original` を locate して
// `proposed` を貼る」フォールバックに使う。optional なのは既存テスト互換のため:
//  - 実呼び出し側(Canvas / store)は full `Suggestion` を渡すため常に `original` を持つ。
//  - 既存ユニットテストの minimal `S` 型は `original` を持たない → undefined のとき pass 1 の
//    verify をスキップし、従来通り「original_span を信じて適用」する(挙動完全互換)。
type SuggestionForDerive = {
  id: string;
  category: Category;
  original_span: { start: number; end: number };
  proposed: string;
  original?: string;
};

function sortSuggestionsForDerive<T extends SuggestionForDerive>(
  suggestions: ReadonlyArray<T>,
): T[] {
  // start 昇順、同 start なら end 降順(長い方を先に取る、F1.1 と整合)。
  return suggestions
    .slice()
    .sort((a, b) => {
      if (a.original_span.start !== b.original_span.start) {
        return a.original_span.start - b.original_span.start;
      }
      return b.original_span.end - a.original_span.end;
    });
}

// 派生 ES 本文 — 採用済 / 編集済の置換を適用した結果。
// 走査は start 昇順 + 累積オフセットで前から順に置換し、`getDerivedSpans` と
// 同じ走査ロジック・同じ整合性ガードで動く。
//
// v2 bug fix (2026-05-26): `structural` カテゴリは **完全 skip**。理由:
//   structural の `proposed` は「(段落削除:冒頭の宣言文段落を取り除き、
//   直接エピソードに入る)」のような operation 説明文 placeholder で、ES 本文に
//   差し込める文字列ではない。structural 採用時の派生 ES への反映は既に
//   `acceptSuggestion`(L1429-1505)内で `applyStructuralOperation`(client side
//   機械適用、Phase B3)を経て `currentEsBody` 側に完結している。ここで再度
//   `proposed` を `original_span` に差し込むと、Canvas に表示される派生 ES に
//   placeholder が混入する重大バグになる(本セッション dogfood で発覚)。
//   structural を走査ループの先頭で `continue` して、置換も累積オフセット更新も
//   span 走査も飛ばす。
// 2026-05-28 dogfood round 3 ⑤ 直接編集 bug fix: 第 5 引数 `bakedIds`(optional、default 空)を
// 追加。直接編集 ON で派生 ES を currentEsBody に flatten した際、既に物理的に焼き込まれた
// text 採用 / 編集の id を渡すと、structural と同様に **完全 skip**(置換 / 累積オフセット /
// span を一切行わない)。これにより flatten 後に form.es_body 基準 span を当てて二重適用
// する破損を防ぐ。default 空のため、既存呼び出し(直接編集していない通常経路)の挙動は不変。
//
// -----------------------------------------------------------------------------
// 2026-05-28 unanchorable-accept APPLY bug fix(本 fix の中核): APPLY 2-pass 化
// -----------------------------------------------------------------------------
// 背景(root cause):
//  - 逆質問の回答を取り込んだ提案は `original` が「先行採用で圧縮済のテキスト」を指す。
//    例(es4 sug_009): `original` =「そこで、20代100名へのアンケートを企画しました。…」
//    (= sug_005 / sug_006 採用で圧縮された後の文)。`original_span` = {179,237}(派生 ES 座標)。
//  - この圧縮後テキストは baseline(form.es_body = 原文、まだ「そこで私は、20代の若者100名を
//    対象とした…」)に **存在しない** → `reAnchorSuggestionsToFormEsBody` の indexOf < 0 で
//    case 3「unanchorable は元 span 温存」が発動し、`original_span` は派生 ES 座標のまま残る。
//  - 従来の単一 pass は baseline に対して `{179,237}+offset` を当てるが、179/237 は「圧縮後」
//    座標、offset は sug_005 / sug_006 の baseline 基準の長さ差分 = **座標系不一致**。誤位置に
//    当たって置換が反映されない / 別所を壊す(= 採用しても本文に反映されない症状)。
//  - これは症状 B の HIGHLIGHT 版(reconcileSpansToDisplayedText)の APPLY 経路版。案 2 と
//    同じ「現在のテキストに anchor」の発想を APPLY 側へ拡張する。
//
// 修正方針(approach a: APPLY を 2-pass に。案 2 と同じ「テキストで locate」):
//  - **pass 1**(従来ロジックを完全保存 + 2 つの deferral 経路を追加): sorted 走査。
//    deferred に回す経路は 2 つ。それ以外は従来通り baseline + 累積オフセットで前から置換。
//    (1) **unanchorable バイパス(本 fix の核、overlap ガードより前)**: 採用 / 編集済かつ
//        `original` が **baseline(esBody)に存在しない**(`esBody.indexOf(original) < 0`、
//        reAnchor case 3 と同一判定)→ `original_span` は派生 ES 座標で baseline 座標の
//        overlap / 範囲ガードと比較しても無意味。よって両ガードを **通さず** deferred に直行。
//        これが es4 sug_009 型(stale 派生 span が先行採用の baseline 領域と衝突する)を救う鍵。
//    (2) **anchorable verify-defer(overlap / 範囲ガードの後)**: `original` が baseline に在る
//        (= anchorable)が、累積オフセット後の派生位置の実テキストが `original` と一致しない
//        span ドリフトの採用 → pass 1 では適用せず deferred(offset / lastEnd も進めない)。
//    * `original` 未指定(既存テストの minimal 型)では (1)(2) とも発火せず、従来通り無条件適用。
//  - **pass 2**(deferred の救済): 各 deferred について、pass 1 の出力テキスト(= 圧縮後の
//    派生 ES)から `original` を indexOf で locate し、`proposed` / edited に置換。
//    * 1 箇所 → そこへ適用。複数 → 派生 start ヒントに最も近い出現を採用(案 2 と同じ曖昧性解消)。
//    * 0 箇所(真に locate 不能)→ skip(誤適用しない。誤位置置換より無の方が安全)。
//
// 設計判断(既存アーキとの整合・低リスク):
//  - `original` 未指定(既存テストの minimal 型)では (1)(2) を完全 skip = 既存 46 ユニットテストの
//    挙動を 1bit も変えない。実呼び出し側は full Suggestion を渡すため本 fix が production で発火。
//  - anchorable な通常採用(original が baseline に在り span も正しい)は verify を通って従来通り
//    適用 → deferred に入らない(無変更)。
//  - structural / baked は従来通り pass 1 冒頭で skip、deferred 対象にもしない。
//  - **overlap-shadowing fix の保持**: overlap ガード(start < lastEnd)で弾かれる「baseline 座標で
//    本当に重なる採用」は (1) を通らない(original が baseline に在る = anchorable のため)。よって
//    従来どおり shadow される。(1) がバイパスするのは unanchorable(baseline に実体が無い)だけで、
//    これは baseline 上の他採用と「重なる」概念自体が成立しないため、二重適用も shadow 破壊も無い。
//  - pass 2 は indexOf ベースで案 2(reconcileSpansToDisplayedText)と同型。各置換ごとに body を
//    更新して都度 re-search するため、複数 deferred の累積位置ずれを自然に吸収する。
// 関連:
//  - reconcileSpansToDisplayedText(本 fix の HIGHLIGHT 版、対称な「テキストで locate」)
//  - reAnchorSuggestionsToFormEsBody case 3(unanchorable 温存。本 fix がその APPLY 側救済)
//  - DECISIONS.md [2026-05-28] ハイライト位置ずれ(症状 B)実装結果 §残課題「unanchorable case」
export function getDerivedEsBody(
  esBody: string,
  suggestions: ReadonlyArray<SuggestionForDerive>,
  acceptedIds: ReadonlyArray<string>,
  editedMap: Readonly<Record<string, string>>,
  bakedIds: ReadonlyArray<string> = [],
): string {
  const sorted = sortSuggestionsForDerive(suggestions);
  const bakedSet = new Set(bakedIds);
  let body = esBody;
  let offset = 0;
  let lastEnd = -1; // 「先勝ち」用、cursor 相当
  // pass 1 で適用できなかった「採用 / 編集済だが baseline 座標に当たらない」提案を退避。
  // derivedStart は pass 2 の複数出現 曖昧性解消ヒント(pass 1 時点の累積オフセット込み位置)。
  const deferred: {
    id: string;
    original: string;
    replacement: string;
    derivedStart: number;
  }[] = [];
  for (const s of sorted) {
    // v2 bug fix: structural は currentEsBody に既に applyStructuralOperation 経由で
    // 適用済 = ここでの追加置換は不要かつ有害。lastEnd / offset の更新も行わない。
    if (s.category === "structural") continue;
    // 2026-05-28 dogfood round 3 ⑤: baked(flatten で currentEsBody に焼き込み済)も
    // structural と同じく完全 skip。置換 / offset / lastEnd 更新を行わない。
    if (bakedSet.has(s.id)) continue;
    const { start, end } = s.original_span;
    const isAccepted = acceptedIds.includes(s.id);
    const isEdited = s.id in editedMap;

    // 2026-05-28 unanchorable-accept fix(本 fix の核): 採用 / 編集済かつ `original` が
    // **baseline(esBody)に存在しない** = unanchorable(reAnchorSuggestionsToFormEsBody の
    // case 3 と同一判定: `esBody.indexOf(original) < 0`)。この場合 `original_span` は
    // 派生 ES 座標のまま温存されており、baseline 座標の overlap ガード(start < lastEnd)/
    // 範囲ガードと比較しても無意味(座標系が違う)。よってここで pass 2 に直行させる
    // (overlap / 範囲ガードを **通さない**)。pass 2 が pass 1 出力の派生テキストから
    // `original` を locate して置換する。
    //
    // 重要(overlap-shadowing fix を壊さないための discriminator):
    //  - `original` が baseline に **存在する** 提案(= anchorable)は、ここを通さず従来の
    //    overlap / 範囲 / verify ガードに掛ける。よって「baseline 座標で本当に重なる採用」は
    //    従来どおり shadow される(2026-05-28 overlap-shadowing bug fix の挙動を完全保持)。
    //  - unanchorable(baseline に original 無し)だけがバイパスする。これは派生座標にしか
    //    実体が無いため、baseline 上の他採用と「重なる」概念自体が成立しない。
    if (
      (isAccepted || isEdited) &&
      typeof s.original === "string" &&
      s.original.length > 0 &&
      esBody.indexOf(s.original) < 0
    ) {
      deferred.push({
        id: s.id,
        original: s.original,
        replacement: isEdited ? editedMap[s.id] : s.proposed,
        // 派生 ES 座標の start をそのままヒントに(pass 2 の複数出現 曖昧性解消用)。
        derivedStart: start,
      });
      continue;
    }

    // overlap ガード(先勝ち、baseline 座標)。anchorable 提案にのみ適用。
    if (start < lastEnd) continue;
    if (!isAccepted && !isEdited) {
      // 2026-05-28 overlap-shadowing bug fix: 未採用 / 未編集の suggestion は派生 ES の
      // text を一切変更しない(置換も累積オフセットも発生しない)。したがって `lastEnd`
      // を進めてはならない。進めると、start 昇順走査で後続にソートされる **採用済** の
      // suggestion で span が重なるもの(start < lastEnd)が上の overlap ガードに弾かれ、
      // 採用済の置換が派生 ES から消える regression が起きる(未採用が採用済を shadow)。
      // 例: 未採用 [60,71] が lastEnd=71 を立て、採用済の typo 修正 [63,65] が 63<71 で skip。
      continue;
    }
    // 編集済が優先(EDITED は ACCEPTED より新しい意図のため)
    const replacement = isEdited ? editedMap[s.id] : s.proposed;
    // 範囲ガード: 元基準で esBody に収まらない span。
    // 2026-05-28 unanchorable-accept fix: 従来は採用でも問答無用で skip(= 反映されない)
    // だったが、`original` があれば pass 2 で派生テキストから救済できるため deferred に回す。
    // (ここに来る = anchorable(original は baseline に在る)が、temp の span が壊れている等。
    //  pass 2 で baseline に在る original を locate して救済できる。)
    const rangeInvalid = start < 0 || end > esBody.length || end <= start;
    if (rangeInvalid) {
      if (typeof s.original === "string" && s.original.length > 0) {
        deferred.push({
          id: s.id,
          original: s.original,
          replacement,
          // 範囲外 span は累積オフセットの基準にならないため derivedStart は素の start を
          // ヒントに使う(pass 2 の複数出現解消で「だいたいこの辺」程度の弱いヒント)。
          derivedStart: start + offset,
        });
      }
      // original が無い(既存テストの minimal 型)場合は従来通り何もせず skip。
      continue;
    }
    // 現在の body に対する派生 start / end(累積オフセットを足し込み)
    const derivedStart = start + offset;
    const derivedEnd = end + offset;
    // 2026-05-28 unanchorable-accept fix: `original` が渡された場合のみ、置換直前に
    // 「派生位置の実テキストが original と一致するか」を verify する。一致しなければ
    // span がずれている採用(anchorable だが span ドリフト等)なので pass 1 では適用せず
    // deferred に回す(offset / lastEnd も進めない = 未採用と同じ扱い)。pass 2 が baseline /
    // 派生テキストから original を locate して救済する。
    // `original` 未指定(既存テストの minimal 型)では verify を skip = 従来通り無条件適用。
    if (typeof s.original === "string") {
      const actual = body.slice(derivedStart, derivedEnd);
      if (actual !== s.original) {
        if (s.original.length > 0) {
          deferred.push({
            id: s.id,
            original: s.original,
            replacement,
            derivedStart,
          });
        }
        continue;
      }
    }
    body = body.slice(0, derivedStart) + replacement + body.slice(derivedEnd);
    // 後続のオフセットを更新(置換差分)
    offset += replacement.length - (end - start);
    lastEnd = end;
  }

  // pass 2: pass 1 で適用できなかった unanchorable 採用を、現在の派生テキスト(pass 1 の出力)
  // から `original` を locate して救済適用する。案 2(reconcileSpansToDisplayedText)と同型の
  // 「テキストで locate → 1 箇所なら適用 / 複数なら最近傍 / 0 箇所なら skip」。
  //
  // 2026-05-28 BUG #2 fix(依存連鎖の取りこぼし): pass 2 を **fixpoint ループ化**。
  // 背景: deferred 同士が依存する場合(B の `original` が A の pass 2 適用後の body にしか
  // 現れない)+ A が B より後ソート(= deferred 配列で後)だと、単一 pass の逐次適用では
  // B を先に locate して 0 箇所 → skip → B の採用が消える。fixpoint 化すると、A が適用された
  // 次の周で B が locate できるようになり、連鎖が解ける。
  // 終了条件: その周で 1 件も適用できなければ終了(残りは真に locate 不能 = 安全に skip)。
  // 各置換ごとに body を更新するため、複数 deferred の累積位置ずれは従来どおり自然に吸収される。
  let remaining = deferred.slice();
  while (remaining.length > 0) {
    const stillDeferred: typeof remaining = [];
    let appliedThisRound = 0;
    for (const d of remaining) {
      const occurrences: number[] = [];
      let from = 0;
      for (;;) {
        const idx = body.indexOf(d.original, from);
        if (idx < 0) break;
        occurrences.push(idx);
        from = idx + 1; // 重なり出現も拾う(1 文字ずつ進める)
      }
      if (occurrences.length === 0) {
        // この周では locate 不能。次の周に残す(他 deferred の適用で body が変われば
        // locate できるようになる可能性がある = 依存連鎖の解消)。
        stillDeferred.push(d);
        continue;
      }
      // 1 箇所 → そこへ適用。複数 → pass 1 で計算した derivedStart に最も近い出現を採用。
      let chosen = occurrences[0];
      if (occurrences.length > 1) {
        let bestDist = Math.abs(occurrences[0] - d.derivedStart);
        for (let i = 1; i < occurrences.length; i++) {
          const dist = Math.abs(occurrences[i] - d.derivedStart);
          if (dist < bestDist) {
            bestDist = dist;
            chosen = occurrences[i];
          }
        }
      }
      body =
        body.slice(0, chosen) + d.replacement + body.slice(chosen + d.original.length);
      appliedThisRound += 1;
    }
    // この周で 1 件も適用できなければ終了(残り stillDeferred は真に locate 不能 → skip)。
    // 無限ループ防止: 適用 0 件 = body 不変 = 次の周も同じ結果になるため break する。
    if (appliedThisRound === 0) break;
    remaining = stillDeferred;
  }
  return body;
}

// UX 改修 3b (2026-05-23): 派生 ES の文字数を返す純関数(Canvas の文字数監視用)。
// `getDerivedEsBody` の結果から長さを取得するだけだが、Canvas / 他所からの呼び出しが
// memo / dependency を簡潔にできるように関数として公開する。
// `getDerivedEsBody` と同じ走査ロジックを共有するため、ハイライト位置との整合は構造で
// 保証される(同一の sortSuggestionsForDerive 経路を使う)。
export function getDerivedEsLength(
  esBody: string,
  suggestions: ReadonlyArray<SuggestionForDerive>,
  acceptedIds: ReadonlyArray<string>,
  editedMap: Readonly<Record<string, string>>,
  // 2026-05-28 dogfood round 3 ⑤: baked 集合を getDerivedEsBody へ透過(default 空で挙動不変)。
  bakedIds: ReadonlyArray<string> = [],
): number {
  return getDerivedEsBody(esBody, suggestions, acceptedIds, editedMap, bakedIds)
    .length;
}

// UX 改修 3b (2026-05-23): 派生 ES が設問の文字数上限を超過しているかを判定する純関数。
// charLimit を未指定(undefined / null)時は常に false を返す(超過判定不可)。
export function isOverCharLimit(
  derivedLength: number,
  charLimit: number | undefined | null,
): boolean {
  if (typeof charLimit !== "number" || !Number.isFinite(charLimit)) {
    return false;
  }
  return derivedLength > charLimit;
}

// 派生 span — 各 suggestion について「現在の派生 ES 本文上での位置」を返す純関数。
// `getDerivedEsBody` と同じ走査順・同じ重なり判定で動くため、両者の整合性は
// 構造で保証される。
//
// 引数:
//  - suggestions: AnalysisResult.suggestions(分析結果)
//  - acceptedIds: 採用済 ID 集合
//  - editedMap: 編集済 ID → edited_text マップ
//  - rejectedIds: 却下済 ID 集合(描画属性に使う、位置計算には影響しない)
//
// 戻り値: 各 suggestion に対応する DerivedSpan の配列(走査順)
//
// 走査スキップ条件:
//  - `lastEnd` より前から始まる span(重なる後発)はスキップ(原状の F1.1 と整合)
//  - 元 esBody の範囲外 / 不正な span はスキップ
// v2 bug fix (2026-05-26): `structural` カテゴリは **完全 skip**。理由は
// `getDerivedEsBody` のコメント参照(structural の `proposed` は placeholder で
// オフセット計算に使えず、span を出すと Canvas が誤った位置を描画する)。
// structural の suggestion は Canvas 中央には描画されない(Phase B4 設計:
// 段落単位構造変更は右パネル SuggestionListPanel / StructuralOperationBlock で表示)。
// よって本関数で span を返さないことは UI 上正しい(Canvas 側の挙動と整合)。
// 2026-05-28 dogfood round 3 ⑤ 直接編集 bug fix: 第 6 引数 `bakedIds`(optional、default 空)を
// 追加。getDerivedEsBody と対称に、flatten で焼き込み済の id は span を返さない / 累積オフセット
// にも影響させない(structural と同じ完全 skip)。default 空のため既存呼び出しの挙動は不変。
export function getDerivedSpans(
  suggestions: ReadonlyArray<SuggestionForDerive>,
  acceptedIds: ReadonlyArray<string>,
  editedMap: Readonly<Record<string, string>>,
  rejectedIds: ReadonlyArray<string>,
  esBodyLength: number,
  bakedIds: ReadonlyArray<string> = [],
): DerivedSpan[] {
  const sorted = sortSuggestionsForDerive(suggestions);
  const bakedSet = new Set(bakedIds);
  const result: DerivedSpan[] = [];
  let offset = 0;
  let lastEnd = -1;
  for (const s of sorted) {
    // v2 bug fix: structural は派生計算から完全に除外(getDerivedEsBody と対称)。
    // Canvas の buildSegments は structural span を消費しないため、span を返さない
    // のが UI 正解(Canvas.tsx L192-205 の B4 設計コメント参照)。
    if (s.category === "structural") continue;
    // 2026-05-28 dogfood round 3 ⑤: baked も完全 skip(getDerivedEsBody と対称)。
    if (bakedSet.has(s.id)) continue;
    const { start, end } = s.original_span;
    if (start < lastEnd) continue;
    if (start < 0 || end > esBodyLength || end <= start) continue;
    const isAccepted = acceptedIds.includes(s.id);
    const isEdited = s.id in editedMap;
    const isApplied = isAccepted || isEdited;
    const isRejected = rejectedIds.includes(s.id);

    if (isApplied) {
      // 派生 span は「置換後の文字列の範囲」を指す(描画はスキップされるが、
      // 累積オフセット計算のためにこの範囲を確定させる必要がある)。
      const replacement = isEdited ? editedMap[s.id] : s.proposed;
      const derivedStart = start + offset;
      const derivedEnd = derivedStart + replacement.length;
      result.push({
        suggestion_id: s.id,
        derivedStart,
        derivedEnd,
        isApplied: true,
        isRejected: false,
      });
      offset += replacement.length - (end - start);
      // 2026-05-28 overlap-shadowing bug fix: 採用済 / 編集済(置換が発生する側)だけが
      // `lastEnd` を進める。getDerivedEsBody と対称(同一の root cause)。
      lastEnd = end;
    } else {
      // 未対応 / 却下のままなら span は原文の範囲 + 現在のオフセット。
      // 2026-05-28 overlap-shadowing bug fix: 未採用 / 却下は派生 text(座標系)を変えない
      // ため `lastEnd` を進めない。進めると、後続にソートされる採用済 suggestion の span が
      // `start < lastEnd` ガードに弾かれてハイライトごと消える(採用済を shadow)。
      // getDerivedEsBody の未採用分岐から lastEnd 更新を外したのと対称の修正。
      // なお「採用済 → 未採用」順で採用済が lastEnd を立て未採用を弾く既存挙動(reAnchor
      // 経路の防御線、derived_es_body.test.ts case 7 等)は採用済側の lastEnd で維持される。
      result.push({
        suggestion_id: s.id,
        derivedStart: start + offset,
        derivedEnd: end + offset,
        isApplied: false,
        isRejected,
      });
    }
  }
  return result;
}

// -----------------------------------------------------------------------------
// 2026-05-27 derivedSpans 座標系統一 bug fix
// -----------------------------------------------------------------------------
// partial refresh / refresh の結果に含まれる updated / added / suggestions の
// `original_span` を form.es_body 基準に再アンカーする純関数。
//
// 背景(root cause):
//  - サーバ側 `resolveOriginalSpans` は `input.es_body`(= displayEsBody、派生 ES)に対して
//    `indexOf(s.original)` で位置解決する(lib/utils/es_anchor.ts:36)
//  - つまり partial / refresh 応答に乗ってくる新規 suggestion の `original_span` は
//    「分析時点の派生 ES の座標系」になっている
//  - 一方、未採用 / 未更新の既存 suggestion は初回分析時に form.es_body に対して
//    解決された座標系を維持している
//  - `applyPartialResult` / `applyRefreshResult` は両者をそのままマージするため、
//    `analysisResult.suggestions` に **2 種類の座標系が混在** する
//  - Canvas の `getDerivedSpans` は累積オフセット計算を「全 span が同一座標系」と仮定
//    しているため、新規 suggestion 側で誤った位置にずれる(ハイライト境界ずれ + lastEnd
//    ガードによる span 落ち = ハイライト消失)
//
// 修正方針(案 A: LLM 出力 span を form.es_body 基準に逆マッピング):
//  - merge 前に updated / added / suggestions の各 suggestion について、
//    `form.es_body.indexOf(s.original)` で再アンカーを試みる
//  - 見つかれば `original_span` を form.es_body 基準に書き換える
//  - 見つからない場合(LLM が採用済 proposed 内のテキストを ID した稀ケース)は
//    元の派生 ES 基準 span を温存する(slightly off だがハイライトは出る、防御線)
//
// 設計判断:
//  - structural カテゴリは Canvas の派生計算で完全 skip されるため、座標系混在の影響を
//    受けない。再アンカー処理に含めても害は無いが、明示的に skip しても良い。本実装では
//    一律に処理する(構造を単純化、structural の original も indexOf で扱える)
//  - 「重複出現」の問題: form.es_body に同じ文字列が複数回出現する場合、indexOf は最初の
//    一致を返す。これは既存 `resolveOriginalSpans`(lib/utils/es_anchor.ts:20)と同じ
//    挙動で、本 fix で挙動を変えない(既存の曖昧性は別 dispatch で対応)
//  - 1 回の re-anchor だけで足りる: 初回 analyze 時点で suggestions は form.es_body 基準で
//    生成される。partial / refresh で新規 suggestion が混入する時に再アンカーすれば、
//    `analysisResult.suggestions` 全体が常に form.es_body 基準に揃う
//
// テスト:
//  - tests/derived_es_body.test.ts の Task E bug fix section に regression case を追加
//  - 本関数の直接テスト(再アンカー前後の original_span)
//  - 「unanchorable」ケース(form.es_body に original が存在しない)で span 温存
//  - 重複出現で最初の一致を採用
//
// 参考:
//  - DECISIONS.md [2026-05-27] derivedSpans 座標系統一 bug fix 方針確定
//  - lib/utils/es_anchor.ts:resolveOriginalSpans(サーバ側の元解決ロジック)
//  - lib/llm/openai.ts:1997-2004(partial 経路の indexOf 解決)
export function reAnchorSuggestionsToFormEsBody(
  formEsBody: string,
  suggestions: ReadonlyArray<Suggestion>,
): Suggestion[] {
  return suggestions.map((s) => {
    const newStart = formEsBody.indexOf(s.original);
    if (newStart < 0) {
      // form.es_body に s.original が見つからない = 採用済 proposed 内のテキストを LLM が
      // 拾った稀ケース。元の span を温存(displayEsBody 基準のまま)。Canvas の派生計算では
      // 累積オフセットが余分に掛かって slightly off だが、span 落ちよりはマシ(防御線)。
      return s;
    }
    const newEnd = newStart + s.original.length;
    if (newStart === s.original_span.start && newEnd === s.original_span.end) {
      // 既に form.es_body 基準なら no-op(初回分析経路で来た既存 suggestion 等)
      return s;
    }
    return {
      ...s,
      original_span: { start: newStart, end: newEnd },
    };
  });
}

// -----------------------------------------------------------------------------
// 2026-05-28 ハイライト位置ずれ(症状 B)補正 — 表示テキストへの verify→relocate→suppress
// -----------------------------------------------------------------------------
// `getDerivedSpans` が返す派生 span を、**表示中 ES の実テキスト**(displayEsBody =
// getDerivedEsBody の出力)で検証・補正する additive な純関数。
//
// 背景(root cause):
//  - 座標系統一 bug fix(2026-05-27)の `reAnchorSuggestionsToFormEsBody` は、partial /
//    refresh で来た新規 suggestion の `original_span` を form.es_body 基準に揃える。
//  - だが、提案が「採用で既に変化したテキスト」を指す場合(例: 先行提案で「上げました」→
//    「改善しました」を採用済 → 後発 pending 提案の `original` =「生徒の成績を改善しました」)、
//    `form.es_body`(= 元原文、まだ「上げました」)に `original` が存在しないため
//    `indexOf < 0` となり、reAnchor case 3「unanchorable は元 span 温存」が発動する。
//  - 温存された span は displayEsBody 基準のままなのに、Canvas は全 span を form.es_body
//    基準と仮定して累積オフセットを足し込む → 派生位置が別の場所(例: 締めの「ら、目標を
//    定めた後も行動」)にずれて誤ハイライトになる(es2 sug_008 で実観測)。
//
// 修正方針(案 2: 表示テキストにアンカー、additive な検証・補正層):
//  - `getDerivedSpans` 本体の signature / 既存挙動は一切変えず、その **結果に対する
//    post-process** として本関数を Canvas から呼ぶ(既存 37 ケースの単体テストを壊さない)。
//  - 各 span について「今あるべき表示テキスト」を決定し、`displayEsBody.slice(derivedStart,
//    derivedEnd)` がそれと一致するか検証する。
//    * pending(未採用): あるべきテキスト = `original`
//    * applied(採用済 / 編集済) かつ描画される(= autoCorrected): あるべきテキスト =
//      編集済なら `editedMap[id]`、それ以外は `proposed`
//  - 一致 → そのまま(既存の正しいケースは一切変更しない = 低リスク)。
//  - 不一致(ずれ検出) → relocate: あるべきテキストを `displayEsBody` から検索し、
//    * 1 箇所一致 → そこへ span を貼り直す
//    * 複数一致 → 計算済 `derivedStart` に最も近い出現を採用(既存 span をヒントに曖昧性解消)
//    * 0 箇所 → suppress(span を結果から落とす = ハイライトを出さない。誤ハイライトより無)
//
// 設計判断:
//  - 「描画されない span」(applied かつ非 autoCorrected、buildSegments が continue する側)は
//    検証・補正の対象外でそのまま通す。これらは Canvas でハイライト描画されないため、表示
//    テキストがずれていても誤ハイライトを生まない。span を動かすと逆に累積整合を壊すリスク。
//    なお getDerivedSpans は派生 span の累積オフセットを既に確定済みで、本関数は派生 span を
//    入力に取るため、suppress / relocate しても他 span の derivedStart には影響しない(各 span
//    は独立した絶対座標を持つ)。
//  - structural は getDerivedSpans が既に除外しており、本関数の入力 span には含まれない。
//  - relocate の検索は indexOf ベース。複数一致時の「最も近い出現」は、元 derivedStart との
//    絶対距離が最小の候補を選ぶ(既存 span をヒントに使う = reAnchor の indexOf 一律最初取り
//    より曖昧性に強い)。
//
// -----------------------------------------------------------------------------
// 2026-05-28 BUG #1 fix(approach B): 欠落 span の生成的補完(getDerivedSpans の 2-pass 非対称
// = unanchorable 採用のハイライト落ちを救済)
// -----------------------------------------------------------------------------
// 背景(root cause):
//  - getDerivedEsBody は a289 で 2-pass 化され、unanchorable 採用(`original` が baseline に無い)
//    を pass 2 で派生テキストから locate して **本文には反映** するようになった。
//  - だが `getDerivedSpans` は単一 pass のままで、unanchorable 採用の span を overlap ガード
//    (`start < lastEnd`、baseline 座標)/ 範囲ガード(`end > esBodyLength`)で **完全に落とす**。
//    本関数(reconcile)は入力 span を「補正(relocate / suppress)」するだけなので、入力に
//    存在しない(= 落ちた)span は復活できない → 本文は出るがハイライト(特に autoCorrected の
//    emerald 強調)が消える(= BUG #1)。
//
// 修正方針(approach B: reconcile を生成的に拡張):
//  - verify/relocate ループ(既存)の後、suggestions 全件を起点に「描画されるべきなのに
//    入力 span にも生成 span にも存在しない applied/autoCorrected 提案」を displayEsBody から
//    locate して補完する。これにより落ちた span を「現テキストにアンカーした座標」で復活させる。
//  - approach A(getDerivedSpans を 2-pass 化)を採らない理由: getDerivedSpans は displayEsBody
//    を受け取らず、unanchorable discriminator(`esBody.indexOf(original) < 0`)に必要な baseline
//    テキストも持たない(`esBodyLength` 数値のみ)。approach A は signature 変更 + locate 機構の
//    重複が必要。reconcile は既に displayEsBody / id 集合 / locate 機構(indexOf 出現収集 +
//    最近傍曖昧性解消)を全て持ち、落ちた applied/autoCorrected の表示テキスト = proposed/edited
//    は a289 の pass 2 で displayEsBody に焼き込み済 = そのまま locate できる。よって approach B
//    が a289/案 2 と最も整合し、getDerivedSpans(overlap-shadowing fix 7772fc1 を含む)を 1 行も
//    変えずに済む(= 既存 getDerivedSpans 54 test 完全不変)。
//
// overlap-shadowing fix(7772fc1)を壊さないための生成条件:
//  - **applied(採用 / 編集)かつ autoCorrected** に限定して生成する(= 描画される側のみ)。
//    理由: getDerivedSpans の overlap ガードが「採用済が後続の重なる未採用を弾く」防御線
//    (case 408)を、生成パスの **テキスト実在ガード** で代替する。詳細は次条。
//  - **legitimate に overlap-shadow された applied は生成されない**(= 自然な安全性): 採用 vs
//    採用で shadow された側は getDerivedEsBody でも対称に shadow されており、その proposed は
//    displayEsBody に焼き込まれていない → locate 0 箇所 → 生成されない。生成されるのは a289 で
//    本文に反映された(= displayEsBody に proposed が実在する)unanchorable 採用だけ。
//  - **既存 span / 生成済 span と座標が重なる場合は生成しない**(coincidental 一致の backstop):
//    proposed が偶然他所にも出現するケースで二重ハイライトを避ける。
//  - structural / baked / 既に入力 span を持つ id は生成対象から除外。
//
// 2026-05-29 shadow-rescue fix(BUG #1 の pending 版): 上の applied/autoCorrected 生成の直後に、
// **pending 提案の span 落ち**を救済する第 2 の生成パスを追加した(関数末尾、最終ソートの直前)。
// 当初「pending は決して生成しない」としていたが、これは「pending を **無条件に** 生成すると
// case 408 防御線を壊す」が正しく、防御線の本質は overlap ガード自体ではなく「shadow された側の
// テキストが displayEsBody に残っているか」にある。pending-rescue は applied 生成と同じ
// **テキスト実在ガード**(`original` が displayEsBody に intact で実在 + 既存 span と非重複)で
// gate するため、legitimate に上書き shadow された pending(original が本文から消えている)は
// 0 箇所 locate で生成されず、case 408 防御線は維持される。救済されるのは「採用済 unanchorable の
// 過大な派生 end が baseline 上は実際には重ならない pending を過剰 shadow した」落ちだけ。
// 詳細は当該ブロック冒頭コメント参照。
//
// 関連:
//  - DECISIONS.md [2026-05-27] derivedSpans 座標系統一 実装結果 §残課題「unanchorable case」
//    (本関数がその残課題の防御線を表示テキスト側で強化する)
//  - getDerivedEsBody の APPLY 2-pass(a289、本 fix の APPLY 側対称)
//  - components/canvas/Canvas.tsx buildSegments(本関数の呼び出し元 = post-process)
export function reconcileSpansToDisplayedText(
  spans: ReadonlyArray<DerivedSpan>,
  suggestions: ReadonlyArray<Suggestion>,
  displayEsBody: string,
  opts: {
    acceptedIds: ReadonlyArray<string>;
    editedMap: Readonly<Record<string, string>>;
    autoCorrectedIds: ReadonlyArray<string>;
    // 2026-05-28 BUG #1 fix: 直接編集 flatten で焼き込み済の id 集合。getDerivedSpans と対称に
    // 生成的補完の対象外にする(default 空 = 既存呼び出しの挙動不変)。
    bakedIds?: ReadonlyArray<string>;
    // 2026-05-29 shadow-rescue fix: 却下済 id 集合。pending-rescue(後述)で却下済を
    // 生成対象から除外するために使う(default 空 = 既存呼び出しの挙動不変)。
    rejectedIds?: ReadonlyArray<string>;
  },
): DerivedSpan[] {
  const byId = new Map(suggestions.map((s) => [s.id, s]));
  const acceptedSet = new Set(opts.acceptedIds);
  const autoCorrectedSet = new Set(opts.autoCorrectedIds);
  const bakedSet = new Set(opts.bakedIds ?? []);
  const rejectedSet = new Set(opts.rejectedIds ?? []);

  const result: DerivedSpan[] = [];
  for (const span of spans) {
    const suggestion = byId.get(span.suggestion_id);
    if (!suggestion) {
      // 対応する suggestion が見つからない(理論上起きないが防御)。そのまま通す。
      result.push(span);
      continue;
    }

    const isEdited = span.suggestion_id in opts.editedMap;
    const isAccepted = acceptedSet.has(span.suggestion_id);
    const isApplied = span.isApplied || isAccepted || isEdited;
    const isAutoCorrected = autoCorrectedSet.has(span.suggestion_id);

    // 描画されない span(applied かつ非 autoCorrected)は検証対象外でそのまま通す。
    // buildSegments 側でハイライト描画が continue されるため、表示テキストがずれていても
    // 誤ハイライトを生まない。span を動かすと累積整合を壊すリスクがあるため触らない。
    if (isApplied && !isAutoCorrected) {
      result.push(span);
      continue;
    }

    // 「今あるべき表示テキスト」を決定する。
    //  - applied(= ここに来るのは autoCorrected のみ): 編集済なら edited_text、
    //    それ以外は proposed(自動修正は proposed が表示テキストに焼き込まれている)
    //  - pending: original
    let expectedText: string;
    if (isApplied) {
      expectedText = isEdited ? opts.editedMap[span.suggestion_id] : suggestion.proposed;
    } else {
      expectedText = suggestion.original;
    }

    // expectedText が空(理論上 schema で min(1) だが防御)なら検証不能、そのまま通す。
    if (expectedText.length === 0) {
      result.push(span);
      continue;
    }

    // 検証: 派生 span が指す表示テキストが expectedText と一致するか。
    const actual = displayEsBody.slice(span.derivedStart, span.derivedEnd);
    if (actual === expectedText) {
      // 一致 → 既存の正しいケース。一切変更しない(低リスク)。
      result.push(span);
      continue;
    }

    // 不一致(ずれ検出) → relocate を試みる。expectedText の全出現位置を集める。
    const occurrences: number[] = [];
    let from = 0;
    for (;;) {
      const idx = displayEsBody.indexOf(expectedText, from);
      if (idx < 0) break;
      occurrences.push(idx);
      from = idx + 1; // 重なり出現も拾う(1 文字ずつ進める)
    }

    if (occurrences.length === 0) {
      // 0 箇所 → suppress(span を結果から落とす)。誤ハイライトより無の方がマシ。
      continue;
    }

    // 1 箇所 → そこへ貼り直す。複数 → 元 derivedStart に最も近い出現を採用(既存 span を
    // ヒントに曖昧性解消)。
    let chosen = occurrences[0];
    if (occurrences.length > 1) {
      let bestDist = Math.abs(occurrences[0] - span.derivedStart);
      for (let i = 1; i < occurrences.length; i++) {
        const dist = Math.abs(occurrences[i] - span.derivedStart);
        if (dist < bestDist) {
          bestDist = dist;
          chosen = occurrences[i];
        }
      }
    }

    result.push({
      ...span,
      derivedStart: chosen,
      derivedEnd: chosen + expectedText.length,
    });
  }

  // 2026-05-28 BUG #1 fix(approach B): 欠落 span の生成的補完。
  // getDerivedSpans が overlap / 範囲ガードで落とした「描画されるべき applied/autoCorrected」を
  // displayEsBody から locate して復活させる。詳細・安全性は本関数冒頭コメント参照。
  //
  // 既に result に存在する id(入力 span を verify/relocate で通したもの)は生成しない。
  const presentIds = new Set(result.map((s) => s.suggestion_id));
  // 生成した span の占有区間(start, end)。既存 result + 生成済との overlap を弾く backstop に使う。
  const occupied: { start: number; end: number }[] = result.map((s) => ({
    start: s.derivedStart,
    end: s.derivedEnd,
  }));
  const overlapsOccupied = (start: number, end: number): boolean =>
    occupied.some((o) => start < o.end && end > o.start);

  for (const suggestion of suggestions) {
    if (presentIds.has(suggestion.id)) continue; // 既に span がある → 生成不要
    // getDerivedSpans と対称の除外: structural / baked は派生計算に含めない。
    if (suggestion.category === "structural") continue;
    if (bakedSet.has(suggestion.id)) continue;

    const isEdited = suggestion.id in opts.editedMap;
    const isAccepted = acceptedSet.has(suggestion.id);
    const isApplied = isAccepted || isEdited;
    const isAutoCorrected = autoCorrectedSet.has(suggestion.id);

    // 生成対象は **applied(採用 / 編集)かつ autoCorrected**(= 描画される側)に限定。
    // pending は生成しない(overlap-shadowing 防御線を壊さないため、冒頭コメント参照)。
    if (!isApplied || !isAutoCorrected) continue;

    // 表示テキスト = 編集済なら edited_text、それ以外は proposed(a289 の pass 2 で displayEsBody
    // に焼き込み済のはず)。
    const expectedText = isEdited ? opts.editedMap[suggestion.id] : suggestion.proposed;
    if (expectedText.length === 0) continue; // 防御(schema 上は min(1))

    // displayEsBody から locate。0 箇所(= legitimate に shadow された等で本文に無い)→ 生成しない。
    const occurrences: number[] = [];
    let from = 0;
    for (;;) {
      const idx = displayEsBody.indexOf(expectedText, from);
      if (idx < 0) break;
      occurrences.push(idx);
      from = idx + 1; // 重なり出現も拾う
    }
    if (occurrences.length === 0) continue;

    // 既存 / 生成済 span と重ならない最初の出現を採用(coincidental 一致の二重ハイライト回避)。
    // 複数候補がある場合も「空いている」出現を順に探す。全て占有済なら生成しない。
    let chosen = -1;
    for (const idx of occurrences) {
      if (!overlapsOccupied(idx, idx + expectedText.length)) {
        chosen = idx;
        break;
      }
    }
    if (chosen < 0) continue;

    result.push({
      suggestion_id: suggestion.id,
      derivedStart: chosen,
      derivedEnd: chosen + expectedText.length,
      isApplied: true,
      isRejected: false,
    });
    occupied.push({ start: chosen, end: chosen + expectedText.length });
  }

  // ---------------------------------------------------------------------------
  // 2026-05-29 shadow-rescue fix(BUG #1 生成的補完の pending 版): 採用済 unanchorable が
  // 隣接 pending を過剰 shadow したハイライト落ちを救済
  // ---------------------------------------------------------------------------
  // 背景(root cause、es5 で実観測):
  //  - 採用済が unanchorable(`original` が「先行採用で変化した後のテキスト」を指し form.es_body
  //    に無い → reAnchorSuggestionsToFormEsBody case 3 で派生座標を温存)だと、その
  //    `original_span.end` は「実際の適用範囲より長い」派生座標のまま残る。
  //  - getDerivedSpans の overlap ガードは採用済の `lastEnd = end`(= この過大な派生 end)を立てる。
  //    すると baseline 座標で正当に後続する anchorable な **pending** 提案が `start < lastEnd` で
  //    完全に落とされる(span 自体が rawSpans に現れない)。
  //  - 上の BUG #1 生成的補完は applied/autoCorrected のみを対象にするため、落ちた pending は
  //    verify/relocate(入力 span が前提)でも生成パスでも復活できず、本文にテキストは在るのに
  //    ハイライトだけ消える(= 本 bug。es5 sug_003 で実観測、sug_004 は別座標で偶発回避)。
  //
  // 修正方針(本 fix、getDerivedSpans を 1 行も変えない = 既存 54 test 完全不変):
  //  - applied/autoCorrected 生成パスの直後に、**入力にも生成にも span を持たない pending 提案**を
  //    起点に「`original` が displayEsBody に **そのまま実在** し、かつ既存/生成済 span と重ならない」
  //    なら span を生成的に復活させる。これは BUG #1 生成的補完の pending 版(対象を applied/
  //    autoCorrected → pending に拡張、判定テキストを proposed/edited → `original` に変える)。
  //
  // overlap-shadowing 防御線(7772fc1 / case 408)を壊さないための安全性(BUG #1 safety 1 と対称):
  //  - **legitimate に shadow された pending は復活しない**: 採用 vs pending(baseline 座標で本当に
  //    重なる)では、採用の proposed が displayEsBody の当該領域を **上書き** しているため、pending の
  //    `original` は displayEsBody に intact では存在しない → indexOf 0 箇所 → 生成されない。
  //    復活するのは「採用の `original_span` が **過大な派生座標** で baseline 上は実際には重ならない」
  //    = pending の `original` が displayEsBody に手付かずで残っているケースだけ(= 本 bug が対象)。
  //  - **却下 / baked / structural / applied は対象外**(pending の純粋な落ちのみ救済)。
  //  - **既存/生成済 span と重なる出現は採用しない**(coincidental 一致の二重ハイライト回避、
  //    BUG #1 生成パスと同一の backstop)。
  // SSOT: DECISIONS.md [2026-05-29] 採用済 unanchorable が隣接 pending を過剰 shadow するハイライト落ち修正
  const presentAfterGen = new Set(result.map((s) => s.suggestion_id));
  for (const suggestion of suggestions) {
    if (presentAfterGen.has(suggestion.id)) continue; // 既に span がある → 救済不要
    if (suggestion.category === "structural") continue;
    if (bakedSet.has(suggestion.id)) continue;
    if (rejectedSet.has(suggestion.id)) continue; // 却下済はハイライトを出さない

    const isEdited = suggestion.id in opts.editedMap;
    const isApplied = acceptedSet.has(suggestion.id) || isEdited;
    if (isApplied) continue; // pending(未採用・未編集)のみが本 fix の対象

    // pending のあるべき表示テキスト = `original`(本文未変更なので原文がそのまま表示中)。
    const expectedText = suggestion.original;
    if (expectedText.length === 0) continue; // 防御(schema 上は min(1))

    // displayEsBody から locate。0 箇所(= legitimate に shadow / 上書きされた)→ 生成しない。
    const occurrences: number[] = [];
    let from = 0;
    for (;;) {
      const idx = displayEsBody.indexOf(expectedText, from);
      if (idx < 0) break;
      occurrences.push(idx);
      from = idx + 1; // 重なり出現も拾う
    }
    if (occurrences.length === 0) continue;

    // 既存 / 生成済 span と重ならない最初の出現を採用(BUG #1 生成パスと同一の backstop)。
    let chosen = -1;
    for (const idx of occurrences) {
      if (!overlapsOccupied(idx, idx + expectedText.length)) {
        chosen = idx;
        break;
      }
    }
    if (chosen < 0) continue;

    result.push({
      suggestion_id: suggestion.id,
      derivedStart: chosen,
      derivedEnd: chosen + expectedText.length,
      isApplied: false,
      isRejected: false,
    });
    occupied.push({ start: chosen, end: chosen + expectedText.length });
  }

  // relocate で span 位置が動くと start 昇順が崩れ得る。呼び出し元 Canvas.buildSegments は
  // `cursor` を前進させながら走査し `derivedStart < cursor` で弾くため、昇順前提が崩れると
  // relocate した正しい span が誤って skip される。getDerivedSpans の出力は昇順で、本関数は
  // その前提を壊さないよう derivedStart 昇順(同 start は derivedEnd 降順 = 長い方優先、
  // sortSuggestionsForDerive と整合)に再ソートして返す。
  result.sort((a, b) => {
    if (a.derivedStart !== b.derivedStart) return a.derivedStart - b.derivedStart;
    return b.derivedEnd - a.derivedEnd;
  });

  return result;
}

// -----------------------------------------------------------------------------
// Bundle 構築: FormState → AnalyzeInputBundleInitial(API 送信形)
// -----------------------------------------------------------------------------
// 呼び出し側で companySummary を渡す(research が成功していれば値、失敗・未入力なら undefined)。
//
// 命名揺れ解消の中核ポイント(F.7): フォーム自体の preset/free_text は
// AnalyzeInputBundleInitial.edit_conditions に直接展開される。
// 旧 InputBundle.editing_condition(単数)は経由しない。
// FormState.char_limit(string)を API 境界の `number | undefined` に正規化する。
// 2026-05-29 char_limit 任意化: 空欄 / 空白のみ / 非正整数は undefined(= 制限なし)。
// isFormValid が「非空なら正整数」を保証済なので、送信時点で非空かつ正整数なら数値、
// それ以外(空欄)は undefined を返す。schema は char_limit を optional として受ける。
export function parseCharLimit(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

export function buildAnalyzeBundle(
  form: FormState,
  companySummary: CompanySummary | undefined,
): AnalyzeInputBundleInitial {
  const char_limit = parseCharLimit(form.char_limit);

  // free_text と user_context は空文字でも default("")で吸収される(schema 側 default)。
  // ただし schema 厳格性を活かすため、明示的に渡す。
  return {
    mode: "initial",
    es_body: form.es_body,
    question: {
      text: form.question_text,
      char_limit,
    },
    company_summary: companySummary,
    edit_conditions: {
      preset: form.preset,
      free_text: form.free_text,
    },
    user_context: form.user_context,
    // Phase E では初回分析のみ。current_es_version=0 が初期値の根拠は
    // docs/decisions_so_far.md「楽観的並行制御 — バージョンとは何か」より。
    // Phase G で accept/edit/reject 後にこの値が +1 されてリフレッシュに渡る。
    current_es_version: 0,
  };
}

// -----------------------------------------------------------------------------
// Phase G Step 2 (2026-05-23): Bundle 構築 — store state → AnalyzeInputBundleRefresh
// -----------------------------------------------------------------------------
// 「再分析する」ボタンクリック時、store から refresh 用 bundle を組み立てる。
//
// 入力ソース:
//  - form / companySummary: initial と同じ(分析開始時の入力を再利用)
//  - actionHistory: store.actionHistory(必ず 1 件以上、空なら button が disabled なので不到達)
//  - currentEsBody: directEdit や採用 / 編集の派生反映を含んだ最新 ES 本文
//  - baseVersion: beginRefresh が返す clientEsVersion(送信時点の基準バージョン)
//
// es_body の渡し方:
//  - Phase G Step 2 では「派生 ES 本文(getDerivedEsBody)」を refresh に投げる方が
//    LLM の判断材料として正しい(採用された変更を反映した状態の ES に対して再指摘)。
//  - ただし、現在の Canvas は `getDerivedEsBody(currentEsBody, suggestions, ...)` で
//    派生計算しているため、refresh bundle も同じ派生を渡すべき。
//  - 簡略化: 呼び出し側(Canvas)で `displayEsBody` を算出してから渡す方が直感的。
//    本関数は受け取る es_body を素直に bundle に詰めるだけにする。
// UX 改修 3b (2026-05-23): `goal` 引数を追加。
//  - 省略 / "balanced": 既存挙動と同じ(prompt / 検証は通常 refresh)
//  - "reduce_length":   buildRefreshUserMessage が削減モード指示を追加で挿入
//  - schema 側で default("balanced") を設定済のため、ここで explicit に渡すことで
//    送信時の意図を明示する(undefined を渡すと default 適用)
// 2026-05-27 エージェント的対話(AI 逆質問): ClarificationAnswer 群と analysisResult から
// 「[逆質問への回答]\nQ: …\nA: …」形式の enriched_intent テキストを生成する純粋関数。
// 回答が無い / 全て空回答 / 質問本文が引けない場合は空文字を返す(append しない side path)。
//
// 形式:
//   [逆質問への回答]
//   Q (全体): <question>
//   A: <answer>
//
//   Q (sug_002): <question>
//   A: <answer>
//
// 設計:
//  - scope === "global" の場合 prefix は「Q (全体): 」
//  - scope === "suggestion" の場合 prefix は「Q (sug_XXX): 」(suggestion_id 流用)
//  - 質問本文(question)は analysisResult から id で引く。引けないものは skip
//  - 各 Q/A ペアは 1 空行で区切る(LLM に明確な区切りを伝える)
//
// Canvas / Test から再利用可能。
export function buildClarificationEnrichedIntent(
  answers: ReadonlyArray<ClarificationAnswer>,
  result: AnalysisResult | null,
): string {
  const validAnswers = answers.filter((a) => a.answer_text.trim().length > 0);
  if (validAnswers.length === 0 || result === null) return "";

  // 複合キー(scope + suggestion_id + question_id)→ ClarificationQuestion の lookup map。
  // 2026-05-29: question_id 単独だと別 suggestion の同名 q_001 が上書きし合い、回答が
  // 取り違えた質問本文に紐づく(enriched_intent に間違った Q が混入)。
  const questionsByKey = new Map<string, ClarificationQuestion>();
  for (const sug of result.suggestions) {
    for (const q of sug.clarification_questions ?? []) {
      questionsByKey.set(
        clarificationIdentity({
          scope: "suggestion",
          suggestion_id: sug.id,
          question_id: q.id,
        }),
        q,
      );
    }
  }
  for (const q of result.global_clarification_questions ?? []) {
    questionsByKey.set(
      clarificationIdentity({ scope: "global", question_id: q.id }),
      q,
    );
  }

  const pairs: string[] = [];
  for (const ans of validAnswers) {
    const q = questionsByKey.get(
      clarificationIdentity({
        scope: ans.scope,
        suggestion_id: ans.suggestion_id,
        question_id: ans.question_id,
      }),
    );
    if (!q) continue; // 質問本文が引けない(refresh で消えた等)→ skip
    const scopeLabel =
      ans.scope === "global"
        ? "全体"
        : ans.suggestion_id !== undefined
          ? ans.suggestion_id
          : "指摘";
    pairs.push(`Q (${scopeLabel}): ${q.question}\nA: ${ans.answer_text.trim()}`);
  }
  if (pairs.length === 0) return "";
  // ヘッダは lib/schema/clarification.ts の SSOT 定数を使う(prompt builder 側の検知と同期)。
  return `${CLARIFICATION_ENRICHED_INTENT_HEADER}\n${pairs.join("\n\n")}`;
}

// 2026-05-27 エージェント的対話(AI 逆質問): user_context に「[逆質問への回答]」section を
// append する純粋関数。base(form.user_context)が空でも安全に動作。
// enrichedIntentText が空文字 / undefined の場合は base をそのまま返す(append しない)。
// 分離して export することで build*Bundle / tests 双方から再利用可能。
export function appendClarificationToUserContext(
  baseUserContext: string,
  enrichedIntentText: string | undefined,
): string {
  if (!enrichedIntentText || enrichedIntentText.trim().length === 0) {
    return baseUserContext;
  }
  const base = baseUserContext.trim();
  // base が空文字なら「[逆質問への回答]\n…」だけ返す。base ありなら 1 空行で区切る
  // (LLM に「ユーザーが当初書いた文脈」と「逆質問への回答」を区別させる)。
  if (base.length === 0) {
    return enrichedIntentText;
  }
  return `${base}\n\n${enrichedIntentText}`;
}

export function buildRefreshBundle(args: {
  form: FormState;
  companySummary: CompanySummary | undefined;
  esBody: string;
  actionHistory: ActionHistoryEntry[];
  baseVersion: number;
  goal?: AnalyzeGoal;
  // 2026-05-27 エージェント的対話: 「この回答で再分析」経路で user_context に enrichment する
  // 「[逆質問への回答]\nQ: …\nA: …」テキスト。通常 refresh では undefined。
  clarificationEnrichedIntent?: string;
}): AnalyzeInputBundleRefresh {
  const char_limit = parseCharLimit(args.form.char_limit);
  return {
    mode: "refresh",
    es_body: args.esBody,
    question: {
      text: args.form.question_text,
      char_limit,
    },
    company_summary: args.companySummary,
    edit_conditions: {
      preset: args.form.preset,
      free_text: args.form.free_text,
    },
    user_context: appendClarificationToUserContext(
      args.form.user_context,
      args.clarificationEnrichedIntent,
    ),
    current_es_version: args.baseVersion,
    action_history: args.actionHistory,
    goal: args.goal ?? "balanced",
  };
}

// -----------------------------------------------------------------------------
// Phase G Step 3b-2 (2026-05-23): Bundle 構築 — store state → AnalyzeInputBundlePartial
// -----------------------------------------------------------------------------
// 「再分析する」ボタン(balanced 経路)で partial mode を使う場合の bundle 組み立て。
// 既存 refresh bundle との違い:
//  - existing_suggestions: 現在の analysisResult.suggestions(span 解決済)を引き継ぐ
//  - overall_assessment: 現在の analysisResult.overall_assessment(Opus の評価軸)
//  - accepted/rejected/edited_suggestion_ids: ユーザー操作済 id 配列
//  - mode: "partial"(refresh と判別される)
//  - goal は持たない(partial は通常再分析のみ、削減は fallback で refresh stream)
//
// 入力は呼び出し側(Canvas の handleRefresh)が store から取り出して渡す。
// Phase G 再修正 (2026-05-24): 副次的な候補プール構造を撤去し、引数も整理した。
// 統合改修パッケージ訂正 (2026-05-25): 構造計算(refresh_scope.ts:computeRefreshScope)
// から AI 判断方式に変更。seedSuggestionIds / seedActionType / editBefore / editAfter を
// 受け取り、partial bundle へ渡す。影響範囲のフィルタは LLM に委ねる。
export function buildPartialBundle(args: {
  form: FormState;
  companySummary: CompanySummary | undefined;
  esBody: string;
  actionHistory: ActionHistoryEntry[];
  baseVersion: number;
  // 現在の AnalysisResult の suggestions / overall_assessment(必須)
  existingSuggestions: import("@/lib/schema/suggestion").Suggestion[];
  overallAssessment: import("@/lib/schema/analysis").OverallAssessment;
  // ユーザー操作済 id 配列(LLM に「触ってはいけない id」を伝えるため)
  acceptedSuggestionIds: string[];
  rejectedSuggestionIds: string[];
  editedSuggestionIds: string[];
  // 統合改修パッケージ訂正 (2026-05-25): AI 判断方式の seed 情報
  seedSuggestionIds: string[];
  seedActionType:
    | "reject"
    | "edit"
    | "direct_edit"
    | "undo"
    | "redo"
    | "manual";
  editBefore?: string;
  editAfter?: string;
  // 2026-05-27 エージェント的対話: 「この回答で再分析」経路で user_context に enrichment する
  // 「[逆質問への回答]\nQ: …\nA: …」テキスト。通常 partial では undefined。
  clarificationEnrichedIntent?: string;
}): AnalyzeInputBundlePartial {
  const char_limit = parseCharLimit(args.form.char_limit);
  const bundle: AnalyzeInputBundlePartial = {
    mode: "partial",
    es_body: args.esBody,
    question: {
      text: args.form.question_text,
      char_limit,
    },
    company_summary: args.companySummary,
    edit_conditions: {
      preset: args.form.preset,
      free_text: args.form.free_text,
    },
    user_context: appendClarificationToUserContext(
      args.form.user_context,
      args.clarificationEnrichedIntent,
    ),
    current_es_version: args.baseVersion,
    action_history: args.actionHistory,
    existing_suggestions: args.existingSuggestions,
    overall_assessment: args.overallAssessment,
    accepted_suggestion_ids: args.acceptedSuggestionIds,
    rejected_suggestion_ids: args.rejectedSuggestionIds,
    edited_suggestion_ids: args.editedSuggestionIds,
    seed_suggestion_ids: args.seedSuggestionIds,
    seed_action_type: args.seedActionType,
  };
  if (args.editBefore !== undefined) {
    bundle.edit_before = args.editBefore;
  }
  if (args.editAfter !== undefined) {
    bundle.edit_after = args.editAfter;
  }
  return bundle;
}
