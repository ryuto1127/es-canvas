"use client";

// =============================================================================
// Phase E: 入力フォーム本体
// =============================================================================
//
// 構成(上から):
//   1. 「ES と設問」セクション(必須) — ES 本体 / 設問 / 文字数制限
//   2. 「企業情報」セクション(任意) — URL / 企業名 / 自由テキスト の 3 タブ(Phase E 拡張 2026-05-23)
//   3. 「添削の方向性」セクション(必須) — プリセット + 自由入力
//   4. 「補足情報」セクション(任意) — ユーザー文脈
//   5. 分析開始ボタン(primary color、icon 付き、loading 時はスピナー)
//
// store は useAnalyzeStore を購読。API 呼び出しはこのコンポーネントから直接行う
// (Phase E では薄い設計、専用 client lib は作らない)。
//
// Phase E UI polish (2026-05-23):
//  - 7 フィールドを 4 セクションに grouping、各セクション Card で囲み accent line を付与
//  - primary button を indigo primary + icon (Sparkles / Loader2) に
//  - 必須マーク `*` を destructive 色で目立たせる(以前から指定済、見た目を強化)
//  - 文字数カウンタの overflow 表示を明確化(オーバー時 destructive)
//  - 各セクションに 1 行説明文(任意セクションで「未入力時の挙動」を補足)
//
// Phase E 拡張 (2026-05-23):
//  - 「企業情報」セクションを URL / 企業名 / 自由テキスト の 3 タブ UI(`Tabs`)に拡張
//  - 各タブの入力は独立 state(タブ切り替えで値は消えない)
//  - 自由テキストは差別化軸 #2「根拠のトレーサビリティ」を維持するため LLM 整形で
//    CompanySummary 形式に揃える(source_url = "user-input" 固定、source_quote は verbatim)
//
// UX 改修 1 (2026-05-23):
//  - 任意セクション(企業情報 / 補足情報)を**折りたたみ可能**に。デフォルト折りたたみ。
//    初見でも「ここを開けば任意項目がある」ことが視認できるよう、ヘッダ右端に
//    展開/折りたたみアイコンを表示。必須セクション(ES と設問 / 添削の方向性)は
//    トグルなしで常時展開。
//  - 「添削の方向性」内の「自由記述」は任意だが、プリセットと同じセクション内に
//    残し、フィールド単位ではトグル化しない(セクション粒度より細かくすると
//    UI 認知負荷が上がるため)。
//
// AGENTS.md 制約遵守:
//  - ユーザーは待たない → Phase E では loading 中 form disable で妥協(Phase G で並行制御)
//  - 数値スコア禁止 → フォームには出さない(token_usage を保持しても UI は出さない)
//
// SSOT: lib/schema/input.ts (EditingPreset values), lib/state/analyze_store.ts

import * as React from "react";
import { useTranslations } from "next-intl";
import {
  EditingPresetSchema,
  AnalyzeInputBundleSchema,
} from "@/lib/schema/input";
import {
  appendCaptureMetaEntry,
  buildAnalyzeBundle,
  isFormValid,
  isLoadingPhase,
  useAnalyzeStore,
  type AnalyzePhase,
  type CompanyInputType,
  type FormState,
  type ServerError,
  type StreamingStage,
} from "@/lib/state/analyze_store";
import type { AnalysisResult } from "@/lib/schema/analysis";
// 提出後改善 #3 準備 (2026-06-09): サーバ応答の optional `capture_meta`(受動計測メタ)。
import type { CaptureMeta } from "@/lib/llm/capture_meta";
import type { CompanySummary } from "@/lib/schema/company";
import {
  openAIKeyHeader,
  getStoredOpenAIKey,
  subscribeOpenAIKey,
  requestOpenSettings,
} from "@/lib/byok";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ArrowRight,
  Building2,
  ChevronDown,
  FileText,
  KeyRound,
  Loader2,
  Sparkles,
  User,
} from "lucide-react";
import { FileUpload } from "./FileUpload";

// 6 種類のプリセット。schema を信頼してそこから派生(値を二重管理しない)。
// EditingPresetSchema は z.enum(...) なので .options で string 配列が取れる。
const PRESET_OPTIONS = EditingPresetSchema.options;

// 「分析開始」ボタンのラベル。phase に応じて変化させる。
// i18n (2026-05-25): translation key を返し、呼び出し側で `t(key)` を引く形式に変更。
function buttonLabelKey(phase: AnalyzePhase): string {
  switch (phase) {
    case "researching":
      return "submit_researching";
    case "analyzing":
      return "submit_analyzing";
    case "done":
    case "error":
      return "submit_done_or_error";
    case "idle":
    default:
      return "submit_idle";
  }
}

