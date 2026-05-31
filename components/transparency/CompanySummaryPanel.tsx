"use client";

// =============================================================================
// Commit D-4 (2026-05-25): 透明性 UI — 右パネル用 企業要約 詳細展開
// =============================================================================
//
// 責務(下部 ResultPanel の CompanySummarySection との違い):
//  - ResultPanel 下部の CompanySummarySection は「全体を読み返す」用の総括表示
//  - 本コンポーネントは「ES 編集中に右パネルから参照する」用の transparency-first 表示
//  - 各 evidence の "claim" と "source_quote" を強調し、`evidence_id` を明示
//    (SuggestionCard の rationale_source.evidence_id から本パネルに飛べる導線を D-4 で追加)
//  - 価値観・採用基準は subtle に表示、evidence list が主役
//
// 設計判断:
//  1) **AI が読み取ったものを「証拠単位」で見せる** — HITL 哲学
//     「個々のHITLが適切でも全体として人間の判断品質を劣化させない」を、
//     「AI の判断根拠の trace を可視化」の形で実装
//  2) **`evidence_id` をハイライト可能に** — SuggestionCard の rationale_source から
//     本パネルの該当 evidence へ scroll する経路を D-4 で接続
//  3) **数値スコア禁止** — 「N 件」表示はカウントのみ、評価の数値化はしない
//
// AGENTS.md Inviolable constraints:
//  - 数値スコア禁止: evidence の件数のみ表示
//  - localStorage 不使用: store 直接購読
//  - rationale_source の捏造禁止: 防衛三段(server 側)で構造的に弾く、本表示は AI 出力を可視化するのみ
//
// SSOT: lib/schema/company.ts (CompanySummary, Evidence, EvidenceCategory),
//       lib/state/analyze_store.ts (companySummary)

import * as React from "react";
import { useTranslations } from "next-intl";
import {
  EVIDENCE_SOURCE_USER_INPUT,
  type CompanySummary,
  type Evidence,
} from "@/lib/schema/company";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { Building2, FileText, Quote } from "lucide-react";

export interface CompanySummaryPanelProps {
  summary: CompanySummary | null;
  highlightEvidenceId?: string | null;
}

export function CompanySummaryPanel({ summary, highlightEvidenceId }: CompanySummaryPanelProps) {
  const t = useTranslations("companyPanel");
  // companySummary が無い場合(research スキップ / 失敗 のいずれか)
  if (!summary) {
    return (
      <div
        className="rounded-md border border-dashed border-border/60 bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground"
        role="region"
        aria-label={t("region_aria")}
      >
        <Building2 className="mx-auto mb-2 size-5 text-muted-foreground/60" />
        <p className="text-jp">{t("empty_no_summary")}</p>
        <p className="mt-1 text-[10px] text-jp">
          {t("empty_hint")}
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-border/60 bg-card/70 p-3"
      role="region"
      aria-label={t("region_aria")}
    >
      {/* 識別情報 */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Building2 className="size-4 text-primary" />
          <span>{summary.company_name}</span>
        </div>
        <p className="text-xs leading-relaxed text-foreground/85 text-jp">
          {summary.business_summary}
        </p>
      </div>

      {/* 価値観 / 採用基準(subtle、合成ビュー) */}
      {summary.values.length > 0 && (
        <div>
          <h5 className="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            {t("values_label")}
          </h5>
          <div className="flex flex-wrap gap-1.5">
            {summary.values.map((v, i) => (
              <Badge key={`${v}-${i}`} variant="secondary" className="text-[10px]">
                {v}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {summary.ideal_candidate && (
        <div>
          <h5 className="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            {t("ideal_candidate_label")}
          </h5>
          <p className="text-xs leading-relaxed text-foreground/85 text-jp">
            {summary.ideal_candidate}
          </p>
        </div>
      )}

      {summary.hiring_criteria.length > 0 && (
        <div>
          <h5 className="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            {t("hiring_criteria_label")}
          </h5>
          <ul className="ml-4 list-disc text-xs text-foreground/85 text-jp">
            {summary.hiring_criteria.map((c, i) => (
              <li key={`${c}-${i}`}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      {/* evidence list — 透明性の主役 */}
      {summary.evidence.length > 0 && (
        <>
          <Separator />
          <div>
            <h5 className="mb-2 flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              <Quote className="size-3" />
              {t("evidence_label", { count: summary.evidence.length })}
            </h5>
            <ul className="flex flex-col gap-2">
              {summary.evidence.map((ev) => (
                <EvidenceListItem
                  key={ev.id}
                  evidence={ev}
                  highlighted={highlightEvidenceId === ev.id}
                />
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

// =============================================================================
// EvidenceListItem — 1 件の証拠を「主役」として表示
// =============================================================================
// 設計: claim を上、source_quote を引用ブロック、出典 URL / ユーザー入力 を下部に。
// `highlighted` props が true の場合は ring + scroll into view(SuggestionCard の
// rationale_source.evidence_id 連動のため)。
function EvidenceListItem({
  evidence,
  highlighted,
}: {
  evidence: Evidence;
  highlighted: boolean;
}) {
  const tCategory = useTranslations("evidenceCategory");
  const tCommon = useTranslations("common");
  const tCard = useTranslations("suggestionCard");
  const isUserInput = evidence.source_url === EVIDENCE_SOURCE_USER_INPUT;

  // highlighted になった瞬間に scroll into view(SuggestionCard 連動の到達点)
  const itemRef = React.useRef<HTMLLIElement>(null);
  React.useEffect(() => {
    if (!highlighted) return;
    const el = itemRef.current;
    if (!el) return;
    const rAF = requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    return () => cancelAnimationFrame(rAF);
  }, [highlighted]);

  return (
    <li
      ref={itemRef}
      data-evidence-id={evidence.id}
      className={cn(
        "flex flex-col gap-1.5 rounded-md border border-border/60 bg-background/40 p-2 transition-all",
        highlighted &&
          "ring-2 ring-primary/60 ring-offset-1 ring-offset-background bg-primary/5",
      )}
    >
      <div className="flex items-center gap-1.5">
        <Badge variant="outline" className="text-[10px]">
          {tCategory(evidence.category)}
        </Badge>
        <span className="font-mono text-[10px] text-muted-foreground">
          {evidence.id}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-foreground text-jp">{evidence.claim}</p>
      <blockquote className="flex gap-1.5 border-l-2 border-muted-foreground/30 bg-muted/40 px-2 py-1 text-[11px] leading-relaxed italic text-muted-foreground text-jp">
        <Quote className="size-3 mt-0.5 shrink-0 text-muted-foreground/60" aria-hidden />
        <span>{evidence.source_quote}</span>
      </blockquote>
      {isUserInput ? (
        <span
          className="text-[10px] text-muted-foreground"
          title={tCard("user_input_source_title")}
        >
          {tCommon("user_input_source")}
        </span>
      ) : (
        <a
          href={evidence.source_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[10px] text-primary underline-offset-2 hover:underline"
        >
          <FileText className="size-2.5" />
          {tCommon("view_source")}
        </a>
      )}
    </li>
  );
}
