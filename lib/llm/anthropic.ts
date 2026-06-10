import Anthropic from "@anthropic-ai/sdk";
// 提出後改善 #3 準備 (2026-06-09): completed event の optional 計測メタ型(additive)。
import type { CaptureMeta } from "./capture_meta";
import {
  type CompanySummary,
  type ResearchInputSource,
  type ResearchLogEntry,
} from "../schema/company";
import {
  buildPartialInvariantBlock,
  buildPartialVariableBlock,
  inferPartialTrigger,
} from "../prompts/partial_refresh";
import {
  ANALYZE_ES_PARTIAL_REFRESH_TOOL,
  ANALYZE_ES_PARTIAL_REFRESH_TOOL_NAME,
} from "../tools/analyze_es_partial_refresh";
import type {
  AIPartialAnalysisOutput,
  PartialAnalysisResult,
} from "../schema/analysis";
import type { AnalyzeInputBundlePartial } from "../schema/input";
import { assignDisplayPriority } from "./analyze_helpers";
import {
  RESEARCH_AGENT_SYSTEM_PROMPT,
  buildInitialResearchPrompt,
} from "../prompts/research";
import {
  RESEARCH_FREETEXT_SYSTEM_PROMPT,
  buildFreetextResearchPrompt,
} from "../prompts/research_freetext";
import {
  FETCH_PAGE_TOOL,
  FETCH_PAGE_TOOL_NAME,
  SUBMIT_SUMMARY_TOOL,
  SUBMIT_SUMMARY_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WEB_SEARCH_TOOL_TYPE,
} from "../tools/research_agent";
import {
  SUBMIT_FREETEXT_SUMMARY_TOOL,
  SUBMIT_FREETEXT_SUMMARY_TOOL_NAME,
} from "../tools/research_freetext";
import { extractFromUrl } from "../utils/url_extract";
import { cachedSystem, cachedUserContext, EPHEMERAL_CACHE } from "./cache";
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
import {
  type AnalysisResult,
  type AnalysisMetadata,
  type AIInitialAnalysisOutput,
  type AIRefreshAnalysisOutput,
  type AIInterviewOutput,
} from "../schema/analysis";
import type { InterviewQuestions } from "../schema/interview";
import type { AISuggestion } from "../schema/suggestion";
import type {
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
import { buildInterviewUserMessage } from "../prompts/interview";
import { ANALYZE_ES_TOOL, ANALYZE_ES_TOOL_NAME } from "../tools/analyze_es";
import {
  ANALYZE_ES_REFRESH_ONLY_TOOL,
  ANALYZE_ES_REFRESH_ONLY_TOOL_NAME,
} from "../tools/analyze_es_refresh_only";
import {
  GENERATE_INTERVIEW_QUESTIONS_TOOL,
  GENERATE_INTERVIEW_QUESTIONS_TOOL_NAME,
} from "../tools/generate_interview_questions";
import {
  buildAnalysisRetryMessage,
  validateAnalysisAgainstInput,
} from "./analyze_helpers";
import {
  buildInterviewRetryMessage,
  validateInterviewOutput,
} from "./interview_helpers";
import { resolveOriginalSpans } from "../utils/es_anchor";

// DECISION: モデル名は1ヶ所に集約。Phase C で initial=Opus / refresh+interview=Sonnet で使い分け
export const MODEL_OPUS = "claude-opus-4-7";
export const MODEL_SONNET = "claude-sonnet-4-6";

// Day 6 (2026-05-24) LLM 比較ベンチで Opus 4.7 経路の analyze を再現するための
// adaptive thinking 設定。Phase G 以前の本番設定と同等。Sonnet 切替で削除済の
// `THINKING_CONFIG` を Opus ベンチ専用に再定義する(initial 経路の Sonnet には
// 適用しない、Opus 専用関数 analyzeInitialOpus / analyzeInitialStreamingOpus でのみ使用)。
//
// adaptive を採用する理由:
//   - dispatch §A-B(B-2)の指示通り、Opus 経路は「adaptive thinking + tool_choice 未指定」
//     の構成。`enabled` だと budget_tokens を明示する必要があり、ベンチで Opus の自己判断
//     に任せたいので `adaptive` を選ぶ
//   - display は default(summarized)に任せる(thinking_delta が SSE 経路で流れる、本ベンチでは
//     非 streaming + 同期版だけだが将来 streaming で thinking を観察したい場合に備える)
const OPUS_ADAPTIVE_THINKING: Anthropic.Messages.ThinkingConfigParam = {
  type: "adaptive",
};

// DECISION [2026-05-22 セッション3]: エージェント上限を 15/5/10 → 5/3/5 に大幅削減。
// セッション2 の数値は「網羅性優先」だったが、実機では Mercari 37分タイムアウト・
// 三菱商事 33分接続エラーで非実用的だった。Mercari 完走実績(5反復 / search 1〜2 /
// fetch 5 で 18件 evidence)から、5/3/5 でも品質は確保できると判断。
// この数値は OpenAI 版と一致させる(Day 6 の LLM 比較で公平な対照群にするため)。
const MAX_AGENT_ITERATIONS = 5;
const WEB_SEARCH_MAX_USES = 3;
const FETCH_PAGE_MAX_USES = 5;

// DECISION [2026-05-22 セッション4]: Anthropic 版は Sonnet 4.6 のまま維持(対照群)。
// Day 6 の LLM 比較で「同じ防衛設計の上で、モデルだけ違う」状態を作るため、Part B/C/D の
// ハードニング設計だけ OpenAI 版と一致させ、モデル昇格は OpenAI 側のみで実施する。

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  private client: Anthropic;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new LLMError("api_error", "ANTHROPIC_API_KEY is not set");
    }
    this.client = new Anthropic({ apiKey: key });
  }

  async researchCompany(input: ResearchInputSource): Promise<CompanySummary> {
    // Phase E 拡張(2026-05-23): 自由テキスト経路はエージェントループ無しで LLM 1 回呼び出し。
    // web_search / fetch_page を使わず、submit_summary 単発で CompanySummary を整形する。
    // 防衛三段の自由テキスト版を validateFreetextSummary + buildFreetextRetryMessage が担う。
    if (input.type === "freetext") {
      return this.researchFreetext(input.value);
    }

    const startedAt = new Date().toISOString();
    const researchLog: ResearchLogEntry[] = [];

    // セッション3 で導入: URL 入力時はサーバー側で先に extractFromUrl を回し、本文を初期
    // コンテキストとして user メッセージに埋め込む。これで初手 fetch_page のラウンドトリップ
    // (2〜10秒)とそれを判断する LLM ターン(数秒)を節約できる。
    const initialContext = await buildInitialContext(input, researchLog);

    // セッション4 ハードニング: 初期 user メッセージに「承認済みURLリスト」を同梱して、
    // 1ターン目から source_url の選択肢を構造で縛る。OpenAI 版と意味的に同一の処理。
    const initialUserPrompt = [
      buildInitialResearchPrompt(input),
      renderInitialContextBlock(initialContext),
      "",
      buildApprovedListMessage(getApprovedUrls(researchLog)),
    ]
      .filter((s) => s.length > 0)
      .join("\n");

    const messages: Anthropic.Messages.MessageParam[] = [
      { role: "user", content: initialUserPrompt },
    ];

    // tools 配列: web_search(Anthropic ネイティブ、max_uses で SDK 側強制)+
    //              fetch_page(カスタム、上限はループ側で is_error で返して強制)+
    //              submit_summary(終端、cache_control で system+tools をキャッシュ対象に)
    const tools: Anthropic.Messages.ToolUnion[] = [
      {
        type: WEB_SEARCH_TOOL_TYPE,
        name: WEB_SEARCH_TOOL_NAME,
        max_uses: WEB_SEARCH_MAX_USES,
        // allowed_callers を ['direct'] に明示。code_execution 経由の呼び出しを禁止して
        // container_id 不要にする(code_execution_20260120 等を tools に入れない構成)。
        allowed_callers: ["direct"],
      },
      FETCH_PAGE_TOOL,
      { ...SUBMIT_SUMMARY_TOOL, cache_control: EPHEMERAL_CACHE },
    ];
    let fetchPageCalls = 0;
    // セッション4 ハードニング(Part D): submit_summary の検証失敗時に1回だけリトライ。
    let retryAttempted = false;

    for (let iteration = 1; iteration <= MAX_AGENT_ITERATIONS; iteration++) {
      let response: Anthropic.Messages.Message;
      try {
        response = await this.client.messages.create({
          model: MODEL_SONNET,
          // evidence×20 + 各 source_quote 最大500字 + claim 最大300字 + 他フィールドで
          // 最終 submit_summary は ~12K トークン消費しうる。8192 では truncation が観測された
          // (テスト企業 ES で evidence が途中で切れて string として解釈される事故)。
          // 16384 で安全マージン。各反復で実消費分のみ計上されるので反復オーバーヘッドは小さい。
          max_tokens: 16384,
          system: cachedSystem(RESEARCH_AGENT_SYSTEM_PROMPT),
          tools,
          messages,
        });
      } catch (err) {
        if (err instanceof Anthropic.RateLimitError) {
          throw new LLMError("rate_limit", "Anthropic rate limit hit", err);
        }
        if (err instanceof Anthropic.APIError) {
          throw new LLMError("api_error", `Anthropic API error: ${err.message}`, err);
        }
        throw new LLMError("unknown", "Unknown Anthropic SDK error", err);
      }

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      let submittedInput: unknown = null;
      let submitToolUseId: string | null = null;

      for (const block of response.content) {
        if (block.type === "server_tool_use" && block.name === "web_search") {
          const query = extractSearchQuery(block.input);
          researchLog.push({
            type: "search",
            query,
            results_count: 0, // 直後の web_search_tool_result で更新
            timestamp: new Date().toISOString(),
          });
        } else if (block.type === "web_search_tool_result") {
          // 直近の search ログに結果件数を反映(逆順走査で最後のものを更新)
          for (let i = researchLog.length - 1; i >= 0; i--) {
            const entry = researchLog[i];
            if (entry.type === "search" && entry.results_count === 0) {
              entry.results_count = Array.isArray(block.content)
                ? block.content.length
                : 0;
              break;
            }
          }
        } else if (block.type === "tool_use" && block.name === FETCH_PAGE_TOOL_NAME) {
          const url =
            typeof block.input === "object" &&
            block.input !== null &&
            "url" in block.input
              ? String((block.input as { url: unknown }).url)
              : "";
          fetchPageCalls++;

          if (fetchPageCalls > FETCH_PAGE_MAX_USES) {
            // 上限超過: 実行せず、エージェントに「これ以上 fetch しないで submit_summary を呼べ」と返す
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify({
                error: "max_uses_exceeded",
                message: `fetch_page の上限 ${FETCH_PAGE_MAX_USES} 回に達しました。これ以上の URL 取得は禁止です。手持ちの情報で submit_summary を呼んでください。`,
              }),
              is_error: true,
            });
            continue;
          }

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

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result.ok
              ? `[Title: ${result.data.title ?? "unknown"}]\n[URL: ${url}]\n\n${result.data.text}`
              : JSON.stringify({
                  error: result.error.kind,
                  message: result.error.message,
                }),
            is_error: !result.ok,
          });
        } else if (
          block.type === "tool_use" &&
          block.name === SUBMIT_SUMMARY_TOOL_NAME
        ) {
          submittedInput = block.input;
          submitToolUseId = block.id;
          // submit_summary が呼ばれたらこの反復で終了。残りブロックは無視
          break;
        }
      }

      if (submittedInput !== null) {
        const finishedAt = new Date().toISOString();
        // セッション4 ハードニング: synthesize は成功時のみ最終 log に反映するため、
        // tentative log を作って validate に渡す(リトライ時はその iter の synthesize を残さない)。
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
            `[AnthropicProvider.researchCompany] retry triggered (${validation.error.kind})`,
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

          // assistant 応答(submit_summary を含む tool_use ブロックを含む)を会話に積み、
          // 続けて tool_result(is_error: true で失敗を伝える)+ text(具体的な修正指示)を
          // 1つの user メッセージで返す。Anthropic は tool_use と対応する tool_result の
          // 整合性を要求するため、submit_summary の tool_use_id に必ず応答する必要がある。
          messages.push({
            role: "assistant",
            content: response.content as unknown as Anthropic.Messages.ContentBlockParam[],
          });
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: submitToolUseId!,
                content: JSON.stringify({
                  error: "validation_failed",
                  kind: validation.error.kind,
                  message: validation.error.message,
                }),
                is_error: true,
              },
              { type: "text", text: retryMessage },
            ],
          });

          // リトライは新規 iteration を消費しない(OpenAI 版と同じ規約)
          iteration--;
          continue;
        }

        console.error(
          "[AnthropicProvider.researchCompany] validation failed after retry",
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

      // 継続: assistant 応答 + (tool_results + 動的承認済みURLリスト) を会話に積む。
      // 動的注入を毎ターン入れることで、submit_summary を呼ぶ直前に必ず最新の承認 URL
      // が AI のコンテキストに現れる。これが捏造を構造で抑止する Part B の核心。
      messages.push({
        role: "assistant",
        content: response.content as unknown as Anthropic.Messages.ContentBlockParam[],
      });
      const approvedUrlsNow = getApprovedUrls(researchLog);
      const userContent: Anthropic.Messages.ContentBlockParam[] = [
        ...toolResults,
        { type: "text", text: buildApprovedListMessage(approvedUrlsNow) },
      ];
      messages.push({ role: "user", content: userContent });

      // 終了判定: end_turn かつ submit されていない → 異常終了
      if (response.stop_reason === "end_turn") {
        throw new LLMError(
          "agent_no_submission",
          "エージェントが submit_summary を呼ばずに end_turn しました",
          { iteration, stop_reason: response.stop_reason },
        );
      }
      // refusal は明示的な拒否。そのまま投げる
      if (response.stop_reason === "refusal") {
        throw new LLMError(
          "api_error",
          "エージェントが応答を拒否しました(refusal)",
          { iteration },
        );
      }
      // tool_use / pause_turn / max_tokens は次の反復で続行
    }

    throw new LLMError(
      "agent_max_iterations",
      `${MAX_AGENT_ITERATIONS} 回の反復で submit_summary に到達しませんでした`,
      { iterations: MAX_AGENT_ITERATIONS, log_entries: researchLog.length },
    );
  }

  // Phase E 拡張(2026-05-23): 自由テキスト経路。エージェントループ無しで submit_summary 単発呼び出し。
  // 防衛三段の自由テキスト版:
  //   Part 1 (モデル品質): Sonnet 4.6(URL/name 経路の Anthropic 側と同モデル、対照群維持)
  //   Part 2 (構造制約): system prompt で「source_url = "user-input" 固定」「source_quote は
  //     自由テキスト内 verbatim」を明示、ツール定義(SUBMIT_FREETEXT_SUMMARY_TOOL)で経路を分離
  //   Part 3 (Zod 検証 + 1回リトライ): validateFreetextSummary + buildFreetextRetryMessage
  private async researchFreetext(freetext: string): Promise<CompanySummary> {
    const startedAt = new Date().toISOString();
    // research_log は synthesize 1 件のみ(外部 fetch なし、search なし)。
    // 自由テキスト経路では「LLM がどのページを見たか」の透明性は存在しない代わりに、
    // 入力された自由テキスト自体が透明性の源泉になる(source_quote が verbatim 一致するため)。
    const researchLog: ResearchLogEntry[] = [];
    const sourceInput: ResearchInputSource = {
      type: "freetext",
      value: freetext,
    };

    const tools: Anthropic.Messages.ToolUnion[] = [
      { ...SUBMIT_FREETEXT_SUMMARY_TOOL, cache_control: EPHEMERAL_CACHE },
    ];

    const initialUserPrompt = buildFreetextResearchPrompt(freetext);
    const messages: Anthropic.Messages.MessageParam[] = [
      { role: "user", content: initialUserPrompt },
    ];

    // 自由テキスト経路は本質的に「単発呼び出し + 検証失敗時 1 回リトライ」のため、最大 2 回
    // attempt するループ。URL/name 経路の MAX_AGENT_ITERATIONS=5 とは別ロジック。
    let retryAttempted = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Anthropic.Messages.Message;
      try {
        response = await this.client.messages.create({
          model: MODEL_SONNET,
          // freetext は外部取得無しで evidence を組み立てるだけなので、URL/name 経路の
          // 16K より小さくても足りる(典型 5〜10 件 evidence)。ただし安全側で 12K 確保。
          max_tokens: 12288,
          system: cachedSystem(RESEARCH_FREETEXT_SYSTEM_PROMPT),
          tools,
          messages,
        });
      } catch (err) {
        if (err instanceof Anthropic.RateLimitError) {
          throw new LLMError("rate_limit", "Anthropic rate limit hit", err);
        }
        if (err instanceof Anthropic.APIError) {
          throw new LLMError(
            "api_error",
            `Anthropic API error: ${err.message}`,
            err,
          );
        }
        throw new LLMError("unknown", "Unknown Anthropic SDK error", err);
      }

      // submit_summary を探す
      const submitBlock = response.content.find(
        (b): b is Anthropic.Messages.ToolUseBlock =>
          b.type === "tool_use" &&
          b.name === SUBMIT_FREETEXT_SUMMARY_TOOL_NAME,
      );

      if (!submitBlock) {
        // 想定外: submit_summary を呼ばずに end_turn した
        throw new LLMError(
          "agent_no_submission",
          "freetext 経路で submit_summary を呼ばずに応答を終えました",
          { stop_reason: response.stop_reason, attempt },
        );
      }

      const finishedAt = new Date().toISOString();
      // synthesize log を最終的に 1 件残す(成功時のみ。検証失敗 → リトライ時は最終 log に
      // 残さない方針は URL/name 経路と整合)
      const iteration = attempt + 1;
      const candidateLog: ResearchLogEntry[] = [
        ...researchLog,
        { type: "synthesize", iteration, timestamp: finishedAt },
      ];

      const validation = validateFreetextSummary(
        submitBlock.input,
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
          "[AnthropicProvider.researchFreetext] validation failed after retry",
          JSON.stringify({ error: validation.error }, null, 2),
        );
        throw new LLMError(
          "schema_validation",
          `freetext submit_summary failed validation after retry: ${validation.error.kind} (${validation.error.message})`,
          { error: validation.error },
        );
      }

      // 1 回だけリトライ: assistant 応答(tool_use ブロック)を会話に積み、tool_result
      // (is_error: true)+ text(自由テキスト用リトライメッセージ)を user で返す。
      retryAttempted = true;
      const retryMessage = buildFreetextRetryMessage(validation.error);
      console.warn(
        `[AnthropicProvider.researchFreetext] retry triggered (${validation.error.kind})`,
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

      messages.push({
        role: "assistant",
        content:
          response.content as unknown as Anthropic.Messages.ContentBlockParam[],
      });
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: submitBlock.id,
            content: JSON.stringify({
              error: "validation_failed",
              kind: validation.error.kind,
              message: validation.error.message,
            }),
            is_error: true,
          },
          { type: "text", text: retryMessage },
        ],
      });
    }

    // ここに到達するのは attempt が 2 を超えた場合のみ(リトライループから抜けた)
    throw new LLMError(
      "unknown",
      "researchFreetext: unreachable — validation loop exhausted without return",
    );
  }

  async analyze(input: AnalyzeInput, mode: AnalyzeMode): Promise<AnalysisResult> {
    // body.mode と引数 mode の不整合を境界で検出(route 層が両方渡してくる構造のため)
    if (input.mode !== mode) {
      throw new LLMError(
        "api_error",
        `AnalyzeInputBundle.mode (${input.mode}) と引数 mode (${mode}) が一致しない`,
      );
    }
    if (input.mode === "initial") {
      return analyzeInitial(this.client, input);
    }
    if (input.mode === "refresh") {
      return analyzeRefresh(this.client, input);
    }
    // Phase G Step 3b-2: 同期版 analyze() では partial は未サポート(streaming 経路のみ)。
    // 後方互換: 同期 analyze() は initial / refresh のみで動作。partial は API route が
    // analyzePartialStream を直接呼ぶ前提。
    throw new LLMError(
      "api_error",
      "Sync analyze() does not support partial mode; call analyzePartialStream() instead",
    );
  }

  // Phase G Step 1 (2026-05-23): initial 経路の streaming 版。
  // 既存 analyze() は維持(refresh + 後方互換)、initial だけ AsyncGenerator を返す新メソッドを追加。
  // route 側で SSE response にマッピングする。
  //
  // event 種別(エンジニア判断):
  //   - started: 分析開始(model, mode 等のメタ)
  //   - thinking: extended thinking の partial(summarized)
  //   - tool_progress: tool_use の input partial JSON が届いたとき(token 数 / bytes の進捗目安)
  //   - retry: 検証失敗 → リトライ発火
  //   - completed: 検証通過、最終 AnalysisResult
  //   - error: 致命的エラー(LLMError、HTTP status は SSE 上では 200 固定、payload で表現)
  //
  // partial JSON parsing 戦略(本 step の判断 = Plan A、dispatch 推奨):
  //   - tool_use.input は完全に揃うまで accumulate(部分 parse はしない)
  //   - 揃ったら既存 validateAnalysisAgainstInput + 1 回リトライ機構を発火
  //   - streaming の体感メリットは thinking summary と tool_progress(token 進捗)で表現
  //   - 真の「suggestion を 1 件ずつ表示」は Step 2 以降で partial JSON parser 導入を再評価
  // 提出後改善 #2 (2026-06-09): route と OpenAIProvider のシグネチャ互換のため
  //   optional `signal` 引数を追加する。**Anthropic provider は本 dispatch では凍結対象**
  //   — 内部実装(MessageStream の abort 伝搬)は同期しない(引数は受け取るが無視)。
  //   Anthropic 経路は v2 切戻し / 障害時 fallback 用のため、破棄 refresh の課金停止
  //   (OpenAI streaming 切断による生成停止)は実装しない。将来 Anthropic を主経路に
  //   戻す場合に同じ配線で signal を MessageStream に渡せるよう、引数だけ整える。
  //   (`_signal` は underscore prefix で意図的未使用、lint の no-unused-vars 許容パターン)
  analyzeInitialStream(
    input: AnalyzeInput,
    _signal?: AbortSignal,
  ): AsyncGenerator<AnalyzeStreamEvent, void, void> {
    if (input.mode !== "initial") {
      throw new LLMError(
        "api_error",
        "analyzeInitialStream は initial モードのみ受け付ける",
      );
    }
    return analyzeInitialStreaming(this.client, input);
  }

  // Phase G Step 2 (2026-05-23): refresh 経路の streaming 版。
  //
  // 既存の同期版 `analyze(input, "refresh")`(下記 analyzeRefresh)は維持(tests/refresh.test.ts
  // の SSE 化後も、外部 caller / fallback を温存するため)。新メソッド `analyzeRefreshStream`
  // が AsyncGenerator を返し、route 側で SSE response にマッピングする。
  //
  // initial 版(analyzeInitialStream)との違い:
  //   - モデル: Sonnet 4.6(refresh のコスト + 速度重視、Phase D の判断と整合)
  //   - thinking: 無効(Phase D `[2026-05-22] refresh / interview ともに thinking 無効`)
  //   - max_tokens: REFRESH_MAX_TOKENS(12288、initial の 16384 より小さい)
  //   - tool: ANALYZE_ES_REFRESH_ONLY_TOOL(interview_questions / es_state_version を構造除外)
  //   - few-shot prefix は initial と完全に同じ(cache 共有のため、Phase D 判断と整合)
  //   - completed.result.es_state_version = current_es_version + 1(サーバ側で +1 強制、
  //     Phase D `[2026-05-22] es_state_version はサーバが +1 で決定論的に付与` と整合)
  //   - completed.result.interview_questions は undefined(refresh では再生成しない、
  //     Phase D `[2026-05-22] /api/interview を独立エンドポイント` と整合)
  //   - completed.result.metadata.trigger = inferRefreshTrigger(action_history)
  //
  // streaming 中の体感は initial 版と同じ(thinking が無いため thinking event は流れない
  // 想定だが、SDK の挙動として何か流れた場合は素直に通す)。tool_progress は input_json_delta
  // を累積文字数で表現する点も initial と同じ。
  //
  // event 種別の reuse: started.mode = "refresh" 以外は initial と同形(AnalyzeStreamEvent
  // 型定義の started を union に拡張、Step 2 の DECISION で記録)。
  // 提出後改善 #2 (2026-06-09): 凍結対象。optional `signal` はシグネチャ互換のためだけに
  //   受け取り、内部では無視する(課金停止の OpenAI streaming 切断は OpenAIProvider のみ)。
  analyzeRefreshStream(
    input: AnalyzeInput,
    _signal?: AbortSignal,
  ): AsyncGenerator<AnalyzeStreamEvent, void, void> {
    if (input.mode !== "refresh") {
      throw new LLMError(
        "api_error",
        "analyzeRefreshStream は refresh モードのみ受け付ける",
      );
    }
    return analyzeRefreshStreaming(this.client, input);
  }

  // Phase G Step 3b-2 (2026-05-23): partial update 経路の streaming 版。
  //
  // 既存の analyzeRefreshStream(全体 refresh、AnalysisResult 全件再生成)を維持しつつ、
  // 「変更が必要な suggestion のみ」を返す partial 経路を別メソッドとして追加。
  //
  // initial / refresh 版との違い:
  //   - モデル: Sonnet 4.6(refresh と同じ、コスト + 速度)
  //   - thinking: 無効(refresh と同じ)
  //   - max_tokens: PARTIAL_MAX_TOKENS(8K、initial の 16K / refresh の 12K より小さい
  //     — partial は updated/added の合計が 15 件以下に絞られるため少量で済む)
  //   - tool: ANALYZE_ES_PARTIAL_REFRESH_TOOL(updated / deleted / added、interview / version 除外)
  //   - few-shot prefix は initial / refresh と同じ(キャッシュ共有のため、Phase D 判断と整合)
  //   - **prompt cache 拡張**: user メッセージ内に「不変ブロック(Opus 評価軸 + 既存
  //     suggestions サマリ)」+「可変ブロック(派生 ES + action_history)」の 2 ブロック
  //     構造を作り、不変ブロックに cache_control を立てる(cachedUserContext helper)。
  //   - completed event の result は PartialAnalysisResult(span 解決済 + display_priority 付与済)。
  //   - completed.kind = "partial"(client / route 側で AnalysisResultSchema ではなく
  //     PartialAnalysisResultSchema で検証する判別)
  // 提出後改善 #2 (2026-06-09): 凍結対象。optional `signal` はシグネチャ互換のためだけに
  //   受け取り、内部では無視する(課金停止の OpenAI streaming 切断は OpenAIProvider のみ)。
  analyzePartialStream(
    input: AnalyzeInput,
    _signal?: AbortSignal,
  ): AsyncGenerator<AnalyzeStreamEvent, void, void> {
    if (input.mode !== "partial") {
      throw new LLMError(
        "api_error",
        "analyzePartialStream は partial モードのみ受け付ける",
      );
    }
    return analyzePartialStreaming(this.client, input);
  }

  async generateInterview(input: InterviewInput): Promise<InterviewQuestions> {
    return generateInterviewImpl(this.client, input);
  }

  // Day 6 (2026-05-24) LLM 比較ベンチ用に追加。Phase G 以前と同じ
  // Opus 4.7 + adaptive thinking の初回分析経路を非 streaming で叩く。
  //
  // 設計判断(2026-05-24):
  //   - bench は `tests/analyze-bench.test.ts` から直接呼ぶ。SSE 化は工数大で本 dispatch
  //     のスコープ外。同期版 analyzeInitial と同形のシグネチャ(Promise<AnalysisResult> を返す)
  //   - 本番経路の Sonnet 切替を巻き戻すものではなく、**比較ベンチ専用の追加経路**。default の
  //     `analyze()` メソッドは Sonnet を呼び続ける
  //   - adaptive thinking + tool_choice 未指定(thinking enabled + tool_choice 強制は API 排他、
  //     2026-05-24 [initial 分析モデル切替] DECISIONS 参照)
  async analyzeInitialOpus(input: AnalyzeInput): Promise<AnalysisResult> {
    if (input.mode !== "initial") {
      throw new LLMError(
        "api_error",
        "analyzeInitialOpus は initial モードのみ受け付ける",
      );
    }
    return analyzeInitialOpusImpl(this.client, input);
  }
}

