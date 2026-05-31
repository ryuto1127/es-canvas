"use client";

// =============================================================================
// FileUpload — ES 本文をファイルから読み込む(.pdf / .md / .markdown / .txt)
// =============================================================================
//
// 目的(2026-05-25 Commit A):
//  - ES 原稿(PDF または Markdown 等のテキストデータ)に対応する入力経路。
//  - 既存のテキスト貼り付け経路は **削除せず併存**(コピペが楽な場合もある)。
//  - 読み込み完了 → 既存 ES 本文テキストエリアに流し込み(その後ユーザーが編集可能)。
//
// 受付形式と経路:
//  - .md / .markdown / .txt: クライアント FileReader で UTF-8 読み込み(API 不要)
//  - .pdf: /api/extract-text に POST(multipart/form-data)→ サーバー側で pdfjs-dist で抽出
//
// UI:
//  - ドラッグ&ドロップエリア + 「ファイルを選択」ボタン
//  - 受付中 / 読み込み中 / エラー の状態表示
//  - 「読み込んだ内容で置き換える」確認ステップ(既存 ES 本文がある場合のみ)
//
// AGENTS.md Inviolable constraints:
//  - 数値スコア禁止: 本 component は文字列のみ扱う
//  - localStorage 不使用: in-memory のみ、永続化なし

import * as React from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Upload, FileText, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";

import type { ExtractTextResponse } from "@/app/api/extract-text/route";

// 受付拡張子(クライアント側 fast check 用)
const ACCEPTED_EXTENSIONS = [".pdf", ".md", ".markdown", ".txt"] as const;
const ACCEPTED_MIME_HINT =
  ".pdf,.md,.markdown,.txt,application/pdf,text/markdown,text/plain";

// クライアント側のサイズ上限(サーバーと整合: 10 MB)
const MAX_CLIENT_FILE_SIZE = 10 * 1024 * 1024;

// ES 本文の文字数上限。schema(lib/schema/input.ts:es_body.max(8000))の安全弁と整合。
// 2026-05-30 N1: 10 MB のファイルサイズ check は通っても 8000 字超は送信時に弾かれるため、
// ready プレビュー(適用前)で超過を一目で分かるよう警告する(InputForm の K4 警告と同色・同趣旨)。
const MAX_ES_BODY_CHARS = 8000;

// PDF 抽出 API の timeout
const EXTRACT_TIMEOUT_MS = 60_000;

type ReadState =
  | { kind: "idle" }
  | { kind: "reading"; fileName: string }
  | { kind: "ready"; fileName: string; text: string; meta?: string }
  | { kind: "error"; fileName: string | null; message: string };

function getExtension(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot) : "";
}

function isAcceptedExtension(name: string): boolean {
  const ext = getExtension(name);
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(ext);
}

// 内部用エラーコード: helper が throw する内部識別子。
// 表示は呼び出し側 React component が messages から引く。
class FileUploadError extends Error {
  // i18n key code(messages.fileUpload.error_<code>)、`network_with_msg` のように
  // 動的 message を含む場合は messageArg に raw 文字列を入れる(後段で {msg} 置換)。
  readonly code: string;
  readonly messageArg?: string;
  readonly statusArg?: number;
  constructor(code: string, opts?: { messageArg?: string; statusArg?: number }) {
    super(code);
    this.code = code;
    this.messageArg = opts?.messageArg;
    this.statusArg = opts?.statusArg;
  }
}

// .md / .markdown / .txt はクライアント FileReader で読む
async function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") {
        resolve(result);
      } else {
        reject(new FileUploadError("filereader"));
      }
    };
    reader.onerror = () => reject(new FileUploadError("reader_generic"));
    reader.readAsText(file, "utf-8");
  });
}

