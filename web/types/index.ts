// ── Dimensions ──────────────────────────────────────────────────────────────

export const DIMENSIONS = [
  "Problem Solved",
  "Customer Segment",
  "Core Mechanism",
  "Tech Category",
  "Business Model",
  "Value Shift",
  "Ecosystem Role",
  "Scalability Lever",
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

export const DEFAULT_WEIGHTS: Record<Dimension, number> = {
  "Problem Solved": 1.4,
  "Customer Segment": 1.2,
  "Core Mechanism": 1.3,
  "Tech Category": 1.1,
  "Business Model": 1.2,
  "Value Shift": 0.9,
  "Ecosystem Role": 0.7,
  "Scalability Lever": 0.8,
};

// ── Firestore documents ─────────────────────────────────────────────────────

export interface SessionDoc {
  userId: string;
  createdAt: number;
  updatedAt: number;
  /** 0=setup, 1=dimensions extracted, 2=embedded, 3=clustered+confirmed, 4=analytics */
  pipelineStep: 0 | 1 | 2 | 3 | 4;

  // Setup
  companyCol: string;
  descCol: string | null;
  customWeights: Record<Dimension, number> | null;

  // Embed
  embeddingsStoragePath: string | null;
  npzPreloaded: boolean;

  // Cluster
  clusterParams: ClusterParams | null;
  clusterMetrics: ClusterMetrics | null;
  clustersConfirmed: boolean;

  // Chat
  chatOnboarded: boolean;
  chatAnalysisContext: string;
  chatMarketContextRaw: string;

  // Analytics
  dealsStoragePath: string | null;
  analyticsColMap: Record<string, string>;

  // Google Sheets
  spreadsheetId: string | null;
  spreadsheetUrl: string | null;

  // Display
  name?: string;
}

export interface ClusterParams {
  minClusterSize: number;
  minSamples: number;
  clusterEpsilon: number;
}

export interface ClusterMetrics {
  silhouette: number | null;
  daviesBouldin: number | null;
}

export interface CompanyDoc {
  id: string; // Firestore doc id
  rowIndex: number;
  name: string;
  originalData: Record<string, unknown>;
  dimensions: Partial<Record<Dimension, string>>;
  clusterId: string | null; // "outliers" or cluster doc id
  umapX: number | null;
  umapY: number | null;
}

export interface ClusterDoc {
  id: string; // Firestore doc id
  name: string;
  description: string;
  color: string;
  isOutliers: boolean;
  companyCount: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  actions?: ClusterAction[] | null;
}

// ── Cluster actions ─────────────────────────────────────────────────────────

export type ClusterAction =
  | { type: "delete"; clusterName: string }
  | { type: "merge"; sources: string[]; newName: string }
  | { type: "add"; name: string; description: string; companies: string[] };

// ── Analytics ───────────────────────────────────────────────────────────────

export interface AnalyticsColMap {
  co_id?: string;
  de_co_id?: string;
  de_co_name?: string;
  deal_id?: string;
  deal_date?: string;
  deal_size?: string;
  series?: string;
  total_raised?: string;
  employees?: string;
  year_founded?: string;
  business_status?: string;
  ownership_status?: string;
  financing_status?: string;
}

export interface ClusterMetricsRow {
  clusterId: string;
  clusterName: string;
  companyCount: number;
  uniqueCompanies: number;
  avgEmployees: number | null;
  avgYearFounded: number | null;
  pctRecentlyFounded: number | null;
  dealCount: number | null;
  dealMomentum: number | null;
  avgFunding: number | null;
  totalFunding: number | null;
  totalInvested4yr: number | null;
  fundingMomentum: number | null;
  capitalMean: number | null;
  capitalMedian: number | null;
  meanMedianRatio: number | null;
  avgSeriesScore: number | null;
  vcGraduationRate: number | null;
  mortalityRate: number | null;
}

// ── Progress events (SSE) ───────────────────────────────────────────────────

export interface ProgressEvent {
  done: number;
  total: number;
  errors: number;
  message?: string;
}

// ── Cluster colors palette ──────────────────────────────────────────────────

export const CLUSTER_COLORS = [
  "#26B4D2", // teal (primary)
  "#E05C5C", // red
  "#8B5CF6", // purple
  "#F59E0B", // amber
  "#10B981", // emerald
  "#3B82F6", // blue
  "#F97316", // orange
  "#EC4899", // pink
  "#14B8A6", // cyan
  "#A3E635", // lime
  "#6366F1", // indigo
  "#84CC16", // yellow-green
] as const;
