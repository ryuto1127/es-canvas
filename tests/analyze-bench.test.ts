/**
 * Day 6 (2026-05-24) LLM 比較ベンチ。
 *
 * 3 系統 × 2 fixture(es1 / es4)= 6 実行を順次回し、質 / コスト / レイテンシを
 * テーブル化 + Markdown レポートに出力する。
 *
 * 系統:
 *   - anthropic-sonnet: Sonnet 4.6 + thinking 無し + tool_choice 強制(本番 default)
 *   - anthropic-opus:   Opus 4.7 + adaptive thinking + tool_choice 未指定(本番切替前の構成)
 *   - openai:           GPT-5.4 full + reasoning effort + tool_choice 強制(Day 6 比較対象)
 *
 * 設計判断(本ベンチ):
 *   - dev server を経由せず provider を直接呼ぶ。route の SSE 経路は 3 系統に対応させると
 *     工数が膨らみ、bench の本質ではないため。provider 直叩きで時間 / token を測る方が
 *     正確(ネットワーク経由の jitter が混入しない)
 *   - 6 実行を順次。並列にすると Anthropic / OpenAI 双方の rate limit を踏みやすい
 *     + cache 影響を切り分けにくくなる
 *   - JSON 出力は tests/output/{fixture}_{provider}_{ts}.json
 *   - 比較レポートは tests/output/bench-report-{date}.md(本実行で 1 ファイル)
 *
 * 実行方法:
 *   1. .env.local に ANTHROPIC_API_KEY と OPENAI_API_KEY を入れる
 *   2. `pnpm test:analyze-bench` で 6 実行
 *
 * 注意:
 *   - prompt cache は provider / model ごとに別 cache key になるため、3 系統で初回 cache miss
 *     が発生する一過性のコスト影響あり(本ベンチでは許容)
 *   - cost は lib/llm/pricing.ts の単価表ベース。GPT-5.4 は暫定値で、ベンチ実行直前に
 *     公式単価で校正することを推奨(DECISIONS に「要追加調査」を明記)
 */

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AnalysisResultSchema,
  type AnalysisResult,
} from "@/lib/schema/analysis";
import {
  AnalyzeInputBundleSchema,
  type AnalyzeInputBundle,
  type AnalyzeInputBundleInitial,
} from "@/lib/schema/input";
import { AnthropicProvider } from "@/lib/llm/anthropic";
import { OpenAIProvider } from "@/lib/llm/openai";
import { calcCost, formatUsd } from "@/lib/llm/pricing";

// .env.local を簡易ロード(dotenv に依存しない、shell export と併用可能)
// Next.js dev server は .env.local を自動ロードするが、本 bench は provider 直叩きのため
// 自力で読む必要がある。dispatch で `pnpm install dotenv` は禁じられているため、
// readFileSync ベースのミニマル実装で済ます。すでに process.env に値があれば上書きしない。
function loadDotEnvLocal(): void {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      // クォート剥がし
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      // shell が空文字列で export しているケース(例: ANTHROPIC_API_KEY=)も上書きする
      // ため、undefined だけでなく "" もチェック対象とする。
      // ファイル側に明示的に空文字列が書いてあるケースは想定外なので、ファイル側の値で
      // 上書きしてしまって OK。
      if (
        process.env[key] === undefined ||
        process.env[key] === ""
      ) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env.local が無いケース。shell export 済を前提として続行
  }
}
loadDotEnvLocal();

const OUTPUT_DIR = resolve(process.cwd(), "tests/output");

type ProviderKey = "anthropic-sonnet" | "anthropic-opus" | "openai";

const PROVIDERS: ReadonlyArray<{
  key: ProviderKey;
  label: string;
  model: string;
}> = [
  {
    key: "anthropic-sonnet",
    label: "Anthropic Sonnet 4.6",
    model: "claude-sonnet-4-6",
  },
  {
    key: "anthropic-opus",
    label: "Anthropic Opus 4.7",
    model: "claude-opus-4-7",
  },
  { key: "openai", label: "OpenAI GPT-5.4", model: "gpt-5.4" },
];

const FIXTURES: ReadonlyArray<{ key: string; label: string; file: string }> = [
  {
    key: "es1",
    label: "es1 (メルカリ, バランス, 完成度高)",
    file: "es1_high_quality_input.json",
  },
  {
    key: "es4",
    label: "es4 (三菱商事, 個性保護, 強い個人トーン)",
    file: "es4_strong_voice_input.json",
  },
];

