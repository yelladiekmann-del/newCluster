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
import { Download, RotateCcw } from "lucide-react";
import { InfoTooltip } from "@/components/ui/tooltip";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ClusterMetricsRow } from "@/types";
import type { ScoringConfig, Direction, MetricConfig, GroupConfig } from "@/lib/analytics/scoring";
import { computeScores, buildJustification } from "@/lib/analytics/scoring";
import { downloadCsvRows } from "@/lib/analytics/export";

interface ColMeta {
  key: keyof ClusterMetricsRow;
  label: string;
  group: string;
  higherIsBetter?: boolean;
  dealsOnly?: boolean;
}

const COLS_META: ColMeta[] = [
  { key: "companyCount", group: "Size", label: "# Total", higherIsBetter: true },
  { key: "uniqueCompanies", group: "Size", label: "# Companies", higherIsBetter: true },
  { key: "avgEmployees", group: "Size", label: "Avg. Employees", higherIsBetter: true },
  { key: "avgYearFounded", group: "Recency", label: "Avg. Founded", higherIsBetter: false },
  { key: "pctRecentlyFounded", group: "Recency", label: "% Recent", higherIsBetter: true },
  { key: "dealCount", group: "Deals", label: "# Deals", higherIsBetter: true, dealsOnly: true },
  { key: "dealMomentum", group: "Deals", label: "Deal Momentum", higherIsBetter: true, dealsOnly: true },
  { key: "avgFunding", group: "Funding", label: "Avg. Raised", higherIsBetter: true },
  { key: "totalFunding", group: "Funding", label: "Total Raised", higherIsBetter: true },
  { key: "totalInvested4yr", group: "Funding", label: "Capital (4yr)", higherIsBetter: true, dealsOnly: true },
  { key: "fundingMomentum", group: "Funding", label: "Funding Momentum", higherIsBetter: true, dealsOnly: true },
  { key: "capitalMean", group: "Capital", label: "Deal Mean", higherIsBetter: true, dealsOnly: true },
  { key: "capitalMedian", group: "Capital", label: "Deal Median", higherIsBetter: true, dealsOnly: true },
  { key: "meanMedianRatio", group: "Capital", label: "Mean/Median", higherIsBetter: false, dealsOnly: true },
  { key: "vcGraduationRate", group: "Risk", label: "VC Grad. Rate", higherIsBetter: true },
  { key: "mortalityRate", group: "Risk", label: "Mortality Rate", higherIsBetter: false },
  { key: "hhi", group: "Market", label: "HHI", higherIsBetter: false },
  { key: "marktreife", group: "Market", label: "Marktreife", higherIsBetter: false, dealsOnly: true },
  { key: "avgSeriesScore", group: "Market", label: "Avg. Stage", higherIsBetter: true, dealsOnly: true },
  { key: "avgPatentFamilies", group: "Technology", label: "Avg. Patents", higherIsBetter: true },
];

const GROUPS = ["Size", "Recency", "Deals", "Funding", "Capital", "Risk", "Market", "Technology"];

function buildDefaultConfig(hasDeals: boolean): ScoringConfig {
  return {
    metrics: COLS_META.map((c) => ({
      key: c.key,
      direction:
        c.dealsOnly && !hasDeals
          ? "neutral"
          : c.higherIsBetter === true
            ? "max"
            : c.higherIsBetter === false
              ? "min"
              : "neutral",
      weight: c.key === "uniqueCompanies" ? 0 : 1,
    })),
    groups: GROUPS.map((g) => ({ group: g, weight: 1 })),
  };
}

function ConfigBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border/70 bg-background px-2 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
      {children}
    </span>
  );
}

interface Props {
  rows: ClusterMetricsRow[];
  hasDeals: boolean;
}

