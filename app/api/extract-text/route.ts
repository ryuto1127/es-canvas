// =============================================================================
// /api/extract-text — PDF テキスト抽出 API route(Node runtime)
// =============================================================================
//
// 目的:
//  - ユーザーがアップロードした PDF ファイルからテキストを抽出し、ES 入力欄に
//    流し込めるよう plain text として返す。
//  - .md / .txt はクライアント側 FileReader で読めるため本 API は経由しない
//    (PDF のみサーバー側で抽出)。
//
// 設計判断(2026-05-25):
//  - クライアント版 pdfjs-dist は Turbopack で worker 設定が要、bundle ~3MB 増、
//    jsdom と同様の依存問題リスク。サーバー API + Node runtime で `pdfjs-dist/legacy`
//    を使うと worker 不要・bundle 影響ゼロで安定動作。
//  - pdf-parse は抽出機能が貧弱・メンテ放置寄りで不採用。
//  - 受付サイズ上限は 10 MB(ES の典型 PDF は数 KB〜数百 KB、念のための DoS 対策)。
//  - ページ数上限は 50 ページ(同上、ES は通常 1〜2 ページ)。
//
// セキュリティ:
//  - `runtime = "nodejs"` で実行(Edge runtime では pdfjs-dist 動作不可)。
//  - サイズ / ページ数の double check(クライアント送信前 + サーバー検証)。
//  - PDF のテキスト抽出失敗(暗号化 PDF / 画像 PDF 等)はエラー文字列で返す。
//    全文 OCR は v1 スコープ外(現状 OCR ライブラリ未導入)。
//
// AGENTS.md Inviolable constraints:
//  - 数値スコア禁止: 本 API は文字列(plain text)のみ返却、スコアは無関係
//  - localStorage 不使用: 本 API は in-memory のみ、永続化なし

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

// 受付サイズ / ページ数の上限
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_PAGES = 50;

// レスポンス型(クライアントと共有する shape)
export type ExtractTextResponse =
  | { ok: true; text: string; pageCount: number }
  | {
      ok: false;
      error: {
        kind:
          | "no_file"
          | "too_large"
          | "too_many_pages"
          | "parse_failed"
          | "empty_text"
          | "unsupported_format";
        message: string;
      };
    };

export async function POST(req: NextRequest): Promise<NextResponse<ExtractTextResponse>> {
  // ファイルアップロードは multipart/form-data で送信される
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: {
          kind: "no_file",
          message: "リクエスト本体が multipart/form-data ではありません",
        },
      },
      { status: 400 },
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          kind: "no_file",
          message: "ファイルが添付されていません(field name: file)",
        },
      },
      { status: 400 },
    );
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          kind: "too_large",
          message: `ファイルサイズが上限(${Math.floor(MAX_FILE_SIZE / 1024 / 1024)} MB)を超えています`,
        },
      },
      { status: 413 },
    );
  }

  // 拡張子 / MIME 型から PDF か判定。本 API は PDF 専用
  // (.md / .txt はクライアント側 FileReader で読むため、ここには来ない想定)。
  const isPdf =
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          kind: "unsupported_format",
          message:
            "PDF 以外のファイルはサポートされていません(.md / .txt はブラウザ側で読み込まれます)",
        },
      },
      { status: 415 },
    );
  }

  // pdfjs-dist の legacy ビルドは Node 環境で動作する。worker は不要。
  // dynamic import にしておくと初回リクエストまで重い依存をロードしない。
  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          kind: "parse_failed",
          message: `pdfjs-dist の読み込みに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        },
      },
      { status: 500 },
    );
  }

  // PDF 本体を ArrayBuffer → Uint8Array で pdfjs に渡す
  const arrayBuffer = await file.arrayBuffer();
  const data = new Uint8Array(arrayBuffer);

  let pdfDocument: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;
  try {
    // disableFontFace: true / useSystemFonts: false で worker / DOM 依存を最小化。
    // pdfjs-dist v6 では `isEvalSupported` は public option から外れたため指定不要
    // (Node runtime では eval は元々無効化されている)。
    const loadingTask = pdfjs.getDocument({
      data,
      disableFontFace: true,
      useSystemFonts: false,
    });
    pdfDocument = await loadingTask.promise;
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          kind: "parse_failed",
          message: `PDF の解析に失敗しました(暗号化されている、または破損している可能性): ${err instanceof Error ? err.message : String(err)}`,
        },
      },
      { status: 422 },
    );
  }

  if (pdfDocument.numPages > MAX_PAGES) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          kind: "too_many_pages",
          message: `ページ数が上限(${MAX_PAGES} ページ)を超えています(${pdfDocument.numPages} ページ)`,
        },
      },
      { status: 413 },
    );
  }

  // 各ページから text content を抽出して結合
  const pageTexts: string[] = [];
  for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
    try {
      const page = await pdfDocument.getPage(pageNum);
      const textContent = await page.getTextContent();
      // textContent.items は TextItem[] で、各 item に str が入る
      // 改行は pdfjs の TextItem.hasEOL で表現される(明示的改行情報)
      const pageText = textContent.items
        .map((item) => {
          if ("str" in item) {
            const t = item.str;
            // EOL を持つ item の後ろに改行を入れる
            return ("hasEOL" in item && item.hasEOL) ? t + "\n" : t;
          }
          return "";
        })
        .join("");
      pageTexts.push(pageText);
    } catch (err) {
      // 個別ページの抽出失敗は warn 相当、本体は続行(部分結果を返す)
      pageTexts.push(`[ページ ${pageNum} の抽出に失敗: ${err instanceof Error ? err.message : String(err)}]`);
    }
  }

  // ページ間は空行で区切る
  const fullText = pageTexts.join("\n\n").trim();

  if (fullText.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          kind: "empty_text",
          message:
            "PDF からテキストを抽出できませんでした(画像 PDF / スキャン PDF の可能性、OCR は未対応)",
        },
      },
      { status: 422 },
    );
  }

  return NextResponse.json({
    ok: true,
    text: fullText,
    pageCount: pdfDocument.numPages,
  });
}
