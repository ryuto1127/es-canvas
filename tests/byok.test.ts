/**
 * BYOK (Bring Your Own Key) — 鍵解決の純粋関数 unit test。
 *
 * `resolveOpenAIKey(headerKey?)` の優先順位を構造で担保する:
 *   1. ヘッダ鍵(trim 後 non-empty) — BYOK 主経路
 *   2. process.env.OPENAI_API_KEY — env fallback
 *   3. どちらも無ければ MissingOpenAIKeyError を throw
 *
 * これは公開デプロイ版で「ユーザーが自分の OpenAI キーを入力して使う」設計の
 * サーバ側の心臓部。後方互換(ヘッダ省略時は従来の env 解決)を担保することで、
 * 既存スモーク(research / analyze / interview / refresh)が env fallback で
 * 従来通り green になることを保証する。
 *
 * 実行方法: `pnpm test:byok`(net 呼び出しなし、ローカル即時実行)
 *
 * SSOT: lib/llm/openai_key.ts:resolveOpenAIKey / tryResolveOpenAIKey
 */

import { strict as assert } from "node:assert";
import {
  MissingOpenAIKeyError,
  OPENAI_KEY_HEADER,
  resolveOpenAIKey,
  tryResolveOpenAIKey,
} from "@/lib/llm/openai_key";
import {
  getStoredOpenAIKey,
  setStoredOpenAIKey,
  clearStoredOpenAIKey,
  openAIKeyHeader,
  OPENAI_KEY_HEADER as CLIENT_OPENAI_KEY_HEADER,
} from "@/lib/byok";

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passCount += 1;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (e) {
    failCount += 1;
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`  FAIL  ${name}\n        ${msg}`);
    process.stdout.write(`  FAIL ${name}\n        ${msg}\n`);
  }
}

// env を一時的に書き換えて関数を実行する helper(テスト間で env を汚染しない)。
function withEnvKey<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.OPENAI_API_KEY;
  if (value === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = value;
  }
  try {
    return fn();
  } finally {
    if (prev === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = prev;
    }
  }
}

// =============================================================================
// ① ヘッダ鍵優先
// =============================================================================
process.stdout.write("[resolveOpenAIKey: ヘッダ鍵優先]\n");

test("ヘッダ鍵が non-empty なら env があってもヘッダ鍵を採用する", () => {
  withEnvKey("sk-env-key", () => {
    const resolved = resolveOpenAIKey("sk-header-key");
    assert.equal(resolved, "sk-header-key");
  });
});

test("ヘッダ鍵は trim される(前後空白を除去して採用)", () => {
  withEnvKey("sk-env-key", () => {
    const resolved = resolveOpenAIKey("  sk-header-key  ");
    assert.equal(resolved, "sk-header-key");
  });
});

test("ヘッダ鍵が env 不在でも採用される", () => {
  withEnvKey(undefined, () => {
    const resolved = resolveOpenAIKey("sk-header-only");
    assert.equal(resolved, "sk-header-only");
  });
});

// =============================================================================
// ② env フォールバック
// =============================================================================
process.stdout.write("[resolveOpenAIKey: env フォールバック]\n");

test("ヘッダ鍵が undefined なら env を採用する(後方互換)", () => {
  withEnvKey("sk-env-fallback", () => {
    const resolved = resolveOpenAIKey(undefined);
    assert.equal(resolved, "sk-env-fallback");
  });
});

test("ヘッダ鍵が null なら env を採用する(req.headers.get の null をそのまま渡せる)", () => {
  withEnvKey("sk-env-fallback", () => {
    const resolved = resolveOpenAIKey(null);
    assert.equal(resolved, "sk-env-fallback");
  });
});

test("ヘッダ鍵が空文字 / 空白のみなら env を採用する", () => {
  withEnvKey("sk-env-fallback", () => {
    assert.equal(resolveOpenAIKey(""), "sk-env-fallback");
    assert.equal(resolveOpenAIKey("   "), "sk-env-fallback");
  });
});

test("env が空白のみの場合はフォールバックとして採用しない(throw に進む)", () => {
  withEnvKey("   ", () => {
    assert.throws(() => resolveOpenAIKey(undefined), MissingOpenAIKeyError);
  });
});

// =============================================================================
// ③ 両方無しで明示エラー
// =============================================================================
process.stdout.write("[resolveOpenAIKey: 両方無しで明示エラー]\n");

test("ヘッダ鍵も env も無ければ MissingOpenAIKeyError を throw する", () => {
  withEnvKey(undefined, () => {
    assert.throws(() => resolveOpenAIKey(undefined), MissingOpenAIKeyError);
    assert.throws(() => resolveOpenAIKey(null), MissingOpenAIKeyError);
    assert.throws(() => resolveOpenAIKey("  "), MissingOpenAIKeyError);
  });
});

test("MissingOpenAIKeyError は kind === 'missing_api_key' を持つ(route 側の 400 判定に使う)", () => {
  withEnvKey(undefined, () => {
    try {
      resolveOpenAIKey(undefined);
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof MissingOpenAIKeyError);
      assert.equal(err.kind, "missing_api_key");
    }
  });
});

// =============================================================================
// ④ tryResolveOpenAIKey(例外なし版)
// =============================================================================
process.stdout.write("[tryResolveOpenAIKey: 例外なし版]\n");

test("tryResolveOpenAIKey は resolve 可能なら鍵を返す", () => {
  withEnvKey(undefined, () => {
    assert.equal(tryResolveOpenAIKey("sk-header"), "sk-header");
  });
  withEnvKey("sk-env", () => {
    assert.equal(tryResolveOpenAIKey(undefined), "sk-env");
  });
});

