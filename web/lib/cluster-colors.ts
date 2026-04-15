import { CLUSTER_COLORS, type ClusterDoc } from "@/types";

export function getFallbackClusterColor(index: number): string {
  return CLUSTER_COLORS[index % CLUSTER_COLORS.length];
}

export function getNextClusterColor(clusters: ClusterDoc[]): string {
  const used = new Set(
    clusters
      .filter((cluster) => !cluster.isOutliers)
      .map((cluster) => cluster.color)
      .filter(Boolean)
  );
  const unused = CLUSTER_COLORS.find((color) => !used.has(color));
  return unused ?? getFallbackClusterColor(clusters.filter((cluster) => !cluster.isOutliers).length);
}
