"use client";

import dynamic from "next/dynamic";
import { useSession } from "@/lib/store/session";
import { CLUSTER_COLORS } from "@/types";

// react-plotly.js uses browser APIs — must be loaded client-side only
const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

export function UmapScatter() {
  const { companies, clusters } = useSession();

  // Group companies by cluster for coloring
  const clusterMap: Record<string, { x: number[]; y: number[]; names: string[]; color: string }> = {};

  for (const company of companies) {
    if (company.umapX == null || company.umapY == null) continue;
    const cid = company.clusterId ?? "outliers";
    const cluster = clusters.find((c) => c.id === cid);
    const color = cluster?.color ?? "#6b7280";
    const label = cluster?.name ?? "Outliers";

    if (!clusterMap[label]) {
      clusterMap[label] = { x: [], y: [], names: [], color };
    }
    clusterMap[label].x.push(company.umapX);
    clusterMap[label].y.push(company.umapY);
    clusterMap[label].names.push(company.name);
  }

  const traces = Object.entries(clusterMap).map(([name, { x, y, names, color }]) => ({
    type: "scatter" as const,
    mode: "markers" as const,
    name,
    x,
    y,
    text: names,
    hovertemplate: "%{text}<extra></extra>",
    marker: {
      color,
      size: 6,
      opacity: name === "Outliers" ? 0.3 : 0.75,
    },
  }));

  if (traces.length === 0) return null;

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <Plot
        data={traces}
        layout={{
          height: 420,
          paper_bgcolor: "transparent",
          plot_bgcolor: "transparent",
          font: { color: "#94a3b8", size: 11 },
          margin: { t: 20, b: 40, l: 40, r: 20 },
          xaxis: { showgrid: false, zeroline: false, showticklabels: false },
          yaxis: { showgrid: false, zeroline: false, showticklabels: false },
          legend: {
            bgcolor: "transparent",
            bordercolor: "transparent",
            font: { size: 11 },
            x: 1,
            xanchor: "right",
          },
          dragmode: "lasso",
        }}
        config={{ displayModeBar: false, responsive: true }}
        style={{ width: "100%" }}
      />
    </div>
  );
}