// API 呼び出しの timeout。tests/analyze.test.ts と揃える(330秒、route maxDuration 300秒 + 30秒)。
const FETCH_TIMEOUT_MS = 330_000;

// =============================================================================
// /api/research 呼び出し
// =============================================================================
// 失敗時は throw せず、{ ok: false, error } を返す(/api/analyze は続行する設計)。
//
// Phase E 拡張(2026-05-23): 入力経路を 3 種に拡張(url / name / freetext)。
// payload の組み立ては input_type に応じて key を切り替える(url / name / value)。
// 提出後改善 #3 準備 (2026-06-09): capture_meta は optional の additive フィールド
// (キャッシュヒット / 旧サーバでは付かない、parse は壊れない)。
type ResearchResponse =
  | { data: CompanySummary; cached?: boolean; capture_meta?: CaptureMeta }
  | { error: ServerError };

type ResearchPayload =
  | { input_type: "url"; url: string }
  | { input_type: "name"; name: string }
  | { input_type: "freetext"; value: string };

async function callResearch(
  payload: ResearchPayload,
): Promise<
  | { ok: true; summary: CompanySummary; captureMeta?: CaptureMeta }
  | { ok: false; error: ServerError }
> {
  let res: Response;
  try {
    res = await fetch("/api/research", {
      method: "POST",
      // BYOK: localStorage の OpenAI 鍵を x-openai-key ヘッダで添える(あれば)。
      headers: { "Content-Type": "application/json", ...openAIKeyHeader() },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "network",
        message:
          err instanceof Error
            ? err.message
            : "ネットワークエラー(企業要約取得)",
      },
    };
  }

  let body: ResearchResponse;
  try {
    body = (await res.json()) as ResearchResponse;
  } catch {
    return {
      ok: false,
      error: {
        kind: "bad_response",
        message: "/api/research が JSON を返しませんでした",
        status: res.status,
      },
    };
  }

  if (!res.ok || "error" in body) {
    const e = "error" in body ? body.error : undefined;
    return {
      ok: false,
      error: {
        kind: e?.kind ?? "unknown",
        message: e?.message ?? `HTTP ${res.status}`,
        stage: e?.stage,
        retryable: e?.retryable,
        status: res.status,
      },
    };
  }

  // 提出後改善 #3 準備 (2026-06-09): capture_meta を pass-through(あれば)。
  return { ok: true, summary: body.data, captureMeta: body.capture_meta };
}

// =============================================================================
// /api/analyze SSE streaming 呼び出し(Phase G Step 1, 2026-05-23)
// =============================================================================
// initial 経路は SSE(text/event-stream)。各 event は `data: <json>\n\n` 形式。
// payload の `type` フィールド(anthropic.ts:AnalyzeStreamEvent と整合)で分岐。
//
// 設計判断:
//  - 進行 event(started / thinking / generating / retrying)は store.streamingStage を
//    更新するだけで、UI が反応(LoadingDisplay の文言切替)
//  - completed event を受け取ったら setAnalysisResult を呼んで終了
//  - error event を受け取ったら setAnalyzeError を呼んで終了
//  - HTTP status は 200 固定の前提だが、defensive に != 200 もエラー扱い
//  - parser はシンプルに、improved buffer 行き帰り(`\n\n` で event 区切り)
//
// SSE payload 型(anthropic.ts:AnalyzeStreamEvent と同形、独立宣言で client / server を結合)
// 提出後改善 #3 準備 (2026-06-09): completed に optional capture_meta(additive)。
type AnalyzeStreamPayload =
  | { type: "started"; mode: "initial"; model: string; attempt: number }
  | { type: "thinking"; delta: string }
  | { type: "tool_progress"; cumulativeChars: number }
  | { type: "retry"; issueKinds: string[] }
  | { type: "completed"; result: AnalysisResult; capture_meta?: CaptureMeta }
  | {
      type: "error";
      kind: string;
      message: string;
      stage?: string;
      retryable?: boolean;
    };

async function callAnalyzeStream(
  input: ReturnType<typeof buildAnalyzeBundle>,
  onStage: (stage: StreamingStage) => void,
): Promise<
  | { ok: true; result: AnalysisResult; captureMeta?: CaptureMeta }
  | { ok: false; error: ServerError }
