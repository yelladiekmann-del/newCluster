"use client";

import type { ClusterMetricsRow } from "@/types";
import { rankRows } from "@/lib/analytics/compute";
import { cn } from "@/lib/utils";

interface Props {
  rows: ClusterMetricsRow[];
  hasDeals: boolean;
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
  higherIsBetter?: boolean;
  rankable?: boolean;
  dealsOnly?: boolean;
}

const COLS: ColDef[] = [
  { key: "companyCount",       group: "Size",       label: "Gesamt",             fmt: (r) => fmtNum(r.companyCount),         higherIsBetter: true,  rankable: true  },
  { key: "uniqueCompanies",    group: "Size",       label: "# Companies",        fmt: (r) => fmtNum(r.uniqueCompanies),      higherIsBetter: true,  rankable: false },
  { key: "avgEmployees",       group: "Size",       label: "⌀ Angestellte",      fmt: (r) => fmtNum(r.avgEmployees),         higherIsBetter: true,  rankable: false },
  { key: "avgYearFounded",     group: "Recency",    label: "⌀ Year Founded",     fmt: (r) => fmtNum(r.avgYearFounded),       higherIsBetter: false, rankable: false },
  { key: "pctRecentlyFounded", group: "Recency",    label: "% Recently Founded", fmt: (r) => fmtPct(r.pctRecentlyFounded),  higherIsBetter: true,  rankable: true  },
  { key: "dealCount",          group: "Deals",      label: "# Deals",            fmt: (r) => fmtNum(r.dealCount),            higherIsBetter: true,  rankable: true,  dealsOnly: true },
  { key: "dealMomentum",       group: "Deals",      label: "Deal Momentum",      fmt: (r) => <MomentumChip value={r.dealMomentum} />,  rankable: false, dealsOnly: true },
  { key: "avgFunding",         group: "Funding",    label: "⌀ Total Raised",     fmt: (r) => fmtMoney(r.avgFunding),         higherIsBetter: true,  rankable: true  },
  { key: "totalFunding",       group: "Funding",    label: "Σ Total Raised",     fmt: (r) => fmtMoney(r.totalFunding),       higherIsBetter: true,  rankable: true  },
  { key: "totalInvested4yr",   group: "Funding",    label: "Σ Capital (4 Jahre)", fmt: (r) => fmtMoney(r.totalInvested4yr),  higherIsBetter: true,  rankable: true,  dealsOnly: true },
  { key: "fundingMomentum",    group: "Funding",    label: "Funding Momentum",   fmt: (r) => <MomentumChip value={r.fundingMomentum} />, rankable: false, dealsOnly: true },
  { key: "capitalMean",        group: "Capital",    label: "Capital Invested Mean",   fmt: (r) => fmtMoney(r.capitalMean),   higherIsBetter: true,  rankable: true,  dealsOnly: true },
  { key: "capitalMedian",      group: "Capital",    label: "Capital Invested Median", fmt: (r) => fmtMoney(r.capitalMedian), higherIsBetter: true,  rankable: true,  dealsOnly: true },
  { key: "meanMedianRatio",    group: "Capital",    label: "Abweichung Mean/Median",  fmt: (r) => fmtNum(r.meanMedianRatio, 2), higherIsBetter: false, rankable: false, dealsOnly: true },
  { key: "vcGraduationRate",   group: "Risk",       label: "VC Graduation Rate", fmt: (r) => fmtPct(r.vcGraduationRate),   higherIsBetter: true,  rankable: true  },
  { key: "mortalityRate",      group: "Risk",       label: "Mortality Rate",     fmt: (r) => fmtPct(r.mortalityRate),      higherIsBetter: false, rankable: true  },
  { key: "hhi",                group: "Market",     label: "Marktanteil (HHI)",  fmt: (r) => fmtNum(r.hhi),                higherIsBetter: false, rankable: true  },
  { key: "avgSeriesScore",     group: "Market",     label: "Marktreife",         fmt: (r) => fmtNum(r.avgSeriesScore, 1),  higherIsBetter: true,  rankable: true,  dealsOnly: true },
  { key: "avgPatentFamilies",  group: "Technology", label: "⌀ Patentierte Erf.", fmt: (r) => fmtNum(r.avgPatentFamilies, 1), higherIsBetter: true, rankable: true  },
];

export function AnalyticsTable({ rows, hasDeals }: Props) {
  const visibleCols = COLS.filter((c) => !c.dealsOnly || hasDeals);

  // Pre-compute ranks for rankable columns
  const ranks: Record<string, Record<string, number>> = {};
  for (const col of visibleCols) {
    if (col.rankable && col.higherIsBetter != null) {
      ranks[col.key] = rankRows(rows, col.key, col.higherIsBetter);
    }
  }

  // Build group spans for header
  const groups: { name: string; span: number }[] = [];
  for (const col of visibleCols) {
    const last = groups[groups.length - 1];
    if (last?.name === col.group) last.span++;
    else groups.push({ name: col.group, span: 1 });
  }

  const rankClass = (rank: number | undefined) => {
    if (!rank) return "text-muted-foreground";
    if (rank === 1) return "font-bold text-foreground";
    if (rank === 2) return "font-semibold text-foreground/80";
    if (rank === 3) return "text-foreground/70";
    return "text-muted-foreground";
  };

  const GROUP_COLORS: Record<string, string> = {
    Size: "bg-blue-500/8",
    Recency: "bg-violet-500/8",
    Deals: "bg-amber-500/8",
    Funding: "bg-emerald-500/8",
    Capital: "bg-cyan-500/8",
    Market: "bg-orange-500/8",
    Risk: "bg-red-500/8",
    Technology: "bg-purple-500/8",
  };

  return (
    <div className="rounded-xl border border-border overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          {/* Group header row */}
          <tr className="border-b border-border">
            <th className="sticky left-0 bg-muted/60 px-4 py-2 text-left text-muted-foreground font-medium" rowSpan={2}>
              Cluster
            </th>
            {groups.map(({ name, span }) => (
              <th
                key={name}
                colSpan={span}
                className={`px-3 py-1.5 text-center text-[10px] font-semibold text-muted-foreground uppercase tracking-wide border-l border-border/60 ${GROUP_COLORS[name] ?? ""}`}
              >
                {name}
              </th>
            ))}
          </tr>
          {/* Column header row */}
          <tr className="border-b border-border bg-muted/40">
            {visibleCols.map((col) => (
              <th
                key={col.key}
                className="px-3 py-2 text-right text-[11px] text-muted-foreground font-medium whitespace-nowrap border-l border-border/30"
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={row.clusterId}
              className={`border-b border-border/40 hover:bg-muted/20 transition-colors ${i % 2 === 1 ? "bg-muted/10" : ""}`}
            >
              <td className="sticky left-0 bg-background px-4 py-2.5 font-medium text-foreground max-w-[160px] truncate border-r border-border/30">
                {row.clusterName}
              </td>
              {visibleCols.map((col) => {
                const rank = ranks[col.key]?.[row.clusterId];
                return (
                  <td
                    key={col.key}
                    className={cn(
                      "px-3 py-2.5 text-right font-mono border-l border-border/20",
                      rankClass(rank)
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
      <div className="px-4 py-2 text-[10px] text-muted-foreground border-t border-border/40 flex gap-4">
        <span>↑ higher is better</span>
        <span>↓ lower is better</span>
        <span>Bold = #1 · progressively lighter = #2 #3</span>
      </div>
    </div>
  );
}
