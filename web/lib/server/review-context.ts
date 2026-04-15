import type { PortfolioReviewContext } from "@/types/ai";
import type { ClusterDoc, CompanyDoc, SessionDoc } from "@/types";

import { buildClusterSummaries } from "./cluster-summaries";

export function buildReviewContext(params: {
  session: SessionDoc;
  clusters: ClusterDoc[];
  companies: CompanyDoc[];
  marketContext: string;
}): PortfolioReviewContext {
  const { session, clusters, companies, marketContext } = params;
  const { summaries, outlierExamples, overlapCandidates } = buildClusterSummaries(
    clusters,
    companies,
    session.descCol ?? null
  );

  const gapHints: string[] = [];
  for (const summary of summaries) {
    if (summary.companyCount <= 2) {
      gapHints.push(`${summary.clusterName} is very small and may need merging or deletion.`);
    }
    if ((summary.cohesionScore ?? 1) < 0.45) {
      gapHints.push(`${summary.clusterName} appears internally mixed based on dimension spread.`);
    }
  }

  if (outlierExamples.length >= 5) {
    gapHints.push("The outlier pool is large enough that a missing segment may be hiding there.");
  }

  return {
    generatedAt: Date.now(),
    analysisContext: session.chatAnalysisContext ?? "",
    marketContext,
    companyCount: companies.length,
    clusterCount: summaries.length,
    outlierCount: companies.filter((company) => company.clusterId === "outliers").length,
    outlierExamples,
    clusterSummaries: summaries,
    overlapCandidates,
    gapHints: gapHints.slice(0, 8),
  };
}
