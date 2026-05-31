// 設問ブロックのレンダリング(initial / refresh / partial / interview で共有)。
//
// 2026-05-29 char_limit 任意化:
//   設問の文字数制限(char_limit)は任意入力になった(制限の無い設問もあるため)。
//   - char_limit が正の整数なら従来どおり「(N字以内)」を付与し、LLM に上限を伝える。
//   - char_limit が未指定(undefined)なら「制限なし」とみなし、上限の記述を一切注入
//     しない。これにより LLM は文字数制限を前提にした圧縮提案(超過削減)を促されない。
//
// 既存挙動(char_limit 有り)を壊さないため、出力文字列は従来のインライン表現
// `[設問]\n${text}(${char_limit}字以内)` と完全一致させている(N 有りの場合)。
//
// SSOT: 4 つの prompt builder(initial.ts / refresh.ts / partial_refresh.ts /
// interview.ts)はすべて本関数を経由して設問ブロックを生成する(条件分岐の二重化を防ぐ)。
export function renderQuestionBlock(
  text: string,
  charLimit: number | undefined,
): string {
  if (typeof charLimit === "number") {
    return `[設問]\n${text}(${charLimit}字以内)`;
  }
  // 制限なし — 上限の記述を付けない(LLM に文字数制約を前提にさせない)。
  return `[設問]\n${text}`;
}
