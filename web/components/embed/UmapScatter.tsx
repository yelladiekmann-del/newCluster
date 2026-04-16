"use client";

import { useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { useSession } from "@/lib/store/session";
import { CLUSTER_COLORS } from "@/types";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { sortClustersOutliersLast } from "@/lib/cluster-order";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

export function UmapScatter() {
  const { companies, clusters } = useSession();
  const plotRef = useRef<unknown>(null);

  const handleExport = useCallback(async (format: "png" | "svg") => {
    if (!plotRef.current) return;
    const Plotly = (await import("plotly.js-dist-min")).default;
    await Plotly.downloadImage(plotRef.current, {
      format,
      filename: `cluster-umap-${new Date().toISOString().slice(0, 10)}`,
      width: 1600,
      height: 1000,
      scale: format === "png" ? 2 : 1,
    });
  }, []);

  // Build a color map for all unique cluster IDs.
  // Prefer the stored cluster color; fall back to CLUSTER_COLORS by index.
  const orderedClusters = sortClustersOutliersLast(clusters);
  const companyClusterIds = [...new Set(
    companies
      .map((company) => company.clusterId ?? "outliers")
      .filter((id) => id !== "outliers")
  )];

  const uniqueClusterIds =
    orderedClusters.filter((cluster) => !cluster.isOutliers).length > 0
      ? orderedClusters
          .filter((cluster) => !cluster.isOutliers)
          .map((cluster) => cluster.id)
          .filter((id) => companies.some((company) => (company.clusterId ?? "outliers") === id))
      : companyClusterIds;

  const colorById: Record<string, string> = { outliers: "#6b7280" };
  uniqueClusterIds.forEach((id, i) => {
    const clusterDoc = clusters.find((c) => c.id === id);
    colorById[id] = clusterDoc?.color ?? CLUSTER_COLORS[i % CLUSTER_COLORS.length];
  });

  const nameById: Record<string, string> = { outliers: "Outliers" };
  uniqueClusterIds.forEach((id) => {
    const clusterDoc = clusters.find((c) => c.id === id);
    nameById[id] = clusterDoc?.name ?? `Cluster ${parseInt(id) + 1}`;
  });

  // Group companies by cluster for Plotly traces
  const traceMap: Record<string, { x: number[]; y: number[]; names: string[]; color: string; isOutlier: boolean }> = {};

  for (const company of companies) {
    if (company.umapX == null || company.umapY == null) continue;
    const cid = company.clusterId ?? "outliers";
    const label = nameById[cid];
    if (!traceMap[label]) {
      traceMap[label] = { x: [], y: [], names: [], color: colorById[cid], isOutlier: cid === "outliers" };
    }
    traceMap[label].x.push(company.umapX);
    traceMap[label].y.push(company.umapY);
    traceMap[label].names.push(company.name);
  }

  const orderedTraceNames = [
    ...(orderedClusters.filter((cluster) => !cluster.isOutliers).length > 0
      ? orderedClusters.filter((cluster) => !cluster.isOutliers).map((cluster) => cluster.name)
      : uniqueClusterIds.map((id) => nameById[id])),
    "Outliers",
  ].filter((name, index, arr) => arr.indexOf(name) === index && traceMap[name]);

  const traces = orderedTraceNames.map((name) => {
    const { x, y, names, color, isOutlier } = traceMap[name];
    return {
      type: "scatter" as const,
      mode: "markers" as const,
      name,
      x,
      y,
      text: names,
      hovertemplate: "%{text}<extra></extra>",
      marker: {
        color,
        size: isOutlier ? 5 : 7,
        opacity: isOutlier ? 0.35 : 0.82,
      },
    };
  });

  if (traces.length === 0) return null;

  return (
    <div className="rounded-xl border border-border overflow-hidden bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-foreground">Cluster Map</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => handleExport("png")}>
            <Download className="h-3.5 w-3.5" />
            PNG
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => handleExport("svg")}>
            <Download className="h-3.5 w-3.5" />
            SVG
          </Button>
        </div>
      </div>
      <Plot
        data={traces}
        onInitialized={(_, graphDiv) => {
          plotRef.current = graphDiv;
        }}
        onUpdate={(_, graphDiv) => {
          plotRef.current = graphDiv;
        }}
        layout={{
          height: 440,
          paper_bgcolor: "transparent",
          plot_bgcolor: "transparent",
          font: { color: "#64748b", size: 11 },
          margin: { t: 16, b: 32, l: 32, r: 16 },
          xaxis: { showgrid: false, zeroline: false, showticklabels: false },
          yaxis: { showgrid: false, zeroline: false, showticklabels: false },
          legend: {
            bgcolor: "rgba(255,255,255,0.8)",
            bordercolor: "rgba(0,0,0,0.06)",
            borderwidth: 1,
            font: { size: 11, color: "#334155" },
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
