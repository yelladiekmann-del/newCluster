"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useSession } from "@/lib/store/session";
import { persistSession, loadCompanies } from "@/lib/firebase/hooks";
import { DimensionWeightSliders } from "./DimensionWeightSliders";
import { ClusterParamsPanel } from "./ClusterParamsPanel";
import { ClusterMetricsBar } from "./ClusterMetricsBar";
import { UmapScatter } from "./UmapScatter";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { saveAs } from "file-saver";
import { ArrowLeft, ArrowRight, Cpu, Download, GitBranch, Loader2, Sparkles } from "lucide-react";
import { createParser } from "eventsource-parser";
import { doc, writeBatch } from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import { syncClustersToSheet } from "@/lib/sheets/sync";
import { CLUSTER_COLORS } from "@/types";
import type { ClusterDoc } from "@/types";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export function EmbedPageClient() {
  const router = useRouter();
  const {
    uid, apiKey,
    companies, setCompanies, setClusters, updateCompany,
    companyCol, customWeights, clusterParams,
    setClusterMetrics, setClustersConfirmed, clustersConfirmed,
    embeddingsStoragePath, npzPreloaded,
    setPipelineStep, pipelineStep,
  } = useSession();

  // Lazy-load companies after optimistic resume navigation
  const [loadError, setLoadError] = useState(false);
  const [loadAttempted, setLoadAttempted] = useState(false);
  const loadData = useCallback(() => {
    if (!uid) return;
    setLoadError(false);
    setLoadAttempted(false);
    if (companies.length === 0)
      loadCompanies(uid, companyCol)
        .then(setCompanies)
        .catch(() => setLoadError(true))
        .finally(() => setLoadAttempted(true));
    else
      setLoadAttempted(true);
  }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadData(); }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps

  // Local state — not persisted until confirmed
  const [featureMatrix, setFeatureMatrix] = useState<number[][] | null>(null);
  const [embeddingsUrl, setEmbeddingsUrl] = useState<string | null>(null);
  const [embedProgress, setEmbedProgress] = useState<{ done: number; total: number; errors: number; skipped: number } | null>(null);
  /** Final error count from the last completed embed run — used to show re-embed prompt. */
  const [lastEmbedErrors, setLastEmbedErrors] = useState(0);
  const [embedding, setEmbedding] = useState(false);
  const [clustering, setClustering] = useState(false);
  const [clusterProgress, setClusterProgress] = useState(0);
  const clusterTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [backWarningOpen, setBackWarningOpen] = useState(false);
  const [reclusterWarningOpen, setReclusterWarningOpen] = useState(false);
  const [clusterResult, setClusterResult] = useState<{
    labels: number[];
    embedded2d: number[][];
    metrics: { silhouette?: number; daviesBouldin?: number };
    nClusters: number;
    nOutliers: number;
  } | null>(null);

  const hasEmbeddings = !!featureMatrix || !!embeddingsUrl || npzPreloaded;
  const hasClusters = clusterResult !== null;

  // ── Embed ────────────────────────────────────────────────────────────────

  const handleEmbed = useCallback(async () => {
    if (!apiKey || !uid || companies.length === 0) return;
    setEmbedding(true);
    setEmbedProgress({ done: 0, total: companies.length, errors: 0, skipped: 0 });
    setLastEmbedErrors(0);
    setClusterResult(null);

    try {
      const res = await fetch("/api/embed", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-gemini-key": apiKey },
        body: JSON.stringify({
          sessionId: uid,
          companies: companies.map((c) => ({ id: c.id, dimensions: c.dimensions })),
          weights: customWeights,
          dimPerField: 256,
          // Pass existing matrix so already-embedded (non-zero) rows are skipped.
          // This makes re-runs only process companies that previously failed.
          existingMatrix: featureMatrix ?? null,
        }),
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => res.statusText);
        toast.error(`Embedding failed (${res.status}): ${errText}`);
        return;
      }

      // Start with existing matrix — rows will be overwritten as new results arrive
      const matrix: number[][] = featureMatrix ? [...featureMatrix] : [];
      let rowIdx = 0;
      let finalErrors = 0;
      let finalSkipped = 0;

      const parser = createParser({
        onEvent: (event) => {
          const data = JSON.parse(event.data);
          if (data.type === "progress") {
            setEmbedProgress({
              done: data.done,
              total: data.total,
              errors: data.errors,
              skipped: data.skipped ?? 0,
            });
            if (data.row) {
              matrix[rowIdx] = data.row;
              rowIdx++;
            }
            finalErrors = data.errors;
            finalSkipped = data.skipped ?? 0;
          } else if (data.type === "done") {
            finalErrors = data.errors ?? finalErrors;
            finalSkipped = data.skipped ?? finalSkipped;
          } else if (data.type === "error") {
            toast.error(`Embedding error: ${data.message}`);
          }
        },
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }

      if (matrix.length > 0) {
        const { saveEmbeddingsToStorage } = await import("@/lib/firebase/companies-storage");
        const url = await saveEmbeddingsToStorage(uid!, matrix);
        setEmbeddingsUrl(url);
        setFeatureMatrix(matrix);
        setLastEmbedErrors(finalErrors);

        const newlyEmbedded = matrix.length - finalSkipped;
        if (finalErrors === 0) {
          if (finalSkipped > 0) {
            toast.success(`${newlyEmbedded.toLocaleString()} companies embedded (${finalSkipped.toLocaleString()} skipped — already done)`);
          } else {
            toast.success(`${matrix.length.toLocaleString()} companies embedded`);
          }
        } else {
          const errorPct = Math.round((finalErrors / matrix.length) * 100);
          if (errorPct >= 10) {
            toast.error(
              `${finalErrors.toLocaleString()} companies failed to embed (${errorPct}%). ` +
              `Your Gemini quota may be exhausted. Click Re-embed to retry failures.`,
              { duration: 8000 }
            );
          } else {
            toast.warning(
              `${finalErrors.toLocaleString()} companies failed to embed and were skipped. ` +
              `Click Re-embed to retry.`,
              { duration: 6000 }
            );
          }
        }
      }
    } catch (err) {
      toast.error(String(err));
    } finally {
      setEmbedding(false);
    }
  }, [apiKey, uid, companies, customWeights, featureMatrix]);

  // ── Download embeddings ──────────────────────────────────────────────────

  const handleDownloadEmbeddings = useCallback(() => {
    if (!featureMatrix) return;
    const payload = {
      companies: companies.map((c) => ({ id: c.id, name: c.name })),
      featureMatrix,
    };
    saveAs(
      new Blob([JSON.stringify(payload)], { type: "application/json" }),
      "embeddings.json"
    );
  }, [featureMatrix, companies]);

  // ── Cluster ──────────────────────────────────────────────────────────────

  const handleCluster = useCallback(async () => {
    if (!uid || (!embeddingsUrl && !embeddingsStoragePath)) return;
    setClustering(true);
    setClusterProgress(0);

    // Animate fake progress: ramps to ~85% over ~60s then stalls until done
    clusterTimerRef.current = setInterval(() => {
      setClusterProgress((p) => {
        if (p >= 85) { clearInterval(clusterTimerRef.current!); return p; }
        return p + 0.5;
      });
    }, 400);

    try {
      const res = await fetch("/api/cluster", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: uid,
          companyIds: companies.map((c) => c.id),
          embeddingsUrl: embeddingsUrl ?? undefined,
          embeddingsStoragePath: !embeddingsUrl && embeddingsStoragePath ? embeddingsStoragePath : undefined,
          minClusterSize: clusterParams.minClusterSize,
          minSamples: clusterParams.minSamples,
          clusterEpsilon: clusterParams.clusterEpsilon,
        }),
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => res.statusText);
        toast.error(`Clustering failed: ${errText}`);
        return;
      }

      // Cluster route streams SSE — parse events.
      // Use an object holder so TypeScript CFA doesn't think the variable is
      // always null (it can't track mutations that happen inside callbacks).
      type ClusterResult = {
        labels: number[];
        embedded2d: number[][];
        metrics: { silhouette?: number; daviesBouldin?: number };
        nClusters: number;
        nOutliers: number;
      };
      const holder: { result: ClusterResult | null } = { result: null };

      const parser = createParser({
        onEvent: (event) => {
          const data = JSON.parse(event.data);
          if (data.type === "progress") {
            if (data.stage === "clustering") setClusterProgress(20);
          } else if (data.type === "done") {
            holder.result = data as ClusterResult;
          } else if (data.type === "error") {
            toast.error(`Clustering failed: ${data.error}`);
          }
        },
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }

      const result = holder.result;
      if (!result) return;

      setClusterResult(result);
      setClusterMetrics({
        silhouette: result.metrics?.silhouette ?? null,
        daviesBouldin: result.metrics?.daviesBouldin ?? null,
      });

      result.labels.forEach((label: number, i: number) => {
        const company = companies[i];
        if (!company) return;
        updateCompany(company.id, {
          clusterId: label === -1 ? "outliers" : String(label),
          umapX: result.embedded2d?.[i]?.[0] ?? null,
          umapY: result.embedded2d?.[i]?.[1] ?? null,
        });
      });

      setClusterProgress(100);
      toast.success(`${result.nClusters} clusters found · ${result.nOutliers} outliers`);
    } catch (err) {
      toast.error(String(err));
    } finally {
      if (clusterTimerRef.current) clearInterval(clusterTimerRef.current);
      setClustering(false);
    }
  }, [uid, embeddingsUrl, embeddingsStoragePath, companies, clusterParams, setClusterMetrics, updateCompany]);

  // ── Back navigation ─────────────────────────────────────────────────────

  const handleBack = useCallback(() => {
    if (clusterResult !== null) {
      setBackWarningOpen(true);
    } else {
      router.push("/setup");
    }
  }, [clusterResult, router]);

  // ── Re-cluster gate ──────────────────────────────────────────────────────

  const onClusterClick = useCallback(() => {
    if (clustersConfirmed) {
      setReclusterWarningOpen(true);
    } else {
      handleCluster();
    }
  }, [clustersConfirmed, handleCluster]);

  // ── Confirm & name clusters ──────────────────────────────────────────────

  const handleConfirm = useCallback(async () => {
    if (!apiKey || !uid || !clusterResult) return;
    setConfirming(true);

    try {
      const { saveCompaniesToStorage } = await import("@/lib/firebase/companies-storage");
      await saveCompaniesToStorage(uid, companies);

      // Group companies by cluster index
      const groups: Record<string, typeof companies> = {};
      companies.forEach((c) => {
        const key = c.clusterId ?? "outliers";
        if (!groups[key]) groups[key] = [];
        groups[key].push(c);
      });

      // Name + describe via Gemini
      const namingRes = await fetch("/api/name-clusters", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-gemini-key": apiKey },
        body: JSON.stringify({ uid }),
      });
      if (!namingRes.ok) {
        throw new Error(`Name clusters failed: ${await namingRes.text()}`);
      }
      const { results: namings } = (await namingRes.json()) as {
        results: Array<{ clusterIndex: string; name: string; description: string }>;
      };

      // Write clusters to Firestore
      const db = getFirebaseDb();
      const batch = writeBatch(db);

      const newClusters: ClusterDoc[] = [];

      namings.forEach(({ clusterIndex, name, description }, i) => {
        const id = clusterIndex;
        const color = CLUSTER_COLORS[i % CLUSTER_COLORS.length];
        const companyCount = groups[clusterIndex]?.length ?? 0;
        const clusterDoc: ClusterDoc = { id, name, description, color, isOutliers: false, companyCount };
        newClusters.push(clusterDoc);
        batch.set(doc(db, "sessions", uid, "clusters", id), clusterDoc);
      });

      // Add outliers cluster
      const outliersCount = groups["outliers"]?.length ?? 0;
      if (outliersCount > 0) {
        const outliersDoc: ClusterDoc = {
          id: "outliers",
          name: "Outliers",
          description: "Companies that did not fit cleanly into any cluster.",
          color: "#6b7280",
          isOutliers: true,
          companyCount: outliersCount,
        };
        newClusters.push(outliersDoc);
        batch.set(doc(db, "sessions", uid, "clusters", "outliers"), outliersDoc);
      }

      await batch.commit();
      setClusters(newClusters);
      setClustersConfirmed(true);

      // Persist clusterId/umapX/umapY to Storage CSV
      await saveCompaniesToStorage(uid, useSession.getState().companies);

      const nextStep = Math.max(pipelineStep, 3) as 3;
      setPipelineStep(nextStep);
      await persistSession(uid, {
        pipelineStep: nextStep,
        clustersConfirmed: true,
        clusterCount: newClusters.filter((c) => !c.isOutliers).length,
      });

      toast.success("Clusters named and confirmed");

      // Background Sheets sync — non-blocking
      const { googleAccessToken, spreadsheetId: sid } = useSession.getState();
      if (googleAccessToken && sid) {
        syncClustersToSheet(googleAccessToken, sid, useSession.getState().companies, newClusters)
          .then(() => toast.success("Clusters synced to Google Sheets"))
          .catch(() => {}); // silent fail
      }

      router.push("/review");
    } catch (err) {
      toast.error(String(err));
    } finally {
      setConfirming(false);
    }
  }, [apiKey, uid, clusterResult, companies, setClusters, setClustersConfirmed, pipelineStep, setPipelineStep, router]);

  const embedPct = embedProgress
    ? Math.round((embedProgress.done / embedProgress.total) * 100)
    : 0;

  // Show error state (failed load, or load completed but returned no companies)
  if (uid && loadAttempted && (loadError || companies.length === 0)) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-sm text-muted-foreground">Failed to load session data.</p>
        <Button variant="outline" size="sm" onClick={loadData}>Retry</Button>
      </div>
    );
  }

  // Show spinner while companies load after fast resume
  if (uid && !loadAttempted && companies.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 pb-24 flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">Embed & Cluster</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Generate vector embeddings per dimension, then run HDBSCAN clustering.
        </p>
      </div>

      {/* Step 1: Embed */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">
            Step 1 — Embed{hasEmbeddings ? " ✓" : ""}
          </h2>
        </div>

        <DimensionWeightSliders />

        {embedding && embedProgress && (
          <div className="flex flex-col gap-1">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>
                Embedding {embedProgress.done}/{embedProgress.total} companies…
                {embedProgress.skipped > 0 && (
                  <span className="ml-1 text-muted-foreground">({embedProgress.skipped} skipped)</span>
                )}
              </span>
              {embedProgress.errors > 0 && (
                <span className="font-semibold text-destructive px-1.5 py-0.5 rounded bg-destructive/10">
                  ⚠ {embedProgress.errors} failed
                </span>
              )}
            </div>
            <Progress value={embedPct} className="h-1.5" />
          </div>
        )}

        {/* Post-run error warning */}
        {!embedding && lastEmbedErrors > 0 && featureMatrix && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <span className="mt-0.5 shrink-0">⚠</span>
            <span>
              <strong>{lastEmbedErrors.toLocaleString()} companies</strong> failed to embed (stored as zero vectors).
              Clustering may be lower quality. Click <strong>Re-embed failed</strong> to retry only those companies.
            </span>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={handleEmbed}
            disabled={!apiKey || embedding || companies.length === 0}
            className="gap-1.5"
          >
            {embedding ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Cpu className="h-3.5 w-3.5" />
            )}
            {hasEmbeddings ? "↺ Re-embed" : "Embed"}
          </Button>
          {/* Show Re-embed failed button separately when errors exist — makes intent clear */}
          {!embedding && lastEmbedErrors > 0 && featureMatrix && (
            <Button
              variant="outline"
              onClick={handleEmbed}
              disabled={!apiKey || embedding}
              className="gap-1.5 border-amber-500/50 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10"
            >
              <Cpu className="h-3.5 w-3.5" />
              Re-embed failed ({lastEmbedErrors.toLocaleString()})
            </Button>
          )}
          {featureMatrix && !embedding && (
            <Button variant="outline" onClick={handleDownloadEmbeddings} className="gap-1.5">
              <Download className="h-3.5 w-3.5" />
              Download embeddings
            </Button>
          )}
        </div>
      </section>

      <Separator />

      {/* Step 2: Cluster */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">
            Step 2 — Cluster{hasClusters ? " ✓" : ""}
          </h2>
        </div>

        {!hasEmbeddings && (
          <p className="text-xs text-muted-foreground">
            Generate embeddings above first.
          </p>
        )}

        <ClusterParamsPanel />

        <Button
          onClick={onClusterClick}
          disabled={!hasEmbeddings || clustering}
          variant={hasEmbeddings ? "default" : "secondary"}
          className="self-start gap-1.5"
        >
          {clustering ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <GitBranch className="h-3.5 w-3.5" />
          )}
          {clustering ? "Clustering…" : "▶ Cluster"}
        </Button>

        {clustering && (
          <div className="flex flex-col gap-1">
            <div className="flex justify-end text-xs text-muted-foreground">
              <span>{clusterProgress}%</span>
            </div>
            <Progress value={clusterProgress} className="h-1.5" />
          </div>
        )}

        {clusterResult && (
          <>
            <ClusterMetricsBar result={clusterResult} />
            <UmapScatter />
          </>
        )}
      </section>

      {/* Sticky bottom action bar — always visible */}
      <div className="fixed bottom-0 left-56 right-0 z-10 bg-background/95 backdrop-blur-sm border-t border-border px-6 py-3 flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={handleBack} className="gap-1.5 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Back to Setup
        </Button>
        {hasClusters ? (
          <Button
            onClick={handleConfirm}
            disabled={!apiKey || confirming}
            className="gap-2"
          >
            {confirming ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {confirming ? "Naming clusters…" : "Confirm & name clusters"}
            {!confirming && <ArrowRight className="h-4 w-4" />}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">
            Run clustering above to continue.
          </p>
        )}
      </div>

      {/* Navigation warning dialogs */}
      <ConfirmDialog
        open={backWarningOpen}
        title="Discard clustering results?"
        description="Your clustering results haven't been confirmed yet. Going back will discard them."
        confirmLabel="Discard & go back"
        variant="destructive"
        onConfirm={() => { setBackWarningOpen(false); router.push("/setup"); }}
        onCancel={() => setBackWarningOpen(false)}
      />
      <ConfirmDialog
        open={reclusterWarningOpen}
        title="Re-cluster?"
        description="Re-clustering will overwrite your confirmed clusters and any edits made in Review & Edit. This cannot be undone."
        confirmLabel="Re-cluster"
        variant="destructive"
        onConfirm={() => { setReclusterWarningOpen(false); handleCluster(); }}
        onCancel={() => setReclusterWarningOpen(false)}
      />
    </div>
  );
}
