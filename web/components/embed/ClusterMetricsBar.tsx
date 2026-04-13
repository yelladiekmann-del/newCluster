"use client";

import { Badge } from "@/components/ui/badge";
import { useSession } from "@/lib/store/session";

interface ClusterResult {
  nClusters: number;
  nOutliers: number;
  metrics: { silhouette?: number; daviesBouldin?: number };
}

function qualityLabel(silhouette?: number): { label: string; variant: "default" | "secondary" | "destructive" } {
  if (!silhouette) return { label: "—", variant: "secondary" };
  if (silhouette >= 0.5) return { label: "Good", variant: "default" };
  if (silhouette >= 0.25) return { label: "Fair", variant: "secondary" };
  return { label: "Poor", variant: "destructive" };
}

export function ClusterMetricsBar({ result }: { result: ClusterResult }) {
  const { companies } = useSession();
  const q = qualityLabel(result.metrics.silhouette);

  return (
    <div className="flex flex-wrap gap-3">
      <Metric label="Companies" value={companies.length} />
      <Metric label="Clusters" value={result.nClusters} />
      <Metric label="Outliers" value={result.nOutliers} />
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Quality</span>
        <Badge variant={q.variant} className="text-xs">{q.label}</Badge>
      </div>
      {result.metrics.silhouette !== undefined && (
        <Metric label="Silhouette" value={result.metrics.silhouette.toFixed(3)} />
      )}
      {result.metrics.daviesBouldin !== undefined && (
        <Metric label="Davies-Bouldin" value={result.metrics.daviesBouldin.toFixed(3)} />
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-mono font-semibold text-foreground">{value}</span>
    </div>
  );
}