// .pdf はサーバー API で抽出
async function extractPdfText(file: File): Promise<{ text: string; pageCount: number }> {
  const formData = new FormData();
  formData.append("file", file);

  let res: Response;
  try {
    res = await fetch("/api/extract-text", {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    });
  } catch (err) {
    // err.message を上位で「Network error: <msg>」のように i18n template に流す
    throw new FileUploadError("network", {
      messageArg: err instanceof Error ? err.message : undefined,
    });
  }

  let body: ExtractTextResponse;
  try {
    body = (await res.json()) as ExtractTextResponse;
  } catch {
    throw new FileUploadError("not_json", { statusArg: res.status });
  }

  if (!body.ok) {
    // サーバーが i18n しないため、サーバーメッセージはそのまま表示用 raw 文字列として扱う
    throw new FileUploadError("server", { messageArg: body.error.message });
  }
  return { text: body.text, pageCount: body.pageCount };
}

// =============================================================================
// FileUpload component
// =============================================================================
// `onText` で読み込んだテキストを親(InputForm)に渡す。親側で「置き換える / 末尾に追加」
// の判断は不要(本 component 内で confirm ダイアログ風の表示は使わず、ready 状態で
// 「適用する」「破棄する」ボタンを出す)。
//
// `currentBodyLength` で既存 ES 本文の長さを受け取り、置換時の警告に使う。
// 0 のときは警告なしで自動適用(誤操作リスクが無いため)。
export function FileUpload({
  onText,
  currentBodyLength,
  disabled,
}: {
  onText: (text: string) => void;
  currentBodyLength: number;
  disabled: boolean;
}) {
  const t = useTranslations("fileUpload");
  const tCommon = useTranslations("common");
  const [state, setState] = React.useState<ReadState>({ kind: "idle" });
  const [isDragging, setIsDragging] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // FileUploadError を表示用 i18n 文字列に変換
  const formatError = React.useCallback(
    (err: unknown): string => {
      if (err instanceof FileUploadError) {
        switch (err.code) {
          case "filereader":
            return t("error_filereader");
          case "reader_generic":
            return t("error_reader_generic");
          case "network":
            return err.messageArg
              ? t("error_network_with_msg", { msg: err.messageArg })
              : t("error_network");
          case "not_json":
            return t("error_not_json", { status: err.statusArg ?? 0 });
          case "server":
            // サーバー由来 message はそのまま(/api/extract-text 側で localized されない)
            return err.messageArg ?? t("error_read_failed");
          default:
            return err.messageArg ?? err.code;
        }
      }
      if (err instanceof Error) return err.message;
      return t("error_read_failed");
    },
    [t],
  );

  // 共通の読み込み処理(ファイル選択 / ドロップ 両方で呼ぶ)
  const handleFile = React.useCallback(async (file: File) => {
    if (disabled) return;

    // クライアント側 fast checks
    if (!isAcceptedExtension(file.name)) {
      setState({
        kind: "error",
        fileName: file.name,
        message: t("error_unsupported", {
          ext: getExtension(file.name) || t("error_unknown_ext"),
        }),
      });
      return;
    }
    if (file.size > MAX_CLIENT_FILE_SIZE) {
      setState({
        kind: "error",
        fileName: file.name,
        message: t("error_too_large", {
          max: Math.floor(MAX_CLIENT_FILE_SIZE / 1024 / 1024),
        }),
      });
      return;
    }

    setState({ kind: "reading", fileName: file.name });

    try {
      const ext = getExtension(file.name);
      if (ext === ".pdf") {
        const { text, pageCount } = await extractPdfText(file);
        setState({
          kind: "ready",
          fileName: file.name,
          text,
          meta: t("ready_meta_pages", { pages: pageCount, chars: text.length }),
        });
      } else {
        // .md / .markdown / .txt
        const text = await readTextFile(file);
        if (text.length === 0) {
          setState({
            kind: "error",
            fileName: file.name,
            message: t("error_empty"),
          });
          return;
        }
        setState({
          kind: "ready",
          fileName: file.name,
          text,
          meta: t("ready_meta_chars", { chars: text.length }),
        });
      }
    } catch (err) {
      setState({
        kind: "error",
        fileName: file.name,
        message: formatError(err),
      });
    }
  }, [disabled, t, formatError]);

  // ファイル選択 input change
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      void handleFile(file);
    }
    // input の value をクリア(同じファイルを再選択しても change が発火するように)
    e.target.value = "";
  };

  // ドラッグ&ドロップ
  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (disabled) return;
    const file = e.dataTransfer.files?.[0];
    if (file) {
      void handleFile(file);
    }
  };

  // 「適用する」を押したら親に text を渡し、state を idle に戻す
  const handleApply = () => {
    if (state.kind !== "ready") return;
    onText(state.text);
    setState({ kind: "idle" });
  };

  // 「破棄する」を押したら state を idle に戻す
  const handleDiscard = () => {
    setState({ kind: "idle" });
  };

  return (
    <div className="flex flex-col gap-2">
      {/* idle / reading / error の時はドロップゾーンを表示。ready の時はプレビュー / 適用ボタン */}
      {state.kind !== "ready" && (
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          aria-disabled={disabled}
          className={[
            "flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-6 transition-colors",
            disabled
              ? "border-border bg-muted/30 text-muted-foreground"
              : isDragging
                ? "border-primary bg-primary/5 text-foreground"
                : "border-border/60 bg-muted/20 text-muted-foreground hover:bg-muted/30",
          ].join(" ")}
        >
          {state.kind === "reading" ? (
            <>
              <Loader2 className="size-5 animate-spin text-primary" />
              <p className="text-xs text-jp">
                {t("reading_prefix")}
                <span className="font-medium text-foreground">{state.fileName}</span>
                {t("reading_suffix")}
              </p>
            </>
          ) : state.kind === "error" ? (
            <>
              <AlertCircle className="size-5 text-destructive" />
              <p className="text-xs text-destructive text-jp">{state.message}</p>
              {state.fileName && (
                <p className="text-[11px] text-muted-foreground text-jp">
                  {t("file_label_prefix")} {state.fileName}
                </p>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => fileInputRef.current?.click()}
              >
                {t("select_another")}
              </Button>
            </>
          ) : (
            <>
              <Upload className="size-5 text-muted-foreground" />
              <p className="text-xs text-jp">
                {t("drop_hint")}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => fileInputRef.current?.click()}
              >
                <FileText className="size-3.5" />
                <span>{t("select_file")}</span>
              </Button>
              <p className="text-[11px] text-muted-foreground text-jp">
                {t("accepted_formats")}
              </p>
            </>
          )}

          {/* 隠し input(クリックで開く) */}
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_MIME_HINT}
            disabled={disabled}
            onChange={handleInputChange}
            className="sr-only"
            aria-label={t("input_aria")}
          />
        </div>
      )}

      {/* ready 状態: 読み込んだテキストの先頭プレビュー + 適用 / 破棄 */}
      {state.kind === "ready" && (
        <div className="flex flex-col gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2.5">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="flex flex-1 flex-col gap-1">
              <p className="text-sm font-medium text-foreground text-jp">
                {t("ready_title")}{" "}
                <span className="font-normal text-muted-foreground">
                  {state.fileName}
                </span>
              </p>
              {state.meta && (
                <p className="text-[11px] text-muted-foreground">{state.meta}</p>
              )}
              {/* 先頭 200 字プレビュー */}
              <p className="mt-1 line-clamp-3 rounded bg-background/60 px-2 py-1.5 text-[11px] text-muted-foreground text-jp">
                {state.text.slice(0, 200)}
                {state.text.length > 200 ? "…" : ""}
              </p>
            </div>
          </div>
          {currentBodyLength > 0 && (
            <p className="text-[11px] text-muted-foreground text-jp">
              {t("replace_warning", { current: currentBodyLength })}
            </p>
          )}
          {/* 2026-05-30 N1: 8000 字超過警告。schema 上限(es_body.max(8000))を素通りすると
              適用後の送信で弾かれるため、適用前に destructive 色で明示する(InputForm の
              es_body_max_over と同色・同趣旨)。適用はブロックせず(貼って後で削る運用を許容)、
              「このまま適用すると送信できない」ことが一目で分かるようにする。 */}
          {state.text.length > MAX_ES_BODY_CHARS && (
            <p className="text-[11px] font-medium text-destructive text-jp">
              {t("over_limit_warning", {
                max: MAX_ES_BODY_CHARS,
                count: state.text.length,
              })}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={handleDiscard}
            >
              {tCommon("discard")}
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={disabled}
              onClick={handleApply}
            >
              {t("apply")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
