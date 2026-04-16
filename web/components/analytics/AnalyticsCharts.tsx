"use client";

import { Download } from "lucide-react";
import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import type { ClusterMetricsRow } from "@/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardAction,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { downloadCsvRows } from "@/lib/analytics/export";

interface Props {
  rows: ClusterMetricsRow[];
}

function fmtMoneyShort(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
}

function fmtCompact(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString();
}

function fmtPct(value: number | null): string {
  if (value == null) return "—";
  return `${value}%`;
}

function MetricRailCard({
  title,
  subtitle,
  rows,
  valueKey,
  formatter,
  filename,
}: {
  title: string;
  subtitle: string;
  rows: ClusterMetricsRow[];
  valueKey: keyof ClusterMetricsRow;
  formatter: (value: number | null) => string;
  filename: string;
}) {
  const ranked = rows
    .filter((row) => typeof row[valueKey] === "number")
    .sort((a, b) => Number(b[valueKey] ?? 0) - Number(a[valueKey] ?? 0));

  const max = Math.max(...ranked.map((row) => Number(row[valueKey] ?? 0)), 0);

  return (
    <Card className="border-border/70 bg-background/80 shadow-sm">
      <CardHeader className="border-b border-border/60 pb-3">
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{subtitle}</CardDescription>
        </div>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() =>
              downloadCsvRows(
                filename,
                ranked.map((row, index) => ({
                  Rank: index + 1,
                  Cluster: row.clusterName,
                  Value: row[valueKey],
                  Companies: row.companyCount,
                }))
              )
            }
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-1">
        {ranked.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 px-4 py-8 text-sm text-muted-foreground">
            No data available for this view yet.
          </div>
        ) : (
          ranked.map((row, index) => {
            const value = Number(row[valueKey] ?? 0);
            const pct = max > 0 ? Math.max(10, (value / max) * 100) : 0;
            return (
              <div key={row.clusterId} className="grid gap-1.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="w-5 shrink-0 text-[11px] font-medium text-muted-foreground">
                      {index + 1}
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">{row.clusterName}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {row.companyCount.toLocaleString()} companies
                      </div>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-sm font-semibold text-foreground">{formatter(value)}</div>
                  </div>
                </div>
                <div className="h-2.5 overflow-hidden rounded-full bg-muted/60">
                  <div
                    className="h-full rounded-full bg-foreground/80 transition-[width]"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function InsightGrid({ rows }: { rows: ClusterMetricsRow[] }) {
  const mostDense = [...rows].sort((a, b) => b.companyCount - a.companyCount)[0];
  const mostActive = [...rows].filter((r) => r.dealCount != null).sort((a, b) => (b.dealCount ?? 0) - (a.dealCount ?? 0))[0];
  const bestFunded = [...rows].filter((r) => r.totalFunding != null).sort((a, b) => (b.totalFunding ?? 0) - (a.totalFunding ?? 0))[0];
  const newest = [...rows].filter((r) => r.avgYearFounded != null).sort((a, b) => (b.avgYearFounded ?? 0) - (a.avgYearFounded ?? 0))[0];

  const items = [
    {
      label: "Largest cluster",
      value: mostDense?.clusterName ?? "—",
      detail: mostDense ? `${fmtCompact(mostDense.companyCount)} companies` : "No company data",
    },
    {
      label: "Most active segment",
      value: mostActive?.clusterName ?? "—",
      detail: mostActive ? `${fmtCompact(mostActive.dealCount ?? null)} deals` : "No deals loaded",
    },
    {
      label: "Capital leader",
      value: bestFunded?.clusterName ?? "—",
      detail: bestFunded ? `${fmtMoneyShort(bestFunded.totalFunding)} total raised` : "No funding data",
    },
    {
      label: "Newest segment",
      value: newest?.clusterName ?? "—",
      detail: newest?.avgYearFounded ? `avg. founded ${newest.avgYearFounded}` : "No founding data",
    },
  ];

  return (
    <Card className="border-border/70 bg-background/80 shadow-sm">
      <CardHeader className="border-b border-border/60 pb-3">
        <div>
          <CardTitle>Headline takeaways</CardTitle>
          <CardDescription>Quick reads on the current shape of the clustered market.</CardDescription>
        </div>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => downloadCsvRows("headline_takeaways.csv", items)}
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3 pt-1 md:grid-cols-2">
        {items.map((item) => (
          <div key={item.label} className="rounded-xl border border-border/70 bg-muted/20 px-4 py-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              {item.label}
            </div>
            <div className="mt-2 text-sm font-semibold text-foreground">{item.value}</div>
            <div className="mt-1 text-xs text-muted-foreground">{item.detail}</div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

const tooltipStyle = {
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 10,
  fontSize: 11,
  color: "hsl(var(--foreground))",
};

export function AnalyticsCharts({ rows }: Props) {
  const hasEmployees = rows.some((r) => r.avgEmployees != null);
  const hasDeals = rows.some((r) => r.dealCount != null);
  const hasFunding = rows.some((r) => r.avgFunding != null);

  return (
    <div className="grid gap-4">
      <InsightGrid rows={rows} />

      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <MetricRailCard
          title="Cluster footprint"
          subtitle="A cleaner ranked view of how company concentration is distributed across segments."
          rows={rows}
          valueKey="companyCount"
          formatter={fmtCompact}
          filename="cluster_footprint.csv"
        />

        {hasDeals ? (
          <MetricRailCard
            title="Deal flow concentration"
            subtitle="Which clusters are capturing the most financing activity right now."
            rows={rows}
            valueKey="dealCount"
            formatter={fmtCompact}
            filename="deal_flow_concentration.csv"
          />
        ) : (
          <Card className="border-border/70 bg-background/80 shadow-sm">
            <CardHeader className="border-b border-border/60 pb-3">
              <CardTitle>Deal flow concentration</CardTitle>
              <CardDescription>Upload a deals file to unlock financing activity views.</CardDescription>
            </CardHeader>
            <CardContent className="pt-1">
              <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-4 py-10 text-sm text-muted-foreground">
                No deals data loaded yet.
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
        {hasEmployees ? (
          <Card className="border-border/70 bg-background/80 shadow-sm">
            <CardHeader className="border-b border-border/60 pb-3">
              <div>
                <CardTitle>Maturity vs. operating scale</CardTitle>
                <CardDescription>
                  Older and larger clusters sit toward the upper-left; younger, leaner clusters sit lower-right.
                </CardDescription>
              </div>
              <CardAction>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() =>
                    downloadCsvRows(
                      "maturity_vs_scale.csv",
                      rows
                        .filter((r) => r.avgYearFounded != null && r.avgEmployees != null)
                        .map((r) => ({
                          Cluster: r.clusterName,
                          "Avg Founded": r.avgYearFounded,
                          "Avg Employees": r.avgEmployees,
                          Companies: r.companyCount,
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
              <ResponsiveContainer width="100%" height={280}>
                <ScatterChart margin={{ top: 10, right: 18, bottom: 12, left: 4 }}>
                  <CartesianGrid stroke="hsl(var(--border))" strokeOpacity={0.45} />
                  <XAxis
                    dataKey="avgYearFounded"
                    name="Avg founded"
                    tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    dataKey="avgEmployees"
                    name="Avg employees"
                    tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <ZAxis dataKey="companyCount" range={[50, 220]} />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    cursor={{ strokeDasharray: "3 3" }}
                    formatter={(value, name) => [value, name]}
                    labelFormatter={(_, payload) => String(payload?.[0]?.payload?.clusterName ?? "")}
                  />
                  <Scatter
                    data={rows.filter((r) => r.avgYearFounded != null && r.avgEmployees != null)}
                    fill="hsl(var(--foreground))"
                    fillOpacity={0.72}
                  />
                </ScatterChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        ) : null}

        {hasFunding ? (
          <Card className="border-border/70 bg-background/80 shadow-sm">
            <CardHeader className="border-b border-border/60 pb-3">
              <div>
                <CardTitle>Capital quality snapshot</CardTitle>
                <CardDescription>
                  Compare median funding strength, recent company formation, and VC graduation at a glance.
                </CardDescription>
              </div>
              <CardAction>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() =>
                    downloadCsvRows(
                      "capital_quality_snapshot.csv",
                      [...rows]
                        .sort((a, b) => (b.avgFunding ?? 0) - (a.avgFunding ?? 0))
                        .map((row) => ({
                          Cluster: row.clusterName,
                          "Avg Raised": row.avgFunding,
                          "% Recent": row.pctRecentlyFounded,
                          "VC Grad Rate": row.vcGraduationRate,
                        }))
                    )
                  }
                >
                  <Download className="h-3.5 w-3.5" />
                  Download
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="grid gap-2.5 pt-1">
              {[...rows]
                .sort((a, b) => (b.avgFunding ?? 0) - (a.avgFunding ?? 0))
                .slice(0, 6)
                .map((row) => (
                  <div key={row.clusterId} className="rounded-xl border border-border/70 bg-muted/15 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-foreground">{row.clusterName}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          Avg. raised {fmtMoneyShort(row.avgFunding)}
                        </div>
                      </div>
                      <div className="text-right text-[11px] text-muted-foreground">
                        <div>Recent: {fmtPct(row.pctRecentlyFounded)}</div>
                        <div>VC grad: {fmtPct(row.vcGraduationRate)}</div>
                      </div>
                    </div>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted/70">
                      <div
                        className="h-full rounded-full bg-foreground/80"
                        style={{
                          width: `${
                            rows.length > 0
                              ? Math.max(
                                  10,
                                  (((row.avgFunding ?? 0) /
                                    Math.max(...rows.map((item) => item.avgFunding ?? 0), 1)) *
                                    100)
                                )
                              : 0
                          }%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
