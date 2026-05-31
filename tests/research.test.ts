/**
 * Phase B-2 リファクタ後のスモークテスト。/api/research を叩いて以下を確認する:
 *
 *   1) 各入力形式 (url / name / both) で正常応答すること
 *   2) evidence.length >= 3 を満たすこと(セッション1 の空っぽ問題が解消)
 *   3) category の分布が2種以上に分散していること
 *   4) すべての evidence[].source_url が research_log の ok な fetch エントリに存在(捏造禁止)
 *   5) 2回目リクエストでキャッシュヒット(X-Cache: HIT、レイテンシ大幅短縮)
 *   6) レイテンシは 60 秒以内が目標(リファクタの主目的)
 *
 * 既定では `getProvider("research")` 経由(現在は OpenAI GPT-5.4 mini)。
 * LLM 比較したい場合は環境変数で切替:
 *
 *   LLM_PROVIDER_OVERRIDE=anthropic pnpm test:research  # サーバー側で全 capability を Anthropic に
 *   PROVIDER=anthropic              pnpm test:research  # 本テスト側で body.provider を明示
 *
 * 実行方法:
 *   1. .env.local に ANTHROPIC_API_KEY / OPENAI_API_KEY を入れる
 *   2. 別ターミナルで `pnpm dev`
 *   3. このターミナルで `pnpm test:research`
 */
import { CompanySummarySchema, type CompanySummary } from "@/lib/schema/company";

const BASE_URL = process.env.RESEARCH_BASE_URL ?? "http://localhost:3000";
const PROVIDER_FOR_BODY = process.env.PROVIDER as
  | "anthropic"
  | "openai"
  | "google"
  | undefined;
// レイテンシ閾値: 60秒以内が目標(リファクタ完了条件)。
// 越えると WARN だけ出すが test fail にはしない(ネットワーク不安定でも進行)。
const LATENCY_TARGET_MS = 60_000;

type ResearchTarget =
  | { input_type: "url"; url: string; label: string }
  | { input_type: "name"; name: string; label: string }
  | { input_type: "both"; url: string; name: string; label: string };

const TARGETS: ResearchTarget[] = [
  {
    input_type: "url",
    url: "https://about.mercari.com/",
    label: "Mercari (URL)",
  },
  {
    input_type: "name",
    name: "株式会社メルカリ",
    label: "Mercari (名前のみ)",
  },
  {
    input_type: "name",
    name: "三菱商事",
    label: "三菱商事 (名前のみ)",
  },
  {
    input_type: "both",
    url: "https://about.mercari.com/",
    name: "株式会社メルカリ",
    label: "Mercari (両方)",
  },
];

type ResearchResponse =
  | { data: CompanySummary; cached: boolean }
  | { error: { kind: string; message: string; stage?: string } };

