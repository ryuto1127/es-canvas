import OpenAI from "openai";
import {
  type CompanySummary,
  type ResearchInputSource,
  type ResearchLogEntry,
} from "../schema/company";
import {
  RESEARCH_AGENT_SYSTEM_PROMPT,
  buildInitialResearchPrompt,
} from "../prompts/research";
import {
  RESEARCH_FREETEXT_SYSTEM_PROMPT,
  buildFreetextResearchPrompt,
} from "../prompts/research_freetext";
import {
  FETCH_PAGE_TOOL_NAME_OAI,
  FETCH_PAGE_TOOL_OAI,
  SUBMIT_SUMMARY_TOOL_NAME_OAI,
  SUBMIT_SUMMARY_TOOL_OAI,
  WEB_SEARCH_TOOL_OAI,
} from "../tools/research_agent_openai";
import {
  SUBMIT_FREETEXT_SUMMARY_TOOL_OAI,
  SUBMIT_FREETEXT_SUMMARY_TOOL_NAME_OAI,
} from "../tools/research_freetext_openai";
import {
  ANALYZE_ES_TOOL_NAME_OAI,
  ANALYZE_ES_TOOL_OAI,
} from "../tools/analyze_es_openai";
import {
  ANALYZE_ES_REFRESH_ONLY_TOOL_NAME_OAI,
  ANALYZE_ES_REFRESH_ONLY_TOOL_OAI,
} from "../tools/analyze_es_refresh_only_openai";
import {
  ANALYZE_ES_PARTIAL_REFRESH_TOOL_NAME_OAI,
  ANALYZE_ES_PARTIAL_REFRESH_TOOL_OAI,
} from "../tools/analyze_es_partial_refresh_openai";
import {
  GENERATE_INTERVIEW_QUESTIONS_TOOL_NAME_OAI,
  GENERATE_INTERVIEW_QUESTIONS_TOOL_OAI,
} from "../tools/generate_interview_questions_openai";
import { extractFromUrl } from "../utils/url_extract";
import {
  buildApprovedListMessage,
  buildFreetextRetryMessage,
  buildInitialContext,
  buildRetryMessage,
  getApprovedUrls,
  mapFetchErrorStatus,
  renderInitialContextBlock,
  validateFreetextSummary,
  validateSummaryWithSources,
} from "./research_helpers";
import {
  LLMError,
  type AnalyzeInput,
  type AnalyzeMode,
  type InterviewInput,
  type LLMProvider,
} from "./types";
import type {
  AIInitialAnalysisOutput,
  AIPartialAnalysisOutput,
  AIRefreshAnalysisOutput,
  AnalysisMetadata,
  AnalysisResult,
  PartialAnalysisResult,
} from "../schema/analysis";
import type { InterviewQuestions } from "../schema/interview";
import type { AISuggestion } from "../schema/suggestion";
import type {
  AnalyzeInputBundlePartial,
  AnalyzeInputBundleRefresh,
  InterviewInputBundle,
} from "../schema/input";
import { ANALYZE_SYSTEM_PROMPT } from "../prompts/system";
import {
  ANALYZE_FEWSHOT_ASSISTANT_INPUT,
  ANALYZE_FEWSHOT_USER_MESSAGE,
} from "../prompts/fewshot";
import { buildInitialUserMessage } from "../prompts/initial";
import {
  buildRefreshUserMessage,
  inferRefreshTrigger,
} from "../prompts/refresh";
import {
  buildPartialInvariantBlock,
  buildPartialVariableBlock,
  inferPartialTrigger,
} from "../prompts/partial_refresh";
import { buildInterviewUserMessage } from "../prompts/interview";
import {
  assignDisplayPriority,
  buildAnalysisRetryMessage,
  validateAnalysisAgainstInput,
} from "./analyze_helpers";
import {
  buildInterviewRetryMessage,
  validateInterviewOutput,
} from "./interview_helpers";
import { resolveOriginalSpans } from "../utils/es_anchor";
import type { AnalyzeStreamEvent } from "./anthropic";

// DECISION [2026-05-22 セッション4]: research の主モデルを GPT-5.4 mini → GPT-5.4 (full) に昇格。
// 統合改修パッケージ (2026-05-25): provider 完全統一に伴い、analyze / refresh / interview も
// すべて GPT-5.4 full に統一。詳細は DECISIONS.md `[2026-05-25] 統合改修パッケージ訂正` 参照。
export const MODEL_RESEARCH = "gpt-5.4" as const;

// 統合改修パッケージ (2026-05-25): 全 analyze 経路で使用する GPT-5.4 full。
// Day 6 ベンチで Sonnet 4.6 同水準の質 + 安いコスト + 低レイテンシ + retry 0 を実証済。
export const MODEL_ANALYZE = "gpt-5.4" as const;

// 統合改修パッケージ (2026-05-25): refresh / interview 経路でも GPT-5.4 full を使用。
// Day 7 まで残り 2-3 日の時間制約上、質的安定を優先(mini 検証は v2)。
export const MODEL_REFRESH = "gpt-5.4" as const;
export const MODEL_INTERVIEW = "gpt-5.4" as const;

// 統合改修パッケージ (2026-05-25): 動的 HITL の意味的差分判定で使用する軽量モデル。
// `lib/llm/semantic_diff.ts`(Commit B で追加)から参照される。
// 短い 2 文比較なら mini で十分(Day 6 で full の overkill 観察)。
export const MODEL_SEMANTIC_DIFF = "gpt-5.4-mini" as const;

// 軽量化: セッション2 の 15/5/10 はデモ用途で過剰だった。リファクタ後は両プロバイダで共有する。
const MAX_AGENT_ITERATIONS = 5;
const MAX_SEARCHES = 3;
const MAX_FETCHES = 5;

// analyze 経路の max_output_tokens 群。
// 統合改修パッケージ (2026-05-25): refresh / partial / interview も Anthropic 経路と
// 同じバジェットで揃え、provider 切替で出力規模が変わらないようにする。
const ANALYZE_MAX_OUTPUT_TOKENS = 16384; // initial
const REFRESH_MAX_OUTPUT_TOKENS = 12288; // refresh(全件再生成)
const PARTIAL_MAX_OUTPUT_TOKENS = 8192; // partial(差分のみ)
const INTERVIEW_MAX_OUTPUT_TOKENS = 4096; // interview(questions のみ)

// research 経路の出力上限。
const MAX_OUTPUT_TOKENS = 12288;

// OpenAI Responses API の output 型に合わせた最小限のローカル別名。
type ResponseOutputItem = OpenAI.Responses.ResponseOutputItem;
type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type Tool = OpenAI.Responses.Tool;

// 統合改修パッケージ (2026-05-25): few-shot で使う固定 call_id(セッション固定の任意文字列)。
// few-shot prefix は initial / refresh / partial / interview で共通化(prompt cache 最大化)。
const FEWSHOT_CALL_ID_OAI = "call_fewshot_analyze_es" as const;

// usage 累計の型エイリアス(provider 内ローカル使用、AnalysisMetadata.token_usage と整合)。
type TotalUsage = {
  input: number;
  output: number;
  cache_read?: number;
  cache_creation?: number;
};

// OpenAI Responses API の usage から「通常 input + cached input」を分離する helper。
// SDK の型上、cached_tokens は ResponseUsage.input_tokens_details.cached_tokens に
// 入る可能性がある(モデル / API バージョンで揺れる)。安全に optional として読む。
function accumulateUsage(
  prev: TotalUsage,
  u: OpenAI.Responses.Response["usage"] | undefined,
): TotalUsage {
  const cachedTokens =
    ((u as unknown as {
      input_tokens_details?: { cached_tokens?: number };
    })?.input_tokens_details?.cached_tokens ?? 0);
  return {
    input: prev.input + ((u?.input_tokens ?? 0) - cachedTokens),
    output: prev.output + (u?.output_tokens ?? 0),
    cache_read: (prev.cache_read ?? 0) + cachedTokens,
    cache_creation: prev.cache_creation,
  };
}

