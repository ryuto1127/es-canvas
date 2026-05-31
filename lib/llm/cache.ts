import type Anthropic from "@anthropic-ai/sdk";

// Anthropic プロンプトキャッシング: ephemeral タイプの cache_control を共通定数で出す
// DECISION: キャッシュ境界は「変わらない先頭(system + few-shot + tools)」と「都度変わるユーザー入力」で分ける
// DECISION: [2026-05-21] "Anthropic キャッシュ境界は「system + tools」を1ブロックで括る" を参照
export const EPHEMERAL_CACHE: Anthropic.Messages.CacheControlEphemeral = { type: "ephemeral" };

// system プロンプトを cache 対象として返す。一文字列を1ブロックでラップ
export function cachedSystem(text: string): Anthropic.Messages.TextBlockParam[] {
  return [
    {
      type: "text",
      text,
      cache_control: EPHEMERAL_CACHE,
    },
  ];
}

// Phase G Step 3b-2 (2026-05-23): user メッセージ内に cache 境界を立てるための helper。
// partial update 経路で Opus の評価軸(不変ブロック)を ephemeral cache 対象として
// 渡すために使う。messages.user.content の 1 ブロックとして "cache まで" のマーカー
// を立てる(ここまでが不変 = cache 対象、次のブロックは可変)。
//
// 設計判断:
//  - cachedSystem と同じ shape(TextBlockParam[] を返す)で API 揃え
//  - 呼び出し側は cachedUserContext(invariant) と { type: "text", text: variable } を
//    並べて user.content に渡す
export function cachedUserContext(
  text: string,
): Anthropic.Messages.TextBlockParam[] {
  return [
    {
      type: "text",
      text,
      cache_control: EPHEMERAL_CACHE,
    },
  ];
}