async function callResearch(target: ResearchTarget): Promise<{
  res: Response;
  body: ResearchResponse;
  ms: number;
}> {
  const requestBody = PROVIDER_FOR_BODY
    ? { ...target, provider: PROVIDER_FOR_BODY }
    : target;
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/api/research`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const ms = Date.now() - t0;
  const body = (await res.json()) as ResearchResponse;
  return { res, body, ms };
}

function isErrorBody(
  b: ResearchResponse,
): b is { error: { kind: string; message: string; stage?: string } } {
  return "error" in b;
}

let failures = 0;
function fail(label: string, msg: string, extra?: unknown): void {
  console.error(`  FAIL [${label}]: ${msg}`);
  if (extra !== undefined) {
    console.error(
      "    extra:",
      typeof extra === "string" ? extra : JSON.stringify(extra, null, 2),
    );
  }
  failures++;
  process.exitCode = 1;
}

// evidence のカテゴリ分布を「official_value: 3, hiring_signal: 2, ...」形式で表す。
function describeCategories(evidence: CompanySummary["evidence"]): string {
  const counts = new Map<string, number>();
  for (const ev of evidence) {
    counts.set(ev.category, (counts.get(ev.category) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([cat, n]) => `${cat}:${n}`)
    .join(", ");
}

async function runOne(target: ResearchTarget): Promise<void> {
  console.log(`\n=== ${target.label} ===`);

  // 1回目: MISS のはず
  const first = await callResearch(target);
  console.log(
    `  [1st] status=${first.res.status}  ${first.ms}ms  cache=${first.res.headers.get("X-Cache")}`,
  );
  if (isErrorBody(first.body)) {
    fail(target.label, "1st call returned error", first.body.error);
    return;
  }

  const parsed = CompanySummarySchema.safeParse(first.body.data);
  if (!parsed.success) {
    fail(target.label, "1st response failed CompanySummary validation", parsed.error.flatten());
    return;
  }
  const summary = parsed.data;
  console.log(
    `  company_name="${summary.company_name}", evidence=${summary.evidence.length}, ` +
      `values=${summary.values.length}, hiring_criteria=${summary.hiring_criteria.length}, ` +
      `ideal_candidate=${summary.ideal_candidate ? "present" : "null"}, ` +
      `iterations=${summary.total_iterations}, log_entries=${summary.research_log.length}`,
  );
  console.log(`  categories: ${describeCategories(summary.evidence)}`);

  // 2-1. evidence 件数は 3〜20(軽量化で典型 5〜10 件想定、上限は schema が 20)
  if (summary.evidence.length < 3) {
    fail(target.label, `evidence.length=${summary.evidence.length} (期待: >=3)`, {
      categories: summary.evidence.map((e) => e.category),
    });
  } else if (summary.evidence.length > 20) {
    fail(target.label, `evidence.length=${summary.evidence.length} (期待: <=20)`);
  }

  // 2-2. category は2種以上
  const categories = new Set(summary.evidence.map((e) => e.category));
  if (categories.size < 2) {
    fail(target.label, `category 種別 ${categories.size} 種 (期待: >=2)`, {
      categories: Array.from(categories),
    });
  }

  // 2-3. name のみ入力では research_log に search が必要(エージェントが公式サイトを特定するため)
  const hasSearch = summary.research_log.some((e) => e.type === "search");
  const hasFetch = summary.research_log.some((e) => e.type === "fetch");
  if (target.input_type === "name" && !hasSearch) {
    fail(target.label, "name 入力なのに research_log に search が無い", summary.research_log);
  }
  if (!hasFetch) {
    fail(target.label, "research_log に fetch エントリが1件も無い", summary.research_log);
  }

  // 2-4. evidence[].source_url が research_log の status=ok な fetch に存在(捏造禁止の自動検証)
  const okFetchedUrls = new Set(
    summary.research_log
      .filter((e) => e.type === "fetch" && e.status === "ok")
      .map((e) => (e as { url: string }).url),
  );
  for (const ev of summary.evidence) {
    if (!okFetchedUrls.has(ev.source_url)) {
      fail(
        target.label,
        `evidence ${ev.id} の source_url が fetch 履歴に無い (捏造の疑い)`,
        { source_url: ev.source_url, ok_fetched_count: okFetchedUrls.size },
      );
    }
  }

  // 2-5. レイテンシ目標は 60秒以内(リファクタの主目的)。超過は WARN のみ
  if (first.ms > LATENCY_TARGET_MS) {
    console.warn(
      `  WARN: 1st latency ${first.ms}ms > ${LATENCY_TARGET_MS}ms target. ` +
        `エージェント上限 (iter/search/fetch) と初期 fetch の効果を再点検`,
    );
  }

  // 2回目: HIT のはず
  const second = await callResearch(target);
  console.log(
    `  [2nd] status=${second.res.status}  ${second.ms}ms  cache=${second.res.headers.get("X-Cache")}`,
  );
  if (second.res.headers.get("X-Cache") !== "HIT") {
    fail(
      target.label,
      `expected X-Cache: HIT on 2nd call, got ${second.res.headers.get("X-Cache")}`,
    );
    return;
  }
  if (first.ms > 0 && second.ms <= first.ms / 2) {
    console.log(
      `  cache speedup: ${first.ms}ms → ${second.ms}ms (${Math.round((1 - second.ms / first.ms) * 100)}% faster)`,
    );
  } else {
    console.warn(
      `  WARN: 2nd call (${second.ms}ms) not dramatically faster than 1st (${first.ms}ms). HIT は来てるのでキャッシュ動作はしている`,
    );
  }
}

async function main() {
  console.log(`Smoke test target: ${BASE_URL}/api/research`);
  if (PROVIDER_FOR_BODY) {
    console.log(`Provider override (body.provider): ${PROVIDER_FOR_BODY}`);
  }
  if (process.env.LLM_PROVIDER_OVERRIDE) {
    console.log(
      `Provider override (env LLM_PROVIDER_OVERRIDE on server): ${process.env.LLM_PROVIDER_OVERRIDE}`,
    );
  }

  // dev server ヘルスチェック
  try {
    await fetch(BASE_URL, { method: "GET" });
  } catch (err) {
    console.error(`\nFAIL: cannot reach ${BASE_URL}. Is \`pnpm dev\` running?\n`, err);
    process.exit(2);
  }

  for (const target of TARGETS) {
    try {
      await runOne(target);
    } catch (err) {
      fail(target.label, "EXCEPTION during test", err instanceof Error ? err.message : err);
    }
  }

  if (failures > 0) {
    console.log(`\n=== Result: FAIL (${failures} failure${failures === 1 ? "" : "s"}) ===`);
  } else {
    console.log("\n=== Result: OK ===");
  }
}

main();