// =============================================================================
// Phase G Step 1 (2026-05-23): SSE streaming イベントの型定義
// Phase G Step 2 (2026-05-23): started の mode を "initial" | "refresh" に拡張
// Phase G Step 3b-2 (2026-05-23): partial mode を追加、completed の result を判別 union に
// =============================================================================
// route.ts は AsyncGenerator<AnalyzeStreamEvent> を ReadableStream の SSE フレーム
// (data: <json>\n\n)に変換する。フィールド名は load-bearing field names と衝突しない
// 新規追加(AGENTS.md「Load-bearing field names: 追加は可」)。
//
// Step 2 で started.mode を "initial" | "refresh" の union に拡張、Step 3b-2 で
// "partial" を追加。client 側で discriminated union として narrowing できる構造を
// 維持しつつ、3 モードを同じ event 種別の reuse として表現する。
//
// completed event の result は **mode で 2 種類に分かれる**:
//  - mode === "initial" | "refresh" → `kind: "full"` + result: AnalysisResult
//  - mode === "partial"             → `kind: "partial"` + result: PartialAnalysisResult
// route 側で AnalysisResultSchema / PartialAnalysisResultSchema を切り替えて
// 二重検証する。client(analyze_stream.ts)も kind で分岐して受ける。
export type AnalyzeStreamEvent =
  | {
      type: "started";
      mode: "initial" | "refresh" | "partial";
      model: string;
      attempt: number; // 1-based(リトライ時に 2)
    }
  | {
      type: "thinking";
      // extended thinking の summarized delta(累積ではなく増分)
      delta: string;
    }
  | {
      type: "tool_progress";
      // tool_use の input partial JSON 進捗(累積 chars 数のみ、内容は出さない)
      // UI は「指摘を生成中…」のようなラベルで進行を見せる
      cumulativeChars: number;
    }
  | {
      type: "retry";
      // 何が違反だったか(短い列挙、UI には「検証エラー、再分析中…」とだけ出す)
      issueKinds: string[];
    }
  | {
      type: "completed";
      kind: "full";
      result: AnalysisResult;
      // 提出後改善 #3 準備 (2026-06-09): 受動計測メタ(optional、additive)。
      // OpenAI provider のみ設定する(Anthropic は凍結方針どおり未実装 = undefined)。
      // 既存 client の parse は未知 / 欠落フィールドで壊れない(optional のため)。
      capture_meta?: CaptureMeta;
    }
  | {
      type: "completed";
      kind: "partial";
      result: PartialAnalysisResult;
      // 提出後改善 #3 準備 (2026-06-09): 同上(optional、additive)。
      capture_meta?: CaptureMeta;
    }
  | {
      type: "error";
      // LLMError の kind を文字列化(HTTP status マッピングは route 側)
      kind: string;
      message: string;
      stage?: string;
      retryable?: boolean;
    };

