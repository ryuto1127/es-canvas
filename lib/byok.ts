// =============================================================================
// BYOK (Bring Your Own Key) — クライアント側の鍵保存 / 読込 util
// =============================================================================
//
// 公開デプロイ版を友達・親に共有できるよう、各ユーザーが自分の OpenAI API キーを
// 入力して使う設計(BYOK)。鍵は **このブラウザの localStorage にのみ** 保存し、
// サーバーには保存・ログしない。OpenAI を使う API 呼び出しに HTTP ヘッダ
// `x-openai-key` で per-request に添えて送る。
//
// AGENTS.md Out of scope(localStorage / DB / 認証は v1 スコープ外)の **唯一の例外**:
//  - 本 BYOK 鍵だけは localStorage に保存する(ユーザー承認済)。
//  - 他のアプリ状態(分析結果 / フォーム / 操作履歴等)は従来通り localStorage に
//    一切載せない(本 util は鍵専用、他用途に流用しない)。
//
// SSR 安全性:
//  - Next.js の server render 中は window / localStorage が無い。全関数で
//    `typeof window === "undefined"` ガードを置き、SSR 時は安全に no-op / null を返す。
//  - localStorage アクセスが throw する環境(プライベートブラウズ等)も try/catch で吸収。

// localStorage のキー名(プロダクト名前空間付き、衝突回避)。
const STORAGE_KEY = "es-canvas:openai_api_key";

// HTTP ヘッダ名(server の lib/llm/openai_key.ts:OPENAI_KEY_HEADER と一致させる)。
// client / server を別モジュールに分けているのは、本 util が "use client" 文脈で
// import されても server 専用 import(process.env 参照等)を巻き込まないため。
export const OPENAI_KEY_HEADER = "x-openai-key";

// useSyncExternalStore 用の購読者集合。set / clear で notify する。
// これにより設定 UI が effect 内 setState を使わず外部ストア(localStorage)を
// React 流儀で購読できる(SSR 安全、hydration mismatch なし)。
const subscribers = new Set<() => void>();
function notifySubscribers(): void {
  for (const cb of subscribers) cb();
}

// localStorage に書けない環境(Safari プライベートブラウズ / quota 超過等)向けの
// in-memory フォールバック。当該セッション(ページが生きている間)のみ鍵を保持する。
// localStorage を優先し、書込失敗時のみこの変数を使う。永続化はされない
// (リロードで消える)が、「保存はできないが今回は動く」状態を作るための退避先。
//
// AGENTS.md Out of scope の例外整合: BYOK 鍵以外の状態は引き続き非永続。本変数も
// 鍵専用のセッションスコープ保持であり、永続ストレージではない。
let inMemoryOpenAIKey: string | null = null;

// 保存済みの OpenAI API キーを読む。未保存 / SSR / 例外時は null。
// localStorage を優先し、読めない / 未保存なら in-memory フォールバックを見る
// (localStorage 書込に失敗したセッションでも当該セッション中は鍵が使える)。
export function getStoredOpenAIKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v !== null) {
      const trimmed = v.trim();
      if (trimmed.length > 0) return trimmed;
    }
  } catch {
    // localStorage 読込不可は無視し、in-memory フォールバックに委ねる。
  }
  return inMemoryOpenAIKey;
}

// 保存の結果。"persisted": localStorage に保存できた。"memory_only": localStorage に
// 書けなかったが in-memory に保持(当該セッションのみ有効)。"cleared": キー削除。
export type SaveKeyResult = "persisted" | "memory_only" | "cleared";

