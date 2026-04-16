"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/store/session";
import { loadCompanies, loadClusters } from "@/lib/firebase/hooks";
import { ClusterOverviewGrid } from "./ClusterOverviewGrid";
import { ClusterEditorPanel } from "./ClusterEditorPanel";
import { AiChatPanel } from "./AiChatPanel";
import { ResortPanel } from "./ResortPanel";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowRight, Download, Loader2, Presentation } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { InfoTooltip } from "@/components/ui/tooltip";
import { UmapScatter, type UmapScatterHandle } from "@/components/embed/UmapScatter";
import { saveAs } from "file-saver";
import Papa from "papaparse";
import { syncReviewToSheet } from "@/lib/sheets/sync";
import { exportClusterSlide } from "@/lib/slides/export";
import { requestSlidesAccess } from "@/lib/firebase/client";
import { toast } from "sonner";

function qualityLabel(score: number): string {
  if (score >= 0.5) return "Good";
  if (score >= 0.3) return "Fair";
  return "Poor";
}

export function ReviewPageClient() {
  const router = useRouter();
  const { uid, companies, clusters, companyCol, clusterMetrics, setCompanies, setClusters } = useSession();
  const [loadError, setLoadError] = useState(false);
  const [loadAttempted, setLoadAttempted] = useState(false);
  const [backWarningOpen, setBackWarningOpen] = useState(false);
  const [creatingSlide, setCreatingSlide] = useState(false);
  const scatterRef = useRef<UmapScatterHandle>(null);

  const loadData = useCallback(() => {
    if (!uid) return;
    setLoadError(false);
    setLoadAttempted(false);
    const p1 = companies.length === 0
      ? loadCompanies(uid, companyCol).then(setCompanies)
      : Promise.resolve();
    const p2 = clusters.length === 0
      ? loadClusters(uid).then(setClusters)
      : Promise.resolve();
    Promise.all([p1, p2])
      .catch(() => setLoadError(true))
      .finally(() => setLoadAttempted(true));
  }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy-load companies + clusters after optimistic navigation (resume fast path).
  // companies.csv already contains _clusterId and _umapX/_umapY so cluster
  // assignments and UMAP coords are restored automatically.
  useEffect(() => {
    loadData();
  }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const handleCreateSlide = async () => {
    if (!uid || !scatterRef.current) return;
    setCreatingSlide(true);
    try {
      let { googleAccessToken, sessionName } = useSession.getState();

      // If the token is missing or the user signed in before the presentations
      // scope was added, trigger an incremental auth popup to get a fresh token.
      if (!googleAccessToken) {
        const fresh = await requestSlidesAccess();
        if (!fresh) throw new Error("Could not obtain Google access token.");
        useSession.getState().setGoogleAccessToken(fresh);
        googleAccessToken = fresh;
      }

      const plotDiv = scatterRef.current.getPlotDiv();
      const url = await exportClusterSlide(
        googleAccessToken,
        uid,
        plotDiv,
        clusters,
        sessionName
      );

      toast.success("Slide created!", {
        description: "Opening in a new tab…",
        action: { label: "Open", onClick: () => window.open(url, "_blank") },
      });
      window.open(url, "_blank");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Scope error — guide the user to re-auth
      if (msg.includes("403") || msg.includes("insufficient")) {
        toast.error("Missing permissions", {
          description: "Sign out and sign back in to grant Slides access, then try again.",
        });
      } else {
        toast.error(`Slide export failed: ${msg}`);
      }
    } finally {
      setCreatingSlide(false);
    }
  };

  // Show error state (failed load, or load completed but returned no companies)
  if (uid && loadAttempted && (loadError || companies.length === 0)) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-sm text-muted-foreground">Failed to load session data.</p>
        <Button variant="outline" size="sm" onClick={loadData}>Retry</Button>
      </div>
    );
  }

  // Show spinner while data loads after fast resume
  if (uid && !loadAttempted && companies.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

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
          <Button
            variant="outline"
            size="sm"
            onClick={handleCreateSlide}
            disabled={creatingSlide || clusters.filter((c) => !c.isOutliers).length === 0}
            className="gap-1.5"
          >
            {creatingSlide ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Presentation className="h-3.5 w-3.5" />
            )}
            {creatingSlide ? "Creating…" : "Create Slide"}
          </Button>
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
        <UmapScatter ref={scatterRef} />
      </div>

      {/* Two-column editor + chat */}
      <div className="grid gap-4 mt-5 px-6 lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-h-[600px] rounded-2xl border border-border/70 bg-background/80 p-5 shadow-sm">
          <ClusterEditorPanel />
        </div>
        <div className="h-[680px] overflow-hidden rounded-2xl border border-border/70 bg-background/80 shadow-sm lg:sticky lg:top-4">
          <AiChatPanel />
        </div>
      </div>

      {/* Re-sort panel — below editor + chat */}
      <ResortPanel />

      {/* Sticky bottom action bar */}
      <div className="sticky bottom-0 z-10 bg-background/95 backdrop-blur-sm border-t border-border px-6 py-3 flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => setBackWarningOpen(true)} className="gap-1.5 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Back to Embed
        </Button>
        <Button onClick={handleContinue} className="gap-2">
          Continue to Analytics
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>

      {/* Back navigation warning */}
      <ConfirmDialog
        open={backWarningOpen}
        title="Go back to Embed & Cluster?"
        description="Your cluster edits are already saved. However, if you re-run clustering it will overwrite all cluster assignments and names."
        confirmLabel="Go Back"
        onConfirm={() => { setBackWarningOpen(false); router.push("/embed"); }}
        onCancel={() => setBackWarningOpen(false)}
      />
    </div>
  );
}