// web_search の input から query を抽出する。SDK 上では `input: unknown` のため緩く扱う。
function extractSearchQuery(input: unknown): string {
  if (typeof input === "object" && input !== null && "query" in input) {
    const q = (input as { query: unknown }).query;
    if (typeof q === "string") return q;
  }
  return "";
}

// -----------------------------------------------------------------------------
// Phase C (セッション5): initial モード深掘り分析
// -----------------------------------------------------------------------------
// 防衛三段の Anthropic 実装:
//   Part 1 (モデル品質): Sonnet 4.6(thinking 無し、tool_choice 強制で安定発火)
//   Part 2 (動的承認リスト): buildInitialUserMessage に承認 evidence_id リストを同梱
//   Part 3 (Zod 検証 + 1回リトライ): validateAnalysisAgainstInput + buildAnalysisRetryMessage
//
// DECISION [2026-05-24] initial 分析モデル切替:
//   Opus 4.7(adaptive thinking)→ Sonnet 4.6(thinking 無し)。検証で品質同水準・
//   レイテンシ 1.9-4 倍速・コスト 40-50% 削減を確認。`thinking enabled` + `tool_choice
//   強制` は両モデルで API 排他のため、第 1 段階として thinking 無しで切替し、tool_choice
//   強制で発火を確実にする(Sonnet は thinking + tool_choice 未指定で text response に
//   分岐する観察あり)。

