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

function MomentumChip({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  if (value > 0)
    return (
      <span className="text-xs px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400">
        +{value}%
      </span>
    );
  if (value < 0)
    return (
      <span className="text-xs px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400">
        {value}%
      </span>
    );
  return (
    <span className="text-xs px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
      0%
    </span>
  );
}

export function AnalyticsTable({ rows, hasDeals }: Props) {
  // Pre-compute ranks
  const ranks = {
    companyCount: rankRows(rows, "companyCount"),
    avgFunding: rankRows(rows, "avgFunding"),
    dealCount: rankRows(rows, "dealCount"),
    graduationCount: rankRows(rows, "graduationCount"),
  };

  const rankClass = (rank: number | undefined) => {
    if (!rank) return "";
    if (rank === 1) return "font-bold text-foreground";
    if (rank === 2) return "font-semibold text-foreground/80";
    return "text-muted-foreground";
  };

  return (
    <div className="rounded-lg border border-border overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            <th className="text-left px-3 py-2.5 text-muted-foreground font-medium sticky left-0 bg-muted/40">
              Cluster
            </th>
            <th className="text-right px-3 py-2.5 text-muted-foreground font-medium">
              Companies ↓
            </th>
            <th className="text-right px-3 py-2.5 text-muted-foreground font-medium">
              Avg employees ↓
            </th>
            <th className="text-right px-3 py-2.5 text-muted-foreground font-medium">
              Avg founded
            </th>
            <th className="text-right px-3 py-2.5 text-muted-foreground font-medium">
              % recent ↓
            </th>
            {hasDeals && (
              <>
                <th className="text-right px-3 py-2.5 text-muted-foreground font-medium">
                  Deals ↓
                </th>
                <th className="text-right px-3 py-2.5 text-muted-foreground font-medium">
                  Momentum
                </th>
              </>
            )}
            <th className="text-right px-3 py-2.5 text-muted-foreground font-medium">
              Avg funding ↓
            </th>
            <th className="text-right px-3 py-2.5 text-muted-foreground font-medium">
              Exits ↓
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.clusterId}
              className="border-b border-border/50 hover:bg-muted/20 transition-colors"
            >
              <td className="px-3 py-2.5 font-medium text-foreground max-w-[160px] truncate sticky left-0 bg-background">
                {row.clusterName}
              </td>
              <td
                className={cn(
                  "px-3 py-2.5 text-right font-mono",
                  rankClass(ranks.companyCount[row.clusterId])
                )}
              >
                {fmtNum(row.companyCount)}
              </td>
              <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">
                {fmtNum(row.avgEmployees)}
              </td>
              <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">
                {fmtNum(row.avgYearFounded)}
              </td>
              <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">
                {row.pctRecentlyFounded != null ? `${row.pctRecentlyFounded}%` : "—"}
              </td>
              {hasDeals && (
                <>
                  <td
                    className={cn(
                      "px-3 py-2.5 text-right font-mono",
                      rankClass(ranks.dealCount[row.clusterId])
                    )}
                  >
                    {fmtNum(row.dealCount)}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <MomentumChip value={row.dealMomentum} />
                  </td>
                </>
              )}
              <td
                className={cn(
                  "px-3 py-2.5 text-right font-mono",
                  rankClass(ranks.avgFunding[row.clusterId])
                )}
              >
                {fmtMoney(row.avgFunding)}
              </td>
              <td
                className={cn(
                  "px-3 py-2.5 text-right font-mono",
                  rankClass(ranks.graduationCount[row.clusterId])
                )}
              >
                {fmtNum(row.graduationCount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] text-muted-foreground px-3 py-2">
        ↓ higher is better · Bold = #1 rank
      </p>
    </div>
  );
}