> {
  // 送信前 Zod 検証(JSON 版と同じ規律)
  const parsed = AnalyzeInputBundleSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        kind: "invalid_input_client",
        message: `フォームの値がスキーマ検証に失敗: ${JSON.stringify(parsed.error.flatten())}`,
      },
    };
  }

  let res: Response;
  try {
    res = await fetch("/api/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        // BYOK: localStorage の OpenAI 鍵を x-openai-key ヘッダで添える(あれば)。
        ...openAIKeyHeader(),
      },
      body: JSON.stringify(parsed.data),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "network",
        message:
          err instanceof Error
            ? err.message
            : "ネットワークエラー(分析 SSE)",
      },
    };
  }

  // 有効な SSE ストリームでない応答(HTTP エラー or body 欠落 or content-type が
  // text/event-stream でない)は、まず JSON の {error}(server の error kind を保持)を
  // parse して返す。parse 不可なら bad_response にフォールバックする。
  // これにより非 2xx の JSON エラー(例 400 missing_api_key)が bad_response に
  // 潰れず、「設定からキーを入れて」の導線が出る。
  const contentType = res.headers.get("content-type") ?? "";
  const isEventStream = contentType.includes("text/event-stream");
  if (!res.ok || !res.body || !isEventStream) {
    try {
      const body = (await res.json()) as { error?: ServerError };
      return {
        ok: false,
        error: body.error ?? {
          kind: "bad_response",
          message: `/api/analyze (initial stream) returned ${res.status} (content-type=${contentType})`,
          status: res.status,
        },
      };
    } catch {
      return {
        ok: false,
        error: {
          kind: "bad_response",
          message: `/api/analyze did not return SSE (status=${res.status}, content-type=${contentType})`,
          status: res.status,
        },
      };
    }
  }

  // SSE をライン単位で読み、`\n\n` で event を区切り、`data: <json>` を抽出。
  // `\r\n` 改行も許容(SSE 仕様)。
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let lastResult: AnalysisResult | null = null;
  // 提出後改善 #3 準備 (2026-06-09): completed event の optional 受動計測メタ。
  let lastCaptureMeta: CaptureMeta | undefined;
  let lastError: ServerError | null = null;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // event 区切りは空行(\n\n または \r\n\r\n)
      let separatorIndex: number;
      while (
        (separatorIndex = findEventSeparator(buffer)) >= 0
      ) {
        const rawEvent = buffer.slice(0, separatorIndex);
        // separator 長(`\n\n` は 2、`\r\n\r\n` は 4)
        const separatorLen = buffer
          .slice(separatorIndex, separatorIndex + 4)
          .startsWith("\r\n\r\n")
          ? 4
          : 2;
        buffer = buffer.slice(separatorIndex + separatorLen);

        const dataLines = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"));
        if (dataLines.length === 0) continue;
        const dataStr = dataLines
          .map((line) => line.slice("data:".length).replace(/^\s/, ""))
          .join("\n");
        if (dataStr.length === 0) continue;

        let payload: AnalyzeStreamPayload;
        try {
          payload = JSON.parse(dataStr) as AnalyzeStreamPayload;
        } catch {
          // 壊れた event は無視(SSE 仕様的に推奨される耐障害性)
          continue;
        }

        switch (payload.type) {
          case "started":
            // attempt=2 はリトライ中の started、stage を retrying のままにする選択もあるが、
            // 視覚的には「再分析中…」の方が誠実なので started でも "started" を維持
            // (retry event 受信時に "retrying" にしている前提)。
            onStage("started");
            break;
          case "thinking":
            onStage("thinking");
            break;
          case "tool_progress":
            onStage("generating");
            break;
          case "retry":
            onStage("retrying");
            break;
          case "completed":
            onStage("finalizing");
            lastResult = payload.result;
            lastCaptureMeta = payload.capture_meta;
            break;
          case "error":
            lastError = {
              kind: payload.kind,
              message: payload.message,
              stage: payload.stage,
              retryable: payload.retryable,
              status: res.status,
            };
            break;
        }
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "network",
        message:
          err instanceof Error
            ? err.message
            : "SSE 読み取り中にエラーが発生しました",
      },
    };
  }

  if (lastError) {
    return { ok: false, error: lastError };
  }
  if (lastResult) {
    return { ok: true, result: lastResult, captureMeta: lastCaptureMeta };
  }
  // completed も error も来ずに stream が終了 = サーバ側の異常終了
  return {
    ok: false,
    error: {
      kind: "bad_response",
      message: "SSE が completed / error を返さずに終了しました",
      status: res.status,
    },
  };
}

// SSE の event 境界(空行)を見つける。`\n\n` と `\r\n\r\n` の両方に対応。
// 戻り値: 境界の先頭インデックス(separator はそこから始まる)。なければ -1。
function findEventSeparator(buffer: string): number {
  // \r\n\r\n を優先して探す(より長いマッチを先に)
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf < 0) return lf;
  if (lf < 0) return crlf;
  return Math.min(crlf, lf);
}