// few-shot example の assistant 応答に与える tool_use_id。実行されない静的な例なので固定文字列で OK。
const FEWSHOT_TOOL_USE_ID = "toolu_fewshot_analyze_es" as const;

// retry 経路の output_config(2026-05-24 retry コスト / レイテンシ削減の名残)。
// DECISION [2026-05-24]:
//   元々は Opus 4.7 + adaptive thinking 構成で「retry は深く考えない」ために
//   `output_config.effort: "low"` を retry のみ明示していた。Sonnet 4.6 切替後は
//   thinking 自体を渡していないため effort は実質 no-op になりうるが、SDK 型上は
//   thinking と独立した optional パラメータで、API も受理する。
//
//   将来 Sonnet 4.6 で adaptive thinking を再導入する(第 2 段階)場合、retry 経路で
//   再び意味を持つため、ヘルパーごと維持する。問題が観測されたら削除して良い。
const RETRY_OUTPUT_CONFIG: Anthropic.Messages.OutputConfig = {
  effort: "low",
};

// attempt index から「retry 用に上書きすべき output_config」を返すヘルパー。
// attempt === 0(初回): undefined
// attempt >= 1(retry): RETRY_OUTPUT_CONFIG(effort: "low")
function pickOutputConfig(
  attempt: number,
): Anthropic.Messages.OutputConfig | undefined {
  return attempt === 0 ? undefined : RETRY_OUTPUT_CONFIG;
}

// initial モードの max_tokens。
// 構造化出力(15 suggestions × 200 tokens + 5 interview_questions × 150 tokens + 総評)
// を十分カバーするバッファ。Sonnet 4.6 の出力上限内。
const ANALYZE_MAX_TOKENS = 16384;

async function analyzeInitial(
  client: Anthropic,
  input: AnalyzeInput,
): Promise<AnalysisResult> {
  if (input.mode !== "initial") {
    throw new LLMError("api_error", "analyzeInitial called with non-initial input");
  }

  // tools 配列: 分析専用ツールを1つだけ。末尾(=このツール)に cache_control を立てて
  // 「ここまで(system + tools 全部)を ephemeral cache」のマーカーにする。
  const tools: Anthropic.Messages.ToolUnion[] = [
    { ...ANALYZE_ES_TOOL, cache_control: EPHEMERAL_CACHE },
  ];

  // few-shot + 実入力で会話履歴を組み立てる。
  // - few-shot user (静的)
  // - few-shot assistant tool_use (静的、cache_control で「ここまでキャッシュ」)
  // - real user: tool_result(few-shot 受理確認)+ text(動的な実入力)
  // Anthropic は role の交互が必要なので、few-shot の assistant 直後の user メッセージで
  //  tool_result と実 user text を 1 ブロックにまとめる。
  const realUserMessage = buildInitialUserMessage(input);

  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: "user",
      content: ANALYZE_FEWSHOT_USER_MESSAGE,
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: FEWSHOT_TOOL_USE_ID,
          name: ANALYZE_ES_TOOL_NAME,
          input: ANALYZE_FEWSHOT_ASSISTANT_INPUT,
          cache_control: EPHEMERAL_CACHE,
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: FEWSHOT_TOOL_USE_ID,
          content:
            "上記は few-shot 例として受理しました。続けて次の入力に対して analyze_es を呼んでください。",
        },
        { type: "text", text: realUserMessage },
      ],
    },
  ];

  // 防衛三段 Part 3: validateAnalysisAgainstInput 失敗時に1回だけリトライ。
  let retryAttempted = false;
  let totalUsage: { input: number; output: number; cache_read?: number; cache_creation?: number } = {
    input: 0,
    output: 0,
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Anthropic.Messages.Message;
    try {
      response = await client.messages.create({
        model: MODEL_SONNET,
        max_tokens: ANALYZE_MAX_TOKENS,
        // Sonnet 4.6 は thinking 無し + tool_choice 強制で analyze_es の発火を確実にする
        // (DECISION [2026-05-24] initial 分析モデル切替を参照)。
        output_config: pickOutputConfig(attempt),
        system: cachedSystem(ANALYZE_SYSTEM_PROMPT),
        tools,
        tool_choice: { type: "tool", name: ANALYZE_ES_TOOL_NAME },
        messages,
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        throw new LLMError("rate_limit", "Anthropic rate limit hit", err);
      }
      if (err instanceof Anthropic.APIError) {
        throw new LLMError("api_error", `Anthropic API error: ${err.message}`, err);
      }
      throw new LLMError("unknown", "Unknown Anthropic SDK error", err);
    }

    // usage を累計する(リトライがあった場合は2回分の総コスト)
    totalUsage = {
      input: totalUsage.input + (response.usage?.input_tokens ?? 0),
      output: totalUsage.output + (response.usage?.output_tokens ?? 0),
      cache_read:
        (totalUsage.cache_read ?? 0) + (response.usage?.cache_read_input_tokens ?? 0),
      cache_creation:
        (totalUsage.cache_creation ?? 0) +
        (response.usage?.cache_creation_input_tokens ?? 0),
    };

    // 応答から analyze_es の tool_use ブロックを取り出す
    const toolUseBlock = response.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock =>
        b.type === "tool_use" && b.name === ANALYZE_ES_TOOL_NAME,
    );

    if (!toolUseBlock) {
      // 想定外: analyze_es を呼ばずに end_turn した
      throw new LLMError(
        "api_error",
        "Anthropic が analyze_es ツールを呼ばずに応答を終えました",
        { stop_reason: response.stop_reason, attempt },
      );
    }

    // 防衛三段 Part 3: 構造 + 意味的検証
    const validation = validateAnalysisAgainstInput(toolUseBlock.input, input);
    if (validation.ok) {
      return assembleAnalysisResult(input, validation.data, totalUsage);
    }

    if (retryAttempted) {
      console.error(
        "[AnthropicProvider.analyze] validation failed after retry",
        JSON.stringify(
          { issues: validation.issues.slice(0, 5), input_mode: input.mode },
          null,
          2,
        ),
      );
      throw new LLMError(
        "analysis_validation",
        `analyze_es output failed validation after retry: ${validation.issues
          .map((i) => i.kind)
          .join(", ")}`,
        { issues: validation.issues },
      );
    }

    // 1回だけリトライ: assistant 応答(thinking + tool_use を含む全 content)を会話に積み、
    // 続けて tool_result(is_error: true)+ text(リトライメッセージ)を user で返す。
    retryAttempted = true;
    const retryMessage = buildAnalysisRetryMessage(validation.issues, input);
    console.warn(
      "[AnthropicProvider.analyze] retry triggered",
      JSON.stringify({ issues: validation.issues.map((i) => i.kind) }),
    );

    messages.push({
      role: "assistant",
      content: response.content as unknown as Anthropic.Messages.ContentBlockParam[],
    });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseBlock.id,
          content: JSON.stringify({
            error: "validation_failed",
            kinds: validation.issues.map((i) => i.kind),
          }),
          is_error: true,
        },
        { type: "text", text: retryMessage },
      ],
    });
    // ループ続行(attempt=1 でリトライ)
  }

  // ここに到達するのは attempt が 2 を超えた場合のみで、想定上は起こらない。
  throw new LLMError(
    "unknown",
    "analyzeInitial: unreachable — validation loop exhausted without return",
  );
}

// -----------------------------------------------------------------------------
// Day 6 (2026-05-24): Opus 4.7 + adaptive thinking 用の initial 経路(同期、bench 専用)
// -----------------------------------------------------------------------------
// 防衛三段は analyzeInitial(Sonnet 用)と同一構造で維持:
//   Part 1: モデル品質 (Opus 4.7、adaptive thinking、tool_choice 未指定)
//   Part 2: 動的承認リスト(buildInitialUserMessage に埋め込み、Sonnet と同じ)
//   Part 3: Zod 検証 + 1 回リトライ(validateAnalysisAgainstInput + buildAnalysisRetryMessage)
//
// Sonnet 版(analyzeInitial)との差分:
//   - model: MODEL_OPUS
//   - thinking: OPUS_ADAPTIVE_THINKING(adaptive)
//   - tool_choice: 未指定(adaptive thinking + tool_choice 強制は API 排他)
//   - retry の output_config: pickOutputConfig(attempt)(retry のみ effort: "low" を継続)
//   - metadata.model: MODEL_OPUS
//
// 「analyze_es を呼ばずに text response で返す」リスクは、prompt 側の指示と Opus の
// tool 発火傾向で吸収する。Sonnet では tool_choice 強制で構造的に保証していたが、
// Opus は adaptive thinking が有効な状態で tool 発火が安定するという経験則に基づく
// (Phase G 以前の本番運用で確認済、DECISIONS [2026-05-24] initial 分析モデル切替を参照)。
async function analyzeInitialOpusImpl(
  client: Anthropic,
  input: AnalyzeInput,
): Promise<AnalysisResult> {
  if (input.mode !== "initial") {
    throw new LLMError(
      "api_error",
      "analyzeInitialOpusImpl called with non-initial input",
    );
  }

  const tools: Anthropic.Messages.ToolUnion[] = [
    { ...ANALYZE_ES_TOOL, cache_control: EPHEMERAL_CACHE },
  ];

  const realUserMessage = buildInitialUserMessage(input);

  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: "user",
      content: ANALYZE_FEWSHOT_USER_MESSAGE,
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: FEWSHOT_TOOL_USE_ID,
          name: ANALYZE_ES_TOOL_NAME,
          input: ANALYZE_FEWSHOT_ASSISTANT_INPUT,
          cache_control: EPHEMERAL_CACHE,
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: FEWSHOT_TOOL_USE_ID,
          content:
            "上記は few-shot 例として受理しました。続けて次の入力に対して analyze_es を呼んでください。",
        },
        { type: "text", text: realUserMessage },
      ],
    },
  ];

  let retryAttempted = false;
  let totalUsage: {
    input: number;
    output: number;
    cache_read?: number;
    cache_creation?: number;
  } = { input: 0, output: 0 };

  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Anthropic.Messages.Message;
    try {
      response = await client.messages.create({
        model: MODEL_OPUS,
        max_tokens: ANALYZE_MAX_TOKENS,
        // adaptive thinking — Opus が深掘りが必要と判断したら自動で thinking 予算を割り当てる
        thinking: OPUS_ADAPTIVE_THINKING,
        // retry の output_config(effort: "low")を継続。adaptive thinking と独立した optional
        output_config: pickOutputConfig(attempt),
        system: cachedSystem(ANALYZE_SYSTEM_PROMPT),
        tools,
        // tool_choice は未指定。adaptive thinking + tool_choice 強制は API 排他。
        // Opus は tool を内部発火する傾向が強い(Phase G 以前の本番運用で確認済)
        messages,
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        throw new LLMError("rate_limit", "Anthropic rate limit hit", err);
      }
      if (err instanceof Anthropic.APIError) {
        throw new LLMError(
          "api_error",
          `Anthropic API error: ${err.message}`,
          err,
        );
      }
      throw new LLMError("unknown", "Unknown Anthropic SDK error", err);
    }

    totalUsage = {
      input: totalUsage.input + (response.usage?.input_tokens ?? 0),
      output: totalUsage.output + (response.usage?.output_tokens ?? 0),
      cache_read:
        (totalUsage.cache_read ?? 0) +
        (response.usage?.cache_read_input_tokens ?? 0),
      cache_creation:
        (totalUsage.cache_creation ?? 0) +
        (response.usage?.cache_creation_input_tokens ?? 0),
    };

    const toolUseBlock = response.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock =>
        b.type === "tool_use" && b.name === ANALYZE_ES_TOOL_NAME,
    );

    if (!toolUseBlock) {
      throw new LLMError(
        "api_error",
        "Anthropic Opus が analyze_es ツールを呼ばずに応答を終えました(text 応答に分岐した可能性)",
        { stop_reason: response.stop_reason, attempt },
      );
    }

    const validation = validateAnalysisAgainstInput(toolUseBlock.input, input);
    if (validation.ok) {
      return assembleAnalysisResultWithModel(
        input,
        validation.data,
        totalUsage,
        MODEL_OPUS,
      );
    }

    if (retryAttempted) {
      console.error(
        "[AnthropicProvider.analyzeInitialOpus] validation failed after retry",
        JSON.stringify(
          { issues: validation.issues.slice(0, 5), input_mode: input.mode },
          null,
          2,
        ),
      );
      throw new LLMError(
        "analysis_validation",
        `Opus analyze_es output failed validation after retry: ${validation.issues
          .map((i) => i.kind)
          .join(", ")}`,
        { issues: validation.issues },
      );
    }

    retryAttempted = true;
    const retryMessage = buildAnalysisRetryMessage(validation.issues, input);
    console.warn(
      "[AnthropicProvider.analyzeInitialOpus] retry triggered",
      JSON.stringify({ issues: validation.issues.map((i) => i.kind) }),
    );

    messages.push({
      role: "assistant",
      content:
        response.content as unknown as Anthropic.Messages.ContentBlockParam[],
    });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseBlock.id,
          content: JSON.stringify({
            error: "validation_failed",
            kinds: validation.issues.map((i) => i.kind),
          }),
          is_error: true,
        },
        { type: "text", text: retryMessage },
      ],
    });
  }

  throw new LLMError(
    "unknown",
    "analyzeInitialOpusImpl: unreachable — validation loop exhausted without return",
  );
}

