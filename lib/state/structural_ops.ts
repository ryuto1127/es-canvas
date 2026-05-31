// =============================================================================
// structural_ops.ts — v2 Phase B3 (2026-05-26)
// =============================================================================
// `structural` カテゴリの suggestion を採用したときに `currentEsBody` に適用する
// 純粋関数群。AI ではなく client side で機械的に派生 ES を生成することで、
// hallucination リスクを回避し、即時 preview を実現する。
//
// 設計原則:
//  - 全関数は **純粋**(同じ input → 同じ output、副作用なし)
//  - 不正 index / 不正 params は **no-op**(元の esBody を返す)で defensive、throw しない
//  - 段落境界は `\n\n+` で split(空段落は弾く)
//  - 文境界は `[。!?]\s*` で split(各段落内)
//  - これらの境界は `lib/prompts/system.ts` (Phase B2) で AI に明示する規約と同一
//
// 呼び出し元:
//  - `lib/state/analyze_store.ts:acceptSuggestion` — structural 採用時に
//    `applyStructuralOperation(currentEsBody, suggestion.structural_params)` を呼ぶ
//  - `components/canvas/StructuralPreviewModal.tsx`(Phase B4 予定)— プレビュー生成
//
// 関連:
//  - `lib/schema/suggestion.ts:StructuralOperationParamsSchema`(Phase B1)
//  - DECISIONS.md [2026-05-26] v2 — structural カテゴリ導入
// =============================================================================

import type { StructuralOperationParams } from "@/lib/schema/suggestion";

// =============================================================================
// 境界判定 helper
// =============================================================================

/**
 * ES 本文を段落単位に分割する。
 *
 * 段落境界: `\n\n+`(2 連続改行以上)。空段落(trim 後 0 文字)は捨てる。
 * AI prompt(system.ts L_paragraphs_definition)と同一の規約。
 *
 * @returns 段落配列(0-indexed)
 */
export function splitParagraphs(esBody: string): string[] {
  return esBody.split(/\n\n+/).filter((p) => p.trim().length > 0);
}

/**
 * 段落本文を文単位に分割する。
 *
 * 文境界: 句読点（。 / ! / ?）+ 後続空白(0文字以上)を区切り文字とし、
 * 句読点 **および後続空白** を前の文に結合する。
 * 例: 「これは文1。文2!文3?」 → ["これは文1。", "文2!", "文3?"]
 * AI prompt(system.ts の文境界定義)と同一の規約。
 *
 * 実装方針(2026-05-30 N3 lossless 化):
 *  - 区切り文字を `[。!?]\s*`(句読点 + 後続空白)としてキャプチャ split する。
 *    例: 「a。 b! c?」 → ["a", "。 ", "b", "! ", "c", "?", ""]
 *  - 偶数 index = 本文、奇数 index = 区切り(句読点 + 空白)を pair で結合する。
 *    旧実装は `\s*` をキャプチャ外で消費して **空白を捨てて** いたため、move_sentence /
 *    文の再結合(`.join("")`)で元の空白・改行が失われる lossy 挙動だった。本実装は
 *    空白を区切りに含めて文側に保持するため、split → join("") が **ロスレス round-trip**
 *    になる(融合・空白消失を防ぐ)。
 *  - 末尾に句読点なし本文が残ったケース(「a。b」 → ["a", "。", "b"])もケアする。
 *
 * 注意: 返る各文は **後続空白を末尾に含む** ことがある(例: "文1。 ")。
 *   呼び出し側(move_sentence の `.join("")`)は round-trip 性を得るためこれをそのまま結合する。
 *   表示用に trim が必要な箇所では呼び出し側で trim すること(本関数は保存責務に専念)。
 *
 * @returns 文配列(0-indexed、句読点 + 後続空白付き)
 */
export function splitSentences(paragraph: string): string[] {
  const tokens = paragraph.split(/([。!?]\s*)/);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const body = tokens[i] ?? "";
    const delim = tokens[i + 1] ?? "";
    const joined = body + delim;
    if (joined.length > 0) out.push(joined);
  }
  return out.filter((s) => s.trim().length > 0);
}

