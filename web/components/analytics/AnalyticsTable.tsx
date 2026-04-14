"use client";

import type { ClusterMetricsRow } from "@/types";
import { rankRows } from "@/lib/analytics/compute";
import { cn } from "@/lib/utils";
import { InfoTooltip } from "@/components/ui/tooltip";

interface Props {
  rows: ClusterMetricsRow[];
  hasDeals: boolean;
}

// Extend rows with optional color (populated by AnalyticsPageClient)
interface RowWithColor extends ClusterMetricsRow {
  color?: string;
}

function fmtNum(n: number | null, decimals = 0): string {
  if (n == null) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

function fmtMoney(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
}

function fmtPct(n: number | null): string {
  if (n == null) return "—";
  return `${n}%`;
}

function MomentumChip({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  const cls =
    value > 0
      ? "bg-emerald-500/15 text-emerald-600"
      : value < 0
      ? "bg-red-500/15 text-red-500"
      : "bg-muted text-muted-foreground";
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${cls}`}>
      {value > 0 ? "+" : ""}
      {value}%
    </span>
  );
}

interface ColDef {
  key: keyof ClusterMetricsRow;
  label: string;
  group: string;
  fmt: (r: ClusterMetricsRow) => React.ReactNode;
  tooltip?: string;
  higherIsBetter?: boolean;
  rankable?: boolean;
  dealsOnly?: boolean;
}

const COLS: ColDef[] = [
  { key: "companyCount",       group: "Size",       label: "Gesamt",             tooltip: "Number of companies assigned to this cluster (including via deals)", fmt: (r) => fmtNum(r.companyCount),         higherIsBetter: true,  rankable: true  },
  { key: "uniqueCompanies",    group: "Size",       label: "# Companies",        tooltip: "Number of distinct companies in the cluster", fmt: (r) => fmtNum(r.uniqueCompanies),      higherIsBetter: true,  rankable: false },
  { key: "avgEmployees",       group: "Size",       label: "⌀ Angestellte",      tooltip: "Average employee count across cluster companies", fmt: (r) => fmtNum(r.avgEmployees),         higherIsBetter: true,  rankable: false },
  { key: "avgYearFounded",     group: "Recency",    label: "⌀ Year Founded",     tooltip: "Average founding year of companies in this cluster", fmt: (r) => fmtNum(r.avgYearFounded),       higherIsBetter: false, rankable: false },
  { key: "pctRecentlyFounded", group: "Recency",    label: "% Recently Founded", tooltip: "% of companies founded in the last 5 years", fmt: (r) => fmtPct(r.pctRecentlyFounded),  higherIsBetter: true,  rankable: true  },
  { key: "dealCount",          group: "Deals",      label: "# Deals",            tooltip: "Total number of investment deals across cluster companies", fmt: (r) => fmtNum(r.dealCount),            higherIsBetter: true,  rankable: true,  dealsOnly: true },
  { key: "dealMomentum",       group: "Deals",      label: "Deal Momentum",      tooltip: "Deal count trend: recent 2 years vs. prior 2 years", fmt: (r) => <MomentumChip value={r.dealMomentum} />,  rankable: false, dealsOnly: true },
  { key: "avgFunding",         group: "Funding",    label: "⌀ Total Raised",     tooltip: "Average total capital raised per company", fmt: (r) => fmtMoney(r.avgFunding),         higherIsBetter: true,  rankable: true  },
  { key: "totalFunding",       group: "Funding",    label: "Σ Total Raised",     tooltip: "Total capital raised across all companies in this cluster", fmt: (r) => fmtMoney(r.totalFunding),       higherIsBetter: true,  rankable: true  },
  { key: "totalInvested4yr",   group: "Funding",    label: "Σ Capital (4 Jahre)", tooltip: "Total capital invested in the last 4 years", fmt: (r) => fmtMoney(r.totalInvested4yr),  higherIsBetter: true,  rankable: true,  dealsOnly: true },
  { key: "fundingMomentum",    group: "Funding",    label: "Funding Momentum",   tooltip: "Funding trend: recent 2 years vs. prior 2 years", fmt: (r) => <MomentumChip value={r.fundingMomentum} />, rankable: false, dealsOnly: true },
  { key: "capitalMean",        group: "Capital",    label: "Capital Invested Mean",   tooltip: "Average size of individual investment deals", fmt: (r) => fmtMoney(r.capitalMean),   higherIsBetter: true,  rankable: true,  dealsOnly: true },
  { key: "capitalMedian",      group: "Capital",    label: "Capital Invested Median", tooltip: "Median size of individual investment deals", fmt: (r) => fmtMoney(r.capitalMedian), higherIsBetter: true,  rankable: true,  dealsOnly: true },
  { key: "meanMedianRatio",    group: "Capital",    label: "Abweichung Mean/Median",  tooltip: "Mean ÷ Median. >1 means outlier deals are pulling the average up", fmt: (r) => fmtNum(r.meanMedianRatio, 2), higherIsBetter: false, rankable: false, dealsOnly: true },
  { key: "vcGraduationRate",   group: "Risk",       label: "VC Graduation Rate", tooltip: "% of companies that have raised a VC round", fmt: (r) => fmtPct(r.vcGraduationRate),   higherIsBetter: true,  rankable: true  },
  { key: "mortalityRate",      group: "Risk",       label: "Mortality Rate",     tooltip: "% of companies with inactive or defunct status", fmt: (r) => fmtPct(r.mortalityRate),      higherIsBetter: false, rankable: true  },
  { key: "hhi",                group: "Market",     label: "Marktanteil (HHI)",  tooltip: "Herfindahl–Hirschman Index: funding concentration. 0–10,000. Higher = more concentrated.", fmt: (r) => fmtNum(r.hhi),                higherIsBetter: false, rankable: true  },
  { key: "avgSeriesScore",     group: "Market",     label: "Marktreife",         tooltip: "Average funding stage maturity (Seed=1 … Series D+=5)", fmt: (r) => fmtNum(r.avgSeriesScore, 1),  higherIsBetter: true,  rankable: true,  dealsOnly: true },
  { key: "avgPatentFamilies",  group: "Technology", label: "⌀ Patentierte Erf.", tooltip: "Average number of patent families per company", fmt: (r) => fmtNum(r.avgPatentFamilies, 1), higherIsBetter: true, rankable: true  },
];

export function AnalyticsTable({ rows, hasDeals }: Props) {
  const typedRows = rows as RowWithColor[];
  const visibleCols = COLS.filter((c) => !c.dealsOnly || hasDeals);

  // Pre-compute ranks for rankable columns
  const ranks: Record<string, Record<string, number>> = {};
  for (const col of visibleCols) {
    if (col.rankable && col.higherIsBetter != null) {
      ranks[col.key] = rankRows(rows, col.key, col.higherIsBetter);
    }
  }

  // Build group spans for header
  const groups: { name: string; span: number; isLast?: boolean }[] = [];
  for (const col of visibleCols) {
    const last = groups[groups.length - 1];
    if (last?.name === col.group) last.span++;
    else groups.push({ name: col.group, span: 1 });
  }

  // Mark last column of each group for right-border separator
  const groupLastColIdx: Set<number> = new Set();
  let colIdx = 0;
  for (const g of groups) {
    colIdx += g.span;
    groupLastColIdx.add(colIdx - 1);
  }

  return (
    <div className="rounded-xl border border-border overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          {/* Group header row */}
          <tr className="border-b border-border bg-muted/30">
            <th className="sticky left-0 bg-muted/40 px-4 py-2 text-left text-muted-foreground font-medium" rowSpan={2}>
              Cluster
            </th>
            {groups.map(({ name, span }) => (
              <th
                key={name}
                colSpan={span}
                className="px-3 py-1.5 text-center text-[10px] font-semibold text-muted-foreground uppercase tracking-wide border-l border-border/40"
              >
                {name}
              </th>
            ))}
          </tr>
          {/* Column header row */}
          <tr className="border-b border-border bg-muted/20">
            {visibleCols.map((col, i) => (
              <th
                key={col.key}
                className={cn(
                  "px-3 py-2 text-right text-[11px] text-muted-foreground font-medium whitespace-nowrap border-l border-border/20",
                  groupLastColIdx.has(i) && "border-r border-border/40"
                )}
              >
                <span className="inline-flex items-center justify-end gap-0.5">
                  {col.label}
                  {col.higherIsBetter === true && (
                    <span className="text-emerald-500/70 ml-0.5">↑</span>
                  )}
                  {col.higherIsBetter === false && (
                    <span className="text-red-400/70 ml-0.5">↓</span>
                  )}
                  {col.tooltip && <InfoTooltip content={col.tooltip} />}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {typedRows.map((row, i) => (
            <tr
              key={row.clusterId}
              className={`border-b border-border/30 hover:bg-muted/20 transition-colors ${i % 2 === 1 ? "bg-muted/5" : ""}`}
            >
              <td className="sticky left-0 bg-background px-4 py-2.5 font-medium text-foreground border-r border-border/20">
                <span className="flex items-center gap-1.5 max-w-[160px]">
                  <span
                    className="h-2 w-2 rounded-full shrink-0"
                    style={{ background: row.color ?? "hsl(var(--muted-foreground))" }}
                  />
                  <span className="truncate">{row.clusterName}</span>
                </span>
              </td>
              {visibleCols.map((col, ci) => {
                const rank = ranks[col.key]?.[row.clusterId];
                const isTopRank = rank === 1;
                return (
                  <td
                    key={col.key}
                    className={cn(
                      "px-3 py-2.5 text-right tabular-nums border-l border-border/10",
                      groupLastColIdx.has(ci) && "border-r border-border/30",
                      isTopRank ? "font-semibold text-foreground" : "text-muted-foreground"
                    )}
                  >
                    {col.fmt(row)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="px-4 py-2 text-[10px] text-muted-foreground border-t border-border/30 flex gap-4">
        <span>↑ higher is better</span>
        <span>↓ lower is better</span>
        <span className="font-semibold text-foreground/60">#1 ranked value shown in bold</span>
      </div>
    </div>
  );
}
