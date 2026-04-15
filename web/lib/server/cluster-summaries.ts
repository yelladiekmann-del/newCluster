import type { ClusterSummary, OverlapCandidate } from "@/types/ai";
import type { ClusterDoc, CompanyDoc } from "@/types";
import { DIMENSIONS } from "@/types";

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function getCompanySnippet(company: CompanyDoc, descCol: string | null): string {
  const explicit = descCol ? normalizeText(company.originalData?.[descCol]) : "";
  if (explicit) return explicit.slice(0, 180);

  const dimText = Object.entries(company.dimensions)
    .filter(([, value]) => !!value)
    .map(([key, value]) => `${key}: ${value}`)
    .join("; ");
  return dimText.slice(0, 180);
}

function topValues(companies: CompanyDoc[], dimension: string): string[] {
  const counts = new Map<string, number>();
  for (const company of companies) {
    const value = normalizeText(company.dimensions[dimension as keyof typeof company.dimensions]);
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([value]) => value);
}

function representativeCompanies(companies: CompanyDoc[], descCol: string | null): CompanyDoc[] {
  const seen = new Set<string>();
  const ranked = [...companies].sort((a, b) => {
    const scoreA = Object.keys(a.dimensions).length + (getCompanySnippet(a, descCol) ? 1 : 0);
    const scoreB = Object.keys(b.dimensions).length + (getCompanySnippet(b, descCol) ? 1 : 0);
    return scoreB - scoreA || a.name.localeCompare(b.name);
  });

  const picks: CompanyDoc[] = [];
  for (const company of ranked) {
    const signature = JSON.stringify(
      Object.entries(company.dimensions)
        .filter(([, value]) => !!value)
        .sort()
    );
    if (signature && seen.has(signature) && picks.length >= 4) continue;
    seen.add(signature);
    picks.push(company);
    if (picks.length >= 8) break;
  }
  return picks;
}

function buildSimilarityTokens(summary: ClusterSummary): Set<string> {
  const tokens = new Set<string>();
  for (const values of Object.values(summary.topDimensions)) {
    for (const value of values) {
      tokens.add(value.toLowerCase());
    }
  }
  return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

export function buildClusterSummaries(
  clusters: ClusterDoc[],
  companies: CompanyDoc[],
  descCol: string | null
): { summaries: ClusterSummary[]; outlierExamples: string[]; overlapCandidates: OverlapCandidate[] } {
  const nonOutlierClusters = clusters.filter((cluster) => !cluster.isOutliers);
  const summaries: ClusterSummary[] = nonOutlierClusters.map((cluster) => {
    const members = companies.filter((company) => company.clusterId === cluster.id);
    const repMembers = representativeCompanies(members, descCol);
    const topDimensions = Object.fromEntries(
      DIMENSIONS.map((dimension) => [dimension, topValues(members, dimension)])
    );

    const cohesionSignals = DIMENSIONS.map((dimension) => {
      const top = topValues(members, dimension);
      if (top.length === 0 || members.length === 0) return null;
      let topCount = 0;
      for (const company of members) {
        const value = normalizeText(company.dimensions[dimension]);
        if (top[0] && value === top[0]) topCount += 1;
      }
      return topCount / members.length;
    }).filter((value): value is number => value != null);

    return {
      clusterId: cluster.id,
      clusterName: cluster.name,
      companyCount: members.length,
      description: cluster.description ?? "",
      topDimensions,
      representativeCompanies: repMembers.map((company) => company.name),
      representativeSnippets: unique(
        repMembers
          .map((company) => getCompanySnippet(company, descCol))
          .filter(Boolean)
      ).slice(0, 3),
      cohesionScore:
        cohesionSignals.length > 0
          ? Number(
              (cohesionSignals.reduce((sum, value) => sum + value, 0) / cohesionSignals.length).toFixed(2)
            )
          : null,
      nearestClusterIds: [],
      nearestClusterNames: [],
    };
  });

  const similarityTokens = new Map(summaries.map((summary) => [summary.clusterId, buildSimilarityTokens(summary)]));
  const overlapCandidates: OverlapCandidate[] = [];

  for (const summary of summaries) {
    const comparisons = summaries
      .filter((other) => other.clusterId !== summary.clusterId)
      .map((other) => ({
        other,
        score: jaccard(
          similarityTokens.get(summary.clusterId) ?? new Set<string>(),
          similarityTokens.get(other.clusterId) ?? new Set<string>()
        ),
      }))
      .sort((a, b) => b.score - a.score);

    summary.nearestClusterIds = comparisons.slice(0, 2).map(({ other }) => other.clusterId);
    summary.nearestClusterNames = comparisons.slice(0, 2).map(({ other }) => other.clusterName);
  }

  for (let i = 0; i < summaries.length; i += 1) {
    for (let j = i + 1; j < summaries.length; j += 1) {
      const a = summaries[i];
      const b = summaries[j];
      const score = jaccard(
        similarityTokens.get(a.clusterId) ?? new Set<string>(),
        similarityTokens.get(b.clusterId) ?? new Set<string>()
      );
      if (score < 0.2) continue;
      overlapCandidates.push({
        clusterAId: a.clusterId,
        clusterAName: a.clusterName,
        clusterBId: b.clusterId,
        clusterBName: b.clusterName,
        score,
        reason: `Shared dimension themes (${Math.round(score * 100)}% overlap)`,
      });
    }
  }

  const outlierExamples = companies
    .filter((company) => company.clusterId === "outliers")
    .slice(0, 8)
    .map((company) => company.name);

  overlapCandidates.sort((a, b) => b.score - a.score);

  return {
    summaries,
    outlierExamples,
    overlapCandidates: overlapCandidates.slice(0, 6),
  };
}