// -----------------------------------------------------------------------------
// Phase G Step 1 (2026-05-23): initial モード streaming 版
// -----------------------------------------------------------------------------
// 防衛三段は initial 同期版(analyzeInitial)と同一構造で維持:
//   Part 1: モデル品質 (Sonnet 4.6、thinking 無し、tool_choice 強制)
//   Part 2: 動的承認リスト(buildInitialUserMessage に埋め込み)
//   Part 3: Zod 検証 + 1 回リトライ(streaming 完了後に既存ロジックを発火)
//
// streaming は **finalMessage() で完成 Message を待ってから検証** する Plan A。
// 途中の tool_progress イベントを AsyncGenerator から yield する(Sonnet 4.6 切替後は
// thinking ブロック自体が出ないため、thinking_delta は実質的に発生しない)。
//
// route.ts はこの generator を SSE フレームに変換する。エラーは generator から
// `{ type: "error", ... }` を yield して終了(throw しない、route 側で SSE error
// event を流して 200 で response を閉じる)。
async function* analyzeInitialStreaming(
  client: Anthropic,
  input: AnalyzeInput,
): AsyncGenerator<AnalyzeStreamEvent, void, void> {
  if (input.mode !== "initial") {
    yield {
      type: "error",
      kind: "api_error",
      message: "analyzeInitialStreaming called with non-initial input",
      stage: "analyze_initial_stream",
    };
    return;
  }

  // tools 配列: 同期版と同じ(cache_control も同じ)
  const tools: Anthropic.Messages.ToolUnion[] = [
    { ...ANALYZE_ES_TOOL, cache_control: EPHEMERAL_CACHE },
  ];

  const realUserMessage = buildInitialUserMessage(input);
  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: "user",
      content: ANALYZE_FEWSHOT_USER_MESSAGE,
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: FEWSHOT_TOOL_USE_ID,
          name: ANALYZE_ES_TOOL_NAME,
          input: ANALYZE_FEWSHOT_ASSISTANT_INPUT,
          cache_control: EPHEMERAL_CACHE,
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: FEWSHOT_TOOL_USE_ID,
          content:
            "上記は few-shot 例として受理しました。続けて次の入力に対して analyze_es を呼んでください。",
        },
        { type: "text", text: realUserMessage },
      ],
    },
  ];

  let retryAttempted = false;
  let totalUsage: {
    input: number;
    output: number;
    cache_read?: number;
    cache_creation?: number;
  } = { input: 0, output: 0 };

  for (let attempt = 0; attempt < 2; attempt++) {
    // started event を流す(リトライ時は attempt: 2)
    yield {
      type: "started",
      mode: "initial",
      model: MODEL_SONNET,
      attempt: attempt + 1,
    };

    // -----------------------------------------------------------------------
    // streaming で 1 回呼び出す
    // -----------------------------------------------------------------------
    // SDK の messages.stream() は MessageStream(AsyncIterable<MessageStreamEvent>)
    // を返す。SDK 内部で SSE をパースしてくれるため、こちら側は構造化された
    // event を for-await で受け取れる。
    let finalMessage: Anthropic.Messages.Message;
    // partial JSON の累積文字数(UI 進捗表示用、内容は流さない)
    let cumulativeInputChars = 0;
    // thinking の累積を簡単な防御として保持(短時間で大量に届くと SSE が詰まるため、
    // 小さな buffer で flush する判断は generator 側の yield 頻度で吸収)。
    const pendingProgressEvents: AnalyzeStreamEvent[] = [];

    try {
      const stream = client.messages.stream({
        model: MODEL_SONNET,
        max_tokens: ANALYZE_MAX_TOKENS,
        // Sonnet 4.6 は thinking 無し + tool_choice 強制で analyze_es の発火を確実にする
        // (DECISION [2026-05-24] initial 分析モデル切替を参照)。同期版 analyzeInitial と
        // 同設定。
        output_config: pickOutputConfig(attempt),
        system: cachedSystem(ANALYZE_SYSTEM_PROMPT),
        tools,
        tool_choice: { type: "tool", name: ANALYZE_ES_TOOL_NAME },
        messages,
      });

      // SDK の MessageStream は AsyncIterable<MessageStreamEvent>。各 raw event を
      // 進行イベントに変換して generator から yield する。
      // ただしジェネレータ関数内で for-await している間は SDK 側のイベント emitter は
      // 別途回っているわけではない(同じ async stream なので、for-await のループ自体
      // が消費 = streaming 進行)。
      for await (const event of stream) {
        // 取りこぼし防止のため、ペンディング進捗を先に flush
        while (pendingProgressEvents.length > 0) {
          const ev = pendingProgressEvents.shift()!;
          yield ev;
        }

        // event ごとの分岐:
        //   - content_block_delta(thinking_delta): extended thinking の partial summary
        //   - content_block_delta(input_json_delta): tool_use input の partial JSON
        // それ以外(message_start / content_block_start / content_block_stop /
        // message_delta / message_stop)は内部状態のみ更新、UI には流さない。
        if (event.type === "content_block_delta") {
          const delta = event.delta;
          if (delta.type === "thinking_delta") {
            // 1 回の delta が長すぎると SSE が詰まる可能性。文字数の安全弁:
            // 1 chunk ≦ 512 chars 程度に切り詰めて流す(UI は単に表示するため、
            // 必要なら client 側で適宜 truncate する想定)。
            const text = delta.thinking ?? "";
            if (text.length > 0) {
              yield { type: "thinking", delta: text };
            }
          } else if (delta.type === "input_json_delta") {
            // tool_use の input が partial で届く。partial を parse しないため、
            // 累積文字数だけ進行表示の目安として流す(本 step の判断 = Plan A)。
            const partial = delta.partial_json ?? "";
            cumulativeInputChars += partial.length;
            yield {
              type: "tool_progress",
              cumulativeChars: cumulativeInputChars,
            };
          }
          // text_delta / signature_delta / citations_delta 等は本経路では出ない
          // (analyze_es は tool_use 強制、text/citation を出さない設計)。
        }
        // 他の event 種別(message_start / content_block_start / content_block_stop /
        // message_delta / message_stop)はジェネレータからは出さない。SDK が finalMessage()
        // で完成 Message を組み立てる際の内部 state に使う。
      }

      // streaming が正常終了した — finalMessage() で完成 Message を取得
      finalMessage = await stream.finalMessage();
    } catch (err) {
      // SDK エラーを LLMError に正規化して yield(throw しない、generator で error
      // event を流してから return)
      if (err instanceof Anthropic.RateLimitError) {
        yield {
          type: "error",
          kind: "rate_limit",
          message: "Anthropic rate limit hit",
          stage: "analyze_initial_stream",
          retryable: true,
        };
        return;
      }
      if (err instanceof Anthropic.APIError) {
        yield {
          type: "error",
          kind: "api_error",
          message: `Anthropic API error: ${err.message}`,
          stage: "analyze_initial_stream",
          retryable: true,
        };
        return;
      }
      yield {
        type: "error",
        kind: "unknown",
        message:
          err instanceof Error ? err.message : "Unknown Anthropic SDK error",
        stage: "analyze_initial_stream",
      };
      return;
    }

    // -----------------------------------------------------------------------
    // 完成 Message を従来ロジック(analyzeInitial)と同形で処理
    // -----------------------------------------------------------------------
    totalUsage = {
      input: totalUsage.input + (finalMessage.usage?.input_tokens ?? 0),
      output: totalUsage.output + (finalMessage.usage?.output_tokens ?? 0),
      cache_read:
        (totalUsage.cache_read ?? 0) +
        (finalMessage.usage?.cache_read_input_tokens ?? 0),
      cache_creation:
        (totalUsage.cache_creation ?? 0) +
        (finalMessage.usage?.cache_creation_input_tokens ?? 0),
    };

    const toolUseBlock = finalMessage.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock =>
        b.type === "tool_use" && b.name === ANALYZE_ES_TOOL_NAME,
    );

    if (!toolUseBlock) {
      yield {
        type: "error",
        kind: "api_error",
        message: "Anthropic が analyze_es ツールを呼ばずに応答を終えました",
        stage: "analyze_initial_stream",
      };
      return;
    }

    // 防衛三段 Part 3: Zod 検証 + 意味的検証
    const validation = validateAnalysisAgainstInput(toolUseBlock.input, input);
    if (validation.ok) {
      // 成功 — 既存の assembleAnalysisResult で AnalysisResult を組み立て completed yield
      let result: AnalysisResult;
      try {
        result = assembleAnalysisResult(input, validation.data, totalUsage);
      } catch (err) {
        // resolveOriginalSpans 失敗(missing 等)は LLMError として送出
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
              : "Unknown error during assemble",
          stage: "analyze_initial_stream_assemble",
        };
        return;
      }
      yield { type: "completed", kind: "full", result };
      return;
    }

    // 検証失敗 — リトライ判定
    if (retryAttempted) {
      console.error(
        "[AnthropicProvider.analyzeInitialStream] validation failed after retry",
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

    // 1 回だけリトライ: retry event を流し、messages を組み立て直して次反復
    retryAttempted = true;
    const issueKinds = validation.issues.map((i) => i.kind);
    yield { type: "retry", issueKinds };

    const retryMessage = buildAnalysisRetryMessage(validation.issues, input);
    console.warn(
      "[AnthropicProvider.analyzeInitialStream] retry triggered",
      JSON.stringify({ issues: issueKinds }),
    );

    messages.push({
      role: "assistant",
      content:
        finalMessage.content as unknown as Anthropic.Messages.ContentBlockParam[],
    });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseBlock.id,
          content: JSON.stringify({
            error: "validation_failed",
            kinds: issueKinds,
          }),
          is_error: true,
        },
        { type: "text", text: retryMessage },
      ],
    });
    // 次反復(attempt=1)で再 stream
  }

  // 到達不能(attempt=2 で必ず completed か error で return している)
  yield {
    type: "error",
    kind: "unknown",
    message:
      "analyzeInitialStreaming: unreachable — validation loop exhausted without yield",
    stage: "analyze_initial_stream",
  };
}