// OpenAI SDK のエラーを LLMError 系の payload に正規化して yield する helper。
// stage は呼び出し側の経路名(analyze_initial_stream / analyze_refresh_stream / 等)。
function* yieldOpenAIError(
  err: unknown,
  stage: string,
): Generator<AnalyzeStreamEvent, void, void> {
  if (err instanceof OpenAI.RateLimitError) {
    yield {
      type: "error",
      kind: "rate_limit",
      message: "OpenAI rate limit hit",
      stage,
      retryable: true,
    };
    return;
  }
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    yield {
      type: "error",
      kind: "timeout",
      message: "OpenAI API connection timeout",
      stage,
      retryable: true,
    };
    return;
  }
  if (err instanceof OpenAI.APIError) {
    yield {
      type: "error",
      kind: "api_error",
      message: `OpenAI API error: ${err.message}`,
      stage,
      retryable: true,
    };
    return;
  }
  yield {
    type: "error",
    kind: "unknown",
    message:
      err instanceof Error ? err.message : "Unknown OpenAI SDK error",
    stage,
  };
}

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai" as const;
  private client: OpenAI;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) {
      throw new LLMError("api_error", "OPENAI_API_KEY is not set");
    }
    this.client = new OpenAI({ apiKey: key });
  }

  async researchCompany(input: ResearchInputSource): Promise<CompanySummary> {
    // Phase E 拡張(2026-05-23): 自由テキスト経路はエージェントループ無し、submit_summary 単発。
    // 防衛三段の自由テキスト版を validateFreetextSummary + buildFreetextRetryMessage が担う。
    if (input.type === "freetext") {
      return this.researchFreetext(input.value);
    }

    const startedAt = new Date().toISOString();
    const researchLog: ResearchLogEntry[] = [];

    // セッション3 で導入: サーバー側で URL 初手 fetch を済ませて初期コンテキストに埋める。
    // name 入力時は何もしない(content=null)。失敗時も致命的にせず、ログだけ残して続行。
    const initialContext = await buildInitialContext(input, researchLog);

    // セッション4 ハードニング: 初期 user メッセージに「承認済みURLリスト」も同梱して、
    // 1ターン目から source_url の選択肢を構造で縛る。初期 fetch が成功していれば 1件、
    // name 入力時は 0件(空リスト)から始まる。
    const initialUserPrompt = [
      buildInitialResearchPrompt(input),
      renderInitialContextBlock(initialContext),
      "",
      buildApprovedListMessage(getApprovedUrls(researchLog)),
    ]
      .filter((s) => s.length > 0)
      .join("\n");

    // 最初の input は user メッセージ1件。以降は function_call_output + 動的 user メッセージ。
    // previous_response_id を使うので、過去の assistant 出力(function_call 等)は
    // OpenAI 側で会話状態として保持される。
    let nextInput: ResponseInputItem[] = [
      { role: "user", content: initialUserPrompt },
    ];
    let previousResponseId: string | undefined = undefined;

    let searchCount = 0;
    let fetchCount = 0;
    // セッション4 ハードニング(Part D): submit_summary の Zod 検証が落ちたら1回だけリトライ。
    // 2回目も失敗したら 503。新規 iteration は消費しない(continue 前に iteration-- する)。
    let retryAttempted = false;

    for (let iteration = 1; iteration <= MAX_AGENT_ITERATIONS; iteration++) {
      // MAX_SEARCHES 超過後は web_search を tools から外して、続けて検索を要求されないようにする。
      // fetch_page と submit_summary は最後まで提示し続ける(終端到達の経路を残す)。
      const tools: Tool[] = [];
      if (searchCount < MAX_SEARCHES) tools.push(WEB_SEARCH_TOOL_OAI);
      tools.push(FETCH_PAGE_TOOL_OAI, SUBMIT_SUMMARY_TOOL_OAI);

      let response: OpenAI.Responses.Response;
      try {
        response = await this.client.responses.create({
          model: MODEL_RESEARCH,
          // 初回は system + user メッセージ、2回目以降は function_call_output + 承認済みリスト。
          // どちらも previous_response_id と組み合わせて「会話の続き」として渡せる。
          input: nextInput,
          previous_response_id: previousResponseId,
          tools,
          instructions: RESEARCH_AGENT_SYSTEM_PROMPT,
          max_output_tokens: MAX_OUTPUT_TOKENS,
          // 自動プロンプトキャッシング: instructions + tools は不変なので OpenAI 側で
          // 1024トークン以上のプレフィックスは自動的にキャッシュされる(cache_control 不要)。
          // 各ターン末尾の動的「承認済みURLリスト」は短く(数十〜200トークン)、それより前の
          // 会話履歴は previous_response_id 経由でキャッシュ対象に残る。
        });
      } catch (err) {
        if (err instanceof OpenAI.RateLimitError) {
          throw new LLMError("rate_limit", "OpenAI rate limit hit", err);
        }
        if (err instanceof OpenAI.APIConnectionTimeoutError) {
          throw new LLMError("timeout", "OpenAI API connection timeout", err);
        }
        if (err instanceof OpenAI.APIError) {
          throw new LLMError(
            "api_error",
            `OpenAI API error: ${err.message}`,
            err,
          );
        }
        throw new LLMError("unknown", "Unknown OpenAI SDK error", err);
      }

      previousResponseId = response.id;

      const toolOutputs: ResponseInputItem[] = [];
      let submittedInput: unknown = null;
      let submitCallId: string | null = null;

      for (const item of response.output) {
        if (item.type === "function_call") {
          if (item.name === SUBMIT_SUMMARY_TOOL_NAME_OAI) {
            try {
              submittedInput = JSON.parse(item.arguments);
              submitCallId = item.call_id;
            } catch (err) {
              throw new LLMError(
                "schema_validation",
                "submit_summary arguments were not valid JSON",
                { raw: item.arguments, cause: err },
              );
            }
            // 終端: 残りの output item は無視
            break;
          }

          if (item.name === FETCH_PAGE_TOOL_NAME_OAI) {
            fetchCount++;
            if (fetchCount > MAX_FETCHES) {
              toolOutputs.push({
                type: "function_call_output",
                call_id: item.call_id,
                output: JSON.stringify({
                  error: "max_uses_exceeded",
                  message: `fetch_page の上限 ${MAX_FETCHES} 回に達しました。これ以上の URL 取得は禁止です。手持ちの情報で submit_summary を呼んでください。`,
                }),
              });
              continue;
            }

            const url = extractUrlArg(item.arguments);
            const t0 = Date.now();
            const result = await extractFromUrl(url);
            const ms = Date.now() - t0;

            researchLog.push({
              type: "fetch",
              url: url || "about:invalid",
              status: result.ok ? "ok" : mapFetchErrorStatus(result.error),
              extracted_chars: result.ok ? result.data.text.length : null,
              ms,
              timestamp: new Date().toISOString(),
            });

            toolOutputs.push({
              type: "function_call_output",
              call_id: item.call_id,
              output: result.ok
                ? `[Title: ${result.data.title ?? "unknown"}]\n[URL: ${url}]\n\n${result.data.text}`
                : JSON.stringify({
                    error: result.error.kind,
                    message: result.error.message,
                  }),
            });
            continue;
          }

          // 未知の function: エラーで返してエージェントに自己訂正の余地を与える
          toolOutputs.push({
            type: "function_call_output",
            call_id: item.call_id,
            output: JSON.stringify({
              error: "unknown_tool",
              message: `Unknown tool: ${item.name}`,
            }),
          });
        } else if (item.type === "web_search_call") {
          // OpenAI 組み込み web_search は結果が会話に自動で含まれる。クライアント側で
          // tool_result を返す必要は無い。research_log にだけクエリ等を記録する。
          searchCount++;
          const query = extractSearchQuery(item);
          researchLog.push({
            type: "search",
            query,
            results_count: 0, // OpenAI 側で件数は露出しないため 0 で固定
            timestamp: new Date().toISOString(),
          });
        }
        // reasoning / message などその他の output item は previous_response_id 側で
        // OpenAI が保持するため、ここでは無視して良い。
      }

      if (submittedInput !== null) {
        const finishedAt = new Date().toISOString();
        // セッション4 ハードニング: synthesize は「この iter で成功裏に合成された」マーカー。
        // 検証が失敗してリトライに入る場合は、その iter の synthesize を最終 log に残さない。
        // → 一旦 tentative log を作って validate に渡し、成功時のみ研究ログに反映する。
        const candidateLog: ResearchLogEntry[] = [
          ...researchLog,
          { type: "synthesize", iteration, timestamp: finishedAt },
        ];

        const validation = validateSummaryWithSources(
          submittedInput,
          candidateLog,
          input,
          startedAt,
          finishedAt,
          iteration,
        );

        if (validation.ok) {
          return validation.data;
        }

        if (!retryAttempted) {
          retryAttempted = true;
          const approvedUrls = getApprovedUrls(researchLog);
          const retryMessage = buildRetryMessage(validation.error, approvedUrls);

          console.warn(
            `[OpenAIProvider.researchCompany] retry triggered (${validation.error.kind})`,
            JSON.stringify({
              iteration,
              error_kind: validation.error.kind,
              error_summary:
                validation.error.kind === "fabricated_source"
                  ? {
                      ev: validation.error.evidenceId,
                      url: validation.error.url,
                    }
                  : { issues: validation.error.issues.slice(0, 3) },
              approved_count: approvedUrls.length,
            }),
          );

          // submit_summary の function_call には function_call_output で応じる必要がある
          // (Responses API は pending tool use を持ったまま次のリクエストを送ると 400)。
          // エラー詳細を tool_result として返し、さらに user メッセージで具体的な修正指示を渡す。
          nextInput = [
            {
              type: "function_call_output",
              call_id: submitCallId!,
              output: JSON.stringify({
                error: "validation_failed",
                kind: validation.error.kind,
                message: validation.error.message,
              }),
            },
            { role: "user", content: retryMessage },
          ];

          // リトライは新規 iteration を消費しない。for ループの iteration++ で次に進むので
          // -- して相殺する(=次の周回は同じ iteration 値で実行される)。
          iteration--;
          continue;
        }

        // 2回目も失敗 → 諦めて 503 相当を投げる
        console.error(
          "[OpenAIProvider.researchCompany] validation failed after retry",
          JSON.stringify({ error: validation.error }, null, 2),
        );
        throw new LLMError(
          "schema_validation",
          `submit_summary failed validation after retry: ${validation.error.kind} (${validation.error.message})`,
          {
            error: validation.error,
            approved_urls: getApprovedUrls(researchLog),
          },
        );
      }

      // 早期終了判定 (submit されていないケース)
      if (response.status === "completed" && toolOutputs.length === 0) {
        // status が completed かつ tool_outputs が空 → エージェントが submit せずに終わった
        throw new LLMError(
          "agent_no_submission",
          "OpenAI agent completed without calling submit_summary",
          { iteration, status: response.status },
        );
      }

      // incomplete: 出力切れ。max_output_tokens を超過したか、その他の理由。
      if (response.status === "incomplete") {
        throw new LLMError(
          "api_error",
          `OpenAI response incomplete (${response.incomplete_details?.reason ?? "unknown"})`,
          { iteration, response_id: response.id },
        );
      }
      if (response.status === "failed") {
        throw new LLMError(
          "api_error",
          `OpenAI response failed: ${response.error?.message ?? "unknown"}`,
          { iteration, response_id: response.id },
        );
      }

      // 次の iter の input: function_call_output 群 + 最新の承認済み URL リスト。
      // submit_summary を呼ぶ直前にこの規律メッセージが来る状態を保つ。
      const approvedUrlsNow = getApprovedUrls(researchLog);
      nextInput = [
        ...toolOutputs,
        {
          role: "user",
          content: buildApprovedListMessage(approvedUrlsNow),
        },
      ];
    }

    throw new LLMError(
      "agent_max_iterations",
      `${MAX_AGENT_ITERATIONS} 回の反復で submit_summary に到達しませんでした (OpenAI)`,
      { iterations: MAX_AGENT_ITERATIONS, log_entries: researchLog.length },
    );
  }

  // Phase E 拡張(2026-05-23): 自由テキスト経路。Anthropic 側と意味的に同一の構造。
  // submit_summary 単発呼び出し + 検証失敗時 1 回リトライ。エージェントループ無し。
  private async researchFreetext(freetext: string): Promise<CompanySummary> {
    const startedAt = new Date().toISOString();
    const researchLog: ResearchLogEntry[] = [];
    const sourceInput: ResearchInputSource = {
      type: "freetext",
      value: freetext,
    };

    const initialUserPrompt = buildFreetextResearchPrompt(freetext);
    let nextInput: ResponseInputItem[] = [
      { role: "user", content: initialUserPrompt },
    ];
    let previousResponseId: string | undefined = undefined;
    let retryAttempted = false;

    for (let attempt = 0; attempt < 2; attempt++) {
      let response: OpenAI.Responses.Response;
      try {
        response = await this.client.responses.create({
          model: MODEL_RESEARCH,
          input: nextInput,
          previous_response_id: previousResponseId,
          tools: [SUBMIT_FREETEXT_SUMMARY_TOOL_OAI],
          instructions: RESEARCH_FREETEXT_SYSTEM_PROMPT,
          // freetext 経路は外部取得無しで evidence を組み立てるだけなので、URL/name 経路の
          // 12K より小さくても足りる。安全側で 8K 確保。
          max_output_tokens: 8192,
        });
      } catch (err) {
        if (err instanceof OpenAI.RateLimitError) {
          throw new LLMError("rate_limit", "OpenAI rate limit hit", err);
        }
        if (err instanceof OpenAI.APIConnectionTimeoutError) {
          throw new LLMError("timeout", "OpenAI API connection timeout", err);
        }
        if (err instanceof OpenAI.APIError) {
          throw new LLMError(
            "api_error",
            `OpenAI API error: ${err.message}`,
            err,
          );
        }
        throw new LLMError("unknown", "Unknown OpenAI SDK error", err);
      }

      previousResponseId = response.id;

      // submit_summary の function_call を探す
      let submittedInput: unknown = null;
      let submitCallId: string | null = null;
      for (const item of response.output) {
        if (
          item.type === "function_call" &&
          item.name === SUBMIT_FREETEXT_SUMMARY_TOOL_NAME_OAI
        ) {
          try {
            submittedInput = JSON.parse(item.arguments);
            submitCallId = item.call_id;
          } catch (err) {
            throw new LLMError(
              "schema_validation",
              "freetext submit_summary arguments were not valid JSON",
              { raw: item.arguments, cause: err },
            );
          }
          break;
        }
      }

      if (submittedInput === null) {
        throw new LLMError(
          "agent_no_submission",
          "OpenAI freetext agent completed without calling submit_summary",
          { attempt, status: response.status },
        );
      }

      const finishedAt = new Date().toISOString();
      const iteration = attempt + 1;
      const candidateLog: ResearchLogEntry[] = [
        ...researchLog,
        { type: "synthesize", iteration, timestamp: finishedAt },
      ];

      const validation = validateFreetextSummary(
        submittedInput,
        freetext,
        candidateLog,
        sourceInput,
        startedAt,
        finishedAt,
        iteration,
      );

      if (validation.ok) {
        return validation.data;
      }

      if (retryAttempted) {
        console.error(
          "[OpenAIProvider.researchFreetext] validation failed after retry",
          JSON.stringify({ error: validation.error }, null, 2),
        );
        throw new LLMError(
          "schema_validation",
          `freetext submit_summary failed validation after retry: ${validation.error.kind} (${validation.error.message})`,
          { error: validation.error },
        );
      }

      retryAttempted = true;
      const retryMessage = buildFreetextRetryMessage(validation.error);
      console.warn(
        `[OpenAIProvider.researchFreetext] retry triggered (${validation.error.kind})`,
        JSON.stringify({
          error_kind: validation.error.kind,
          error_summary:
            validation.error.kind === "fabricated_source"
              ? {
                  ev: validation.error.evidenceId,
                  url: validation.error.url,
                }
              : { issues: validation.error.issues.slice(0, 3) },
        }),
      );

      // function_call の応答として function_call_output(error 詳細)+ user(リトライメッセージ)
      nextInput = [
        {
          type: "function_call_output",
          call_id: submitCallId!,
          output: JSON.stringify({
            error: "validation_failed",
            kind: validation.error.kind,
            message: validation.error.message,
          }),
        },
        { role: "user", content: retryMessage },
      ];
    }

    throw new LLMError(
      "unknown",
      "researchFreetext: unreachable — validation loop exhausted without return",
    );
  }

  // 統合改修パッケージ (2026-05-25): analyze 経路の同期版。
  // initial / refresh をサポート(partial は streaming 経路のみ、Anthropic と同じ規律)。
  // OpenAI SDK でも非 streaming で完結する経路を維持(tests/analyze-bench.test.ts 等から
  // 直接 instantiation で叩く外部 caller があるため)。
  async analyze(input: AnalyzeInput, mode: AnalyzeMode): Promise<AnalysisResult> {
    if (input.mode !== mode) {
      throw new LLMError(
        "api_error",
        `AnalyzeInputBundle.mode (${input.mode}) と引数 mode (${mode}) が一致しない`,
      );
    }
    if (input.mode === "initial") {
      return analyzeInitialOpenAI(this.client, input);
    }
    if (input.mode === "refresh") {
      return analyzeRefreshOpenAI(this.client, input);
    }
    // partial は streaming 経路のみ(Anthropic と同じ規律)
    throw new LLMError(
      "api_error",
      "Sync analyze() does not support partial mode; call analyzePartialStream() instead",
    );
  }

  // 統合改修パッケージ (2026-05-25): SSE streaming 経路 — initial。
  // 既存の同期版 `analyze(input, "initial")` は維持(tests/analyze-bench.test.ts 等の
  // 外部 caller / fallback を温存するため)。route は streaming を必ず使う。
  analyzeInitialStream(
    input: AnalyzeInput,
  ): AsyncGenerator<AnalyzeStreamEvent, void, void> {
    if (input.mode !== "initial") {
      throw new LLMError(
        "api_error",
        "analyzeInitialStream は initial モードのみ受け付ける",
      );
    }
    return analyzeInitialStreamingOpenAI(this.client, input);
  }

  // 統合改修パッケージ (2026-05-25): SSE streaming 経路 — refresh。
  // Anthropic 経路と同じ event 種別 / 同じ防衛三段で振る舞う。
  analyzeRefreshStream(
    input: AnalyzeInput,
  ): AsyncGenerator<AnalyzeStreamEvent, void, void> {
    if (input.mode !== "refresh") {
      throw new LLMError(
        "api_error",
        "analyzeRefreshStream は refresh モードのみ受け付ける",
      );
    }
    return analyzeRefreshStreamingOpenAI(this.client, input);
  }

  // 統合改修パッケージ (2026-05-25): SSE streaming 経路 — partial。
  analyzePartialStream(
    input: AnalyzeInput,
  ): AsyncGenerator<AnalyzeStreamEvent, void, void> {
    if (input.mode !== "partial") {
      throw new LLMError(
        "api_error",
        "analyzePartialStream は partial モードのみ受け付ける",
      );
    }
    return analyzePartialStreamingOpenAI(this.client, input);
  }

  // 統合改修パッケージ (2026-05-25): /api/interview 経路の本実装。
  // Anthropic 経路 `generateInterviewImpl` と意味的に同形(防衛三段 + 1 回リトライ)。
  async generateInterview(input: InterviewInput): Promise<InterviewQuestions> {
    return generateInterviewOpenAI(this.client, input);
  }
}

