"use client";

// =============================================================================
// Phase F UX 改修 1 (2026-05-23): 分析後の入力サマリバー(collapsible)
// =============================================================================
//
// 責務:
//  - `phase === "done"` のときに、入力フォームの代わりに表示する**畳まれた要約**
//  - 折りたたみ時(デフォルト): 1 行で「ES 冒頭 30 字 / 設問冒頭 / 企業情報 / プリセット」
//    程度のメタ情報 + 「編集する」ボタン
//  - 展開時: 各フィールドの中身を read-only で表示 + 「編集する」ボタン
//  - 「編集する」ボタン押下時: `startEditingMode()` を呼び、現在の form / 結果 /
//    Canvas 状態を snapshot した上で `phase = idle` に遷移する。InputForm が
//    再表示される。編集モードからは「戻る」(snapshot restore)または
//    「分析開始」(新規セッション)に分岐する(MainArea 側で UI 提供)。
//
// 設計判断:
//  1) **デフォルト折りたたみ** — Canvas を主役にするため、サマリバーは最小限の高さに。
//     ユーザーが入力を確認したい時だけ展開可能。
//  2) **「編集する」と「再分析する」の違い** — 本コンポーネントの「編集する」は
//     編集モード経由で、何も変えずに「戻る」が可能(snapshot restore)、
//     または変更を反映して「分析開始」(新規セッション、action_history は失われる)。
//     Canvas の「再分析する」(Phase F Step 2 で配置、現在は disabled)は
//     `action_history` を保持して /api/analyze refresh を呼ぶ別経路。
//  3) **form 値は保持** — `startEditingMode()` は form を触らない。ユーザーが
//     直前の入力を修正する UX。
//  4) **企業情報の表示** — 選択されている input_type に応じて該当フィールドを表示。
//
// UX 改修 1b (2026-05-23):
//  - 従来は `resetSession()` 経由で「戻れない」破壊的な編集モード遷移だったが、
//    `startEditingMode()` 経由に変更。何も変えずに戻りたいユーザーが結果画面に
//    戻れるようになった。
//
// AGENTS.md Inviolable constraints との対応:
//  - 数値スコア禁止: サマリバーには数値スコアを出さない(文字数のみ表示)
//  - ES 全面書き換え禁止: サマリは閲覧専用、編集は InputForm 経由でのみ
//  - localStorage 不使用: 全 state は store メモリのみ
//
// SSOT: lib/state/analyze_store.ts (form, startEditingMode, cancelEditingMode)

import * as React from "react";
import { useTranslations } from "next-intl";
import { useAnalyzeStore } from "@/lib/state/analyze_store";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronUp, FilePenLine, Settings2 } from "lucide-react";

// =============================================================================
// 1 行サマリ用の冒頭抜粋(全角 30 字程度で切る)
// =============================================================================
function truncate(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max) + "…";
}

// =============================================================================
// 企業情報の 1 行サマリ(input_type ごと、i18n 経由で表示)
// =============================================================================
function buildCompanySummaryLabel(
  type: "url" | "name" | "freetext",
  url: string,
  name: string,
  freetext: string,
  emptyLabel: string,
  freetextTemplate: (count: number) => string,
): string {
  switch (type) {
    case "url":
      return url.trim().length > 0 ? truncate(url, 40) : emptyLabel;
    case "name":
      return name.trim().length > 0 ? truncate(name, 30) : emptyLabel;
    case "freetext":
      return freetext.trim().length > 0
        ? freetextTemplate(freetext.length)
        : emptyLabel;
  }
}