// OpenAI API キーを保存する。空文字 / 空白のみが渡された場合はクリア扱い。
// 戻り値で「localStorage に保存できたか / メモリのみか / クリアか」を返す。
// localStorage 書込に失敗しても in-memory に鍵を退避し、当該セッション中は使える。
export function setStoredOpenAIKey(key: string): SaveKeyResult {
  if (typeof window === "undefined") {
    // SSR 経路では保存しようがないが、API 契約上 result を返す必要があるため
    // クリア相当を返す(実際にこの経路で呼ばれることはハンドラ側で起こらない)。
    return key.trim().length === 0 ? "cleared" : "memory_only";
  }
  const trimmed = key.trim();

  if (trimmed.length === 0) {
    // クリア: localStorage と in-memory の両方を消す。
    inMemoryOpenAIKey = null;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // localStorage 操作不可でも in-memory は既に消したので問題ない。
    }
    notifySubscribers();
    return "cleared";
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, trimmed);
    // 永続化に成功したら in-memory フォールバックは不要(整合のためクリア)。
    inMemoryOpenAIKey = null;
    notifySubscribers();
    return "persisted";
  } catch {
    // localStorage 書込不可(容量超過 / プライベートブラウズ等)。
    // 当該セッションだけは使えるよう in-memory に退避し、UI には正直に通知する。
    inMemoryOpenAIKey = trimmed;
    notifySubscribers();
    return "memory_only";
  }
}

// 保存済みの OpenAI API キーを削除する(localStorage と in-memory の両方)。
export function clearStoredOpenAIKey(): void {
  inMemoryOpenAIKey = null;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // no-op
  }
  notifySubscribers();
}

// useSyncExternalStore 用の subscribe 関数。
// 同一タブ内の set / clear に加え、他タブでの storage イベントも購読する
// (別タブでキーを更新したとき UI のステータスを追従させる)。
// 戻り値は unsubscribe 関数。SSR 時は no-op を返す。
export function subscribeOpenAIKey(onChange: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  subscribers.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === null) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    subscribers.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

// fetch の headers に混ぜる用の object を返す。保存済み鍵があれば
// `{ "x-openai-key": <key> }`、無ければ空 object(ヘッダを付けない)。
//
// 使い方:
//   fetch("/api/analyze", {
//     headers: { "Content-Type": "application/json", ...openAIKeyHeader() },
//     ...
//   })
export function openAIKeyHeader(): Record<string, string> {
  const key = getStoredOpenAIKey();
  return key ? { [OPENAI_KEY_HEADER]: key } : {};
}

// -----------------------------------------------------------------------------
// 設定パネルを「どこからでもワンクリックで開く」ための極小イベントバス
// -----------------------------------------------------------------------------
// 背景(2026-05-29 APIキー未設定 UX 改修):
//  - 鍵未設定エラー(サーバの `missing_api_key`)を表示する箇所(ErrorDisplay /
//    ResearchWarning / Canvas の RefreshErrorBanner)から「設定を開く」アクションを
//    出したいが、設定 UI(ApiKeySettings)はヘッダ右上の自己完結 Popover で、
//    エラー表示とは離れた component tree にいる。
//  - 依存を増やさず(toast 基盤 / context provider を新設せず)疎結合に開閉要求を
//    届けるため、byok util が既に持つ「購読者集合 + notify」パターンを踏襲した
//    極小イベントバスを置く。ApiKeySettings が購読し、要求を受けたら自分を開く。
//
// SSR 安全性: 購読は client component の effect 内でのみ行われる。requestOpenSettings
// は client のイベントハンドラからのみ呼ばれる(SSR 経路では発火しない)。
const openSettingsSubscribers = new Set<() => void>();

// 設定パネルを開くことを要求する(エラー UI の「設定を開く」ボタン等から呼ぶ)。
export function requestOpenSettings(): void {
  for (const cb of openSettingsSubscribers) cb();
}

// 設定パネル(ApiKeySettings)が「開け」要求を購読する。戻り値は unsubscribe。
export function subscribeOpenSettings(onRequest: () => void): () => void {
  openSettingsSubscribers.add(onRequest);
  return () => {
    openSettingsSubscribers.delete(onRequest);
  };
}
