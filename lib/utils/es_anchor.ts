import type { AISuggestion } from "../schema/suggestion";
import type { Suggestion } from "../schema/suggestion";

// Phase C: AI 出力の suggestion.original を ES 本体に対して indexOf で位置解決する。
// LLM はインデックス計算が苦手なので、サーバ側で確実に解決する判断(キックオフ Section 2 判断2)。
//
// DECISION (セッション5):
//  - 複数箇所に同じ文字列が出現する場合は「最初のヒット位置」を採用する。
//    Phase F の二方向ハイライトで曖昧性が問題になったら、AI に前後コンテキスト文字列を
//    追加出力させる方式に拡張する。本セッションでは未対応。
//  - 見つからないケースは validateAnalysisAgainstInput で先に弾く想定(防衛三段の Part 3)。
//    リトライ後も残った場合は、ここでは LLMError を投げず {found: false} を返す責務分離。

export type AnchorResult =
  | { found: true; suggestion: Suggestion }
  | { found: false; aiSuggestion: AISuggestion };

// 1件の AISuggestion を Suggestion(original_span 付き)に変換する。
function resolveOne(esBody: string, ai: AISuggestion): AnchorResult {
  const start = esBody.indexOf(ai.original);
  if (start < 0) {
    return { found: false, aiSuggestion: ai };
  }
  const end = start + ai.original.length;
  return {
    found: true,
    suggestion: {
      ...ai,
      original_span: { start, end },
    },
  };
}

// 全 AISuggestion を一括で位置解決する。
// 見つからないものは missing[] に集める(呼び出し側で LLMError("analysis_validation") を投げる想定)。
export function resolveOriginalSpans(
  esBody: string,
  aiSuggestions: AISuggestion[],
): {
  resolved: Suggestion[];
  missing: AISuggestion[];
} {
  const resolved: Suggestion[] = [];
  const missing: AISuggestion[] = [];
  for (const ai of aiSuggestions) {
    const r = resolveOne(esBody, ai);
    if (r.found) {
      resolved.push(r.suggestion);
    } else {
      missing.push(r.aiSuggestion);
    }
  }
  return { resolved, missing };
}
