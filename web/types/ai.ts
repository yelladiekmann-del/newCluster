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
  outlierExamples: string[];
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