// =============================================================================
// 統合改修パッケージ (2026-05-25): OpenAI initial analyze(同期版、retains 既存)
// =============================================================================
// 防衛三段の OpenAI 実装(Anthropic 経路と意味的に同形):
//   Part 1 (モデル品質): GPT-5.4 full + reasoning.effort
//   Part 2 (動的承認リスト): buildInitialUserMessage(入力に承認 evidence ID リストを埋込)
//   Part 3 (Zod 検証 + 1 回リトライ): validateAnalysisAgainstInput + buildAnalysisRetryMessage
async function analyzeInitialOpenAI(
  client: OpenAI,
  input: AnalyzeInput,
): Promise<AnalysisResult> {
  if (input.mode !== "initial") {
    throw new LLMError(
      "api_error",
      "analyzeInitialOpenAI called with non-initial input",
    );
  }

  const realUserMessage = buildInitialUserMessage(input);

  // 会話履歴を1リクエストにまとめて入れる(previous_response_id を使わない理由:
  // few-shot を毎回固定で再投入したいため、自動継続より明示組み立てが安全)
  // - user: few-shot user message
  // - assistant: function_call(ANALYZE_ES、few-shot の assistant 出力を例示)
  // - user: function_call_output(few-shot 受理確認)+ 実 input
  let nextInput: ResponseInputItem[] = [
    {
      role: "user",
      content: ANALYZE_FEWSHOT_USER_MESSAGE,
    },
    {
      type: "function_call",
      call_id: FEWSHOT_CALL_ID_OAI,
      name: ANALYZE_ES_TOOL_NAME_OAI,
      arguments: JSON.stringify(ANALYZE_FEWSHOT_ASSISTANT_INPUT),
    },
    {
      type: "function_call_output",
      call_id: FEWSHOT_CALL_ID_OAI,
      output:
        "上記は few-shot 例として受理しました。続けて次の入力に対して analyze_es を呼んでください。",
    },
    {
      role: "user",
      content: realUserMessage,
    },
  ];

  const tools: Tool[] = [ANALYZE_ES_TOOL_OAI];

  let retryAttempted = false;
  let totalUsage: TotalUsage = { input: 0, output: 0 };

  for (let attempt = 0; attempt < 2; attempt++) {
    let response: OpenAI.Responses.Response;
    try {
      response = await client.responses.create({
        model: MODEL_ANALYZE,
        input: nextInput,
        instructions: ANALYZE_SYSTEM_PROMPT,
        tools,
        tool_choice: {
          type: "function",
          name: ANALYZE_ES_TOOL_NAME_OAI,
        },
        max_output_tokens: ANALYZE_MAX_OUTPUT_TOKENS,
        reasoning: {
          effort: attempt === 0 ? "medium" : "low",
        },
      });
    } catch (err) {
      if (err instanceof OpenAI.RateLimitError) {
        throw new LLMError("rate_limit", "OpenAI rate limit hit", err);
      }
      if (err instanceof OpenAI.APIConnectionTimeoutError) {
        throw new LLMError("timeout", "OpenAI API connection timeout", err);
      }
      if (err instanceof OpenAI.APIError) {
        throw new LLMError(
          "api_error",
          `OpenAI API error: ${err.message}`,
          err,
        );
      }
      throw new LLMError("unknown", "Unknown OpenAI SDK error", err);
    }

    totalUsage = accumulateUsage(totalUsage, response.usage);

    // function_call(analyze_es)を探す
    let toolUseArguments: string | null = null;
    let toolUseCallId: string | null = null;
    for (const item of response.output) {
      if (
        item.type === "function_call" &&
        item.name === ANALYZE_ES_TOOL_NAME_OAI
      ) {
        toolUseArguments = item.arguments;
        toolUseCallId = item.call_id;
        break;
      }
    }

    if (toolUseArguments === null || toolUseCallId === null) {
      // text 応答に分岐したケース
      throw new LLMError(
        "api_error",
        "OpenAI が analyze_es ツールを呼ばずに応答を終えました",
        { status: response.status, attempt },
      );
    }

    // arguments(JSON 文字列)を parse
    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(toolUseArguments);
    } catch (err) {
      throw new LLMError(
        "schema_validation",
        "analyze_es arguments were not valid JSON",
        { raw: toolUseArguments, cause: err },
      );
    }

    const validation = validateAnalysisAgainstInput(parsedArgs, input);
    if (validation.ok) {
      return assembleInitialAnalysisResultOpenAI(
        input,
        validation.data,
        totalUsage,
      );
    }

    if (retryAttempted) {
      console.error(
        "[OpenAIProvider.analyze] validation failed after retry",
        JSON.stringify(
          { issues: validation.issues.slice(0, 5), input_mode: input.mode },
          null,
          2,
        ),
      );
      throw new LLMError(
        "analysis_validation",
        `OpenAI analyze_es output failed validation after retry: ${validation.issues
          .map((i) => i.kind)
          .join(", ")}`,
        { issues: validation.issues },
      );
    }

    // 1 回だけリトライ
    retryAttempted = true;
    const retryMessage = buildAnalysisRetryMessage(validation.issues, input);
    console.warn(
      "[OpenAIProvider.analyze] retry triggered",
      JSON.stringify({ issues: validation.issues.map((i) => i.kind) }),
    );

    nextInput = [
      ...nextInput,
      {
        type: "function_call",
        call_id: toolUseCallId,
        name: ANALYZE_ES_TOOL_NAME_OAI,
        arguments: toolUseArguments,
      },
      {
        type: "function_call_output",
        call_id: toolUseCallId,
        output: JSON.stringify({
          error: "validation_failed",
          kinds: validation.issues.map((i) => i.kind),
        }),
      },
      {
        role: "user",
        content: retryMessage,
      },
    ];
  }

  throw new LLMError(
    "unknown",
    "analyzeInitialOpenAI: unreachable — validation loop exhausted without return",
  );
}

