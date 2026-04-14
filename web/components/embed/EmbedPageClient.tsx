"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useSession } from "@/lib/store/session";
import { persistSession } from "@/lib/firebase/hooks";
import { DimensionWeightSliders } from "./DimensionWeightSliders";
import { ClusterParamsPanel } from "./ClusterParamsPanel";
import { ClusterMetricsBar } from "./ClusterMetricsBar";
import { UmapScatter } from "./UmapScatter";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { saveAs } from "file-saver";
import { ArrowRight, Cpu, Download, GitBranch, Loader2, Sparkles } from "lucide-react";
import { createParser } from "eventsource-parser";
import { doc, writeBatch, collection, setDoc } from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import { nameAllClusters } from "@/lib/gemini/name-clusters";
import { syncClustersToSheet } from "@/lib/sheets/sync";
import { CLUSTER_COLORS } from "@/types";
import type { ClusterDoc } from "@/types";

export function EmbedPageClient() {
  const router = useRouter();
  const {
    uid, apiKey,
    companies, clusters, setClusters, updateCompany,
    customWeights, clusterParams,
    setClusterMetrics, setClustersConfirmed,
    embeddingsStoragePath, npzPreloaded,
    setPipelineStep, pipelineStep,
  } = useSession();

  // Local state — not persisted until confirmed
  const [featureMatrix, setFeatureMatrix] = useState<number[][] | null>(null);
  const [embedProgress, setEmbedProgress] = useState<{ done: number; total: number; errors: number } | null>(null);
  const [embedding, setEmbedding] = useState(false);
  const [clustering, setClustering] = useState(false);
  const [clusterProgress, setClusterProgress] = useState(0);
  const clusterTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [clusterResult, setClusterResult] = useState<{
    labels: number[];
    embedded2d: number[][];
    metrics: { silhouette?: number; daviesBouldin?: number };
    nClusters: number;
    nOutliers: number;
  } | null>(null);

  const hasEmbeddings = !!featureMatrix || npzPreloaded;
  const hasClusters = clusterResult !== null;

  // ── Embed ────────────────────────────────────────────────────────────────

  const handleEmbed = useCallback(async () => {
    if (!apiKey || !uid || companies.length === 0) return;
    setEmbedding(true);
    setEmbedProgress({ done: 0, total: companies.length, errors: 0 });
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
        }),
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => res.statusText);
        toast.error(`Embedding failed (${res.status}): ${errText}`);
        return;
      }

      let matrix: number[][] = [];
      const parser = createParser({
        onEvent: (event) => {
          const data = JSON.parse(event.data);
          if (data.type === "progress") {
            setEmbedProgress({ done: data.done, total: data.total, errors: data.errors });
          } else if (data.type === "done") {
            matrix = data.featureMatrix ?? data.feature_matrix;
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
        setFeatureMatrix(matrix);
        toast.success(`${matrix.length.toLocaleString()} companies embedded`);
      }
    } catch (err) {
      toast.error(String(err));
    } finally {
      setEmbedding(false);
    }
  }, [apiKey, uid, companies, customWeights]);

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
    if (!uid || !featureMatrix) return;
    setClustering(true);
    setClusterProgress(0);

    // Animate fake progress: ramps to ~85% over ~30s then stalls until done
    clusterTimerRef.current = setInterval(() => {
      setClusterProgress((p) => {
        if (p >= 85) { clearInterval(clusterTimerRef.current!); return p; }
        return p + 1;
      });
    }, 400);

    try {
      const res = await fetch("/api/cluster", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: uid,
          companyIds: companies.map((c) => c.id),
          featureMatrix,
          minClusterSize: clusterParams.minClusterSize,
          minSamples: clusterParams.minSamples,
          clusterEpsilon: clusterParams.clusterEpsilon,
          umapClusterDims: clusterParams.umapClusterDims,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(`Clustering failed: ${err.error}`);
        return;
      }

      const result = await res.json();
      setClusterResult(result);
      setClusterMetrics({
        silhouette: result.metrics?.silhouette ?? null,
        daviesBouldin: result.metrics?.daviesBouldin ?? null,
      });

      // Update companies in local store with cluster assignments + UMAP coords
      result.labels.forEach((label: number, i: number) => {
        const company = companies[i];
        if (!company) return;
        updateCompany(company.id, {
          clusterId: label === -1 ? "outliers" : String(label),
          outlierScore: result.outlierScores?.[i] ?? null,
          umapX: result.embedded2d?.[i]?.[0] ?? null,
          umapY: result.embedded2d?.[i]?.[1] ?? null,
        });
      });

      setClusterProgress(100);
      toast.success(
        `${result.nClusters} clusters found · ${result.nOutliers} outliers`
      );
    } catch (err) {
      toast.error(String(err));
    } finally {
      if (clusterTimerRef.current) clearInterval(clusterTimerRef.current);
      setClustering(false);
    }
  }, [uid, featureMatrix, companies, clusterParams, setClusterMetrics, updateCompany]);

  // ── Confirm & name clusters ──────────────────────────────────────────────

  const handleConfirm = useCallback(async () => {
    if (!apiKey || !uid || !clusterResult) return;
    setConfirming(true);

    try {
      // Group companies by cluster index
      const groups: Record<string, typeof companies> = {};
      companies.forEach((c) => {
        const key = c.clusterId ?? "outliers";
        if (!groups[key]) groups[key] = [];
        groups[key].push(c);
      });

      const nonOutlierGroups = Object.entries(groups)
        .filter(([k]) => k !== "outliers")
        .map(([k, v]) => ({ clusterIndex: k, companies: v }));

      // Name + describe via Gemini
      const namings = await nameAllClusters(apiKey, nonOutlierGroups);

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

      const nextStep = Math.max(pipelineStep, 3) as 3;
      setPipelineStep(nextStep);
      await persistSession(uid, {
        pipelineStep: nextStep,
        clustersConfirmed: true,
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

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 flex flex-col gap-6">
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
              <span>Embedding {embedProgress.done}/{embedProgress.total} companies…</span>
              {embedProgress.errors > 0 && (
                <span className="text-destructive">{embedProgress.errors} errors</span>
              )}
            </div>
            <Progress value={embedPct} className="h-1.5" />
          </div>
        )}

        <div className="flex gap-2">
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
          onClick={handleCluster}
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
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Running UMAP + HDBSCAN…</span>
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

      {/* Confirm CTA */}
      {hasClusters && (
        <>
          <Separator />
          <section className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              Gemini will name each cluster and generate descriptions, then take you to the review page.
            </p>
            <Button
              onClick={handleConfirm}
              disabled={!apiKey || confirming}
              className="self-start gap-2"
            >
              {confirming ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              {confirming ? "Naming clusters…" : "Confirm & name clusters →"}
            </Button>
          </section>
        </>
      )}
    </div>
  );
}
