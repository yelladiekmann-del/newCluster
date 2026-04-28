import type { NextRequest } from "next/server";
import type { ClusterDoc } from "@/types";

import { buildClusterSummaries } from "@/lib/server/cluster-summaries";
import { nameClustersFromSummaries } from "@/lib/server/name-clusters";
import { loadSessionSnapshot } from "@/lib/server/session-data";
import { getGeminiKey } from "@/lib/server/gemini-key";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const apiKey = getGeminiKey();

  const { uid } = (await req.json()) as { uid?: string };

  if (!uid) {
    return Response.json({ error: "uid is required" }, { status: 400 });
  }

  try {
    const { session, companies, clusters } = await loadSessionSnapshot(uid);
    const clusterIds = Array.from(
      new Set(
        companies
          .map((company) => company.clusterId)
          .filter((clusterId): clusterId is string => !!clusterId && clusterId !== "outliers")
      )
    ).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (clusterIds.length === 0) {
      return Response.json({ error: "No non-outlier clusters found" }, { status: 400 });
    }

    const effectiveClusters: ClusterDoc[] =
      clusters.filter((cluster) => !cluster.isOutliers).length > 0
        ? clusters
        : clusterIds.map((clusterId) => ({
            id: clusterId,
            name: `Cluster ${clusterId}`,
            description: "",
            color: "",
            isOutliers: false,
            companyCount: companies.filter((company) => company.clusterId === clusterId).length,
          }));

    const { summaries } = buildClusterSummaries(effectiveClusters, companies, session.descCol ?? null);
    const results = await nameClustersFromSummaries(apiKey, summaries, { uid });
    return Response.json({ results });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
