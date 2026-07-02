import type { ClusterAction } from "@/types";

export interface ClusterSummary {
  clusterId: string;
  clusterName: string;
  companyCount: number;
  description: string;
  topDimensions: Record<string, string[]>;
  representativeCompanies: string[];
  representativeSnippets: string[];
  cohesionScore: number | null;
  nearestClusterIds: string[];
  nearestClusterNames: string[];
  /** All companies in the cluster — name + description snippet (≤200 chars). Used for chat context. */
  allCompanies: { name: string; description: string }[];
}

export interface OverlapCandidate {
  clusterAId: string;
  clusterAName: string;
  clusterBId: string;
  clusterBName: string;
  score: number;
  reason: string;
}

export interface PortfolioReviewContext {
  generatedAt: number;
  analysisContext: string;
  marketContext: string;
  companyCount: number;
  clusterCount: number;
  outlierCount: number;
  /** @deprecated use outlierCompanies */
  outlierExamples: string[];
  /** All outlier companies with description snippets — for chat context. */
  outlierCompanies: { name: string; description: string }[];
  clusterSummaries: ClusterSummary[];
  overlapCandidates: OverlapCandidate[];
  gapHints: string[];
}

export interface ClusterNamingResult {
  clusterIndex: string;
  name: string;
  description: string;
}

export interface ChatRouteResponse {
  text: string;
  actions: ClusterAction[] | null;
}