export function ScoringPanel({ rows, hasDeals }: Props) {
  const { uid, scoringConfig, setScoringConfig } = useSession();
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [config, setConfig] = useState<ScoringConfig>(() => {
    if (scoringConfig) return scoringConfig as ScoringConfig;
    return buildDefaultConfig(hasDeals);
  });

  useEffect(() => {
    if (!scoringConfig) return;
    const timer = window.setTimeout(() => {
      setConfig(scoringConfig as ScoringConfig);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [scoringConfig]);

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
        metrics: prev.metrics.map((m) => (m.key === key ? { ...m, ...patch } : m)),
      };
      scheduleSave(updated);
      return updated;
    });
  }, [scheduleSave]);

  const updateGroup = useCallback((group: string, patch: Partial<GroupConfig>) => {
    setConfig((prev) => {
      const updated: ScoringConfig = {
        ...prev,
        groups: prev.groups.map((g) => (g.group === group ? { ...g, ...patch } : g)),
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

  const scores = useMemo(() => computeScores(rows, config), [rows, config]);

  const metricMap = useMemo(() => {
    const map: Record<string, MetricConfig> = {};
    for (const metric of config.metrics) map[metric.key as string] = metric;
    return map;
  }, [config.metrics]);

  const groupMap = useMemo(() => {
    const map: Record<string, GroupConfig> = {};
    for (const group of config.groups) map[group.group] = group;
    return map;
  }, [config.groups]);

  if (rows.length === 0) return null;

  return (
    <div className="grid gap-4 xl:grid-cols-[1.08fr_0.92fr]">
      <Card className="border-border/70 bg-background/80 shadow-sm">
        <CardHeader className="border-b border-border/60 pb-3">
          <div>
            <CardTitle>Score thesis builder</CardTitle>
            <CardDescription>
              Adjust the relative importance of each metric family, then fine-tune the metrics inside it.
            </CardDescription>
          </div>
          <CardAction>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() =>
                  downloadCsvRows(
                    "scoring_config.csv",
                    [
                      ...config.metrics.map((metric) => ({
                        Type: "Metric",
                        Name: metric.key as string,
                        Direction: metric.direction,
                        Weight: metric.weight,
                      })),
                      ...config.groups.map((group) => ({
                        Type: "Group",
                        Name: group.group,
                        Direction: "—",
                        Weight: group.weight,
                      })),
                    ]
                  )
                }
              >
                <Download className="h-3.5 w-3.5" />
                Download
              </Button>
              <Button variant="outline" size="sm" onClick={handleReset} className="gap-1.5">
                <RotateCcw className="h-3.5 w-3.5" />
                Reset
              </Button>
            </div>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-3 pt-1">
          <div className="grid gap-3 xl:grid-cols-2">
            {GROUPS.map((group) => {
              const metrics = COLS_META.filter((col) => col.group === group);
              const groupConfig = groupMap[group] ?? { group, weight: 1 };
              const groupDisabled = metrics.every((metric) => metric.dealsOnly && !hasDeals);
              return (
                <div key={group} className="rounded-2xl border border-border/70 bg-muted/10 p-3">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="space-y-1">
                      <div className="text-sm font-semibold text-foreground">{group}</div>
                      <div className="text-xs text-muted-foreground">
                        {groupDisabled ? "Needs deals data" : "Category weighting"}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <ConfigBadge>Group weight</ConfigBadge>
                      <Select
                        value={String(groupConfig.weight)}
                        onValueChange={(value) => !groupDisabled && updateGroup(group, { weight: Number(value) })}
                        disabled={groupDisabled}
                      >
                        <SelectTrigger className="h-8 w-20 border-border/70 bg-background">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {[1, 2, 3, 4, 5, 6].map((n) => (
                            <SelectItem key={n} value={String(n)}>
                              {n}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="grid gap-2.5">
                    {metrics.map((metric) => {
                      const metricConfig = metricMap[metric.key as string] ?? {
                        key: metric.key,
                        direction: "neutral" as Direction,
                        weight: 0,
                      };
                      const disabled = metric.dealsOnly && !hasDeals;
                      return (
                        <div
                          key={metric.key}
                          className={`rounded-xl border border-border/70 bg-background/80 p-2.5 ${disabled ? "opacity-45" : ""}`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <div className="truncate text-sm font-medium text-foreground">{metric.label}</div>
                                <InfoTooltip content={buildJustification(metric.key as string, metricConfig.direction, metricConfig.weight)} />
                              </div>
                              {disabled && (
                                <div className="mt-0.5 text-[11px] text-muted-foreground">
                                  Needs deals data
                                </div>
                              )}
                            </div>
                            <div className="grid shrink-0 grid-cols-2 gap-2">
                              <div className="grid gap-1">
                                <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Direction</div>
                                <Select
                                  value={metricConfig.direction}
                                  onValueChange={(value) => !disabled && updateMetric(metric.key as string, { direction: value as Direction })}
                                  disabled={disabled}
                                >
                                  <SelectTrigger className="h-7 w-[112px] border-border/70 bg-background text-xs">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="max">Max ↑</SelectItem>
                                    <SelectItem value="min">Min ↓</SelectItem>
                                    <SelectItem value="neutral">Neutral</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>

                              <div className="grid gap-1">
                                <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Weight</div>
                                <Select
                                  value={String(metricConfig.weight)}
                                  onValueChange={(value) => !disabled && updateMetric(metric.key as string, { weight: Number(value) })}
                                  disabled={disabled}
                                >
                                  <SelectTrigger className="h-7 w-[88px] border-border/70 bg-background text-xs">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {[0, 1, 2, 3, 4].map((n) => (
                                      <SelectItem key={n} value={String(n)}>
                                        {n}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/70 bg-background/80 shadow-sm">
        <CardHeader className="border-b border-border/60 pb-3">
          <div>
            <CardTitle>Cluster ranking</CardTitle>
            <CardDescription>
              Live score output from the current thesis configuration.
            </CardDescription>
          </div>
          <CardAction>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() =>
                downloadCsvRows(
                  "cluster_ranking.csv",
                  scores.map((score, index) => ({
                    Rank: index + 1,
                    Cluster: score.clusterName,
                    Score: score.score,
                  }))
                )
              }
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="pt-1">
          <div className="overflow-hidden rounded-2xl border border-border/70">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border/70 bg-muted/30">
                  <th className="w-10 px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">#</th>
                  <th className="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Cluster</th>
                  <th className="w-20 px-4 py-2.5 text-right text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Score</th>
                  <th className="w-40 px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Strength</th>
                </tr>
              </thead>
              <tbody>
                {scores.map((score, index) => (
                  <tr
                    key={score.clusterId}
                    className={`border-b border-border/50 last:border-0 ${index % 2 === 1 ? "bg-muted/10" : "bg-background"}`}
                  >
                    <td className="px-4 py-3 text-xs font-medium text-muted-foreground">{index + 1}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">{score.clusterName}</div>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-foreground">{score.score}</td>
                    <td className="px-4 py-3">
                      <Progress value={score.score} className="h-2 bg-muted/70" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