// 統合改修パッケージ (2026-05-25): OpenAI refresh analyze(同期版)。
// Anthropic 経路 `analyzeRefresh` と同形(防衛三段 + 1 回リトライ + サーバ強制の version+1)。
async function analyzeRefreshOpenAI(
  client: OpenAI,
  input: AnalyzeInputBundleRefresh,
): Promise<AnalysisResult> {
  const realUserMessage = buildRefreshUserMessage(input);

  // few-shot prefix は initial と完全に同じ(prompt cache 共有のため)
  let nextInput: ResponseInputItem[] = [
    {
      role: "user",
      content: ANALYZE_FEWSHOT_USER_MESSAGE,
    },
    {
      type: "function_call",
      call_id: FEWSHOT_CALL_ID_OAI,
      name: ANALYZE_ES_TOOL_NAME_OAI,
      arguments: JSON.stringify(ANALYZE_FEWSHOT_ASSISTANT_INPUT),
    },
    {
      type: "function_call_output",
      call_id: FEWSHOT_CALL_ID_OAI,
      output:
        "上記は few-shot 例として受理しました。続けて次の入力に対して analyze_es_refresh_only を呼んでください。interview_questions と es_state_version は出力しないでください(ツールスキーマから除外されています)。",
    },
    {
      role: "user",
      content: realUserMessage,
    },
  ];

  const tools: Tool[] = [ANALYZE_ES_REFRESH_ONLY_TOOL_OAI];

  let retryAttempted = false;
  let totalUsage: TotalUsage = { input: 0, output: 0 };

  for (let attempt = 0; attempt < 2; attempt++) {
    let response: OpenAI.Responses.Response;
    try {
      response = await client.responses.create({
        model: MODEL_REFRESH,
        input: nextInput,
        instructions: ANALYZE_SYSTEM_PROMPT,
        tools,
        tool_choice: {
          type: "function",
          name: ANALYZE_ES_REFRESH_ONLY_TOOL_NAME_OAI,
        },
        max_output_tokens: REFRESH_MAX_OUTPUT_TOKENS,
        reasoning: {
          effort: attempt === 0 ? "medium" : "low",
        },
      });
    } catch (err) {
      if (err instanceof OpenAI.RateLimitError) {
        throw new LLMError("rate_limit", "OpenAI rate limit hit", err);
      }
      if (err instanceof OpenAI.APIConnectionTimeoutError) {
        throw new LLMError("timeout", "OpenAI API connection timeout", err);
      }
      if (err instanceof OpenAI.APIError) {
        throw new LLMError("api_error", `OpenAI API error: ${err.message}`, err);
      }
      throw new LLMError("unknown", "Unknown OpenAI SDK error", err);
    }

    totalUsage = accumulateUsage(totalUsage, response.usage);

    let toolUseArguments: string | null = null;
    let toolUseCallId: string | null = null;
    for (const item of response.output) {
      if (
        item.type === "function_call" &&
        item.name === ANALYZE_ES_REFRESH_ONLY_TOOL_NAME_OAI
      ) {
        toolUseArguments = item.arguments;
        toolUseCallId = item.call_id;
        break;
      }
    }

    if (toolUseArguments === null || toolUseCallId === null) {
      throw new LLMError(
        "api_error",
        "OpenAI が analyze_es_refresh_only ツールを呼ばずに応答を終えました",
        { status: response.status, attempt },
      );
    }

    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(toolUseArguments);
    } catch (err) {
      throw new LLMError(
        "schema_validation",
        "analyze_es_refresh_only arguments were not valid JSON",
        { raw: toolUseArguments, cause: err },
      );
    }

    const validation = validateAnalysisAgainstInput(parsedArgs, input);
    if (validation.ok) {
      return assembleRefreshAnalysisResultOpenAI(input, validation.data, totalUsage);
    }

    if (retryAttempted) {
      console.error(
        "[OpenAIProvider.analyze refresh] validation failed after retry",
        JSON.stringify(
          { issues: validation.issues.slice(0, 5), input_mode: input.mode },
          null,
          2,
        ),
      );
      throw new LLMError(
        "analysis_validation",
        `OpenAI analyze_es_refresh_only output failed validation after retry: ${validation.issues
          .map((i) => i.kind)
          .join(", ")}`,
        { issues: validation.issues },
      );
    }

    retryAttempted = true;
    const retryMessage = buildAnalysisRetryMessage(validation.issues, input);
    console.warn(
      "[OpenAIProvider.analyze refresh] retry triggered",
      JSON.stringify({ issues: validation.issues.map((i) => i.kind) }),
    );

    nextInput = [
      ...nextInput,
      {
        type: "function_call",
        call_id: toolUseCallId,
        name: ANALYZE_ES_REFRESH_ONLY_TOOL_NAME_OAI,
        arguments: toolUseArguments,
      },
      {
        type: "function_call_output",
        call_id: toolUseCallId,
        output: JSON.stringify({
          error: "validation_failed",
          kinds: validation.issues.map((i) => i.kind),
        }),
      },
      {
        role: "user",
        content: retryMessage,
      },
    ];
  }

  throw new LLMError(
    "unknown",
    "analyzeRefreshOpenAI: unreachable — validation loop exhausted without return",
  );
}

