// =============================================================================
// BYOK (Bring Your Own Key) — OpenAI API キー解決の純粋関数
// =============================================================================
//
// 公開デプロイ版を友達・親に共有できるよう、各ユーザーが自分の OpenAI API キーを
// 入力して使う設計(BYOK)。鍵はクライアントの localStorage にのみ保存され
// (`lib/byok.ts`)、HTTP ヘッダ `x-openai-key` で per-request にサーバへ渡る。
//
// 本モジュールは「鍵の出所をどう決めるか」だけを担う純粋関数。OpenAI SDK や
// その他の重い依存を import しないため、unit test(`tests/byok.test.ts`)から
// 副作用なく直接 import できる。
//
// 優先順位(dispatch 設計):
//   1. ヘッダ鍵(trim 後 non-empty) — BYOK 主経路
//   2. process.env.OPENAI_API_KEY — localhost 開発者 / 本番 env fallback
//   3. どちらも無ければ MissingOpenAIKeyError を throw(route が 400 に変換)
//
// 防御三段・スキーマ・プロンプト・検証ロジックは一切変えない。鍵の出所が
// 変わるだけ(provider 内の挙動は従来通り)。
//
// セキュリティ: 鍵そのものはログ出力しない(本モジュールは throw / return のみ、
// console.* で鍵を出さない)。

// 鍵が解決できなかったことを表す専用エラー。route 側でこれを捕捉して
// `{ error: { kind: "missing_api_key" } }` + status 400 を返す。
export class MissingOpenAIKeyError extends Error {
  readonly kind = "missing_api_key" as const;
  constructor(message = "OpenAI API key is not available (header nor env)") {
    super(message);
    this.name = "MissingOpenAIKeyError";
  }
}

// ヘッダ鍵 → env → throw の順で OpenAI API キーを解決する純粋関数。
//
//  - headerKey: HTTP ヘッダ `x-openai-key` の生値(null / undefined を許容)。
//    trim 後に non-empty ならこれを採用(BYOK)。
//  - 採用されなければ process.env.OPENAI_API_KEY を見る(env fallback)。
//  - どちらも無ければ MissingOpenAIKeyError を throw する。
//
// この関数自体は鍵を一切ログに出さない。
export function resolveOpenAIKey(headerKey?: string | null): string {
  const trimmed = typeof headerKey === "string" ? headerKey.trim() : "";
  if (trimmed.length > 0) {
    return trimmed;
  }

  const envKey = process.env.OPENAI_API_KEY;
  if (typeof envKey === "string" && envKey.trim().length > 0) {
    return envKey;
  }

  throw new MissingOpenAIKeyError();
}

// route が `req.headers.get("x-openai-key")` の戻り値をそのまま渡せるよう、
// optional のヘッダ鍵を受けて「resolve 可能か」を例外なく判定する薄い helper。
// resolve できれば鍵を返し、できなければ null を返す(鍵はログに出さない)。
export function tryResolveOpenAIKey(headerKey?: string | null): string | null {
  try {
    return resolveOpenAIKey(headerKey);
  } catch {
    return null;
  }
}

// HTTP ヘッダ名(client / server で共有する定数)。
export const OPENAI_KEY_HEADER = "x-openai-key" as const;