// AI 出力 + 入力 Bundle + usage から最終 AnalysisResult を組み立てる。
// - es_state_version は入力 current_es_version で上書き(LLM 出力は信用しない)
// - suggestions は resolveOriginalSpans で original_span を付与
// - interview_questions.generated_at_es_version も current_es_version で上書き
function assembleAnalysisResult(
  input: AnalyzeInput,
  ai: AIInitialAnalysisOutput,
  usage: { input: number; output: number; cache_read?: number; cache_creation?: number },
): AnalysisResult {
  return assembleAnalysisResultWithModel(input, ai, usage, MODEL_SONNET);
}

// Day 6 (2026-05-24): model 名を引数で渡せる版。bench で Opus / Sonnet を出し分けるため。
// Sonnet 用の `assembleAnalysisResult` は本関数を MODEL_SONNET で呼ぶ薄いラッパとして残し、
// 本関数を Opus / 将来の比較対象モデルからも共有する。
function assembleAnalysisResultWithModel(
  input: AnalyzeInput,
  ai: AIInitialAnalysisOutput,
  usage: { input: number; output: number; cache_read?: number; cache_creation?: number },
  model: string,
): AnalysisResult {
  if (input.mode !== "initial") {
    throw new LLMError(
      "api_error",
      "assembleAnalysisResultWithModel called with non-initial input",
    );
  }

  const { resolved, missing } = resolveOriginalSpans(
    input.es_body,
    ai.suggestions as AISuggestion[],
  );

  if (missing.length > 0) {
    // validateAnalysisAgainstInput で original_not_in_es として弾けているはずだが、二重防御。
    throw new LLMError(
      "analysis_validation",
      `${missing.length} suggestion(s) have original text not present in es_body (post-validation anchor failure)`,
      { missing_ids: missing.map((m) => m.id) },
    );
  }

  const metadata: AnalysisMetadata = {
    generated_at: new Date().toISOString(),
    model,
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

// -----------------------------------------------------------------------------
// Phase D (セッション6): refresh モード再分析 + /api/interview 面接質問生成
// -----------------------------------------------------------------------------
// 設計判断(キックオフ判断1〜5):
//   - 別ツール analyze_es_refresh_only を使う(interview_questions と es_state_version を
//     構造的に除外。プロンプト指示 + ツール構造の二重防衛)
//   - Phase C の system + few-shot prefix をそのまま再利用(cache 共有)
//   - es_state_version はサーバが current_es_version + 1 で決定論的に付与
//   - original_span は resolveOriginalSpans を再走(各 refresh で再計算)
//   - モデルは Sonnet 4.6(コスト重視 + 20〜40秒目安、Phase C より速い)

// refresh モードの max_tokens。Sonnet 4.6 で thinking 無し、15 suggestions + 総評で
// 8K 程度に収まる想定。余裕を持って 12K。
const REFRESH_MAX_TOKENS = 12288;

// /api/interview の max_tokens。questions 3〜5 × 5フィールドで 1〜2K に収まる。
// 余裕を持って 4K。few-shot prefix(initial と同じ)があるので入力 token は大きいが、
// 出力は小さい。
const INTERVIEW_MAX_TOKENS = 4096;

async function analyzeRefresh(
  client: Anthropic,
  input: AnalyzeInputBundleRefresh,
): Promise<AnalysisResult> {
  // tools 配列: refresh 専用ツール。末尾(=このツール)に cache_control を立てる。
  const tools: Anthropic.Messages.ToolUnion[] = [
    { ...ANALYZE_ES_REFRESH_ONLY_TOOL, cache_control: EPHEMERAL_CACHE },
  ];

  // 重要: few-shot prefix は Phase C initial と完全に同じ。tools が変わるため tool
  // 定義ハッシュとしてはキャッシュ境界がずれる可能性があるが、system + few-shot 文字列
  // は同一なので messages 部分の cache_read が成立する余地は残る。
  // few-shot tool_use.name は "analyze_es"(履歴的な参照、Anthropic は会話履歴上の
  // 旧ツール名を許容)。現在の tools には analyze_es_refresh_only しか無いので、
  // 次の assistant ターンでは強制的にこちらを呼ぶ。
  const realUserMessage = buildRefreshUserMessage(input);

  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: "user",
      content: ANALYZE_FEWSHOT_USER_MESSAGE,
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: FEWSHOT_TOOL_USE_ID,
          name: ANALYZE_ES_TOOL_NAME,
          input: ANALYZE_FEWSHOT_ASSISTANT_INPUT,
          cache_control: EPHEMERAL_CACHE,
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: FEWSHOT_TOOL_USE_ID,
          content:
            "上記は few-shot 例として受理しました。続けて次の入力に対して analyze_es_refresh_only を呼んでください。interview_questions と es_state_version は出力しないでください(ツールスキーマから除外されています)。",
        },
        { type: "text", text: realUserMessage },
      ],
    },
  ];

  // 防衛三段 Part 3: validateAnalysisAgainstInput 失敗時に1回だけリトライ。
  let retryAttempted = false;
  let totalUsage: {
    input: number;
    output: number;
    cache_read?: number;
    cache_creation?: number;
  } = { input: 0, output: 0 };

  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Anthropic.Messages.Message;
    try {
      response = await client.messages.create({
        model: MODEL_SONNET,
        max_tokens: REFRESH_MAX_TOKENS,
        // Sonnet 4.6 では thinking 不要(Phase C より速い 20〜40秒を狙う設計)
        system: cachedSystem(ANALYZE_SYSTEM_PROMPT),
        tools,
        messages,
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        throw new LLMError("rate_limit", "Anthropic rate limit hit", err);
      }
      if (err instanceof Anthropic.APIError) {
        throw new LLMError("api_error", `Anthropic API error: ${err.message}`, err);
      }
      throw new LLMError("unknown", "Unknown Anthropic SDK error", err);
    }

    totalUsage = {
      input: totalUsage.input + (response.usage?.input_tokens ?? 0),
      output: totalUsage.output + (response.usage?.output_tokens ?? 0),
      cache_read:
        (totalUsage.cache_read ?? 0) + (response.usage?.cache_read_input_tokens ?? 0),
      cache_creation:
        (totalUsage.cache_creation ?? 0) +
        (response.usage?.cache_creation_input_tokens ?? 0),
    };

    const toolUseBlock = response.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock =>
        b.type === "tool_use" && b.name === ANALYZE_ES_REFRESH_ONLY_TOOL_NAME,
    );

    if (!toolUseBlock) {
      throw new LLMError(
        "api_error",
        "Anthropic が analyze_es_refresh_only ツールを呼ばずに応答を終えました",
        { stop_reason: response.stop_reason, attempt },
      );
    }

    const validation = validateAnalysisAgainstInput(toolUseBlock.input, input);
    if (validation.ok) {
      return assembleRefreshAnalysisResult(input, validation.data, totalUsage);
    }

    if (retryAttempted) {
      console.error(
        "[AnthropicProvider.analyze refresh] validation failed after retry",
        JSON.stringify(
          { issues: validation.issues.slice(0, 5), input_mode: input.mode },
          null,
          2,
        ),
      );
      throw new LLMError(
        "analysis_validation",
        `analyze_es_refresh_only output failed validation after retry: ${validation.issues
          .map((i) => i.kind)
          .join(", ")}`,
        { issues: validation.issues },
      );
    }

    // 1回だけリトライ
    retryAttempted = true;
    const retryMessage = buildAnalysisRetryMessage(validation.issues, input);
    console.warn(
      "[AnthropicProvider.analyze refresh] retry triggered",
      JSON.stringify({ issues: validation.issues.map((i) => i.kind) }),
    );

    messages.push({
      role: "assistant",
      content: response.content as unknown as Anthropic.Messages.ContentBlockParam[],
    });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseBlock.id,
          content: JSON.stringify({
            error: "validation_failed",
            kinds: validation.issues.map((i) => i.kind),
          }),
          is_error: true,
        },
        { type: "text", text: retryMessage },
      ],
    });
  }

  throw new LLMError(
    "unknown",
    "analyzeRefresh: unreachable — validation loop exhausted without return",
  );
}