// =============================================================================
// 統合改修パッケージ (2026-05-25): OpenAI streaming 経路 — initial / refresh / partial
// =============================================================================
// Anthropic 経路と同じ AnalyzeStreamEvent を発行する。OpenAI Responses API の
// streaming は thinking delta を返さない(出る場合もあるが reasoning model でも
// summarized は標準的に出ない)ため、本実装では started / tool_progress / retry /
// completed / error のみを yield する。
//
// 設計判断:
//  - 非 streaming で 1 リクエストを完結させ、得られた response から output[] を
//    走査して event を「擬似的に」流す。OpenAI Responses API の純 streaming
//    (`stream: true`)は本 dispatch では採用しない(SSE pipeline の単純さを優先、
//    将来 streaming token 進捗を流す改修は v2 で再評価)。
//  - tool_progress event は「arguments の累積文字数」を 1 回だけ流す(SSE client が
//    "generating" stage を確認できる程度の最小限のシグナル、UX 上は十分)。
//  - 防衛三段 Part 3 は同期版と同じ実装(validateAnalysisAgainstInput + 1 回リトライ)。
// =============================================================================

async function* analyzeInitialStreamingOpenAI(
  client: OpenAI,
  input: AnalyzeInput,
): AsyncGenerator<AnalyzeStreamEvent, void, void> {
  if (input.mode !== "initial") {
    yield {
      type: "error",
      kind: "api_error",
      message: "analyzeInitialStreamingOpenAI called with non-initial input",
      stage: "analyze_initial_stream",
    };
    return;
  }

  const realUserMessage = buildInitialUserMessage(input);
  let nextInput: ResponseInputItem[] = [
    { role: "user", content: ANALYZE_FEWSHOT_USER_MESSAGE },
    {
      type: "function_call",
      call_id: FEWSHOT_CALL_ID_OAI,
      name: ANALYZE_ES_TOOL_NAME_OAI,
      arguments: JSON.stringify(ANALYZE_FEWSHOT_ASSISTANT_INPUT),
    },
    {
      type: "function_call_output",
      call_id: FEWSHOT_CALL_ID_OAI,
      output:
        "上記は few-shot 例として受理しました。続けて次の入力に対して analyze_es を呼んでください。",
    },
    { role: "user", content: realUserMessage },
  ];

  const tools: Tool[] = [ANALYZE_ES_TOOL_OAI];

  let retryAttempted = false;
  let totalUsage: TotalUsage = { input: 0, output: 0 };

  for (let attempt = 0; attempt < 2; attempt++) {
    yield {
      type: "started",
      mode: "initial",
      model: MODEL_ANALYZE,
      attempt: attempt + 1,
    };

    let response: OpenAI.Responses.Response;
    try {
      response = await client.responses.create({
        model: MODEL_ANALYZE,
        input: nextInput,
        instructions: ANALYZE_SYSTEM_PROMPT,
        tools,
        tool_choice: {
          type: "function",
          name: ANALYZE_ES_TOOL_NAME_OAI,
        },
        max_output_tokens: ANALYZE_MAX_OUTPUT_TOKENS,
        reasoning: {
          effort: attempt === 0 ? "medium" : "low",
        },
      });
    } catch (err) {
      yield* yieldOpenAIError(err, "analyze_initial_stream");
      return;
    }

    totalUsage = accumulateUsage(totalUsage, response.usage);

    let toolUseArguments: string | null = null;
    let toolUseCallId: string | null = null;
    for (const item of response.output) {
      if (
        item.type === "function_call" &&
        item.name === ANALYZE_ES_TOOL_NAME_OAI
      ) {
        toolUseArguments = item.arguments;
        toolUseCallId = item.call_id;
        break;
      }
    }

    if (toolUseArguments === null || toolUseCallId === null) {
      yield {
        type: "error",
        kind: "api_error",
        message: "OpenAI が analyze_es ツールを呼ばずに応答を終えました",
        stage: "analyze_initial_stream",
      };
      return;
    }

    // tool_progress を 1 回流す(arguments の累積文字数を擬似シグナルとして)
    yield {
      type: "tool_progress",
      cumulativeChars: toolUseArguments.length,
    };

    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(toolUseArguments);
    } catch {
      yield {
        type: "error",
        kind: "schema_validation",
        message: "analyze_es arguments were not valid JSON",
        stage: "analyze_initial_stream",
        retryable: false,
      };
      return;
    }

    const validation = validateAnalysisAgainstInput(parsedArgs, input);
    if (validation.ok) {
      let result: AnalysisResult;
      try {
        result = assembleInitialAnalysisResultOpenAI(
          input,
          validation.data,
          totalUsage,
        );
      } catch (err) {
        if (err instanceof LLMError) {
          yield {
            type: "error",
            kind: err.kind,
            message: err.message,
            stage: "analyze_initial_stream_assemble",
            retryable: false,
          };
          return;
        }
        yield {
          type: "error",
          kind: "unknown",
          message:
            err instanceof Error
              ? err.message
              : "Unknown error during initial assemble",
          stage: "analyze_initial_stream_assemble",
        };
        return;
      }
      yield { type: "completed", kind: "full", result };
      return;
    }

    if (retryAttempted) {
      console.error(
        "[OpenAIProvider.analyzeInitialStream] validation failed after retry",
        JSON.stringify(
          { issues: validation.issues.slice(0, 5), input_mode: input.mode },
          null,
          2,
        ),
      );
      yield {
        type: "error",
        kind: "analysis_validation",
        message: `analyze_es output failed validation after retry: ${validation.issues
          .map((i) => i.kind)
          .join(", ")}`,
        stage: "analyze_initial_stream_validation",
        retryable: false,
      };
      return;
    }

    retryAttempted = true;
    const issueKinds = validation.issues.map((i) => i.kind);
    yield { type: "retry", issueKinds };

    const retryMessage = buildAnalysisRetryMessage(validation.issues, input);
    console.warn(
      "[OpenAIProvider.analyzeInitialStream] retry triggered",
      JSON.stringify({ issues: issueKinds }),
    );

    nextInput = [
      ...nextInput,
      {
        type: "function_call",
        call_id: toolUseCallId,
        name: ANALYZE_ES_TOOL_NAME_OAI,
        arguments: toolUseArguments,
      },
      {
        type: "function_call_output",
        call_id: toolUseCallId,
        output: JSON.stringify({
          error: "validation_failed",
          kinds: issueKinds,
        }),
      },
      {
        role: "user",
        content: retryMessage,
      },
    ];
  }

  yield {
    type: "error",
    kind: "unknown",
    message:
      "analyzeInitialStreamingOpenAI: unreachable — validation loop exhausted without yield",
    stage: "analyze_initial_stream",
  };
}