// =============================================================================
// InputSummaryBar 本体
// =============================================================================
export function InputSummaryBar() {
  const t = useTranslations("inputSummary");
  const tCompanyType = useTranslations("companyInputType");
  const tCommon = useTranslations("common");
  const tPreset = useTranslations("preset");
  const form = useAnalyzeStore((s) => s.form);
  const startEditingMode = useAnalyzeStore((s) => s.startEditingMode);

  // 折りたたみ状態(デフォルト: 閉じる)。本バーは Canvas を主役にするため、
  // 詳細はユーザーが「展開する」を押した時にだけ見えるようにする。
  const [open, setOpen] = React.useState(false);

  const handleEdit = React.useCallback(() => {
    // 編集モード = snapshot 退避 + idle へ。
    // 「戻る」で何も変えずに結果画面に戻れる(snapshot restore)、
    // または「分析開始」で変更を反映して新規セッションへ進める。
    startEditingMode();
  }, [startEditingMode]);

  const esPreview = truncate(form.es_body, 30);
  const questionPreview = truncate(form.question_text, 30);
  const companyPreview = buildCompanySummaryLabel(
    form.company_input_type,
    form.company_url,
    form.company_name,
    form.company_freetext,
    tCommon("unanswered"),
    (count) => t("freetext_chars_template", { count }),
  );

  return (
    <Card size="sm" className="border-border/60 bg-card/70">
      <CardContent className="flex flex-col gap-3 py-3">
        <Collapsible open={open} onOpenChange={setOpen}>
          {/* ヘッダー行: 折りたたみ時の 1 行サマリ + 編集 / 展開ボタン */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* 1 行サマリ(折りたたみ時も常時表示) */}
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Settings2 className="size-3" />
                <span>{t("section_label")}</span>
              </span>
              <span className="text-foreground/80" title={form.es_body}>
                {t("es_prefix")} <span className="font-medium">「{esPreview}」</span>
              </span>
              <span className="text-muted-foreground" title={form.question_text}>
                {t("question_prefix")} 「{questionPreview}」
              </span>
              <span className="text-muted-foreground">
                {t("company_prefix_template", {
                  type: tCompanyType(form.company_input_type),
                })}{" "}
                {companyPreview}
              </span>
              <Badge variant="outline" className="text-[10px]">
                {tPreset(form.preset)}
              </Badge>
            </div>

            {/* ボタン列: 編集する + 展開トグル */}
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="xs"
                onClick={handleEdit}
                title={t("edit_button_title")}
              >
                <FilePenLine className="size-3" />
                <span>{t("edit_button")}</span>
              </Button>
              <CollapsibleTrigger
                render={
                  <Button
                    variant="ghost"
                    size="xs"
                    aria-label={open ? t("collapse_aria") : t("expand_aria")}
                    title={open ? t("collapse_title") : t("expand_title")}
                  >
                    {open ? (
                      <ChevronUp className="size-3" />
                    ) : (
                      <ChevronDown className="size-3" />
                    )}
                  </Button>
                }
              />
            </div>
          </div>

          {/* 展開時の詳細(全フィールド read-only) */}
          <CollapsibleContent>
            <div className="mt-3 grid grid-cols-1 gap-3 border-t border-border/40 pt-3 text-xs lg:grid-cols-2">
              <DetailRow label={t("detail_es_body")} value={form.es_body} multiline />
              <DetailRow label={t("detail_question")} value={form.question_text} multiline />
              <DetailRow
                label={t("detail_char_limit")}
                value={
                  form.char_limit.trim().length > 0
                    ? `${form.char_limit} ${tCommon("char_unit")}`
                    : t("detail_char_limit_none")
                }
              />
              <DetailRow
                label={t("detail_company_label", {
                  type: tCompanyType(form.company_input_type),
                })}
                value={
                  form.company_input_type === "url"
                    ? form.company_url
                    : form.company_input_type === "name"
                      ? form.company_name
                      : form.company_freetext
                }
                multiline={form.company_input_type === "freetext"}
              />
              <DetailRow label={t("detail_preset")} value={tPreset(form.preset)} />
              <DetailRow
                label={t("detail_free_text")}
                value={form.free_text}
                multiline
              />
              <DetailRow
                label={t("detail_user_context")}
                value={form.user_context}
                multiline
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}

// =============================================================================
// 展開時の詳細行(label + value、空なら「未入力」表示)
// =============================================================================
function DetailRow({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  const tCommon = useTranslations("common");
  const empty = value.trim().length === 0;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      {empty ? (
        <span className="text-muted-foreground italic">{tCommon("unanswered")}</span>
      ) : multiline ? (
        <p className="leading-relaxed whitespace-pre-wrap text-foreground/85 text-jp">
          {value}
        </p>
      ) : (
        <span className="text-foreground/85">{value}</span>
      )}
    </div>
  );
}
