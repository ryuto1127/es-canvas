import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

// DECISION: Result 型でエラーを返す(throw しない)。理由:
// - fetch / Readability の失敗は「想定内の失敗」(到達不能ドメイン、ボイラープレートだけのページ、SPAでrender不能 等)
// - throw で済ませると上位で try/catch がネスト、想定内エラーの分岐が読みづらくなる
// - 上位の /api/research は HTTP ステータスにマップする必要があるので、kind 付きで返したい
export type ExtractResult =
  | { ok: true; data: { text: string; title: string | null; lang: string | null } }
  | { ok: false; error: { kind: ExtractErrorKind; message: string; cause?: unknown } };

export type ExtractErrorKind =
  | "invalid_url"
  | "timeout"
  | "fetch_failed"
  | "non_ok_status"
  | "parse_failed"
  | "empty_content";

// DECISION: 8000字切り詰め。理由: 大企業の長文ページでも価値観・MVV は冒頭〜中盤に集中、
// LLM 入力コストとレイテンシのバランス。8000 字なら Sonnet で 1回あたり ~3000 トークン程度
const MAX_CHARS = 8000;
const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT =
  "es-canvas-research/0.1 (+https://github.com/example/es-canvas; selection-task)";

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export async function extractFromUrl(url: string): Promise<ExtractResult> {
  if (!isValidHttpUrl(url)) {
    return { ok: false, error: { kind: "invalid_url", message: `Invalid URL: ${url}` } };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (err) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: {
        kind: isAbort ? "timeout" : "fetch_failed",
        message: isAbort
          ? `Request to ${url} exceeded ${FETCH_TIMEOUT_MS}ms`
          : `Failed to fetch ${url}`,
        cause: err,
      },
    };
  }
  clearTimeout(timer);

  if (!response.ok) {
    return {
      ok: false,
      error: {
        kind: "non_ok_status",
        message: `${url} returned HTTP ${response.status}`,
      },
    };
  }

  const html = await response.text();
  let dom: JSDOM;
  try {
    dom = new JSDOM(html, { url });
  } catch (err) {
    return {
      ok: false,
      error: { kind: "parse_failed", message: "JSDOM failed to parse HTML", cause: err },
    };
  }

  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  // Readability が拒否(短すぎる / extractable と判断しなかった)場合、article は null
  const rawText = article?.textContent ?? dom.window.document.body?.textContent ?? "";
  const normalized = rawText.replace(/\s+/g, " ").trim();

  if (normalized.length === 0) {
    return {
      ok: false,
      error: { kind: "empty_content", message: `No extractable text from ${url}` },
    };
  }

  const truncated =
    normalized.length > MAX_CHARS ? normalized.slice(0, MAX_CHARS) : normalized;

  return {
    ok: true,
    data: {
      text: truncated,
      title: article?.title ?? dom.window.document.title ?? null,
      lang: article?.lang ?? null,
    },
  };
}