async function* analyzeRefreshStreamingOpenAI(
  client: OpenAI,
  input: AnalyzeInput,
): AsyncGenerator<AnalyzeStreamEvent, void, void> {
  if (input.mode !== "refresh") {
    yield {
      type: "error",
      kind: "api_error",
      message: "analyzeRefreshStreamingOpenAI called with non-refresh input",
      stage: "analyze_refresh_stream",
    };
    return;
  }

  const realUserMessage = buildRefreshUserMessage(input);
  let nextInput: ResponseInputItem[] = [
    { role: "user", content: ANALYZE_FEWSHOT_USER_MESSAGE },
    {
      type: "function_call",
      call_id: FEWSHOT_CALL_ID_OAI,
      name: ANALYZE_ES_TOOL_NAME_OAI,
      arguments: JSON.stringify(ANALYZE_FEWSHOT_ASSISTANT_INPUT),
    },
    {
      type: "function_call_output",
      call_id: FEWSHOT_CALL_ID_OAI,
      output:
        "上記は few-shot 例として受理しました。続けて次の入力に対して analyze_es_refresh_only を呼んでください。interview_questions と es_state_version は出力しないでください(ツールスキーマから除外されています)。",
    },
    { role: "user", content: realUserMessage },
  ];

  const tools: Tool[] = [ANALYZE_ES_REFRESH_ONLY_TOOL_OAI];

  let retryAttempted = false;
  let totalUsage: TotalUsage = { input: 0, output: 0 };

  for (let attempt = 0; attempt < 2; attempt++) {
    yield {
      type: "started",
      mode: "refresh",
      model: MODEL_REFRESH,
      attempt: attempt + 1,
    };

    let response: OpenAI.Responses.Response;
    try {
      response = await client.responses.create({
        model: MODEL_REFRESH,
        input: nextInput,
        instructions: ANALYZE_SYSTEM_PROMPT,
        tools,
        tool_choice: {
          type: "function",
          name: ANALYZE_ES_REFRESH_ONLY_TOOL_NAME_OAI,
        },
        max_output_tokens: REFRESH_MAX_OUTPUT_TOKENS,
        reasoning: {
          effort: attempt === 0 ? "medium" : "low",
        },
      });
    } catch (err) {
      yield* yieldOpenAIError(err, "analyze_refresh_stream");
      return;
    }

    totalUsage = accumulateUsage(totalUsage, response.usage);

    let toolUseArguments: string | null = null;
    let toolUseCallId: string | null = null;
    for (const item of response.output) {
      if (
        item.type === "function_call" &&
        item.name === ANALYZE_ES_REFRESH_ONLY_TOOL_NAME_OAI
      ) {
        toolUseArguments = item.arguments;
        toolUseCallId = item.call_id;
        break;
      }
    }

    if (toolUseArguments === null || toolUseCallId === null) {
      yield {
        type: "error",
        kind: "api_error",
        message:
          "OpenAI が analyze_es_refresh_only ツールを呼ばずに応答を終えました",
        stage: "analyze_refresh_stream",
      };
      return;
    }

    yield {
      type: "tool_progress",
      cumulativeChars: toolUseArguments.length,
    };

    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(toolUseArguments);
    } catch {
      yield {
        type: "error",
        kind: "schema_validation",
        message: "analyze_es_refresh_only arguments were not valid JSON",
        stage: "analyze_refresh_stream",
        retryable: false,
      };
      return;
    }

    const validation = validateAnalysisAgainstInput(parsedArgs, input);
    if (validation.ok) {
      let result: AnalysisResult;
      try {
        result = assembleRefreshAnalysisResultOpenAI(
          input,
          validation.data,
          totalUsage,
        );
      } catch (err) {
        if (err instanceof LLMError) {
          yield {
            type: "error",
            kind: err.kind,
            message: err.message,
            stage: "analyze_refresh_stream_assemble",
            retryable: false,
          };
          return;
        }
        yield {
          type: "error",
          kind: "unknown",
          message:
            err instanceof Error
              ? err.message
              : "Unknown error during refresh assemble",
          stage: "analyze_refresh_stream_assemble",
        };
        return;
      }
      yield { type: "completed", kind: "full", result };
      return;
    }

    if (retryAttempted) {
      console.error(
        "[OpenAIProvider.analyzeRefreshStream] validation failed after retry",
        JSON.stringify(
          { issues: validation.issues.slice(0, 5), input_mode: input.mode },
          null,
          2,
        ),
      );
      yield {
        type: "error",
        kind: "analysis_validation",
        message: `analyze_es_refresh_only output failed validation after retry: ${validation.issues
          .map((i) => i.kind)
          .join(", ")}`,
        stage: "analyze_refresh_stream_validation",
        retryable: false,
      };
      return;
    }

    retryAttempted = true;
    const issueKinds = validation.issues.map((i) => i.kind);
    yield { type: "retry", issueKinds };

    const retryMessage = buildAnalysisRetryMessage(validation.issues, input);
    console.warn(
      "[OpenAIProvider.analyzeRefreshStream] retry triggered",
      JSON.stringify({ issues: issueKinds }),
    );

    nextInput = [
      ...nextInput,
      {
        type: "function_call",
        call_id: toolUseCallId,
        name: ANALYZE_ES_REFRESH_ONLY_TOOL_NAME_OAI,
        arguments: toolUseArguments,
      },
      {
        type: "function_call_output",
        call_id: toolUseCallId,
        output: JSON.stringify({
          error: "validation_failed",
          kinds: issueKinds,
        }),
      },
      {
        role: "user",
        content: retryMessage,
      },
    ];
  }

  yield {
    type: "error",
    kind: "unknown",
    message:
      "analyzeRefreshStreamingOpenAI: unreachable — validation loop exhausted without yield",
    stage: "analyze_refresh_stream",
  };
}

