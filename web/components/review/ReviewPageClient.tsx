"use client";

import { useRouter } from "next/navigation";
import { useSession } from "@/lib/store/session";
import { ClusterOverviewGrid } from "./ClusterOverviewGrid";
import { ClusterEditorPanel } from "./ClusterEditorPanel";
import { AiChatPanel } from "./AiChatPanel";
import { ResortPanel } from "./ResortPanel";
import { Button } from "@/components/ui/button";
import { ArrowRight, Download } from "lucide-react";
import { InfoTooltip } from "@/components/ui/tooltip";
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
              <span className="flex items-center">
                Silhouette:{" "}
                <span className="text-foreground font-mono ml-1">{clusterMetrics.silhouette.toFixed(2)}</span>{" "}
                <span className="ml-1">({qualityLabel(clusterMetrics.silhouette)})</span>
                <InfoTooltip content="Measures cluster cohesion vs. separation. >0.5 = good, 0.3–0.5 = fair, <0.3 = poor" />
              </span>
              {clusterMetrics.daviesBouldin != null && (
                <span className="flex items-center">
                  Davies-Bouldin:{" "}
                  <span className="text-foreground font-mono ml-1">{clusterMetrics.daviesBouldin.toFixed(2)}</span>
                  <InfoTooltip content="Measures average cluster overlap. Lower is better; <1.0 is good." />
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

      {/* Two-column editor + chat */}
      <div className="flex gap-0 mt-5 border-t border-border">
        <div className="flex-1 border-r border-border p-5 min-h-[600px]">
          <ClusterEditorPanel />
        </div>
        <div className="w-[420px] shrink-0 h-[680px] sticky top-0 overflow-hidden flex flex-col">
          <AiChatPanel />
        </div>
      </div>

      {/* Re-sort panel — below editor + chat */}
      <ResortPanel />

      {/* Sticky bottom action bar */}
      <div className="sticky bottom-0 z-10 bg-background/95 backdrop-blur-sm border-t border-border px-6 py-3 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {clusters.filter((c) => !c.isOutliers).length} clusters · {companies.length} companies
        </span>
        <Button onClick={handleContinue} className="gap-2">
          Continue to Analytics
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
