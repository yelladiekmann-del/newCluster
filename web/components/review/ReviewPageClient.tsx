"use client";

import { useRouter } from "next/navigation";
import { useSession } from "@/lib/store/session";
import { ClusterOverviewGrid } from "./ClusterOverviewGrid";
import { ClusterEditorPanel } from "./ClusterEditorPanel";
import { AiChatPanel } from "./AiChatPanel";
import { ResortPanel } from "./ResortPanel";
import { Button } from "@/components/ui/button";
import { ArrowRight, Download } from "lucide-react";
import { UmapScatter } from "@/components/embed/UmapScatter";
import { saveAs } from "file-saver";
import Papa from "papaparse";
import { syncReviewToSheet } from "@/lib/sheets/sync";

function qualityLabel(score: number): string {
  if (score >= 0.5) return "Good";
  if (score >= 0.3) return "Fair";
  return "Poor";
}

export function ReviewPageClient() {
  const router = useRouter();
  const { companies, clusters, companyCol, clusterMetrics } = useSession();

  async function handleContinue() {
    const { googleAccessToken, spreadsheetId } = useSession.getState();
    if (googleAccessToken && spreadsheetId) {
      syncReviewToSheet(googleAccessToken, spreadsheetId, companies, clusters).catch(() => {});
    }
    router.push("/analytics");
  }

  const handleDownload = () => {
    const rows = companies.map((c) => {
      const cluster = clusters.find((cl) => cl.id === c.clusterId);
      return {
        [companyCol]: c.name,
        Cluster: cluster?.name ?? "Outliers",
        "Outlier score": c.outlierScore ?? "",
        ...c.dimensions,
      };
    });
    const csv = Papa.unparse(rows);
    saveAs(new Blob([csv], { type: "text/csv" }), "cluster_results.csv");
  };

  return (
    <div className="overflow-y-auto h-full">
      {/* Header */}
      <div className="px-6 py-5 border-b border-border flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Review & Edit</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {companies.length} companies · {clusters.filter((c) => !c.isOutliers).length} clusters
          </p>
          {clusterMetrics?.silhouette != null && (
            <div className="flex gap-3 text-xs text-muted-foreground mt-1">
              <span>
                Silhouette:{" "}
                <span className="text-foreground font-mono">{clusterMetrics.silhouette.toFixed(2)}</span>{" "}
                ({qualityLabel(clusterMetrics.silhouette)})
              </span>
              {clusterMetrics.daviesBouldin != null && (
                <span>
                  Davies-Bouldin:{" "}
                  <span className="text-foreground font-mono">{clusterMetrics.daviesBouldin.toFixed(2)}</span>
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleDownload} className="gap-1.5">
            <Download className="h-3.5 w-3.5" />
            Download CSV
          </Button>
          <Button size="sm" onClick={handleContinue} className="gap-1.5">
            Continue to Analytics
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Cluster overview cards */}
      <div className="px-6 pt-5">
        <ClusterOverviewGrid />
      </div>

      {/* UMAP scatter */}
      <div className="px-6 pt-4">
        <UmapScatter />
      </div>

      {/* Re-sort panel */}
      <ResortPanel />

      {/* Two-column editor + chat */}
      <div className="flex gap-0 mt-5 border-t border-border min-h-[600px]">
        <div className="flex-1 border-r border-border p-5">
          <ClusterEditorPanel />
        </div>
        <div className="w-[420px] shrink-0">
          <AiChatPanel />
        </div>
      </div>
    </div>
  );
}