async function* analyzePartialStreamingOpenAI(
  client: OpenAI,
  input: AnalyzeInput,
): AsyncGenerator<AnalyzeStreamEvent, void, void> {
  if (input.mode !== "partial") {
    yield {
      type: "error",
      kind: "api_error",
      message: "analyzePartialStreamingOpenAI called with non-partial input",
      stage: "analyze_partial_stream",
    };
    return;
  }

  // 統合改修パッケージ (2026-05-25): user メッセージは 2 ブロック構造のまま渡す。
  // OpenAI Responses API は明示的な cache_control を持たないが、不変ブロックを先頭に
  // 置くことで自動 prompt cache の前方プレフィックスとして 1024 token 以上をヒットさせる。
  const invariantText = buildPartialInvariantBlock(input);
  const variableText = buildPartialVariableBlock(input);
  const fullUserMessage = `${invariantText}\n\n${variableText}`;

  let nextInput: ResponseInputItem[] = [
    { role: "user", content: ANALYZE_FEWSHOT_USER_MESSAGE },
    {
      type: "function_call",
      call_id: FEWSHOT_CALL_ID_OAI,
      name: ANALYZE_ES_TOOL_NAME_OAI,
      arguments: JSON.stringify(ANALYZE_FEWSHOT_ASSISTANT_INPUT),
    },
    {
      type: "function_call_output",
      call_id: FEWSHOT_CALL_ID_OAI,
      output:
        "上記は few-shot 例として受理しました。続けて次の入力に対して analyze_es_partial_refresh を呼んでください。interview_questions と es_state_version は出力しないでください(ツールスキーマから除外されています)。",
    },
    { role: "user", content: fullUserMessage },
  ];

  const tools: Tool[] = [ANALYZE_ES_PARTIAL_REFRESH_TOOL_OAI];

  let retryAttempted = false;
  let totalUsage: TotalUsage = { input: 0, output: 0 };

  for (let attempt = 0; attempt < 2; attempt++) {
    yield {
      type: "started",
      mode: "partial",
      model: MODEL_REFRESH,
      attempt: attempt + 1,
    };

    let response: OpenAI.Responses.Response;
    try {
      response = await client.responses.create({
        model: MODEL_REFRESH,
        input: nextInput,
        instructions: ANALYZE_SYSTEM_PROMPT,
        tools,
        tool_choice: {
          type: "function",
          name: ANALYZE_ES_PARTIAL_REFRESH_TOOL_NAME_OAI,
        },
        max_output_tokens: PARTIAL_MAX_OUTPUT_TOKENS,
        reasoning: {
          effort: attempt === 0 ? "medium" : "low",
        },
      });
    } catch (err) {
      yield* yieldOpenAIError(err, "analyze_partial_stream");
      return;
    }

    totalUsage = accumulateUsage(totalUsage, response.usage);

    let toolUseArguments: string | null = null;
    let toolUseCallId: string | null = null;
    for (const item of response.output) {
      if (
        item.type === "function_call" &&
        item.name === ANALYZE_ES_PARTIAL_REFRESH_TOOL_NAME_OAI
      ) {
        toolUseArguments = item.arguments;
        toolUseCallId = item.call_id;
        break;
      }
    }

    if (toolUseArguments === null || toolUseCallId === null) {
      yield {
        type: "error",
        kind: "api_error",
        message:
          "OpenAI が analyze_es_partial_refresh ツールを呼ばずに応答を終えました",
        stage: "analyze_partial_stream",
      };
      return;
    }

    yield {
      type: "tool_progress",
      cumulativeChars: toolUseArguments.length,
    };

    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(toolUseArguments);
    } catch {
      yield {
        type: "error",
        kind: "schema_validation",
        message: "analyze_es_partial_refresh arguments were not valid JSON",
        stage: "analyze_partial_stream",
        retryable: false,
      };
      return;
    }

    const validation = validateAnalysisAgainstInput(parsedArgs, input);
    if (validation.ok) {
      let result: PartialAnalysisResult;
      try {
        result = assemblePartialAnalysisResultOpenAI(
          input,
          validation.data,
          totalUsage,
        );
      } catch (err) {
        if (err instanceof LLMError) {
          yield {
            type: "error",
            kind: err.kind,
            message: err.message,
            stage: "analyze_partial_stream_assemble",
            retryable: false,
          };
          return;
        }
        yield {
          type: "error",
          kind: "unknown",
          message:
            err instanceof Error
              ? err.message
              : "Unknown error during partial assemble",
          stage: "analyze_partial_stream_assemble",
        };
        return;
      }
      yield { type: "completed", kind: "partial", result };
      return;
    }

    if (retryAttempted) {
      console.error(
        "[OpenAIProvider.analyzePartialStream] validation failed after retry",
        JSON.stringify(
          { issues: validation.issues.slice(0, 5), input_mode: input.mode },
          null,
          2,
        ),
      );
      yield {
        type: "error",
        kind: "analysis_validation",
        message: `analyze_es_partial_refresh output failed validation after retry: ${validation.issues
          .map((i) => i.kind)
          .join(", ")}`,
        stage: "analyze_partial_stream_validation",
        retryable: false,
      };
      return;
    }

    retryAttempted = true;
    const issueKinds = validation.issues.map((i) => i.kind);
    yield { type: "retry", issueKinds };

    const retryMessage = buildAnalysisRetryMessage(validation.issues, input);
    console.warn(
      "[OpenAIProvider.analyzePartialStream] retry triggered",
      JSON.stringify({ issues: issueKinds }),
    );

    nextInput = [
      ...nextInput,
      {
        type: "function_call",
        call_id: toolUseCallId,
        name: ANALYZE_ES_PARTIAL_REFRESH_TOOL_NAME_OAI,
        arguments: toolUseArguments,
      },
      {
        type: "function_call_output",
        call_id: toolUseCallId,
        output: JSON.stringify({
          error: "validation_failed",
          kinds: issueKinds,
        }),
      },
      {
        role: "user",
        content: retryMessage,
      },
    ];
  }

  yield {
    type: "error",
    kind: "unknown",
    message:
      "analyzePartialStreamingOpenAI: unreachable — validation loop exhausted without yield",
    stage: "analyze_partial_stream",
  };
}

// =============================================================================
// 統合改修パッケージ (2026-05-25): /api/interview の OpenAI 実装
// =============================================================================
// 防衛三段は Anthropic 経路 `generateInterviewImpl` と同形:
//   Part 1 (モデル品質): GPT-5.4 full
//   Part 2 (動的承認): buildInterviewUserMessage(企業要約 evidence を文脈に同梱)
//   Part 3 (Zod 検証 + 1 回リトライ): validateInterviewOutput + buildInterviewRetryMessage
async function generateInterviewOpenAI(
  client: OpenAI,
  input: InterviewInputBundle,
): Promise<InterviewQuestions> {
  const realUserMessage = buildInterviewUserMessage(input);

  // few-shot prefix は initial / refresh / partial と同じ(prompt cache 共有)
  let nextInput: ResponseInputItem[] = [
    { role: "user", content: ANALYZE_FEWSHOT_USER_MESSAGE },
    {
      type: "function_call",
      call_id: FEWSHOT_CALL_ID_OAI,
      name: ANALYZE_ES_TOOL_NAME_OAI,
      arguments: JSON.stringify(ANALYZE_FEWSHOT_ASSISTANT_INPUT),
    },
    {
      type: "function_call_output",
      call_id: FEWSHOT_CALL_ID_OAI,
      output:
        "上記は few-shot 例として受理しました。続けて次の入力に対して generate_interview_questions を呼んでください。suggestions / overall_assessment / generated_at_es_version / is_stale は出力しないでください(ツールスキーマから除外されています)。",
    },
    { role: "user", content: realUserMessage },
  ];

  const tools: Tool[] = [GENERATE_INTERVIEW_QUESTIONS_TOOL_OAI];

  let retryAttempted = false;
  let totalUsage: TotalUsage = { input: 0, output: 0 };

  for (let attempt = 0; attempt < 2; attempt++) {
    let response: OpenAI.Responses.Response;
    try {
      response = await client.responses.create({
        model: MODEL_INTERVIEW,
        input: nextInput,
        instructions: ANALYZE_SYSTEM_PROMPT,
        tools,
        tool_choice: {
          type: "function",
          name: GENERATE_INTERVIEW_QUESTIONS_TOOL_NAME_OAI,
        },
        max_output_tokens: INTERVIEW_MAX_OUTPUT_TOKENS,
        reasoning: {
          effort: attempt === 0 ? "medium" : "low",
        },
      });
    } catch (err) {
      if (err instanceof OpenAI.RateLimitError) {
        throw new LLMError("rate_limit", "OpenAI rate limit hit", err);
      }
      if (err instanceof OpenAI.APIConnectionTimeoutError) {
        throw new LLMError("timeout", "OpenAI API connection timeout", err);
      }
      if (err instanceof OpenAI.APIError) {
        throw new LLMError("api_error", `OpenAI API error: ${err.message}`, err);
      }
      throw new LLMError("unknown", "Unknown OpenAI SDK error", err);
    }

    totalUsage = accumulateUsage(totalUsage, response.usage);

    let toolUseArguments: string | null = null;
    let toolUseCallId: string | null = null;
    for (const item of response.output) {
      if (
        item.type === "function_call" &&
        item.name === GENERATE_INTERVIEW_QUESTIONS_TOOL_NAME_OAI
      ) {
        toolUseArguments = item.arguments;
        toolUseCallId = item.call_id;
        break;
      }
    }

    if (toolUseArguments === null || toolUseCallId === null) {
      throw new LLMError(
        "api_error",
        "OpenAI が generate_interview_questions ツールを呼ばずに応答を終えました",
        { status: response.status, attempt },
      );
    }

    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(toolUseArguments);
    } catch (err) {
      throw new LLMError(
        "schema_validation",
        "generate_interview_questions arguments were not valid JSON",
        { raw: toolUseArguments, cause: err },
      );
    }

    const validation = validateInterviewOutput(parsedArgs, input);
    if (validation.ok) {
      return assembleInterviewResultOpenAI(input, validation.data, totalUsage);
    }

    if (retryAttempted) {
      console.error(
        "[OpenAIProvider.generateInterview] validation failed after retry",
        JSON.stringify({ issues: validation.issues.slice(0, 5) }, null, 2),
      );
      throw new LLMError(
        "analysis_validation",
        `generate_interview_questions output failed validation after retry: ${validation.issues
          .map((i) => i.kind)
          .join(", ")}`,
        { issues: validation.issues },
      );
    }

    retryAttempted = true;
    const retryMessage = buildInterviewRetryMessage(validation.issues);
    console.warn(
      "[OpenAIProvider.generateInterview] retry triggered",
      JSON.stringify({ issues: validation.issues.map((i) => i.kind) }),
    );

    nextInput = [
      ...nextInput,
      {
        type: "function_call",
        call_id: toolUseCallId,
        name: GENERATE_INTERVIEW_QUESTIONS_TOOL_NAME_OAI,
        arguments: toolUseArguments,
      },
      {
        type: "function_call_output",
        call_id: toolUseCallId,
        output: JSON.stringify({
          error: "validation_failed",
          kinds: validation.issues.map((i) => i.kind),
        }),
      },
      {
        role: "user",
        content: retryMessage,
      },
    ];
  }

  throw new LLMError(
    "unknown",
    "generateInterviewOpenAI: unreachable — validation loop exhausted without return",
  );
}

