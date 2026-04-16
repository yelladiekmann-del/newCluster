"use client";

import { create } from "zustand";
import type {
  ClusterDoc,
  ClusterMetrics,
  ClusterParams,
  CompanyDoc,
  ChatMessage,
  Dimension,
  AnalyticsColMap,
} from "@/types";
import type { ScoringConfig } from "@/lib/analytics/scoring";
import { DEFAULT_WEIGHTS } from "@/types";

export interface AuthUser {
  uid: string;
  email: string;
  displayName: string | null;
  photoURL: string | null;
}

export interface SessionState {
  // Auth
  authResolved: boolean;
  uid: string | null;
  sessionId: string | null;
  authUser: AuthUser | null;

  // API key lives only in sessionStorage — never Firestore
  apiKey: string | null;

  // Google OAuth token — per-user, lives in sessionStorage
  googleAccessToken: string | null;

  // Google Sheets — per-session
  spreadsheetId: string | null;
  spreadsheetUrl: string | null;

  // Setup
  pipelineStep: 0 | 1 | 2 | 3 | 4;
  companyCol: string;
  descCol: string | null;
  customWeights: Record<Dimension, number>;

  // Data (in-memory cache of Firestore sub-collections)
  companies: CompanyDoc[];
  clusters: ClusterDoc[];

  // Embed
  embeddingsStoragePath: string | null;
  npzPreloaded: boolean;

  // Cluster
  clusterParams: ClusterParams;
  clusterMetrics: ClusterMetrics | null;
  clustersConfirmed: boolean;

  // Chat
  chatMessages: ChatMessage[];
  chatOnboarded: boolean;
  chatAnalysisContext: string;
  chatMarketContextRaw: string;

  // Analytics
  dealsStoragePath: string | null;
  analyticsColMap: AnalyticsColMap;
  scoringConfig: ScoringConfig | null;

  // Display
  sessionName: string | null;

  // Actions
  setAuthResolved: (resolved: boolean) => void;
  setUid: (uid: string | null) => void;
  setSessionId: (id: string | null) => void;
  setAuthUser: (user: AuthUser | null) => void;
  setApiKey: (key: string | null) => void;
  setGoogleAccessToken: (token: string | null) => void;
  setSpreadsheetId: (id: string | null) => void;
  setSpreadsheetUrl: (url: string | null) => void;
  setPipelineStep: (step: 0 | 1 | 2 | 3 | 4) => void;
  setCompanyCol: (col: string) => void;
  setDescCol: (col: string | null) => void;
  setCustomWeights: (weights: Record<Dimension, number>) => void;
  setCompanies: (companies: CompanyDoc[]) => void;
  setClusters: (clusters: ClusterDoc[]) => void;
  updateCompany: (id: string, patch: Partial<CompanyDoc>) => void;
  updateCluster: (id: string, patch: Partial<ClusterDoc>) => void;
  setEmbeddingsStoragePath: (path: string | null) => void;
  setNpzPreloaded: (v: boolean) => void;
  setClusterParams: (params: Partial<ClusterParams>) => void;
  setClusterMetrics: (m: ClusterMetrics | null) => void;
  setClustersConfirmed: (v: boolean) => void;
  addChatMessage: (msg: ChatMessage) => void;
  setChatMessages: (msgs: ChatMessage[]) => void;
  setChatOnboarded: (v: boolean) => void;
  setChatAnalysisContext: (s: string) => void;
  setChatMarketContextRaw: (s: string) => void;
  setDealsStoragePath: (path: string | null) => void;
  setAnalyticsColMap: (map: AnalyticsColMap) => void;
  setScoringConfig: (config: ScoringConfig | null) => void;
  setSessionName: (name: string | null) => void;
  /** Full reset — called when starting a new session */
  reset: () => void;
}

const defaultClusterParams: ClusterParams = {
  minClusterSize: 5,
  minSamples: 3,
  clusterEpsilon: 0.0,
};