test("tryResolveOpenAIKey は resolve 不能なら null を返す(throw しない)", () => {
  withEnvKey(undefined, () => {
    assert.equal(tryResolveOpenAIKey(undefined), null);
    assert.equal(tryResolveOpenAIKey(""), null);
  });
});

// =============================================================================
// ⑤ ヘッダ名定数
// =============================================================================
process.stdout.write("[OPENAI_KEY_HEADER 定数]\n");

test("ヘッダ名は小文字の x-openai-key(HTTP ヘッダは case-insensitive だが client / server で統一)", () => {
  assert.equal(OPENAI_KEY_HEADER, "x-openai-key");
});

// =============================================================================
// ⑥ client 側 setStoredOpenAIKey の成功 / 失敗 + in-memory フォールバック
//    (lib/byok.ts — localStorage 書込が失敗する環境でも当該セッションは動く)
// =============================================================================
process.stdout.write(
  "[setStoredOpenAIKey: localStorage 成功 / 失敗 + in-memory フォールバック]\n",
);

// 制御可能な localStorage モック。failWrite を true にすると setItem が throw する
// (Safari プライベートブラウズ / quota 超過の再現)。
function makeMockLocalStorage(opts: { failWrite?: boolean; failRead?: boolean }) {
  const store = new Map<string, string>();
  return {
    store,
    storage: {
      getItem(key: string): string | null {
        if (opts.failRead) throw new Error("read blocked (mock)");
        return store.has(key) ? (store.get(key) as string) : null;
      },
      setItem(key: string, value: string): void {
        if (opts.failWrite) throw new Error("write blocked (mock)");
        store.set(key, value);
      },
      removeItem(key: string): void {
        store.delete(key);
      },
    },
  };
}

// globalThis.window を差し替えて byok util(typeof window ガード)を client 文脈に
// 見せる helper。テスト後に必ず復元し、in-memory フォールバック変数も
// clearStoredOpenAIKey() でリセットする(module レベル state がテスト間で漏れないよう)。
function withMockWindow<T>(
  opts: { failWrite?: boolean; failRead?: boolean },
  fn: (mock: ReturnType<typeof makeMockLocalStorage>) => T,
): T {
  const mock = makeMockLocalStorage(opts);
  const prevWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    localStorage: mock.storage,
    addEventListener() {},
    removeEventListener() {},
  };
  try {
    return fn(mock);
  } finally {
    // in-memory フォールバックを必ずクリアしてからテスト用 window を撤去。
    clearStoredOpenAIKey();
    if (prevWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = prevWindow;
    }
  }
}

test("localStorage 書込成功時は 'persisted' を返し、getStored が読める", () => {
  withMockWindow({}, (mock) => {
    const result = setStoredOpenAIKey("sk-persist-me");
    assert.equal(result, "persisted");
    // 実際に localStorage に載っている。
    assert.equal(mock.store.get("es-canvas:openai_api_key"), "sk-persist-me");
    // getStored は localStorage を優先して読める。
    assert.equal(getStoredOpenAIKey(), "sk-persist-me");
  });
});

test("空文字保存は 'cleared' を返し、localStorage / in-memory とも空になる", () => {
  withMockWindow({}, (mock) => {
    setStoredOpenAIKey("sk-temp");
    const result = setStoredOpenAIKey("   "); // 空白のみ = クリア扱い
    assert.equal(result, "cleared");
    assert.equal(mock.store.has("es-canvas:openai_api_key"), false);
    assert.equal(getStoredOpenAIKey(), null);
  });
});

test("localStorage 書込失敗時は 'memory_only' を返す(成功表示にしない)", () => {
  withMockWindow({ failWrite: true }, (mock) => {
    const result = setStoredOpenAIKey("sk-mem-only");
    assert.equal(result, "memory_only");
    // localStorage には載っていない(書込が throw した)。
    assert.equal(mock.store.has("es-canvas:openai_api_key"), false);
  });
});

test("localStorage 書込失敗でも getStored は in-memory フォールバックで鍵を返す", () => {
  withMockWindow({ failWrite: true }, () => {
    setStoredOpenAIKey("sk-session-only");
    // localStorage に書けなくても、当該セッション中は in-memory から読める。
    assert.equal(getStoredOpenAIKey(), "sk-session-only");
  });
});

test("localStorage 読込が throw する環境でも in-memory フォールバックで鍵を返す", () => {
  withMockWindow({ failWrite: true, failRead: true }, () => {
    setStoredOpenAIKey("sk-both-fail");
    // 読込も書込も throw するが、in-memory に退避してあるので読める。
    assert.equal(getStoredOpenAIKey(), "sk-both-fail");
  });
});

test("openAIKeyHeader は in-memory フォールバックの鍵もヘッダに載せる", () => {
  withMockWindow({ failWrite: true }, () => {
    setStoredOpenAIKey("sk-header-mem");
    const header = openAIKeyHeader();
    assert.equal(header[CLIENT_OPENAI_KEY_HEADER], "sk-header-mem");
  });
});

test("localStorage 書込成功後は in-memory に残さない(整合: localStorage が真)", () => {
  withMockWindow({}, (mock) => {
    setStoredOpenAIKey("sk-real");
    // localStorage をモック直接操作で消すと、in-memory に残っていないことを確認できる。
    mock.store.clear();
    assert.equal(getStoredOpenAIKey(), null);
  });
});

// =============================================================================
// summary
// =============================================================================
process.stdout.write(`\nResults: ${passCount} pass / ${failCount} fail\n`);
if (failCount > 0) {
  process.stdout.write("\nFailures:\n");
  for (const f of failures) {
    process.stdout.write(f + "\n");
  }
  process.exit(1);
}
process.exit(0);
