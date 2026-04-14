"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useSession } from "@/lib/store/session";
import { persistSession } from "@/lib/firebase/hooks";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RotateCcw } from "lucide-react";
import { InfoTooltip } from "@/components/ui/tooltip";
import type { ClusterMetricsRow } from "@/types";
import type { ScoringConfig, Direction, MetricConfig, GroupConfig } from "@/lib/analytics/scoring";
import { computeScores, buildJustification, METRIC_GROUP_MAP } from "@/lib/analytics/scoring";

// ── Default config derived from COLS metadata ──────────────────────────────────

interface ColMeta {
  key: keyof ClusterMetricsRow;
  label: string;
  group: string;
  higherIsBetter?: boolean;
  dealsOnly?: boolean;
}

const COLS_META: ColMeta[] = [
  { key: "companyCount",       group: "Size",       label: "# Total",                 higherIsBetter: true  },
  { key: "uniqueCompanies",    group: "Size",       label: "# Companies",             higherIsBetter: true  },
  { key: "avgEmployees",       group: "Size",       label: "Avg. Employees",          higherIsBetter: true  },
  { key: "avgYearFounded",     group: "Recency",    label: "Avg. Founded",            higherIsBetter: false },
  { key: "pctRecentlyFounded", group: "Recency",    label: "% Recent",                higherIsBetter: true  },
  { key: "dealCount",          group: "Deals",      label: "# Deals",                 higherIsBetter: true,  dealsOnly: true },
  { key: "dealMomentum",       group: "Deals",      label: "Deal Momentum",           higherIsBetter: true,  dealsOnly: true },
  { key: "avgFunding",         group: "Funding",    label: "Avg. Raised",             higherIsBetter: true  },
  { key: "totalFunding",       group: "Funding",    label: "Total Raised",            higherIsBetter: true  },
  { key: "totalInvested4yr",   group: "Funding",    label: "Capital (4yr)",           higherIsBetter: true,  dealsOnly: true },
  { key: "fundingMomentum",    group: "Funding",    label: "Funding Momentum",        higherIsBetter: true,  dealsOnly: true },
  { key: "capitalMean",        group: "Capital",    label: "Deal Mean",               higherIsBetter: true,  dealsOnly: true },
  { key: "capitalMedian",      group: "Capital",    label: "Deal Median",             higherIsBetter: true,  dealsOnly: true },
  { key: "meanMedianRatio",    group: "Capital",    label: "Mean/Median",             higherIsBetter: false, dealsOnly: true },
  { key: "vcGraduationRate",   group: "Risk",       label: "VC Grad. Rate",           higherIsBetter: true  },
  { key: "mortalityRate",      group: "Risk",       label: "Mortality Rate",          higherIsBetter: false },
  { key: "hhi",                group: "Market",     label: "HHI",                     higherIsBetter: false },
  { key: "avgSeriesScore",     group: "Market",     label: "Maturity",                higherIsBetter: true,  dealsOnly: true },
  { key: "avgPatentFamilies",  group: "Technology", label: "Avg. Patents",            higherIsBetter: true  },
];

const GROUPS = ["Size", "Recency", "Deals", "Funding", "Capital", "Risk", "Market", "Technology"];

function buildDefaultConfig(hasDeals: boolean): ScoringConfig {
  return {
    metrics: COLS_META.map((c) => ({
      key: c.key,
      direction: (c.dealsOnly && !hasDeals)
        ? "neutral"
        : c.higherIsBetter === true
        ? "max"
        : c.higherIsBetter === false
        ? "min"
        : "neutral",
      // uniqueCompanies overlaps with companyCount — default weight 0
      weight: c.key === "uniqueCompanies" ? 0 : 1,
    })),
    groups: GROUPS.map((g) => ({ group: g, weight: 1 })),
  };
}

// ── Styling helpers ────────────────────────────────────────────────────────────

const DIRECTION_STYLES: Record<Direction, string> = {
  max:     "bg-emerald-500/15 text-emerald-700 border-emerald-200",
  min:     "bg-red-500/15 text-red-600 border-red-200",
  neutral: "bg-muted text-muted-foreground border-border",
};

