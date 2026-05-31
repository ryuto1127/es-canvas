"use client";

// =============================================================================
// ApiKeySettings — BYOK 設定パネル(2026-05-29)
// =============================================================================
//
// 公開デプロイ版を友達・親に共有できるよう、各ユーザーが自分の OpenAI API キーを
// 入力して使う設計(BYOK)。本コンポーネントはヘッダ右上の歯車ボタンから開く
// 設定パネルで、キーの入力 / 保存 / 削除を行う。
//
// 設計判断:
//  - **新規依存を入れない**。既存の shadcn ラッパ(Popover / Input / Button)を再利用。
//    Popover は @base-ui/react ベース(package.json に既存)、追加 npm install 不要。
//  - キーの永続化は `lib/byok.ts`(localStorage、SSR 安全)。本 component は state と
//    UI だけを持ち、保存ロジックは byok util に委譲。
//  - 保存 / 削除のフィードバックは **インライン**(ステータス行)。アプリに toast
//    基盤(sonner 等)が無いため、依存を増やさずインラインで完結させる。
//  - キー入力は `type="password"`(肩越しの覗き見対策)。表示 / 非表示トグルを付ける。
//  - キー取得先リンクは `target="_blank" rel="noopener noreferrer"`。
//
// プライバシー注記(必須表示):
//  - 「このキーはあなたのブラウザにのみ保存され、サーバーには保存されません。」
//    (i18n: settings.privacy_note)
//
// AGENTS.md Out of scope(localStorage は v1 スコープ外)の唯一の例外が本 BYOK キー。
// 他のアプリ状態は localStorage に載せない(byok util も鍵専用)。

import * as React from "react";
import { useTranslations } from "next-intl";
import {
  Settings,
  Eye,
  EyeOff,
  ExternalLink,
  Check,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  getStoredOpenAIKey,
  setStoredOpenAIKey,
  clearStoredOpenAIKey,
  subscribeOpenAIKey,
  subscribeOpenSettings,
} from "@/lib/byok";
import { cn } from "@/lib/utils";

const OPENAI_KEYS_URL = "https://platform.openai.com/api-keys";