// =============================================================================
// AnalysisResult / PartialAnalysisResult / InterviewQuestions 組み立て(OpenAI 用)
// =============================================================================
// Anthropic の assembleAnalysisResultWithModel / assembleRefreshAnalysisResult /
// assemblePartialAnalysisResult / assembleInterviewResult と意味的に同形だが、
// model 名は MODEL_ANALYZE / MODEL_REFRESH / MODEL_INTERVIEW("gpt-5.4")で固定。
// Anthropic 側の helper を import せず本ファイル内で完結させるのは、循環依存
// (provider 間の helper 共有)を避けるため。

function assembleInitialAnalysisResultOpenAI(
  input: AnalyzeInput,
  ai: AIInitialAnalysisOutput,
  usage: TotalUsage,
): AnalysisResult {
  if (input.mode !== "initial") {
    throw new LLMError(
      "api_error",
      "assembleInitialAnalysisResultOpenAI called with non-initial input",
    );
  }

  const { resolved, missing } = resolveOriginalSpans(
    input.es_body,
    ai.suggestions as AISuggestion[],
  );

  if (missing.length > 0) {
    throw new LLMError(
      "analysis_validation",
      `${missing.length} suggestion(s) have original text not present in es_body (post-validation anchor failure)`,
      { missing_ids: missing.map((m) => m.id) },
    );
  }

  const metadata: AnalysisMetadata = {
    generated_at: new Date().toISOString(),
    model: MODEL_ANALYZE,
    trigger: "initial",
    token_usage: usage,
  };

  return {
    es_state_version: input.current_es_version,
    overall_assessment: ai.overall_assessment,
    suggestions: resolved,
    interview_questions: {
      ...ai.interview_questions,
      generated_at_es_version: input.current_es_version,
      is_stale: false,
    },
    metadata,
  };
}

function assembleRefreshAnalysisResultOpenAI(
  input: AnalyzeInputBundleRefresh,
  ai: AIRefreshAnalysisOutput,
  usage: TotalUsage,
): AnalysisResult {
  const { resolved, missing } = resolveOriginalSpans(
    input.es_body,
    ai.suggestions as AISuggestion[],
  );

  if (missing.length > 0) {
    throw new LLMError(
      "analysis_validation",
      `${missing.length} suggestion(s) have original text not present in es_body (post-validation anchor failure)`,
      { missing_ids: missing.map((m) => m.id) },
    );
  }

  const metadata: AnalysisMetadata = {
    generated_at: new Date().toISOString(),
    model: MODEL_REFRESH,
    trigger: inferRefreshTrigger(input.action_history),
    token_usage: usage,
  };

  return {
    es_state_version: input.current_es_version + 1,
    overall_assessment: ai.overall_assessment,
    suggestions: resolved,
    // refresh では interview_questions を返さない(/api/interview で別途生成する設計)
    metadata,
  };
}

function assemblePartialAnalysisResultOpenAI(
  input: AnalyzeInputBundlePartial,
  ai: AIPartialAnalysisOutput,
  usage: TotalUsage,
): PartialAnalysisResult {
  // updated / added それぞれ resolveOriginalSpans → display_priority 付与
  const updatedResolve = resolveOriginalSpans(
    input.es_body,
    ai.updated as AISuggestion[],
  );
  const addedResolve = resolveOriginalSpans(
    input.es_body,
    ai.added as AISuggestion[],
  );

  const allMissing = [...updatedResolve.missing, ...addedResolve.missing];
  if (allMissing.length > 0) {
    throw new LLMError(
      "analysis_validation",
      `${allMissing.length} suggestion(s) have original text not present in es_body (partial post-validation anchor failure)`,
      { missing_ids: allMissing.map((m) => m.id) },
    );
  }

  // display_priority 付与は acceptedSuggestionIds を引数に渡す
  const acceptedIds = input.accepted_suggestion_ids;
  const updatedWithPriority = updatedResolve.resolved.map((s) =>
    assignDisplayPriority(s, acceptedIds),
  );
  const addedWithPriority = addedResolve.resolved.map((s) =>
    assignDisplayPriority(s, acceptedIds),
  );

  const metadata: AnalysisMetadata = {
    generated_at: new Date().toISOString(),
    model: MODEL_REFRESH,
    trigger: inferPartialTrigger(input.action_history),
    token_usage: usage,
  };

  return {
    es_state_version: input.current_es_version + 1,
    updated: updatedWithPriority,
    deleted: ai.deleted,
    added: addedWithPriority,
    overall_assessment: ai.overall_assessment,
    metadata,
  };
}

function assembleInterviewResultOpenAI(
  input: InterviewInputBundle,
  ai: { questions: InterviewQuestions["questions"] },
  _usage: TotalUsage,
): InterviewQuestions {
  return {
    generated_at_es_version: input.current_es_version,
    is_stale: false,
    questions: ai.questions,
  };
}

// function_call の arguments(JSON 文字列)から url を取り出す。
function extractUrlArg(rawArgs: string): string {
  try {
    const parsed = JSON.parse(rawArgs);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "url" in parsed &&
      typeof (parsed as { url: unknown }).url === "string"
    ) {
      return (parsed as { url: string }).url;
    }
  } catch {
    // 落ちたら空文字を返す: extractFromUrl 側が invalid_url で返してログに残る
  }
  return "";
}

// web_search_call の action から query 文字列を抽出。
// action は Search | OpenPage | Find の判別ユニオン。Search の queries[] の先頭か、
// 旧フィールド query を採用。OpenPage / Find は URL or pattern を query 相当として記録。
function extractSearchQuery(
  item: Extract<ResponseOutputItem, { type: "web_search_call" }>,
): string {
  const action = item.action;
  if (action.type === "search") {
    if (Array.isArray(action.queries) && action.queries.length > 0) {
      return action.queries.join(" / ");
    }
    return action.query ?? "";
  }
  if (action.type === "open_page") {
    return `open_page: ${action.url ?? ""}`;
  }
  if (action.type === "find_in_page") {
    return `find_in_page: ${action.pattern} @ ${action.url}`;
  }
  return "";
}
