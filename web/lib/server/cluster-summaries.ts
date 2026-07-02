import type { ClusterSummary, OverlapCandidate } from "@/types/ai";
import type { ClusterDoc, CompanyDoc, Dimension } from "@/types";
import { DIMENSIONS } from "@/types";

const HIGH_SIGNAL_DIMS: Dimension[] = ["Problem Solved", "Customer Segment", "Core Mechanism", "Value Shift"];

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function getCompanySnippet(company: CompanyDoc, descCol: string | null): string {
  const explicit = descCol ? normalizeText(company.originalData?.[descCol]) : "";
  // Longer snippets give Gemini more signal for naming — 250 chars is the sweet spot
  // between context richness and prompt size.
  if (explicit) return explicit.slice(0, 250);

  // Fallback: reconstruct from the most signal-rich dimensions
  const dimText = HIGH_SIGNAL_DIMS
    .filter((d) => company.dimensions[d])
    .map((d) => `${d}: ${company.dimensions[d]}`)
    .join("; ");
  return dimText.slice(0, 250);
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

  // Score: prioritise companies with rich high-signal dimensions AND a real description.
  // Diversity tie-break: skip companies whose dimension fingerprint was already seen
  // (avoids 8 identical "B2B SaaS / AI-ML / logistics" companies swamping the context).
  const ranked = [...companies].sort((a, b) => {
    const scoreA =
      HIGH_SIGNAL_DIMS.filter((d) => a.dimensions[d]).length * 2 +
      Object.keys(a.dimensions).length +
      (getCompanySnippet(a, descCol).length > 30 ? 1 : 0);
    const scoreB =
      HIGH_SIGNAL_DIMS.filter((d) => b.dimensions[d]).length * 2 +
      Object.keys(b.dimensions).length +
      (getCompanySnippet(b, descCol).length > 30 ? 1 : 0);
    return scoreB - scoreA || a.name.localeCompare(b.name);
  });

  const picks: CompanyDoc[] = [];
  for (const company of ranked) {
    // Diversity fingerprint: top values of the 4 most signal-rich dimensions
    const fingerprint = HIGH_SIGNAL_DIMS
      .map((d) => company.dimensions[d] ?? "")
      .join("|");
    if (fingerprint && seen.has(fingerprint) && picks.length >= 5) continue;
    seen.add(fingerprint);
    picks.push(company);
    if (picks.length >= 10) break; // more companies = richer context for Gemini
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
): { summaries: ClusterSummary[]; outlierExamples: string[]; outlierCompanies: { name: string; description: string }[]; overlapCandidates: OverlapCandidate[] } {
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
          .filter((s) => s.length > 20)
      ).slice(0, 5),
      cohesionScore:
        cohesionSignals.length > 0
          ? Number(
              (cohesionSignals.reduce((sum, value) => sum + value, 0) / cohesionSignals.length).toFixed(2)
            )
          : null,
      nearestClusterIds: [],
      nearestClusterNames: [],
      // All members with a short description — this is what the chat model uses.
      // Sorted by representativeness (same ranking as repMembers) so the most
      // signal-rich companies appear first in long clusters.
      allCompanies: [...members]
        .sort((a, b) => {
          const scoreA =
            HIGH_SIGNAL_DIMS.filter((d) => a.dimensions[d]).length * 2 +
            Object.keys(a.dimensions).length +
            (getCompanySnippet(a, descCol).length > 30 ? 1 : 0);
          const scoreB =
            HIGH_SIGNAL_DIMS.filter((d) => b.dimensions[d]).length * 2 +
            Object.keys(b.dimensions).length +
            (getCompanySnippet(b, descCol).length > 30 ? 1 : 0);
          return scoreB - scoreA || a.name.localeCompare(b.name);
        })
        .map((company) => ({
          name: company.name,
          description: getCompanySnippet(company, descCol).slice(0, 200),
        })),
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
      const tokensA = similarityTokens.get(a.clusterId) ?? new Set<string>();
      const tokensB = similarityTokens.get(b.clusterId) ?? new Set<string>();
      const sharedTokens = [...tokensA].filter((t) => tokensB.has(t)).slice(0, 4);
      const reason = sharedTokens.length > 0
        ? `Both focus on: ${sharedTokens.join(", ")}`
        : "Similar dimensional profile";
      overlapCandidates.push({
        clusterAId: a.clusterId,
        clusterAName: a.clusterName,
        clusterBId: b.clusterId,
        clusterBName: b.clusterName,
        score,
        reason,
      });
    }
  }

  const outliers = companies.filter((company) => company.clusterId === "outliers");

  const outlierExamples = outliers.slice(0, 8).map((company) => company.name);

  const outlierCompanies = outliers.map((company) => ({
    name: company.name,
    description: getCompanySnippet(company, descCol).slice(0, 200),
  }));

  overlapCandidates.sort((a, b) => b.score - a.score);

  return {
    summaries,
    outlierExamples,
    outlierCompanies,
    overlapCandidates: overlapCandidates.slice(0, 6),
  };
}
