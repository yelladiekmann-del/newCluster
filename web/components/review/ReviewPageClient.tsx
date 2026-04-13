"use client";

import { useRouter } from "next/navigation";
import { useSession } from "@/lib/store/session";
import { ClusterOverviewGrid } from "./ClusterOverviewGrid";
import { ClusterEditorPanel } from "./ClusterEditorPanel";
import { AiChatPanel } from "./AiChatPanel";
import { Button } from "@/components/ui/button";
import { ArrowRight, Download } from "lucide-react";
import { UmapScatter } from "@/components/embed/UmapScatter";
import { saveAs } from "file-saver";
import Papa from "papaparse";

export function ReviewPageClient() {
  const router = useRouter();
  const { companies, clusters, companyCol } = useSession();

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
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-5 border-b border-border flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Review & Edit</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {companies.length} companies · {clusters.filter((c) => !c.isOutliers).length} clusters
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleDownload} className="gap-1.5">
            <Download className="h-3.5 w-3.5" />
            Download CSV
          </Button>
          <Button size="sm" onClick={() => router.push("/analytics")} className="gap-1.5">
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

      {/* Two-column editor + chat */}
      <div className="flex flex-1 gap-0 mt-5 min-h-0 border-t border-border">
        <div className="flex-1 border-r border-border overflow-y-auto p-5">
          <ClusterEditorPanel />
        </div>
        <div className="w-[420px] shrink-0 overflow-y-auto">
          <AiChatPanel />
        </div>
      </div>
    </div>
  );
}