interface BenchResult {
  fixtureKey: string;
  providerKey: ProviderKey;
  providerLabel: string;
  modelName: string;
  // 成功時
  latencyMs: number;
  retryAttempted: boolean; // metadata 経由で観察できないため、warn ログを caller 側で検知
  analysis?: AnalysisResult;
  // 質的メトリクス
  suggestionCount: number;
  categoryCounts: Record<string, number>;
  rationaleSourceCounts: Record<string, number>;
  interviewQuestionCount: number;
  preservedVoiceNote: string;
  overallSummary: string;
  // token / cost
  tokenInput: number;
  tokenOutput: number;
  tokenCacheRead: number;
  tokenCacheCreation: number;
  costUsd: number;
  // 失敗時
  error?: string;
}

function loadFixture(file: string): AnalyzeInputBundleInitial {
  const path = resolve(process.cwd(), "tests/fixtures", file);
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  const parsed = AnalyzeInputBundleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Fixture ${file} validation failed:\n${JSON.stringify(
        parsed.error.flatten(),
        null,
        2,
      )}`,
    );
  }
  if (parsed.data.mode !== "initial") {
    throw new Error(`Fixture ${file} is not initial mode`);
  }
  return parsed.data;
}

async function runOne(
  fixtureKey: string,
  fixtureLabel: string,
  input: AnalyzeInputBundle,
  providerKey: ProviderKey,
  providerLabel: string,
  modelName: string,
): Promise<BenchResult> {
  const t0 = Date.now();
  const result: BenchResult = {
    fixtureKey,
    providerKey,
    providerLabel,
    modelName,
    latencyMs: 0,
    retryAttempted: false,
    suggestionCount: 0,
    categoryCounts: {},
    rationaleSourceCounts: {},
    interviewQuestionCount: 0,
    preservedVoiceNote: "",
    overallSummary: "",
    tokenInput: 0,
    tokenOutput: 0,
    tokenCacheRead: 0,
    tokenCacheCreation: 0,
    costUsd: 0,
  };

  // retry warning を観察するための console.warn フック
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const msg = args.length > 0 ? String(args[0]) : "";
    if (msg.includes("retry triggered")) {
      result.retryAttempted = true;
    }
    originalWarn.apply(console, args as Parameters<typeof console.warn>);
  };

  try {
    let analysis: AnalysisResult;
    if (providerKey === "anthropic-sonnet") {
      const provider = new AnthropicProvider();
      analysis = await provider.analyze(input, "initial");
    } else if (providerKey === "anthropic-opus") {
      const provider = new AnthropicProvider();
      analysis = await provider.analyzeInitialOpus(input);
    } else {
      const provider = new OpenAIProvider();
      analysis = await provider.analyze(input, "initial");
    }
    result.latencyMs = Date.now() - t0;

    // 最終 Zod 検証(provider 内で済んでいるが念のため)
    const finalParse = AnalysisResultSchema.safeParse(analysis);
    if (!finalParse.success) {
      throw new Error(
        `final AnalysisResult validation failed: ${JSON.stringify(
          finalParse.error.flatten(),
          null,
          2,
        )}`,
      );
    }
    analysis = finalParse.data;
    result.analysis = analysis;

    // メトリクス集計
    result.suggestionCount = analysis.suggestions.length;
    for (const s of analysis.suggestions) {
      result.categoryCounts[s.category] =
        (result.categoryCounts[s.category] ?? 0) + 1;
      const t = s.rationale_source.type;
      result.rationaleSourceCounts[t] =
        (result.rationaleSourceCounts[t] ?? 0) + 1;
    }
    result.interviewQuestionCount =
      analysis.interview_questions?.questions.length ?? 0;
    result.preservedVoiceNote =
      analysis.overall_assessment.preserved_voice_note;
    result.overallSummary = analysis.overall_assessment.summary;

    const usage = analysis.metadata?.token_usage;
    result.tokenInput = usage?.input ?? 0;
    result.tokenOutput = usage?.output ?? 0;
    result.tokenCacheRead = usage?.cache_read ?? 0;
    result.tokenCacheCreation = usage?.cache_creation ?? 0;
    const cost = calcCost(modelName, {
      input: result.tokenInput,
      output: result.tokenOutput,
      cache_read: result.tokenCacheRead,
      cache_creation: result.tokenCacheCreation,
    });
    result.costUsd = cost.totalUsd;

    // 個別 JSON 保存
    await saveOutputJson(fixtureKey, providerKey, analysis);
  } catch (err) {
    result.latencyMs = Date.now() - t0;
    result.error =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(
      `  [FAIL] ${fixtureLabel} / ${providerLabel}: ${result.error}`,
    );
  } finally {
    console.warn = originalWarn;
  }

  return result;
}

async function saveOutputJson(
  fixtureKey: string,
  providerKey: ProviderKey,
  analysis: AnalysisResult,
): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const path = resolve(
    OUTPUT_DIR,
    `${fixtureKey}_${providerKey}_${ts}.json`,
  );
  await writeFile(path, JSON.stringify(analysis, null, 2));
  console.log(`  saved: ${path}`);
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  return `${sec}s`;
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function describeCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "(none)";
  return entries.map(([k, v]) => `${k}:${v}`).join(" ");
}

function escapeMarkdown(text: string, maxLen = 200): string {
  // パイプ記号は表内で escape、改行は空白に
  let s = text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  if (s.length > maxLen) s = s.slice(0, maxLen) + "…";
  return s;
}

function buildSummaryTable(results: BenchResult[]): string {
  const headers = [
    "ES",
    "Provider",
    "Suggestions",
    "Categories",
    "Latency",
    "Tokens (in/out)",
    "Cache (read/create)",
    "Cost ($)",
    "Retry",
  ];
  const lines: string[] = [];
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`|${headers.map(() => "---").join("|")}|`);
  for (const r of results) {
    const cells: string[] = [];
    cells.push(r.fixtureKey);
    cells.push(r.providerLabel);
    if (r.error) {
      cells.push("ERROR");
      cells.push(escapeMarkdown(r.error, 100));
      cells.push(fmtDuration(r.latencyMs));
      cells.push("-");
      cells.push("-");
      cells.push("-");
      cells.push("-");
    } else {
      cells.push(String(r.suggestionCount));
      cells.push(describeCounts(r.categoryCounts));
      cells.push(fmtDuration(r.latencyMs));
      cells.push(`${fmtTokens(r.tokenInput)}/${fmtTokens(r.tokenOutput)}`);
      cells.push(
        `${fmtTokens(r.tokenCacheRead)}/${fmtTokens(r.tokenCacheCreation)}`,
      );
      cells.push(formatUsd(r.costUsd));
      cells.push(r.retryAttempted ? "1" : "0");
    }
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

function buildQualitativeSection(results: BenchResult[]): string {
  const lines: string[] = [];

  // 各 fixture × provider の質的観察
  for (const fixture of FIXTURES) {
    lines.push(`### ${fixture.label}`);
    lines.push("");
    for (const provider of PROVIDERS) {
      const r = results.find(
        (x) =>
          x.fixtureKey === fixture.key && x.providerKey === provider.key,
      );
      if (!r) continue;
      lines.push(`#### ${provider.label}`);
      lines.push("");
      if (r.error) {
        lines.push(`- ERROR: ${r.error}`);
        lines.push("");
        continue;
      }
      lines.push(`- overall_summary: ${r.overallSummary}`);
      lines.push(`- preserved_voice_note: "${r.preservedVoiceNote}"`);
      lines.push(`- rationale_source 分布: ${describeCounts(r.rationaleSourceCounts)}`);
      lines.push(`- interview_questions 数: ${r.interviewQuestionCount}`);
      lines.push("");
      lines.push("**指摘の rationale 抜粋(冒頭3件):**");
      lines.push("");
      const sugs = r.analysis?.suggestions ?? [];
      for (const s of sugs.slice(0, 3)) {
        const orig = s.original.length > 40 ? s.original.slice(0, 40) + "…" : s.original;
        const rat =
          s.rationale.length > 200 ? s.rationale.slice(0, 200) + "…" : s.rationale;
        lines.push(`- [${s.category}/${s.rationale_source.type}] original: "${orig}"`);
        lines.push(`  rationale: ${rat}`);
      }
      lines.push("");

      // 面接質問の抜粋(冒頭2件)
      const questions = r.analysis?.interview_questions?.questions ?? [];
      if (questions.length > 0) {
        lines.push("**面接質問の抜粋(冒頭2件):**");
        lines.push("");
        for (const q of questions.slice(0, 2)) {
          const qt = q.question.length > 200 ? q.question.slice(0, 200) + "…" : q.question;
          lines.push(`- ${qt}`);
        }
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

function buildAggregateStats(results: BenchResult[]): string {
  const lines: string[] = [];
  const byProvider = new Map<ProviderKey, BenchResult[]>();
  for (const r of results) {
    const arr = byProvider.get(r.providerKey) ?? [];
    arr.push(r);
    byProvider.set(r.providerKey, arr);
  }
  lines.push("| Provider | 合計 Latency | 合計 Cost | 平均 Suggestions | 成功数 / 全数 |");
  lines.push("|---|---|---|---|---|");
  for (const provider of PROVIDERS) {
    const arr = byProvider.get(provider.key) ?? [];
    const ok = arr.filter((r) => !r.error);
    const totalMs = arr.reduce((a, r) => a + r.latencyMs, 0);
    const totalUsd = ok.reduce((a, r) => a + r.costUsd, 0);
    const avgSug =
      ok.length === 0
        ? 0
        : ok.reduce((a, r) => a + r.suggestionCount, 0) / ok.length;
    lines.push(
      `| ${provider.label} | ${fmtDuration(totalMs)} | ${formatUsd(totalUsd)} | ${avgSug.toFixed(1)} | ${ok.length} / ${arr.length} |`,
    );
  }
  return lines.join("\n");
}

async function buildReport(results: BenchResult[]): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`# Day 6 LLM 比較ベンチレポート — ${date}`);
  lines.push("");
  lines.push(
    "Sonnet 4.6 切替後の本番品質と Opus 4.7 / OpenAI GPT-5.4 の対照を取った Day 6 比較ベンチ。同じ es1 / es4 を 3 系統で分析し、質 / コスト / レイテンシを並べた。",
  );
  lines.push("");
  lines.push("## 実行サマリ");
  lines.push("");
  lines.push(buildSummaryTable(results));
  lines.push("");
  lines.push("## Provider 別集計");
  lines.push("");
  lines.push(buildAggregateStats(results));
  lines.push("");
  lines.push("## 質的観察");
  lines.push("");
  lines.push(buildQualitativeSection(results));
  lines.push("");
  lines.push("## 補足");
  lines.push("");
  lines.push("- Cost は lib/llm/pricing.ts の単価表(Anthropic 公式 + GPT-5.4 暫定値)から計算。");
  lines.push(
    "- GPT-5.4 の単価は OpenAI 公式 docs で再確認すること(DECISIONS の「要追加調査」を参照)。",
  );
  lines.push(
    "- prompt cache は 3 系統で別 cache key になるため、初回 cache miss の一過性コスト影響あり。",
  );
  lines.push(
    "- レイテンシは provider 直叩き計測(SSE / route オーバーヘッドなし)。",
  );
  lines.push("");
  return lines.join("\n");
}

async function main() {
  // env 検証
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set in .env.local");
    process.exit(2);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set in .env.local");
    process.exit(2);
  }

  const results: BenchResult[] = [];

  for (const fixture of FIXTURES) {
    const input = loadFixture(fixture.file);
    for (const provider of PROVIDERS) {
      console.log(`\n=== ${fixture.label} / ${provider.label} ===`);
      const r = await runOne(
        fixture.key,
        fixture.label,
        input,
        provider.key,
        provider.label,
        provider.model,
      );
      if (!r.error) {
        console.log(
          `  latency=${fmtDuration(r.latencyMs)}, suggestions=${r.suggestionCount}, cost=${formatUsd(r.costUsd)}, retry=${r.retryAttempted ? "1" : "0"}`,
        );
        console.log(
          `  tokens in/out=${fmtTokens(r.tokenInput)}/${fmtTokens(r.tokenOutput)}, cache read/create=${fmtTokens(r.tokenCacheRead)}/${fmtTokens(r.tokenCacheCreation)}`,
        );
      }
      results.push(r);
    }
  }

  // 比較レポート出力(stdout + markdown ファイル)
  const reportMd = await buildReport(results);
  console.log("\n\n");
  console.log(reportMd);

  await mkdir(OUTPUT_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = resolve(OUTPUT_DIR, `bench-report-${date}.md`);
  await writeFile(reportPath, reportMd);
  console.log(`\nreport saved: ${reportPath}`);

  // 失敗があれば exit 1(ただしレポート保存は完遂)
  const failures = results.filter((r) => r.error).length;
  if (failures > 0) {
    console.error(`\n=== Result: ${failures} failure(s) out of ${results.length} ===`);
    process.exitCode = 1;
  } else {
    console.log(`\n=== Result: OK (${results.length} / ${results.length} succeeded) ===`);
  }
}

main();
