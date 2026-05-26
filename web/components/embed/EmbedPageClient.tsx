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
import { AlertTriangle, ArrowLeft, ArrowRight, ChevronDown, ChevronUp, Cpu, GitBranch, Loader2, Sparkles } from "lucide-react";
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
    uid,
    companies, setCompanies, setClusters,
    companyCol, customWeights, clusterParams,
    setClusterMetrics, setClustersConfirmed, clustersConfirmed,
    embeddingsStoragePath, setEmbeddingsStoragePath, npzPreloaded,
    setPipelineStep, pipelineStep,
    lastEmbedErrors, setLastEmbedErrors,
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
  const [embedProgress, setEmbedProgress] = useState<{ done: number; total: number; errors: number; skipped: number } | null>(null);
  const [embedToEmbed, setEmbedToEmbed] = useState<number | null>(null);
  const [embedding, setEmbedding] = useState(false);
  const [failedEmbedIds, setFailedEmbedIds] = useState<string[]>([]);
  const [failedEmbedOpen, setFailedEmbedOpen] = useState(false);
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

  const hasEmbeddings = !!embeddingsStoragePath || npzPreloaded;
  const hasClusters = clusterResult !== null;

  // ── Embed ────────────────────────────────────────────────────────────────

  const handleEmbed = useCallback(async () => {
    if (!uid || companies.length === 0) return;
    setEmbedding(true);
    setEmbedProgress({ done: 0, total: companies.length, errors: 0, skipped: 0 });
    setEmbedToEmbed(null);
    setLastEmbedErrors(0);
    setClusterResult(null);

    try {
      const res = await fetch("/api/embed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: uid,
          companies: companies.map((c) => ({ id: c.id, dimensions: c.dimensions })),
          weights: customWeights,
          // Pass existing storage path so the server can download and skip already-embedded rows
          embeddingsStoragePath: embeddingsStoragePath ?? null,
        }),
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => res.statusText);
        toast.error(`Embedding failed (${res.status}): ${errText}`);
        return;
      }

      let finalErrors = 0;
      let finalSkipped = 0;
      let finalTotal = companies.length;
      const accumulatedErrorIds: string[] = [];
      setFailedEmbedIds([]);
      setFailedEmbedOpen(false);

      const parser = createParser({
        onEvent: (event) => {
          const data = JSON.parse(event.data);
          if (data.type === "init") {
            setEmbedToEmbed(data.toEmbed);
            setEmbedProgress({ done: 0, total: data.toEmbed, errors: 0, skipped: 0 });
          } else if (data.type === "progress") {
            const adjustedTotal = embedToEmbed ?? data.total;
            const adjustedDone = Math.max(0, data.done - (data.skipped ?? 0));
            setEmbedProgress({
              done: adjustedDone,
              total: adjustedTotal,
              errors: data.errors,
              skipped: data.skipped ?? 0,
            });
            finalErrors = data.errors;
            finalSkipped = data.skipped ?? 0;
            finalTotal = data.total;
            if (Array.isArray(data.errorIds) && data.errorIds.length > 0) {
              accumulatedErrorIds.push(...data.errorIds);
            }
          } else if (data.type === "done") {
            finalErrors = data.errors ?? finalErrors;
            finalSkipped = data.skipped ?? finalSkipped;
            const ids: string[] = Array.isArray(data.errorIds) && data.errorIds.length > 0
              ? data.errorIds
              : accumulatedErrorIds;
            if (ids.length > 0) {
              setFailedEmbedIds(ids);
              setFailedEmbedOpen(true);
            }
            // Server uploads matrix to Storage and returns the path
            if (data.embeddingsStoragePath) {
              setEmbeddingsStoragePath(data.embeddingsStoragePath);
              persistSession(uid, { embeddingsStoragePath: data.embeddingsStoragePath }).catch(
                (err) => console.error("[embed] persistSession failed:", err)
              );
            }
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

      setLastEmbedErrors(finalErrors);
      persistSession(uid, { lastEmbedErrors: finalErrors }).catch(
        (err) => console.error("[embed] failed to persist lastEmbedErrors:", err)
      );
      const newlyEmbedded = finalTotal - finalSkipped;

      if (finalErrors === 0) {
        if (finalSkipped > 0) {
          toast.success(`${newlyEmbedded.toLocaleString()} companies embedded (${finalSkipped.toLocaleString()} skipped — already done)`);
        } else {
          toast.success(`${finalTotal.toLocaleString()} companies embedded`);
        }
      } else {
        // Failed companies are shown in the collapsible panel below — no separate toast needed
        toast.warning(`${finalErrors.toLocaleString()} companies failed to embed — see list below.`, { duration: 4000 });
      }
    } catch (err) {
      toast.error(String(err));
    } finally {
      setEmbedding(false);
    }
  }, [uid, companies, customWeights, embeddingsStoragePath, setEmbeddingsStoragePath]);

  // ── Cluster ──────────────────────────────────────────────────────────────

  const handleCluster = useCallback(async () => {
    if (!uid || !embeddingsStoragePath) return;
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
          embeddingsStoragePath,
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

      // Single O(N) pass instead of N × O(N) updateCompany calls
      setCompanies(companies.map((c, i) => ({
        ...c,
        clusterId: result.labels[i] === -1 ? "outliers" : String(result.labels[i]),
        umapX: result.embedded2d?.[i]?.[0] ?? null,
        umapY: result.embedded2d?.[i]?.[1] ?? null,
      })));

      setClusterProgress(100);
      toast.success(`${result.nClusters} clusters found · ${result.nOutliers} outliers`);
    } catch (err) {
      toast.error(String(err));
    } finally {
      if (clusterTimerRef.current) clearInterval(clusterTimerRef.current);
      setClustering(false);
    }
  }, [uid, embeddingsStoragePath, companies, clusterParams, setClusterMetrics, setCompanies]);

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
    if (!uid || !clusterResult) return;
    setConfirming(true);

    try {
      // Save cluster results (clusterId + umapX/Y) server-side via Admin SDK.
      // This replaces the old browser-side saveCompaniesToStorage call which
      // took 2–5 min for large datasets due to client SDK round-trip latency.
      const confirmRes = await fetch("/api/confirm-clusters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uid,
          updates: companies.map((c) => ({
            id: c.id,
            clusterId: c.clusterId,
            umapX: c.umapX,
            umapY: c.umapY,
          })),
        }),
      });
      if (!confirmRes.ok) {
        throw new Error(`Failed to save cluster results: ${await confirmRes.text()}`);
      }

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
        headers: { "Content-Type": "application/json" },
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

      // No second save needed — companies (with clusterId/umapX/Y) were already
      // written to Firestore via /api/confirm-clusters above.

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
  }, [uid, clusterResult, companies, setClusters, setClustersConfirmed, pipelineStep, setPipelineStep, router]);

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
                  <span className="ml-1 text-muted-foreground/60">({embedProgress.skipped} already done)</span>
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

        {/* Failed embed panel — collapsible, shows company names */}
        {!embedding && lastEmbedErrors > 0 && embeddingsStoragePath && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 text-sm">
            <button
              type="button"
              onClick={() => setFailedEmbedOpen((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-2 text-amber-600 hover:text-amber-700 transition-colors"
            >
              <span className="flex items-center gap-1.5 font-medium text-xs">
                <AlertTriangle className="h-3.5 w-3.5" />
                {lastEmbedErrors.toLocaleString()} companies failed to embed (stored as zero vectors) — clustering may be lower quality
              </span>
              {failedEmbedOpen ? <ChevronUp className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
            </button>
            {failedEmbedOpen && (
              <div className="px-3 pb-3 flex flex-col gap-2">
                <p className="text-xs text-muted-foreground">
                  These companies had no embeddable dimensions or hit a quota error. Use <strong>Re-embed failed</strong> to retry them.
                </p>
                {failedEmbedIds.length > 0 ? (
                  <ul className="text-xs text-muted-foreground space-y-0.5 max-h-36 overflow-y-auto">
                    {failedEmbedIds.map((id) => {
                      const name = companies.find((c) => c.id === id)?.name ?? id;
                      return <li key={id} className="truncate">· {name}</li>;
                    })}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground italic">
                    Company names unavailable — re-embed to see updated list.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={handleEmbed}
            disabled={embedding || companies.length === 0}
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
          {!embedding && lastEmbedErrors > 0 && embeddingsStoragePath && (
            <Button
              variant="outline"
              onClick={handleEmbed}
              disabled={embedding}
              className="gap-1.5 border-amber-500/50 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10"
            >
              <Cpu className="h-3.5 w-3.5" />
              Re-embed failed ({lastEmbedErrors.toLocaleString()})
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
            disabled={confirming}
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