export const useSession = create<SessionState>((set) => ({
  authResolved: false,
  uid: null,
  sessionId: null,
  authUser: null,
  apiKey: null,
  googleAccessToken: null,
  spreadsheetId: null,
  spreadsheetUrl: null,
  pipelineStep: 0,
  companyCol: "name",
  descCol: null,
  customWeights: { ...DEFAULT_WEIGHTS },
  companies: [],
  clusters: [],
  embeddingsStoragePath: null,
  npzPreloaded: false,
  clusterParams: { ...defaultClusterParams },
  clusterMetrics: null,
  clustersConfirmed: false,
  chatMessages: [],
  chatOnboarded: false,
  chatAnalysisContext: "",
  chatMarketContextRaw: "",
  dealsStoragePath: null,
  analyticsColMap: {},
  scoringConfig: null,
  sessionName: null,

  setAuthResolved: (authResolved) => set({ authResolved }),
  setUid: (uid) => set({ uid }),
  setSessionId: (sessionId) => set({ sessionId }),
  setAuthUser: (authUser) => set({ authUser }),
  setApiKey: (apiKey) => set({ apiKey }),
  setGoogleAccessToken: (googleAccessToken) => set({ googleAccessToken }),
  setSpreadsheetId: (spreadsheetId) => set({ spreadsheetId }),
  setSpreadsheetUrl: (spreadsheetUrl) => set({ spreadsheetUrl }),
  setPipelineStep: (pipelineStep) => set({ pipelineStep }),
  setCompanyCol: (companyCol) => set({ companyCol }),
  setDescCol: (descCol) => set({ descCol }),
  setCustomWeights: (customWeights) => set({ customWeights }),
  setCompanies: (companies) => set({ companies }),
  setClusters: (clusters) => set({ clusters }),
  updateCompany: (id, patch) =>
    set((s) => ({
      companies: s.companies.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    })),
  updateCluster: (id, patch) =>
    set((s) => ({
      clusters: s.clusters.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    })),
  setEmbeddingsStoragePath: (embeddingsStoragePath) =>
    set({ embeddingsStoragePath }),
  setNpzPreloaded: (npzPreloaded) => set({ npzPreloaded }),
  setClusterParams: (params) =>
    set((s) => ({ clusterParams: { ...s.clusterParams, ...params } })),
  setClusterMetrics: (clusterMetrics) => set({ clusterMetrics }),
  setClustersConfirmed: (clustersConfirmed) => set({ clustersConfirmed }),
  addChatMessage: (msg) =>
    set((s) => ({ chatMessages: [...s.chatMessages, msg] })),
  setChatMessages: (chatMessages) => set({ chatMessages }),
  setChatOnboarded: (chatOnboarded) => set({ chatOnboarded }),
  setChatAnalysisContext: (chatAnalysisContext) => set({ chatAnalysisContext }),
  setChatMarketContextRaw: (chatMarketContextRaw) =>
    set({ chatMarketContextRaw }),
  setDealsStoragePath: (dealsStoragePath) => set({ dealsStoragePath }),
  setAnalyticsColMap: (analyticsColMap) => set({ analyticsColMap }),
  setScoringConfig: (scoringConfig) => set({ scoringConfig }),
  setSessionName: (sessionName) => set({ sessionName }),
  reset: () =>
    set({
      spreadsheetId: null,
      spreadsheetUrl: null,
      pipelineStep: 0,
      companyCol: "name",
      descCol: null,
      customWeights: { ...DEFAULT_WEIGHTS },
      companies: [],
      clusters: [],
      embeddingsStoragePath: null,
      npzPreloaded: false,
      clusterParams: { ...defaultClusterParams },
      clusterMetrics: null,
      clustersConfirmed: false,
      chatMessages: [],
      chatOnboarded: false,
      chatAnalysisContext: "",
      chatMarketContextRaw: "",
      dealsStoragePath: null,
      analyticsColMap: {},
      scoringConfig: null,
      sessionName: null,
    }),
}));
