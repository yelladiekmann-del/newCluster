"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  ZAxis,
} from "recharts";
import type { ClusterMetricsRow } from "@/types";

interface Props {
  rows: ClusterMetricsRow[];
}

const TEAL = "#26B4D2";
const TEAL_DIM = "#26B4D280";

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-3">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {title}
      </p>
      {children}
    </div>
  );
}

const tooltipStyle = {
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 6,
  fontSize: 11,
  color: "hsl(var(--foreground))",
};

export function AnalyticsCharts({ rows }: Props) {
  const hasEmployees = rows.some((r) => r.avgEmployees != null);
  const hasFunding = rows.some((r) => r.avgFunding != null);
  const hasDeals = rows.some((r) => r.dealCount != null);

  const sorted = [...rows].sort((a, b) => b.companyCount - a.companyCount);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Cluster size */}
      <ChartCard title="Companies per cluster">
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={sorted} layout="vertical" margin={{ left: 0, right: 16 }}>
            <CartesianGrid horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.5} />
            <XAxis type="number" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="clusterName" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} width={100} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "hsl(var(--muted))" }} />
            <Bar dataKey="companyCount" name="Companies" fill={TEAL} radius={[0, 3, 3, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Maturity scatter */}
      {hasEmployees && (
        <ChartCard title="Maturity vs. Scale">
          <ResponsiveContainer width="100%" height={220}>
            <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 0 }}>
              <CartesianGrid stroke="hsl(var(--border))" strokeOpacity={0.4} />
              <XAxis
                dataKey="avgYearFounded"
                name="Avg founded"
                tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                axisLine={false}
                tickLine={false}
                label={{ value: "Avg founded", position: "insideBottom", offset: -10, fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              />
              <YAxis
                dataKey="avgEmployees"
                name="Avg employees"
                tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                axisLine={false}
                tickLine={false}
              />
              <ZAxis dataKey="companyCount" range={[40, 200]} />
              <Tooltip
                contentStyle={tooltipStyle}
                cursor={{ strokeDasharray: "3 3" }}
                formatter={(value, name) => [value, name]}
              />
              <Scatter
                data={rows.filter((r) => r.avgYearFounded != null && r.avgEmployees != null)}
                fill={TEAL}
                opacity={0.75}
                name="Cluster"
              />
            </ScatterChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* Deals */}
      {hasDeals && (
        <ChartCard title="Deals by cluster">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={[...rows].sort((a, b) => (b.dealCount ?? 0) - (a.dealCount ?? 0))} layout="vertical" margin={{ left: 0, right: 16 }}>
              <CartesianGrid horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.5} />
              <XAxis type="number" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="clusterName" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} width={100} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "hsl(var(--muted))" }} />
              <Bar dataKey="dealCount" name="Deals" fill={TEAL} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* Funding */}
      {hasFunding && (
        <ChartCard title="Avg funding raised">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={[...rows].sort((a, b) => (b.avgFunding ?? 0) - (a.avgFunding ?? 0))} layout="vertical" margin={{ left: 0, right: 16 }}>
              <CartesianGrid horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.5} />
              <XAxis type="number" tickFormatter={(v) => `$${(v / 1e6).toFixed(0)}M`} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="clusterName" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} width={100} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "hsl(var(--muted))" }} formatter={(v) => [`$${((v as number) / 1e6).toFixed(1)}M`, "Avg raised"]} />
              <Bar dataKey="avgFunding" name="Avg funding" fill={TEAL} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}
    </div>
  );
}