/**
 * 段落本文を「1 つの段落」に統合する際の境界結合(2026-05-30 N3 融合防止)。
 *
 * 背景: merge_paragraphs は複数段落の本文を 1 段落に結合する。旧実装は `.join("")` で
 *   無区切り連結していたため、左段落が句点で終わらない場合に「…末尾先頭…」と文が融合した。
 *
 * ルール(隣接する 2 ピースの境界ごとに判定):
 *  - 左ピースが空 / 右ピースが空 → そのまま連結(区切り不要)
 *  - 境界に既に空白がある(左の末尾 or 右の先頭が空白)→ 区切り不要(既存空白を尊重)
 *  - 左ピースの最後の非空白文字が文末句読点(。/ ! / ? / 全角・半角)→ 区切り不要
 *    (句読点が既に文境界を成しているため、空白を足すと冗長)
 *  - 上記いずれでもない(句点で終わらず空白も無い)→ 半角スペース 1 つを挿入して融合を防ぐ
 *
 * 純粋関数 / 副作用なし。日本語は文間スペース不要だが、本来別段落だった内容が
 * 無境界で癒着するのを防ぐ最小介入として半角スペースを採用(改行は段落内なので使わない)。
 */
const SENTENCE_ENDING_PUNCT = /[。．！？!?]$/;

export function joinParagraphContents(pieces: string[]): string {
  let result = "";
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (i === 0) {
      result = piece;
      continue;
    }
    if (piece.length === 0 || result.length === 0) {
      result += piece;
      continue;
    }
    const leftEndsWhitespace = /\s$/.test(result);
    const rightStartsWhitespace = /^\s/.test(piece);
    const leftEndsSentence = SENTENCE_ENDING_PUNCT.test(result.replace(/\s+$/, ""));
    if (leftEndsWhitespace || rightStartsWhitespace || leftEndsSentence) {
      result += piece;
    } else {
      result += " " + piece;
    }
  }
  return result;
}

// =============================================================================
// 5 operations の純粋関数(applyStructuralOperation)
// =============================================================================

/**
 * structural operation を適用して新しい ES 本文を返す。
 *
 * - 不正 index / 不正 params の場合は **元の esBody をそのまま返す**(no-op、throw しない)
 * - operation は discriminated union により型安全に narrow される
 *
 * @param esBody 適用対象の ES 本文
 * @param params 適用する structural operation の params(discriminated union)
 * @returns 適用後の ES 本文(不正なら元のまま)
 */