const WEIGHT_STYLES: Record<number, string> = {
  0: "bg-muted text-muted-foreground",
  1: "bg-emerald-100 text-emerald-700",
  2: "bg-amber-100 text-amber-700",
  3: "bg-orange-100 text-orange-700",
  4: "bg-red-100 text-red-700",
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

// ── Component ──────────────────────────────────────────────────────────────────

interface Props {
  rows: ClusterMetricsRow[];
  hasDeals: boolean;
  clusterColors?: Record<string, string>;
}

export function ScoringPanel({ rows, hasDeals, clusterColors }: Props) {
  const { uid, scoringConfig, setScoringConfig } = useSession();
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initialise from persisted config or defaults
  const [config, setConfig] = useState<ScoringConfig>(() => {
    if (scoringConfig) return scoringConfig as ScoringConfig;
    return buildDefaultConfig(hasDeals);
  });

  // Sync if Firestore pushes a config after mount (e.g. session resume)
  useEffect(() => {
    if (scoringConfig) setConfig(scoringConfig as ScoringConfig);
  }, [scoringConfig]);

  // Debounced Firestore save
  const scheduleSave = useCallback((cfg: ScoringConfig) => {
    if (!uid) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      persistSession(uid, { scoringConfig: cfg }).catch(() => {});
      setScoringConfig(cfg);
    }, 1000);
  }, [uid, setScoringConfig]);

  const updateMetric = useCallback((key: string, patch: Partial<MetricConfig>) => {
    setConfig((prev) => {
      const updated: ScoringConfig = {
        ...prev,
        metrics: prev.metrics.map((m) =>
          m.key === key ? { ...m, ...patch } : m
        ),
      };
      scheduleSave(updated);
      return updated;
    });
  }, [scheduleSave]);

  const updateGroup = useCallback((group: string, patch: Partial<GroupConfig>) => {
    setConfig((prev) => {
      const updated: ScoringConfig = {
        ...prev,
        groups: prev.groups.map((g) =>
          g.group === group ? { ...g, ...patch } : g
        ),
      };
      scheduleSave(updated);
      return updated;
    });
  }, [scheduleSave]);

  const handleReset = useCallback(() => {
    const def = buildDefaultConfig(hasDeals);
    setConfig(def);
    scheduleSave(def);
  }, [hasDeals, scheduleSave]);

  const scores = useMemo(
    () => computeScores(rows, config, clusterColors),
    [rows, config, clusterColors]
  );

  // Build lookup maps
  const metricMap = useMemo(() => {
    const m: Record<string, MetricConfig> = {};
    for (const mc of config.metrics) m[mc.key as string] = mc;
    return m;
  }, [config.metrics]);

  const groupMap = useMemo(() => {
    const m: Record<string, GroupConfig> = {};
    for (const gc of config.groups) m[gc.group] = gc;
    return m;
  }, [config.groups]);

  if (rows.length === 0) return null;

  return (
    <div className="flex flex-col gap-6">
      {/* Config table */}
      <div className="rounded-xl border border-border overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              <th className="sticky left-0 bg-muted/60 px-4 py-2.5 text-left text-[11px] font-medium text-muted-foreground w-32">
                Category
              </th>
              <th className="px-3 py-2.5 text-center text-[11px] font-medium text-muted-foreground w-24 border-l border-border/30">
                <span className="inline-flex items-center gap-0.5">
                  Group wt.
                  <InfoTooltip content="Multiplies all metric scores in this group relative to other groups. Higher = this group matters more overall." />
                </span>
              </th>
              <th className="px-4 py-2.5 text-left text-[11px] font-medium text-muted-foreground border-l border-border/30">
                Metric
              </th>
              <th className="px-3 py-2.5 text-center text-[11px] font-medium text-muted-foreground w-28 border-l border-border/30">
                <span className="inline-flex items-center gap-0.5">
                  Direction
                  <InfoTooltip content="Max: higher values rank better · Min: lower values rank better · Neutral: excluded from scoring" />
                </span>
              </th>
              <th className="px-3 py-2.5 text-center text-[11px] font-medium text-muted-foreground w-24 border-l border-border/30">
                <span className="inline-flex items-center gap-0.5">
                  Weight
                  <InfoTooltip content="Importance of this metric within its group (0 = excluded, 4 = strongest influence)" />
                </span>
              </th>
              <th className="px-4 py-2.5 text-left text-[11px] font-medium text-muted-foreground border-l border-border/30">
                Justification
              </th>
            </tr>
          </thead>
          <tbody>
            {GROUPS.map((group) => {
              const groupMetrics = COLS_META.filter((c) => c.group === group);
              const gc = groupMap[group] ?? { group, weight: 1 };
              const isDealsGroup = groupMetrics.every((c) => c.dealsOnly);
              const groupDimmed = isDealsGroup && !hasDeals;

              return groupMetrics.map((col, colIdx) => {
                const mc = metricMap[col.key as string] ?? { key: col.key, direction: "neutral" as Direction, weight: 0 };
                const isDimmed = (col.dealsOnly && !hasDeals) || groupDimmed;
                const justification = buildJustification(col.key as string, mc.direction, mc.weight);
                const rowBg = GROUP_COLORS[group] ?? "";

                return (
                  <tr
                    key={col.key}
                    className={`border-b border-border/40 last:border-0 ${rowBg} ${isDimmed ? "opacity-40" : ""}`}
                  >
                    {/* Group cell — only on first metric row */}
                    {colIdx === 0 && (
                      <td
                        rowSpan={groupMetrics.length}
                        className="sticky left-0 px-4 py-2.5 font-semibold text-foreground border-r border-border/30 align-top pt-3 bg-inherit"
                      >
                        {group}
                      </td>
                    )}

                    {/* Group weight — only on first metric row */}
                    {colIdx === 0 && (
                      <td
                        rowSpan={groupMetrics.length}
                        className="px-3 py-2.5 text-center border-l border-r border-border/30 align-middle bg-inherit"
                      >
                        <Select
                          value={String(gc.weight)}
                          onValueChange={(v) => !isDimmed && updateGroup(group, { weight: Number(v) })}
                          disabled={isDimmed}
                        >
                          <SelectTrigger className="h-7 w-16 text-xs mx-auto border-border/60">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {[1, 2, 3, 4, 5, 6].map((n) => (
                              <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                    )}

                    {/* Metric name */}
                    <td className="px-4 py-2.5 text-foreground/90 border-l border-border/20">
                      {col.label}
                      {col.dealsOnly && !hasDeals && (
                        <span className="ml-1.5 text-[10px] text-muted-foreground italic">no deals</span>
                      )}
                    </td>

                    {/* Direction */}
                    <td className="px-3 py-2.5 text-center border-l border-border/20">
                      <Select
                        value={mc.direction}
                        onValueChange={(v) => !isDimmed && updateMetric(col.key as string, { direction: v as Direction })}
                        disabled={isDimmed}
                      >
                        <SelectTrigger
                          className={`h-7 w-24 text-xs mx-auto border ${DIRECTION_STYLES[mc.direction]}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="max">Max ↑</SelectItem>
                          <SelectItem value="min">Min ↓</SelectItem>
                          <SelectItem value="neutral">Neutral</SelectItem>
                        </SelectContent>
                      </Select>
                    </td>

                    {/* Weight */}
                    <td className="px-3 py-2.5 text-center border-l border-border/20">
                      <Select
                        value={String(mc.weight)}
                        onValueChange={(v) => !isDimmed && updateMetric(col.key as string, { weight: Number(v) })}
                        disabled={isDimmed}
                      >
                        <SelectTrigger
                          className={`h-7 w-16 text-xs mx-auto border-0 rounded-full font-semibold ${WEIGHT_STYLES[mc.weight] ?? WEIGHT_STYLES[0]}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {[0, 1, 2, 3, 4].map((n) => (
                            <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>

                    {/* Justification */}
                    <td className="px-4 py-2.5 text-muted-foreground border-l border-border/20 max-w-xs">
                      {justification}
                    </td>
                  </tr>
                );
              });
            })}
          </tbody>
        </table>
      </div>

      {/* Reset button */}
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={handleReset} className="gap-1.5 text-xs">
          <RotateCcw className="h-3 w-3" />
          Reset to defaults
        </Button>
      </div>

      {/* Ranked results */}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Cluster Ranking</h3>
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-2.5 text-left text-[11px] font-medium text-muted-foreground w-8">#</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium text-muted-foreground">Cluster</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium text-muted-foreground w-16">Score</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium text-muted-foreground w-48" />
              </tr>
            </thead>
            <tbody>
              {scores.map((s, i) => (
                <tr
                  key={s.clusterId}
                  className={`border-b border-border/40 last:border-0 hover:bg-muted/20 transition-colors ${i % 2 === 1 ? "bg-muted/10" : ""}`}
                >
                  <td className="px-4 py-3 text-xs text-muted-foreground font-mono">
                    {i + 1}
                  </td>
                  <td className="px-4 py-3 font-medium text-foreground">
                    <div className="flex items-center gap-2">
                      {s.color && (
                        <div
                          className="h-2.5 w-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: s.color }}
                        />
                      )}
                      {s.clusterName}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right font-mono font-semibold text-foreground">
                    {s.score}
                  </td>
                  <td className="px-4 py-3">
                    <Progress
                      value={s.score}
                      className="h-2"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