// =============================================================================
// /api/research 送信 payload の組み立て(Phase E 拡張 2026-05-23)
// =============================================================================
// 現在選択中の company_input_type に対応するフィールド値が「入力済」(空でない)なら
// payload を返し、未入力なら null を返す(/api/research をスキップする)。
//
// 経路別の「入力済」判定:
//   - url:      trim 後に空でなければ送信(URL 形式は schema が弾く、もし不正なら 400 で返る)
//   - name:     trim 後に空でなければ送信(min 1 字なので 1 字で送信可能)
//   - freetext: trim 後に 20 字以上で送信(schema の min 20 と一致、未満なら未入力扱い)
//
// 各タブの値は独立 state なので、他タブに値が入っていても無視する(意図的)。
function buildResearchPayload(form: {
  company_input_type: CompanyInputType;
  company_url: string;
  company_name: string;
  company_freetext: string;
}): ResearchPayload | null {
  switch (form.company_input_type) {
    case "url": {
      const url = form.company_url.trim();
      if (url.length === 0) return null;
      return { input_type: "url", url };
    }
    case "name": {
      const name = form.company_name.trim();
      if (name.length === 0) return null;
      return { input_type: "name", name };
    }
    case "freetext": {
      const value = form.company_freetext.trim();
      // schema の min(20) 未満は送ってもサーバで弾かれるため、クライアント側で未入力扱いに。
      if (value.length < 20) return null;
      return { input_type: "freetext", value };
    }
  }
}

// =============================================================================
// セクション見出し付き Card のラッパ
// =============================================================================
// 左に primary の縦線(accent line)を付けて、セクション境界を視覚化する。
// 任意セクションには `optional` を立ててバッジ表記。
//
// UX 改修 1 (2026-05-23): `collapsible` prop で折りたたみ対応に拡張。
//  - collapsible なしまたは false: 従来通り常時展開
//  - collapsible: true: ヘッダがクリッカブル、右端に chevron アイコン、
//    `defaultOpen` で初期状態を制御(デフォルト false = 折りたたみ)
//  - 折りたたみ時もヘッダ(タイトル + 任意バッジ + description)は見えるので
//    「ここに任意項目がある」ことは初見でも視認できる
// 任意セクション用の小さいバッジ(translation 経由)
function OptionalBadge() {
  const tCommon = useTranslations("common");
  return (
    <span className="ml-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      {tCommon("optional")}
    </span>
  );
}