// -----------------------------------------------------------------------------
// Phase G Step 2 (2026-05-23): refresh モード streaming 版
// -----------------------------------------------------------------------------
// 防衛三段は refresh 同期版(analyzeRefresh)と同一構造で維持:
//   Part 1: モデル品質 (Sonnet 4.6、thinking 無し)
//   Part 2: 動的承認リスト(buildRefreshUserMessage に埋め込み)
//   Part 3: Zod 検証 + 1 回リトライ(streaming 完了後に既存ロジックを発火)
//
// streaming は **finalMessage() で完成 Message を待ってから検証** する Plan A
// (Step 1 と同じ判断、G1.3 / G1.4 / G1.5 を refresh でも踏襲)。途中の
// tool_progress イベントだけ AsyncGenerator から yield する。
//
// route.ts はこの generator を SSE フレームに変換する。エラーは generator から
// `{ type: "error", ... }` を yield して終了(throw しない、route 側で SSE error
// event を流して 200 で response を閉じる)。
async function* analyzeRefreshStreaming(
  client: Anthropic,
  input: AnalyzeInput,
): AsyncGenerator<AnalyzeStreamEvent, void, void> {
  if (input.mode !== "refresh") {
    yield {
      type: "error",
      kind: "api_error",
      message: "analyzeRefreshStreaming called with non-refresh input",
      stage: "analyze_refresh_stream",
    };
    return;
  }

  // tools 配列: 同期版(analyzeRefresh)と同じ(cache_control も同じ)
  const tools: Anthropic.Messages.ToolUnion[] = [
    { ...ANALYZE_ES_REFRESH_ONLY_TOOL, cache_control: EPHEMERAL_CACHE },
  ];

  // few-shot prefix は initial と完全に同じ(cache 共有、Phase D 判断と整合)
  const realUserMessage = buildRefreshUserMessage(input);
  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: "user",
      content: ANALYZE_FEWSHOT_USER_MESSAGE,
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: FEWSHOT_TOOL_USE_ID,
          name: ANALYZE_ES_TOOL_NAME,
          input: ANALYZE_FEWSHOT_ASSISTANT_INPUT,
          cache_control: EPHEMERAL_CACHE,
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: FEWSHOT_TOOL_USE_ID,
          content:
            "上記は few-shot 例として受理しました。続けて次の入力に対して analyze_es_refresh_only を呼んでください。interview_questions と es_state_version は出力しないでください(ツールスキーマから除外されています)。",
        },
        { type: "text", text: realUserMessage },
      ],
    },
  ];

  let retryAttempted = false;
  let totalUsage: {
    input: number;
    output: number;
    cache_read?: number;
    cache_creation?: number;
  } = { input: 0, output: 0 };

  for (let attempt = 0; attempt < 2; attempt++) {
    // started event を流す(リトライ時は attempt: 2)
    yield {
      type: "started",
      mode: "refresh",
      model: MODEL_SONNET,
      attempt: attempt + 1,
    };

    // -----------------------------------------------------------------------
    // streaming で 1 回呼び出す
    // -----------------------------------------------------------------------
    let finalMessage: Anthropic.Messages.Message;
    // partial JSON の累積文字数(UI 進捗表示用、内容は流さない)
    let cumulativeInputChars = 0;

    try {
      const stream = client.messages.stream({
        model: MODEL_SONNET,
        max_tokens: REFRESH_MAX_TOKENS,
        // Sonnet 4.6 では thinking 不要(Phase D の同期版と整合)
        system: cachedSystem(ANALYZE_SYSTEM_PROMPT),
        tools,
        messages,
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta") {
          const delta = event.delta;
          if (delta.type === "thinking_delta") {
            // refresh は thinking 無効だが、SDK が何か流す可能性に備えて素直に通す。
            const text = delta.thinking ?? "";
            if (text.length > 0) {
              yield { type: "thinking", delta: text };
            }
          } else if (delta.type === "input_json_delta") {
            const partial = delta.partial_json ?? "";
            cumulativeInputChars += partial.length;
            yield {
              type: "tool_progress",
              cumulativeChars: cumulativeInputChars,
            };
          }
        }
      }

      finalMessage = await stream.finalMessage();
    } catch (err) {
      // SDK エラーを LLMError 系の payload に正規化して yield(throw しない)
      if (err instanceof Anthropic.RateLimitError) {
        yield {
          type: "error",
          kind: "rate_limit",
          message: "Anthropic rate limit hit",
          stage: "analyze_refresh_stream",
          retryable: true,
        };
        return;
      }
      if (err instanceof Anthropic.APIError) {
        yield {
          type: "error",
          kind: "api_error",
          message: `Anthropic API error: ${err.message}`,
          stage: "analyze_refresh_stream",
          retryable: true,
        };
        return;
      }
      yield {
        type: "error",
        kind: "unknown",
        message:
          err instanceof Error ? err.message : "Unknown Anthropic SDK error",
        stage: "analyze_refresh_stream",
      };
      return;
    }

    // -----------------------------------------------------------------------
    // 完成 Message を従来ロジック(analyzeRefresh)と同形で処理
    // -----------------------------------------------------------------------
    totalUsage = {
      input: totalUsage.input + (finalMessage.usage?.input_tokens ?? 0),
      output: totalUsage.output + (finalMessage.usage?.output_tokens ?? 0),
      cache_read:
        (totalUsage.cache_read ?? 0) +
        (finalMessage.usage?.cache_read_input_tokens ?? 0),
      cache_creation:
        (totalUsage.cache_creation ?? 0) +
        (finalMessage.usage?.cache_creation_input_tokens ?? 0),
    };

    const toolUseBlock = finalMessage.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock =>
        b.type === "tool_use" && b.name === ANALYZE_ES_REFRESH_ONLY_TOOL_NAME,
    );

    if (!toolUseBlock) {
      yield {
        type: "error",
        kind: "api_error",
        message:
          "Anthropic が analyze_es_refresh_only ツールを呼ばずに応答を終えました",
        stage: "analyze_refresh_stream",
      };
      return;
    }

    // 防衛三段 Part 3: Zod 検証 + 意味的検証(refresh 用 schema を関数オーバーロード経由で呼ぶ)
    const validation = validateAnalysisAgainstInput(toolUseBlock.input, input);
    if (validation.ok) {
      // 成功 — 既存の assembleRefreshAnalysisResult で AnalysisResult を組み立て completed yield
      let result: AnalysisResult;
      try {
        result = assembleRefreshAnalysisResult(input, validation.data, totalUsage);
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

    // 検証失敗 — リトライ判定
    if (retryAttempted) {
      console.error(
        "[AnthropicProvider.analyzeRefreshStream] validation failed after retry",
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

    // 1 回だけリトライ: retry event を流し、messages を組み立て直して次反復
    retryAttempted = true;
    const issueKinds = validation.issues.map((i) => i.kind);
    yield { type: "retry", issueKinds };

    const retryMessage = buildAnalysisRetryMessage(validation.issues, input);
    console.warn(
      "[AnthropicProvider.analyzeRefreshStream] retry triggered",
      JSON.stringify({ issues: issueKinds }),
    );

    messages.push({
      role: "assistant",
      content:
        finalMessage.content as unknown as Anthropic.Messages.ContentBlockParam[],
    });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseBlock.id,
          content: JSON.stringify({
            error: "validation_failed",
            kinds: issueKinds,
          }),
          is_error: true,
        },
        { type: "text", text: retryMessage },
      ],
    });
    // 次反復(attempt=1)で再 stream
  }

  // 到達不能(attempt=2 で必ず completed か error で return している)
  yield {
    type: "error",
    kind: "unknown",
    message:
      "analyzeRefreshStreaming: unreachable — validation loop exhausted without yield",
    stage: "analyze_refresh_stream",
  };
}

// refresh 出力の組み立て。initial 用 assembleAnalysisResult との違い:
//  - es_state_version = input.current_es_version + 1(キックオフ判断4 でサーバ強制)
//  - interview_questions は undefined(refresh では生成しない)
//  - metadata.model = MODEL_SONNET
//  - metadata.trigger = inferRefreshTrigger(action_history)
function assembleRefreshAnalysisResult(
  input: AnalyzeInputBundleRefresh,
  ai: AIRefreshAnalysisOutput,
  usage: { input: number; output: number; cache_read?: number; cache_creation?: number },
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
    model: MODEL_SONNET,
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

// =============================================================================
// Phase G Step 3b-2 (2026-05-23): partial mode streaming 実装
// =============================================================================
// 設計判断:
//   - モデル: Sonnet 4.6 + thinking 無し(refresh と同じ)
//   - max_tokens: PARTIAL_MAX_TOKENS = 8192(updated + added が 15 件以下に絞られる
//     ため initial の 16K / refresh の 12K より小さくて済む。安全マージンとして 8K 確保)
//   - tool: ANALYZE_ES_PARTIAL_REFRESH_TOOL
//   - few-shot: initial / refresh と同じ prefix を共有(cache を最大化)
//   - prompt cache 拡張: user メッセージを 2 ブロック構造にし、不変ブロックに
//     cache_control を立てる(cachedUserContext)。
//   - 防衛三段 Part 3: validateAnalysisAgainstInput(partial overload) + 1 回リトライ
const PARTIAL_MAX_TOKENS = 8192;

async function* analyzePartialStreaming(
  client: Anthropic,
  input: AnalyzeInput,
): AsyncGenerator<AnalyzeStreamEvent, void, void> {
  if (input.mode !== "partial") {
    yield {
      type: "error",
      kind: "api_error",
      message: "analyzePartialStreaming called with non-partial input",
      stage: "analyze_partial_stream",
    };
    return;
  }

  // tools 配列: partial 専用ツール、cache_control で「ここまで(system + tools)を
  // ephemeral cache」のマーカー。
  const tools: Anthropic.Messages.ToolUnion[] = [
    { ...ANALYZE_ES_PARTIAL_REFRESH_TOOL, cache_control: EPHEMERAL_CACHE },
  ];

  // user メッセージは 2 ブロック構造:
  //  1. 不変ブロック(Opus 評価軸 + 既存 suggestions サマリ + 静的指示)
  //     → cache_control で ephemeral cache する。session 内で再利用される。
  //  2. 可変ブロック(派生 ES + action_history + 添削条件 等 + チェックリスト)
  //     → 操作のたびに変わるため cache 対象外。
  const invariantText = buildPartialInvariantBlock(input);
  const variableText = buildPartialVariableBlock(input);

  // few-shot prefix は initial / refresh と完全に同じ(キャッシュ共有のため、Phase D 判断と整合)
  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: "user",
      content: ANALYZE_FEWSHOT_USER_MESSAGE,
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: FEWSHOT_TOOL_USE_ID,
          name: ANALYZE_ES_TOOL_NAME,
          input: ANALYZE_FEWSHOT_ASSISTANT_INPUT,
          cache_control: EPHEMERAL_CACHE,
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: FEWSHOT_TOOL_USE_ID,
          content:
            "上記は few-shot 例として受理しました。続けて次の入力に対して analyze_es_partial_refresh を呼んでください。interview_questions と es_state_version は出力しないでください(ツールスキーマから除外されています)。",
        },
        // 2 ブロック構造: 不変(cache)+ 可変(都度)
        ...cachedUserContext(invariantText),
        { type: "text", text: variableText },
      ],
    },
  ];

  let retryAttempted = false;
  let totalUsage: {
    input: number;
    output: number;
    cache_read?: number;
    cache_creation?: number;
  } = { input: 0, output: 0 };

  for (let attempt = 0; attempt < 2; attempt++) {
    // started event(リトライ時は attempt: 2)
    yield {
      type: "started",
      mode: "partial",
      model: MODEL_SONNET,
      attempt: attempt + 1,
    };

    let finalMessage: Anthropic.Messages.Message;
    let cumulativeInputChars = 0;

    try {
      const stream = client.messages.stream({
        model: MODEL_SONNET,
        max_tokens: PARTIAL_MAX_TOKENS,
        // Sonnet 4.6 では thinking 無効(Phase D 同期版 / refresh と整合)
        system: cachedSystem(ANALYZE_SYSTEM_PROMPT),
        tools,
        messages,
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta") {
          const delta = event.delta;
          if (delta.type === "thinking_delta") {
            const text = delta.thinking ?? "";
            if (text.length > 0) {
              yield { type: "thinking", delta: text };
            }
          } else if (delta.type === "input_json_delta") {
            const partial = delta.partial_json ?? "";
            cumulativeInputChars += partial.length;
            yield {
              type: "tool_progress",
              cumulativeChars: cumulativeInputChars,
            };
          }
        }
      }

      finalMessage = await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        yield {
          type: "error",
          kind: "rate_limit",
          message: "Anthropic rate limit hit",
          stage: "analyze_partial_stream",
          retryable: true,
        };
        return;
      }
      if (err instanceof Anthropic.APIError) {
        yield {
          type: "error",
          kind: "api_error",
          message: `Anthropic API error: ${err.message}`,
          stage: "analyze_partial_stream",
          retryable: true,
        };
        return;
      }
      yield {
        type: "error",
        kind: "unknown",
        message:
          err instanceof Error ? err.message : "Unknown Anthropic SDK error",
        stage: "analyze_partial_stream",
      };
      return;
    }

    // ----- usage 累計 -----
    totalUsage = {
      input: totalUsage.input + (finalMessage.usage?.input_tokens ?? 0),
      output: totalUsage.output + (finalMessage.usage?.output_tokens ?? 0),
      cache_read:
        (totalUsage.cache_read ?? 0) +
        (finalMessage.usage?.cache_read_input_tokens ?? 0),
      cache_creation:
        (totalUsage.cache_creation ?? 0) +
        (finalMessage.usage?.cache_creation_input_tokens ?? 0),
    };

    // partial ツールの tool_use ブロックを取り出す
    const toolUseBlock = finalMessage.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock =>
        b.type === "tool_use" &&
        b.name === ANALYZE_ES_PARTIAL_REFRESH_TOOL_NAME,
    );

    if (!toolUseBlock) {
      yield {
        type: "error",
        kind: "api_error",
        message:
          "Anthropic が analyze_es_partial_refresh ツールを呼ばずに応答を終えました",
        stage: "analyze_partial_stream",
      };
      return;
    }

    // 防衛三段 Part 3: Zod + context-dependent 検証
    const validation = validateAnalysisAgainstInput(toolUseBlock.input, input);
    if (validation.ok) {
      // 成功 — partial 結果を組み立てて completed yield
      let result: PartialAnalysisResult;
      try {
        result = assemblePartialAnalysisResult(input, validation.data, totalUsage);
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

    // 検証失敗 — リトライ判定
    if (retryAttempted) {
      console.error(
        "[AnthropicProvider.analyzePartialStream] validation failed after retry",
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

    // 1 回だけリトライ
    retryAttempted = true;
    const issueKinds = validation.issues.map((i) => i.kind);
    yield { type: "retry", issueKinds };

    const retryMessage = buildAnalysisRetryMessage(validation.issues, input);
    console.warn(
      "[AnthropicProvider.analyzePartialStream] retry triggered",
      JSON.stringify({ issues: issueKinds }),
    );

    messages.push({
      role: "assistant",
      content:
        finalMessage.content as unknown as Anthropic.Messages.ContentBlockParam[],
    });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseBlock.id,
          content: JSON.stringify({
            error: "validation_failed",
            kinds: issueKinds,
          }),
          is_error: true,
        },
        { type: "text", text: retryMessage },
      ],
    });
  }

  yield {
    type: "error",
    kind: "unknown",
    message:
      "analyzePartialStreaming: unreachable — validation loop exhausted without yield",
    stage: "analyze_partial_stream",
  };
}