export function ApiKeySettings() {
  const t = useTranslations("settings");

  // 保存済みキーの有無を localStorage(外部ストア)から購読する。
  // useSyncExternalStore は SSR 安全(getServerSnapshot で false 固定)で、
  // effect 内の setState を避けつつ hydration mismatch も起こさない React 流儀。
  const hasStoredKey = React.useSyncExternalStore(
    subscribeOpenAIKey,
    () => getStoredOpenAIKey() !== null,
    () => false,
  );

  // 入力欄の値(編集中バッファ)。popover を開くたびに最新の保存値で同期する。
  const [draft, setDraft] = React.useState("");
  // キー表示 / 非表示トグル。
  const [revealed, setRevealed] = React.useState(false);
  // 保存 / 削除直後のインラインフィードバック。
  //  - "saved": localStorage に永続保存できた
  //  - "memory_only": localStorage に書けず、当該セッションのみ有効(正直な案内)
  //  - "cleared": 削除した
  const [feedback, setFeedback] = React.useState<
    "saved" | "memory_only" | "cleared" | null
  >(null);

  // 開閉を controlled state にする(2026-05-29)。これにより鍵未設定エラー UI の
  // 「設定を開く」アクション(lib/byok.ts:requestOpenSettings)から外部要求で
  // 開けるようになる。開くたびの draft 同期 / フィードバックリセットは
  // syncOnOpen に集約。
  const [open, setOpen] = React.useState(false);

  // 開いた瞬間に最新の保存値を入力欄へ反映し、フィードバック等をリセットする。
  // hasStoredKey は useSyncExternalStore で localStorage を購読しているため
  // ここで手動更新は不要(set/clear 時に自動で追従する)。
  const syncOnOpen = React.useCallback(() => {
    const stored = getStoredOpenAIKey();
    setDraft(stored ?? "");
    setFeedback(null);
    setRevealed(false);
  }, []);

  // エラー UI 等からの「設定を開く」要求を購読。要求が来たら open にして同期する。
  React.useEffect(() => {
    return subscribeOpenSettings(() => {
      syncOnOpen();
      setOpen(true);
    });
  }, [syncOnOpen]);

  function handleSave() {
    // setStoredOpenAIKey は「永続保存できたか / メモリのみか / クリアか」を返す。
    // localStorage に書けなかった場合(Safari プライベートブラウズ等)は嘘の
    // 「保存しました」を出さず、当該セッションのみ有効である旨を正直に案内する。
    const result = setStoredOpenAIKey(draft);
    if (result === "cleared") {
      setFeedback("cleared");
    } else if (result === "memory_only") {
      setFeedback("memory_only");
    } else {
      setFeedback("saved");
    }
  }

  function handleClear() {
    clearStoredOpenAIKey();
    setDraft("");
    setRevealed(false);
    setFeedback("cleared");
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // 開くたびに最新の保存値を入力欄に反映し、フィードバックをリセットする。
        if (next) syncOnOpen();
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="icon"
            aria-label={t("button_aria")}
            className="relative h-8 w-8"
          >
            <Settings className="size-4" aria-hidden />
            {/* 保存済みキーがあれば緑ドット、無ければ amber ドットでステータスを示す */}
            <span
              className={cn(
                "absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background",
                hasStoredKey ? "bg-emerald-500" : "bg-amber-500",
              )}
              aria-hidden
            />
          </Button>
        }
      />
      <PopoverContent align="end" className="w-80">
        <div className="flex flex-col gap-3">
          {/* タイトル + 説明 */}
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold">{t("title")}</h2>
            <p className="text-xs text-muted-foreground text-jp">
              {t("description")}
            </p>
          </div>

          {/* キー入力欄(password、表示トグル付き) */}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="byok-openai-key"
              className="text-xs font-medium text-foreground"
            >
              {t("key_label")}
            </label>
            <div className="relative">
              <Input
                id="byok-openai-key"
                type={revealed ? "text" : "password"}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setFeedback(null);
                }}
                placeholder={t("key_placeholder")}
                autoComplete="off"
                spellCheck={false}
                className="pr-8 font-mono text-xs"
              />
              <button
                type="button"
                onClick={() => setRevealed((v) => !v)}
                aria-label={revealed ? "hide" : "show"}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
              >
                {revealed ? (
                  <EyeOff className="size-3.5" aria-hidden />
                ) : (
                  <Eye className="size-3.5" aria-hidden />
                )}
              </button>
            </div>
          </div>

          {/* プライバシー注記(必須) */}
          <p className="text-xs text-muted-foreground text-jp">
            {t("privacy_note")}
          </p>

          {/* キー取得先リンク */}
          <a
            href={OPENAI_KEYS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            {t("get_key_link")}
            <ExternalLink className="size-3" aria-hidden />
          </a>

          {/* 保存 / 削除ボタン */}
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handleSave} className="flex-1">
              {t("save")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleClear}
              disabled={!hasStoredKey && draft.trim().length === 0}
            >
              {t("clear")}
            </Button>
          </div>

          {/* インラインフィードバック。memory_only は「保存できなかった」正直な
              案内なので warning(amber)スタイル + 警告アイコンで、成功(緑 + Check)
              と視覚的に区別する。 */}
          {feedback === "memory_only" ? (
            <p className="flex items-start gap-1 text-xs text-amber-600 dark:text-amber-400 text-jp">
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
              {t("memory_only_toast")}
            </p>
          ) : feedback ? (
            <p className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
              <Check className="size-3.5" aria-hidden />
              {feedback === "saved" ? t("saved_toast") : t("cleared_toast")}
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