export function applyStructuralOperation(
  esBody: string,
  params: StructuralOperationParams,
): string {
  const paragraphs = splitParagraphs(esBody);

  switch (params.operation) {
    case "delete_paragraph": {
      if (params.target_paragraph_index < 0) return esBody;
      if (params.target_paragraph_index >= paragraphs.length) return esBody;
      return paragraphs
        .filter((_, i) => i !== params.target_paragraph_index)
        .join("\n\n");
    }

    case "reorder_paragraphs": {
      // 長さ一致 + 全 index が存在範囲 + 全 index ユニーク = permutation 検証
      if (params.new_order.length !== paragraphs.length) return esBody;
      if (params.new_order.some((i) => i < 0 || i >= paragraphs.length)) return esBody;
      const seen = new Set<number>();
      for (const i of params.new_order) {
        if (seen.has(i)) return esBody;
        seen.add(i);
      }
      return params.new_order.map((i) => paragraphs[i]).join("\n\n");
    }

    case "merge_paragraphs": {
      if (
        params.target_paragraph_indices.some(
          (i) => i < 0 || i >= paragraphs.length,
        )
      ) {
        return esBody;
      }
      // 重複 index は弾く(同じ段落を 2 回統合は意味なし)
      const uniqIndices = Array.from(new Set(params.target_paragraph_indices));
      if (uniqIndices.length !== params.target_paragraph_indices.length) return esBody;
      const indicesSet = new Set(uniqIndices);
      // 統合内容は元の順序を維持(target_paragraph_indices の指定順ではなく、ES 出現順)
      const sortedIndices = [...uniqIndices].sort((a, b) => a - b);
      // 2026-05-30 N3: 無区切り `.join("")` は左段落が句点で終わらない場合に文を融合させる。
      // joinParagraphContents で「句点なし境界には半角スペース 1 つ」を挿入して融合を防ぐ。
      const merged = joinParagraphContents(sortedIndices.map((i) => paragraphs[i]));
      // remaining = 統合対象外段落、insertAt = 統合対象の最小 index 位置
      const remaining = paragraphs.filter((_, i) => !indicesSet.has(i));
      const insertAt = sortedIndices[0];
      remaining.splice(insertAt, 0, merged);
      return remaining.join("\n\n");
    }

    case "move_sentence": {
      // 2026-05-30 N2 調査メモ(粗さは仕様として意図的、欠陥ではない):
      //   target_position は before | after の 2 値のみ(target 段落内の文 index を持たない)
      //   ため、移動文は target 段落の **先頭 or 末尾** にしか着地しない。AI が「段落中ほどの
      //   この文の直後」を意図しても、最も近い段落境界に丸められる。
      //   ただし検証の結果、文の消失 / 重複 / 別段落への誤挿入は **発生しない**(移動前後で
      //   文の multiset は保存、移動文は必ず target 段落に入る)。粗さ = 着地位置の粒度のみ。
      //   段落内 index 指定(target_sentence_index)は load-bearing な structural_params
      //   スキーマ拡張になり submission 直前のリスクが高いため v2 候補とし、v1 では before/after
      //   の粗い粒度を「仕様」として据え置く(HITL ではユーザーが採用後に微調整できる)。
      if (params.source_paragraph_index < 0) return esBody;
      if (params.source_paragraph_index >= paragraphs.length) return esBody;
      if (params.target_paragraph_index < 0) return esBody;
      if (params.target_paragraph_index >= paragraphs.length) return esBody;
      const sourceSentences = splitSentences(paragraphs[params.source_paragraph_index]);
      if (params.source_sentence_index < 0) return esBody;
      if (params.source_sentence_index >= sourceSentences.length) return esBody;
      const movingSentence = sourceSentences[params.source_sentence_index];
      const newSourceSentences = sourceSentences.filter(
        (_, i) => i !== params.source_sentence_index,
      );

      // source と target が同一段落のケース: 配列を一度操作してから join
      if (params.source_paragraph_index === params.target_paragraph_index) {
        // target_position に従って挿入(remove 後の位置基準)
        const insertAt =
          params.target_position === "before" ? 0 : newSourceSentences.length;
        newSourceSentences.splice(insertAt, 0, movingSentence);
        const newParagraph = newSourceSentences.join("");
        const newParagraphs = paragraphs.map((p, i) =>
          i === params.source_paragraph_index ? newParagraph : p,
        );
        return newParagraphs.filter((p) => p.trim().length > 0).join("\n\n");
      }

      // source と target が別段落
      const targetSentences = splitSentences(paragraphs[params.target_paragraph_index]);
      const insertAt =
        params.target_position === "before" ? 0 : targetSentences.length;
      targetSentences.splice(insertAt, 0, movingSentence);
      const newSourceParagraph = newSourceSentences.join("");
      const newTargetParagraph = targetSentences.join("");
      const newParagraphs = paragraphs.map((p, i) => {
        if (i === params.source_paragraph_index) return newSourceParagraph;
        if (i === params.target_paragraph_index) return newTargetParagraph;
        return p;
      });
      // 移動後に source 段落が空になるケースは段落自体を削除
      return newParagraphs.filter((p) => p.trim().length > 0).join("\n\n");
    }

    case "add_paragraph": {
      if (params.target_paragraph_index < 0) return esBody;
      // 末尾追加を許容するため、`==` paragraphs.length も有効
      // target_position === "before" のとき index < paragraphs.length が必要、
      // target_position === "after" のとき index < paragraphs.length が必要(末尾段落の after を許容)
      if (params.target_paragraph_index >= paragraphs.length) return esBody;
      const inserted = [...paragraphs];
      const insertAt =
        params.target_position === "before"
          ? params.target_paragraph_index
          : params.target_paragraph_index + 1;
      inserted.splice(insertAt, 0, params.new_content);
      return inserted.join("\n\n");
    }
  }
}