function SectionCard({
  icon: Icon,
  title,
  description,
  optional,
  collapsible,
  defaultOpen,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  optional?: boolean;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const tForm = useTranslations("inputForm");
  // collapsible でない場合は従来通り常時展開
  if (!collapsible) {
    return (
      <Card className="relative overflow-visible">
        <span
          aria-hidden
          className="absolute top-3 bottom-3 left-0 w-[3px] rounded-r-full bg-primary/70"
        />
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Icon className="size-4 text-primary" />
            <span>{title}</span>
            {optional ? <OptionalBadge /> : null}
          </CardTitle>
          {description ? (
            <CardDescription className="text-xs leading-relaxed">
              {description}
            </CardDescription>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-5">{children}</CardContent>
      </Card>
    );
  }

  // collapsible: ヘッダがトリガになる
  return (
    <Card className="relative overflow-visible">
      <span
        aria-hidden
        className="absolute top-3 bottom-3 left-0 w-[3px] rounded-r-full bg-primary/70"
      />
      <Collapsible defaultOpen={defaultOpen}>
        <CollapsibleTrigger
          render={
            <button
              type="button"
              className="group/section-trigger flex w-full items-center justify-between gap-2 rounded-t-xl px-4 py-3 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
              aria-label={tForm("section_toggle_aria", { section: title })}
            >
              <span className="flex flex-col gap-1">
                <span className="flex items-center gap-2 text-base font-heading font-medium leading-snug">
                  <Icon className="size-4 text-primary" />
                  <span>{title}</span>
                  {optional ? <OptionalBadge /> : null}
                </span>
                {description ? (
                  <span className="text-xs leading-relaxed text-muted-foreground text-jp">
                    {description}
                  </span>
                ) : null}
              </span>
              <ChevronDown
                className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/section-trigger:rotate-180"
                aria-hidden
              />
            </button>
          }
        />
        <CollapsibleContent>
          <div className="flex flex-col gap-5 px-4 pb-4 pt-1">{children}</div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

// =============================================================================
// 企業情報の 3 タブ UI(Phase E 拡張 2026-05-23)
// =============================================================================
// タブ: URL / 企業名 / 自由テキスト。各タブの入力は独立 state で、タブ切り替え時に
// 他タブの値は消えない(意図的)。送信時は handleSubmit が
// `form.company_input_type` を見て該当フィールドだけを /api/research に渡す。
//
// 各タブの placeholder / 補足文 / 制約(min/max):
//   URL:      placeholder = "https://example.com/"、HTML5 type=url 検証
//   企業名:    placeholder = "例: ターゲット企業名"、1〜100 字
//   自由テキスト: placeholder = 企業行動指針の例文、20〜4000 字、文字数カウンタ
const COMPANY_TAB_VALUES: ReadonlyArray<CompanyInputType> = [
  "url",
  "name",
  "freetext",
];

// 自由テキスト経路の文字数下限/上限(schema の min(20)/max(4000) と一致)
const FREETEXT_MIN_LEN = 20;
const FREETEXT_MAX_LEN = 4000;

function CompanyInputTabs({ disabled }: { disabled: boolean }) {
  const t = useTranslations("inputForm");
  const tCompanyType = useTranslations("companyInputType");
  const companyInputType = useAnalyzeStore((s) => s.form.company_input_type);
  const companyUrl = useAnalyzeStore((s) => s.form.company_url);
  const companyName = useAnalyzeStore((s) => s.form.company_name);
  const companyFreetext = useAnalyzeStore((s) => s.form.company_freetext);
  const setField = useAnalyzeStore((s) => s.setField);

  const freetextLen = companyFreetext.length;
  const freetextUnder = freetextLen > 0 && freetextLen < FREETEXT_MIN_LEN;
  const freetextOver = freetextLen > FREETEXT_MAX_LEN;

  return (
    <Tabs
      value={companyInputType}
      onValueChange={(v) => {
        // base-ui Tabs の onValueChange は unknown(Value 型)を返す。
        // CompanyInputType の literal union に narrowing してから setField に渡す。
        if (v === "url" || v === "name" || v === "freetext") {
          setField("company_input_type", v);
        }
      }}
      className="flex flex-col gap-3"
    >
      <TabsList className="w-fit">
        {COMPANY_TAB_VALUES.map((v) => (
          <TabsTrigger key={v} value={v} disabled={disabled}>
            {tCompanyType(v)}
          </TabsTrigger>
        ))}
      </TabsList>

      {/* URL タブ */}
      <TabsContent value="url" className="flex flex-col gap-1.5">
        <label
          htmlFor="company_url"
          className="text-sm font-medium text-foreground"
        >
          {t("company_url_label")}
        </label>
        <Input
          id="company_url"
          type="url"
          value={companyUrl}
          onChange={(e) => setField("company_url", e.target.value)}
          placeholder={t("company_url_placeholder")}
          disabled={disabled}
        />
        <p className="text-xs text-muted-foreground text-jp">
          {t("company_url_hint")}
        </p>
      </TabsContent>

      {/* 企業名タブ */}
      <TabsContent value="name" className="flex flex-col gap-1.5">
        <label
          htmlFor="company_name"
          className="text-sm font-medium text-foreground"
        >
          {t("company_name_label")}
        </label>
        <Input
          id="company_name"
          type="text"
          value={companyName}
          onChange={(e) => setField("company_name", e.target.value)}
          placeholder={t("company_name_placeholder")}
          disabled={disabled}
          maxLength={100}
        />
        <p className="text-xs text-muted-foreground text-jp">
          {t("company_name_hint")}
        </p>
      </TabsContent>

      {/* 自由テキストタブ */}
      <TabsContent value="freetext" className="flex flex-col gap-1.5">
        <label
          htmlFor="company_freetext"
          className="text-sm font-medium text-foreground"
        >
          {t("company_freetext_label")}
        </label>
        <Textarea
          id="company_freetext"
          value={companyFreetext}
          onChange={(e) => setField("company_freetext", e.target.value)}
          placeholder={t("company_freetext_placeholder")}
          rows={6}
          disabled={disabled}
          aria-invalid={freetextUnder || freetextOver}
        />
        <p className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">
            {t("es_count_current")}{" "}
            <span className="font-medium text-foreground">{freetextLen}</span>{" "}
            {t("es_count_chars")}
          </span>
          {freetextOver ? (
            <span className="text-destructive">
              {t("company_freetext_over", { max: FREETEXT_MAX_LEN })}
            </span>
          ) : freetextUnder ? (
            <span className="text-muted-foreground">
              {t("company_freetext_under_prefix")}{" "}
              {FREETEXT_MIN_LEN - freetextLen}
              {t("company_freetext_under_suffix", { min: FREETEXT_MIN_LEN })}
            </span>
          ) : (
            <span className="text-muted-foreground">
              {t("company_freetext_range", { min: FREETEXT_MIN_LEN, max: FREETEXT_MAX_LEN })}
            </span>
          )}
        </p>
        <p className="text-xs text-muted-foreground text-jp">
          {t("company_freetext_hint")}
        </p>
      </TabsContent>
    </Tabs>
  );
}

// =============================================================================
// Form component
// =============================================================================
// hasServerKey: サーバ env(OPENAI_API_KEY)に鍵があるか。server component から
// boolean のみ受け取る(鍵そのものは渡さない)。BYOK 事前ヒントの出し分けに使う:
//  - true(localhost dev = env 鍵あり)→ BYOK は「任意」案内(従来文言)
//  - false(本番 = env 鍵なし)→ BYOK は「必須」案内(目立たせる + 設定を開く)
export function InputForm({ hasServerKey }: { hasServerKey: boolean }) {
  const t = useTranslations("inputForm");
  const form = useAnalyzeStore((s) => s.form);
  const phase = useAnalyzeStore((s) => s.phase);
  const setField = useAnalyzeStore((s) => s.setField);
  const startAnalysis = useAnalyzeStore((s) => s.startAnalysis);
  const setResearching = useAnalyzeStore((s) => s.setResearching);
  const setAnalyzing = useAnalyzeStore((s) => s.setAnalyzing);
  const setCompanySummary = useAnalyzeStore((s) => s.setCompanySummary);
  const setAnalysisResult = useAnalyzeStore((s) => s.setAnalysisResult);
  const setResearchError = useAnalyzeStore((s) => s.setResearchError);
  const setAnalyzeError = useAnalyzeStore((s) => s.setAnalyzeError);
  // Phase G Step 1: SSE streaming の細分化進捗を store に書き込む
  const setStreamingStage = useAnalyzeStore((s) => s.setStreamingStage);

  const loading = isLoadingPhase(phase);
  const valid = isFormValid(form);
  const canSubmit = valid && !loading;

  // BYOK 事前ヒント(2026-05-29 出し分け改修): 自分のキーが localStorage に未保存の
  // とき、分析ボタン付近にヒントを出す。サーバ env に鍵があるか(hasServerKey、
  // server component から prop)で文言を出し分ける:
  //  - hasServerKey === true(localhost dev = env 鍵あり)→ BYOK は **任意**。
  //    「自分の OpenAI キーで使う場合は設定から」の案内調(従来文言を維持)。
  //  - hasServerKey === false(本番 = env 鍵なし)→ 入力は **必須**。「分析するには
  //    APIキーの入力が必要」と明確に伝え、目立たせる + 「設定を開く」アクション。
  //  - 確実な未設定判定はサーバ応答(missing_api_key)にも委ねており、分析時エラー
  //    表示(目立つ + 設定ワンクリック)は既存のまま変更しない。
  //  - useSyncExternalStore で localStorage を購読(SSR 安全、hydration mismatch なし、
  //    getServerSnapshot は true 固定 = SSR / 初期描画では案内を出さない)。
  //    hasServerKey は prop で SSR / 初期描画から確定するので mismatch を生まない。
  const hasStoredKey = React.useSyncExternalStore(
    subscribeOpenAIKey,
    () => getStoredOpenAIKey() !== null,
    () => true,
  );

  // 文字数カウンタ用 — char_limit が有効な正の整数のときのみ counter / over を表示。
  // 2026-05-29 char_limit 任意化: 空欄(制限なし)では counter も over 警告も出さない。
  // 空白のみ / 非整数 / 0 以下も「無効 = 非表示」に倒す(整数性は isFormValid と整合)。
  const esLen = form.es_body.length;
  const charLimitTrimmed = form.char_limit.trim();
  const charLimit = Number(charLimitTrimmed);
  const charLimitValid =
    charLimitTrimmed.length > 0 && Number.isInteger(charLimit) && charLimit > 0;
  const charOver = charLimitValid && esLen > charLimit;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    startAnalysis(); // 前回の結果 / エラーをクリア

    // 1. 企業情報の入力があれば /api/research を呼ぶ
    //    入力経路に応じて payload を組み立てる(URL / 企業名 / 自由テキスト)。
    //    どのタブも空(未入力)なら research をスキップして analyze に直行。
    let summary: CompanySummary | undefined;
    const payload = buildResearchPayload(form);
    if (payload) {
      setResearching();
      const r = await callResearch(payload);
      if (r.ok) {
        summary = r.summary;
        setCompanySummary(r.summary);
        // 提出後改善 #3 準備 (2026-06-09): research 経路の受動計測(dev 専用 capture)。
        // capture_meta が付いた応答(= 実 LLM call があった、キャッシュヒットでない)のみ。
        if (r.captureMeta) {
          appendCaptureMetaEntry("research", r.captureMeta);
        }
      } else {
        // research 失敗は致命的ではない、ソフトエラーとして残し analyze に続行
        setResearchError(r.error);
      }
    }

    // 2. /api/analyze を呼ぶ
    //   Phase G Step 1 (2026-05-23): initial 経路は SSE streaming(callAnalyzeStream)、
    //   refresh 経路は既存 JSON(callAnalyze、Step 2 で SSE 化)。
    //   buildAnalyzeBundle が initial 専用 bundle を返す(refresh 経路は v1 では未到達)、
    //   現状は常に SSE 経路に乗る。Step 2 で refresh bundle が来た場合の分岐を入れる。
    setAnalyzing();
    setStreamingStage("started");
    const bundle = buildAnalyzeBundle(form, summary);
    const a = await callAnalyzeStream(bundle, (stage) =>
      setStreamingStage(stage),
    );
    if (a.ok) {
      // 提出後改善 #3 準備 (2026-06-09): captureMeta(あれば)を capture エントリに同梱。
      setAnalysisResult(a.result, a.captureMeta);
    } else {
      setAnalyzeError(a.error);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      {/* ============================================================
          Section 1: ES と設問(必須)
          ============================================================ */}
      <SectionCard
        icon={FileText}
        title={t("section_es_title")}
        description={t("section_es_description")}
      >
        {/* ES 本体 */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="es_body"
            className="text-sm font-medium text-foreground"
          >
            {t("es_body_label")} <span className="text-destructive">*</span>
          </label>
          {/* 2026-05-25 Commit B: ES 本文をファイルから読み込む経路。
              テキスト貼り付け経路は併存(下の textarea)、どちらでも入力できる。 */}
          <FileUpload
            onText={(text) => setField("es_body", text)}
            currentBodyLength={form.es_body.length}
            disabled={loading}
          />
          <Textarea
            id="es_body"
            value={form.es_body}
            onChange={(e) => setField("es_body", e.target.value)}
            placeholder={t("es_body_placeholder")}
            rows={10}
            disabled={loading}
            required
            aria-invalid={form.es_body.length > 0 && form.es_body.trim().length < 1}
          />
          <p className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {t("es_count_current")} <span className="font-medium text-foreground">{esLen}</span> {t("es_count_chars")}
            </span>
            {charLimitValid && (
              <span className={charOver ? "text-destructive" : "text-muted-foreground"}>
                {charOver ? t("char_limit_over_prefix") : ""}
                {t("char_limit_suffix", { limit: charLimit })}
              </span>
            )}
          </p>
          {/* 2026-05-29 修正: ES 本文 8000 字(schema の安全弁 es_body.max(8000))超過時の
              警告。設問の char_limit とは独立した hard limit。これがあると送信ボタンが
              disabled になる(isFormValid が上限を見る)ため、送信前に直せるよう明示する。 */}
          {esLen > 8000 && (
            <p className="text-xs text-destructive">
              {t("es_body_max_over", { count: esLen })}
            </p>
          )}
        </div>

        {/* 設問 */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="question_text"
            className="text-sm font-medium text-foreground"
          >
            {t("question_label")} <span className="text-destructive">*</span>
          </label>
          <Textarea
            id="question_text"
            value={form.question_text}
            onChange={(e) => setField("question_text", e.target.value)}
            placeholder={t("question_placeholder")}
            rows={2}
            disabled={loading}
            required
            aria-invalid={
              form.question_text.length > 0 && form.question_text.trim().length < 1
            }
          />
        </div>

        {/* 文字数制限(任意 2026-05-29: 制限の無い設問もあるため空欄でも送信可) */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="char_limit"
            className="text-sm font-medium text-foreground"
          >
            {t("char_limit_label")}{" "}
            <span className="text-xs text-muted-foreground">
              {t("char_limit_optional_note")}
            </span>
          </label>
          <Input
            id="char_limit"
            type="number"
            min={1}
            step={1}
            value={form.char_limit}
            onChange={(e) => setField("char_limit", e.target.value)}
            disabled={loading}
            placeholder={t("char_limit_placeholder")}
            className="w-32"
          />
          <p className="text-xs text-muted-foreground text-jp">
            {t("char_limit_hint")}
          </p>
        </div>
      </SectionCard>

      {/* ============================================================
          Section 2: 企業情報(任意) — 3 タブ UI(URL / 企業名 / 自由テキスト)
          UX 改修 1: デフォルト折りたたみ(初見でも見出しは見える)
          ============================================================ */}
      <SectionCard
        icon={Building2}
        title={t("section_company_title")}
        description={t("section_company_description")}
        optional
        collapsible
        defaultOpen={false}
      >
        <CompanyInputTabs disabled={loading} />
      </SectionCard>

      {/* ============================================================
          Section 3: 添削の方向性(必須)
          ============================================================ */}
      <SectionCard
        icon={Sparkles}
        title={t("section_direction_title")}
        description={t("section_direction_description")}
      >
        {/* 添削条件プリセット */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="preset"
            className="text-sm font-medium text-foreground"
          >
            {t("preset_label")} <span className="text-destructive">*</span>
          </label>
          <PresetSelect form={form} setField={setField} disabled={loading} />
        </div>

        {/* 添削条件 自由入力 */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="free_text"
            className="text-sm font-medium text-foreground"
          >
            {t("free_text_label")}{" "}
            <span className="text-xs text-muted-foreground">{t("free_text_optional_note")}</span>
          </label>
          <Textarea
            id="free_text"
            value={form.free_text}
            onChange={(e) => setField("free_text", e.target.value)}
            placeholder={t("free_text_placeholder")}
            rows={2}
            disabled={loading}
          />
        </div>
      </SectionCard>

      {/* ============================================================
          Section 4: 補足情報(任意) — UX 改修 1: デフォルト折りたたみ
          ============================================================ */}
      <SectionCard
        icon={User}
        title={t("section_context_title")}
        description={t("section_context_description")}
        optional
        collapsible
        defaultOpen={false}
      >
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="user_context"
            className="text-sm font-medium text-foreground"
          >
            {t("user_context_label")}
          </label>
          <Textarea
            id="user_context"
            value={form.user_context}
            onChange={(e) => setField("user_context", e.target.value)}
            placeholder={t("user_context_placeholder")}
            rows={2}
            disabled={loading}
          />
        </div>
      </SectionCard>

      {/* ============================================================
          分析開始ボタン
          ============================================================ */}
      <div className="flex flex-col gap-2 pt-1">
        <Button
          type="submit"
          disabled={!canSubmit}
          variant="default"
          size="lg"
          className="w-full sm:w-auto"
        >
          {loading ? (
            <Loader2 className="animate-spin" />
          ) : phase === "done" || phase === "error" ? (
            <ArrowRight />
          ) : (
            <Sparkles />
          )}
          <span>{t(buttonLabelKey(phase))}</span>
        </Button>
        {!valid && !loading && (
          <p className="text-xs text-muted-foreground text-jp">
            {t("submit_invalid_hint")}
          </p>
        )}
        {/* BYOK 事前ヒント: 鍵未保存のときのみ表示。サーバ env に鍵があるか
            (hasServerKey)で出し分ける。 */}
        {!hasStoredKey &&
          (hasServerKey ? (
            // server env に鍵あり(localhost dev)→ BYOK は任意。案内調(従来文言)。
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground text-jp">
              <KeyRound className="size-3.5 shrink-0" aria-hidden />
              <span>{t("byok_hint")}</span>
              <button
                type="button"
                onClick={requestOpenSettings}
                className="font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded-sm"
              >
                {t("byok_hint_action")}
              </button>
            </p>
          ) : (
            // server env に鍵なし(本番)→ 入力は必須。目立たせる(bordered card +
            // primary accent)+「設定を開く」アクション。過剰演出・数値は無し。
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5 text-sm">
              <KeyRound className="size-4 shrink-0 text-primary" aria-hidden />
              <span className="font-medium text-foreground text-jp">
                {t("byok_required_hint")}
              </span>
              <button
                type="button"
                onClick={requestOpenSettings}
                className="font-medium text-primary underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded-sm"
              >
                {t("byok_required_action")}
              </button>
            </div>
          ))}
      </div>
    </form>
  );
}

// =============================================================================
// PresetSelect — preset の select。preset 値は schema 上は日本語(load-bearing)、
// 表示 label は messages/<locale>.json の `preset` namespace から引く。
// 2026-05-27 prompt 設計批判 #6 への対応(Task d-2): dropdown 内の各 option 下に
// 1 行 hint を subtle text(text-muted-foreground、text-xs)で表示。i18n は
// `preset_hint` namespace。SelectValue(閉時表示)は preset 名のみ(hint を出すと
// trigger が縦長化して UI 認知負荷が増えるため)。
// =============================================================================
function PresetSelect({
  form,
  setField,
  disabled,
}: {
  form: FormState;
  setField: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  disabled: boolean;
}) {
  const tPreset = useTranslations("preset");
  const tPresetHint = useTranslations("preset_hint");
  return (
    <Select
      // base-ui の Select は string 値しか受けないが、EditingPreset が string enum なのでそのまま渡せる
      value={form.preset}
      onValueChange={(v) => {
        // base-ui Select の onValueChange は string を返す。schema で再 narrowing する。
        const parsed = EditingPresetSchema.safeParse(v);
        if (parsed.success) setField("preset", parsed.data);
      }}
      disabled={disabled}
    >
      <SelectTrigger id="preset" className="w-fit min-w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PRESET_OPTIONS.map((preset) => (
          <SelectItem key={preset} value={preset}>
            <div className="flex flex-col gap-0.5 py-0.5">
              <span>{tPreset(preset)}</span>
              <span className="text-xs text-muted-foreground text-jp">
                {tPresetHint(preset)}
              </span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