// AIPartialAnalysisOutput + input → PartialAnalysisResult。
//  - es_state_version = input.current_es_version + 1(サーバ強制、refresh と同じ)
//  - updated / added の各 suggestion は resolveOriginalSpans で original_span を付与
//  - display_priority をヒューリスティック補正で付与 + internal_priority を消去
//  - overall_assessment は AI 出力(optional)、なければ undefined のまま(applyPartialResult
//    側で「未更新」として既存 Opus 評価を保持する)
//  - metadata.model = MODEL_SONNET
//  - metadata.trigger = inferPartialTrigger(action_history)
function assemblePartialAnalysisResult(
  input: AnalyzeInputBundlePartial,
  ai: AIPartialAnalysisOutput,
  usage: { input: number; output: number; cache_read?: number; cache_creation?: number },
): PartialAnalysisResult {
  // updated と added それぞれ resolveOriginalSpans → display_priority 付与
  const updatedResolve = resolveOriginalSpans(
    input.es_body,
    ai.updated as AISuggestion[],
  );
  const addedResolve = resolveOriginalSpans(
    input.es_body,
    ai.added as AISuggestion[],
  );

  // partial では「originalが ES に見つからない」は片方ずつ存在しうる
  const allMissing = [...updatedResolve.missing, ...addedResolve.missing];
  if (allMissing.length > 0) {
    throw new LLMError(
      "analysis_validation",
      `${allMissing.length} suggestion(s) have original text not present in es_body (partial post-validation anchor failure)`,
      { missing_ids: allMissing.map((m) => m.id) },
    );
  }

  // display_priority 付与は acceptedSuggestionIds を引数に渡す
  // (重複ペナルティ:related_suggestion_ids が採用済とマッチ → -1 段階)
  const acceptedIds = input.accepted_suggestion_ids;
  const updatedWithPriority = updatedResolve.resolved.map((s) =>
    assignDisplayPriority(s, acceptedIds),
  );
  const addedWithPriority = addedResolve.resolved.map((s) =>
    assignDisplayPriority(s, acceptedIds),
  );

  const metadata: AnalysisMetadata = {
    generated_at: new Date().toISOString(),
    model: MODEL_SONNET,
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

// /api/interview の面接質問生成実装。
// lib/prompts/interview.ts: 独立ツール generate_interview_questions を使用。
// few-shot prefix は initial / refresh と共有(static cache の最大化)。
async function generateInterviewImpl(
  client: Anthropic,
  input: InterviewInputBundle,
): Promise<InterviewQuestions> {
  const tools: Anthropic.Messages.ToolUnion[] = [
    { ...GENERATE_INTERVIEW_QUESTIONS_TOOL, cache_control: EPHEMERAL_CACHE },
  ];

  const realUserMessage = buildInterviewUserMessage(input);

  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: "user",
      content: ANALYZE_FEWSHOT_USER_MESSAGE,
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: FEWSHOT_TOOL_USE_ID,
          name: ANALYZE_ES_TOOL_NAME,
          input: ANALYZE_FEWSHOT_ASSISTANT_INPUT,
          cache_control: EPHEMERAL_CACHE,
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: FEWSHOT_TOOL_USE_ID,
          content:
            "上記は few-shot 例として受理しました。続けて次の入力に対して generate_interview_questions を呼んでください。suggestions / overall_assessment / generated_at_es_version / is_stale は出力しないでください(ツールスキーマから除外されています)。",
        },
        { type: "text", text: realUserMessage },
      ],
    },
  ];

  let retryAttempted = false;
  let totalUsage: {
    input: number;
    output: number;
    cache_read?: number;
    cache_creation?: number;
  } = { input: 0, output: 0 };

  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Anthropic.Messages.Message;
    try {
      response = await client.messages.create({
        model: MODEL_SONNET,
        max_tokens: INTERVIEW_MAX_TOKENS,
        system: cachedSystem(ANALYZE_SYSTEM_PROMPT),
        tools,
        messages,
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        throw new LLMError("rate_limit", "Anthropic rate limit hit", err);
      }
      if (err instanceof Anthropic.APIError) {
        throw new LLMError("api_error", `Anthropic API error: ${err.message}`, err);
      }
      throw new LLMError("unknown", "Unknown Anthropic SDK error", err);
    }

    totalUsage = {
      input: totalUsage.input + (response.usage?.input_tokens ?? 0),
      output: totalUsage.output + (response.usage?.output_tokens ?? 0),
      cache_read:
        (totalUsage.cache_read ?? 0) + (response.usage?.cache_read_input_tokens ?? 0),
      cache_creation:
        (totalUsage.cache_creation ?? 0) +
        (response.usage?.cache_creation_input_tokens ?? 0),
    };

    const toolUseBlock = response.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock =>
        b.type === "tool_use" &&
        b.name === GENERATE_INTERVIEW_QUESTIONS_TOOL_NAME,
    );

    if (!toolUseBlock) {
      throw new LLMError(
        "api_error",
        "Anthropic が generate_interview_questions ツールを呼ばずに応答を終えました",
        { stop_reason: response.stop_reason, attempt },
      );
    }

    const validation = validateInterviewOutput(toolUseBlock.input, input);
    if (validation.ok) {
      return assembleInterviewResult(input, validation.data, totalUsage);
    }

    if (retryAttempted) {
      console.error(
        "[AnthropicProvider.generateInterview] validation failed after retry",
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
      "[AnthropicProvider.generateInterview] retry triggered",
      JSON.stringify({ issues: validation.issues.map((i) => i.kind) }),
    );

    messages.push({
      role: "assistant",
      content: response.content as unknown as Anthropic.Messages.ContentBlockParam[],
    });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseBlock.id,
          content: JSON.stringify({
            error: "validation_failed",
            kinds: validation.issues.map((i) => i.kind),
          }),
          is_error: true,
        },
        { type: "text", text: retryMessage },
      ],
    });
  }

  throw new LLMError(
    "unknown",
    "generateInterviewImpl: unreachable — validation loop exhausted without return",
  );
}

// AIInterviewOutput + input → InterviewQuestions(サーバ側で is_stale / generated_at_es_version を付与)。
// LLM 出力は questions だけなので、サーバが残りを決定論的に組み立てる(キックオフ判断4)。
// usage はメタとして InterviewQuestions に直接埋めず、route 側で必要なら別フィールド経由で公開する。
function assembleInterviewResult(
  input: InterviewInputBundle,
  ai: AIInterviewOutput,
  _usage: { input: number; output: number; cache_read?: number; cache_creation?: number },
): InterviewQuestions {
  return {
    generated_at_es_version: input.current_es_version,
    is_stale: false,
    questions: ai.questions,
  };
}

// generateInterviewImpl の usage を route 層から取り出すための拡張(オプション)。
// InterviewQuestions スキーマに metadata を持たせると Zod 検証が厳しくなるため、
// 当面は console.log で観測する(Phase C analyze と同じスタンス)。
//
// Phase D セッション6 では「動いていることの観測」を優先し、metadata は console.warn で代用。
