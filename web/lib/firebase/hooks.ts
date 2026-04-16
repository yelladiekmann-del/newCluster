"use client";

import { useEffect } from "react";
import {
  doc,
  setDoc,
  getDoc,
  deleteDoc,
  onSnapshot,
  collection,
  getDocs,
  writeBatch,
} from "firebase/firestore";
import { getFirebaseDb, onAuthChange } from "./client";
import { useSession } from "@/lib/store/session";
import type { CompanyDoc, ClusterDoc, ChatMessage, SessionDoc } from "@/types";
import { toast } from "sonner";

/** Top-level hook: watches Firebase auth state and syncs authUser into Zustand. */
export function useFirebaseSession() {
  const { setAuthResolved, setAuthUser } = useSession();

  useEffect(() => {
    return onAuthChange((user) => {
      setAuthResolved(true);
      if (user?.email?.endsWith("@hy.co")) {
        setAuthUser({
          uid: user.uid,
          email: user.email!,
          displayName: user.displayName,
          photoURL: user.photoURL,
        });
      } else {
        clearSignedOutClientState();
      }
    });
  }, [setAuthResolved, setAuthUser]);
}

// ── Session snapshot listener ─────────────────────────────────────────────────

let activeSessionUnsub: (() => void) | null = null;

export function detachSessionListener() {
  if (activeSessionUnsub) {
    activeSessionUnsub();
    activeSessionUnsub = null;
  }
}

export function clearActiveSessionState() {
  detachSessionListener();
  const store = useSession.getState();
  store.reset();
  store.setUid(null);
  store.setSessionId(null);
}

export function clearSignedOutClientState() {
  detachSessionListener();
  sessionStorage.removeItem("hy_google_token");

  const store = useSession.getState();
  const apiKey = sessionStorage.getItem("hy_gemini_key");
  store.reset();
  store.setUid(null);
  store.setSessionId(null);
  store.setAuthUser(null);
  store.setGoogleAccessToken(null);
  store.setApiKey(apiKey);
}

/**
 * Attaches a live Firestore listener to a session doc and hydrates the store.
 * Replaces any previously active listener.
 */
export function attachSessionListener(sessionId: string): () => void {
  detachSessionListener();

  const db = getFirebaseDb();
  const {
    setPipelineStep,
    setCompanyCol,
    setDescCol,
    setCustomWeights,
    setEmbeddingsStoragePath,
    setNpzPreloaded,
    setClusterParams,
    setClusterMetrics,
    setClustersConfirmed,
    setChatOnboarded,
    setChatAnalysisContext,
    setChatMarketContextRaw,
    setDealsStoragePath,
    setAnalyticsColMap,
    setScoringConfig,
    setSessionName,
  } = useSession.getState();

  const unsub = onSnapshot(doc(db, "sessions", sessionId), (s) => {
    if (!s.exists()) return;
    const d = s.data() as SessionDoc;
    setPipelineStep(d.pipelineStep ?? 0);
    setCompanyCol(d.companyCol ?? "name");
    setDescCol(d.descCol ?? null);
    if (d.customWeights) setCustomWeights(d.customWeights);
    setEmbeddingsStoragePath(d.embeddingsStoragePath ?? null);
    setNpzPreloaded(d.npzPreloaded ?? false);
    if (d.clusterParams) setClusterParams(d.clusterParams);
    setClusterMetrics(d.clusterMetrics ?? null);
    setClustersConfirmed(d.clustersConfirmed ?? false);
    setChatOnboarded(d.chatOnboarded ?? false);
    setChatAnalysisContext(d.chatAnalysisContext ?? "");
    setChatMarketContextRaw(d.chatMarketContextRaw ?? "");
    setDealsStoragePath(d.dealsStoragePath ?? null);
    setAnalyticsColMap(d.analyticsColMap ?? {});
    setScoringConfig((d.scoringConfig as Parameters<typeof setScoringConfig>[0]) ?? null);
    setSessionName(d.name ?? null);
  });

  activeSessionUnsub = unsub;
  return unsub;
}

// ── Session creation / resume ─────────────────────────────────────────────────

/** Creates a new session doc in Firestore and initialises the Zustand store. */
export async function createNewSession(authUid: string, name?: string): Promise<string> {
  const sessionId = crypto.randomUUID();
  const db = getFirebaseDb();
  const now = Date.now();

  try {
    await setDoc(doc(db, "sessions", sessionId), {
      userId: authUid,
      createdAt: now,
      updatedAt: now,
      pipelineStep: 0,
      companyCol: "name",
      descCol: null,
      customWeights: null,
      embeddingsStoragePath: null,
      npzPreloaded: false,
      clusterParams: null,
      clusterMetrics: null,
      clustersConfirmed: false,
      chatOnboarded: false,
      chatAnalysisContext: "",
      chatMarketContextRaw: "",
      dealsStoragePath: null,
      analyticsColMap: {},
      spreadsheetId: null,
      spreadsheetUrl: null,
      name: name ?? "Untitled session",
    } satisfies Omit<SessionDoc, "userId"> & { userId: string });
  } catch (err) {
    toast.error("Failed to create session: " + (err instanceof Error ? err.message : String(err)));
    throw err;
  }

  const store = useSession.getState();
  clearActiveSessionState();
  store.setUid(sessionId);
  store.setSessionId(sessionId);
  store.setSessionName(name ?? "Untitled session");

  const key = sessionStorage.getItem("hy_gemini_key");
  if (key) store.setApiKey(key);

  attachSessionListener(sessionId);
  return sessionId;
}

/**
 * Fast resume — reads only the Firestore session doc (~100–200 ms) and
 * navigates immediately. Companies, clusters, and chat are loaded lazily
 * on the target page. Chat history is intentionally not restored.
 */
export async function resumeSessionFast(sessionId: string): Promise<number> {
  const db = getFirebaseDb();
  const snap = await getDoc(doc(db, "sessions", sessionId));
  if (!snap.exists()) throw new Error("Session not found");
  const d = snap.data() as SessionDoc;

  const store = useSession.getState();
  clearActiveSessionState();
  store.setUid(sessionId);
  store.setSessionId(sessionId);
  store.setPipelineStep(d.pipelineStep ?? 0);
  store.setCompanyCol(d.companyCol ?? "name");
  store.setDescCol(d.descCol ?? null);
  if (d.customWeights) store.setCustomWeights(d.customWeights);
  store.setEmbeddingsStoragePath(d.embeddingsStoragePath ?? null);
  store.setNpzPreloaded(d.npzPreloaded ?? false);
  if (d.clusterParams) store.setClusterParams(d.clusterParams);
  store.setClusterMetrics(d.clusterMetrics ?? null);
  store.setClustersConfirmed(d.clustersConfirmed ?? false);
  store.setChatOnboarded(d.chatOnboarded ?? false);
  store.setChatAnalysisContext(d.chatAnalysisContext ?? "");
  store.setChatMarketContextRaw(d.chatMarketContextRaw ?? "");
  store.setDealsStoragePath(d.dealsStoragePath ?? null);
  store.setAnalyticsColMap(d.analyticsColMap ?? {});
  store.setScoringConfig((d.scoringConfig as Parameters<typeof store.setScoringConfig>[0]) ?? null);
  store.setSpreadsheetId(d.spreadsheetId ?? null);
  store.setSpreadsheetUrl(d.spreadsheetUrl ?? null);
  store.setSessionName(d.name ?? null);

  const key = sessionStorage.getItem("hy_gemini_key");
  if (key) store.setApiKey(key);

  attachSessionListener(sessionId);
  return d.pipelineStep ?? 0;
}

/** Loads an existing session from Firestore and hydrates the Zustand store. */
export async function resumeSession(sessionId: string): Promise<number> {
  const db = getFirebaseDb();
  const snap = await getDoc(doc(db, "sessions", sessionId));
  if (!snap.exists()) throw new Error("Session not found");
  const d = snap.data() as SessionDoc;

  const store = useSession.getState();
  clearActiveSessionState();
  store.setUid(sessionId);
  store.setSessionId(sessionId);
  store.setPipelineStep(d.pipelineStep ?? 0);
  store.setCompanyCol(d.companyCol ?? "name");
  store.setDescCol(d.descCol ?? null);
  if (d.customWeights) store.setCustomWeights(d.customWeights);
  store.setEmbeddingsStoragePath(d.embeddingsStoragePath ?? null);
  store.setNpzPreloaded(d.npzPreloaded ?? false);
  if (d.clusterParams) store.setClusterParams(d.clusterParams);
  store.setClusterMetrics(d.clusterMetrics ?? null);
  store.setClustersConfirmed(d.clustersConfirmed ?? false);
  store.setChatOnboarded(d.chatOnboarded ?? false);
  store.setChatAnalysisContext(d.chatAnalysisContext ?? "");
  store.setChatMarketContextRaw(d.chatMarketContextRaw ?? "");
  store.setDealsStoragePath(d.dealsStoragePath ?? null);
  store.setAnalyticsColMap(d.analyticsColMap ?? {});
  store.setScoringConfig((d.scoringConfig as Parameters<typeof store.setScoringConfig>[0]) ?? null);
  store.setSpreadsheetId(d.spreadsheetId ?? null);
  store.setSpreadsheetUrl(d.spreadsheetUrl ?? null);
  store.setSessionName(d.name ?? null);

  const key = sessionStorage.getItem("hy_gemini_key");
  if (key) store.setApiKey(key);

  const [companies, clusters, msgs] = await Promise.all([
    loadCompanies(sessionId, d.companyCol ?? "name"),
    loadClusters(sessionId),
    loadChatHistory(sessionId),
  ]);
  store.setCompanies(companies);
  store.setClusters(clusters);
  store.setChatMessages(msgs);

  attachSessionListener(sessionId);
  return d.pipelineStep ?? 0;
}

// ── Sub-collection loaders ────────────────────────────────────────────────────

export async function loadCompanies(uid: string, companyCol = "name"): Promise<CompanyDoc[]> {
  // 1. Firestore subcollection — primary, always reliable
  console.log("[loadCompanies] 1. querying Firestore subcollection for uid:", uid);
  const db = getFirebaseDb();
  try {
    const snap = await getDocs(collection(db, "sessions", uid, "companies"));
    console.log("[loadCompanies] 2. Firestore subcollection —", snap.docs.length, "docs");

    if (!snap.empty) {
      const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() } as CompanyDoc));
      docs.sort((a, b) => a.rowIndex - b.rowIndex);
      console.log("[loadCompanies] 3. Firestore OK — returning", docs.length, "docs ✓");
      return docs;
    }
    console.warn("[loadCompanies] 2b. Firestore subcollection empty — trying Storage fallback...");
  } catch (err) {
    console.error("[loadCompanies] 2b. Firestore getDocs threw:", err);
  }

  // 2. Storage fallback — for sessions that pre-date the dual-write migration
  try {
    const { loadCompaniesFromStorage } = await import("./companies-storage");
    const docs = await loadCompaniesFromStorage(uid, companyCol);
    if (docs.length > 0) {
      console.log("[loadCompanies] Storage fallback OK — returning", docs.length, "docs ✓");
      return docs;
    }
    console.warn("[loadCompanies] Storage returned 0 docs");
  } catch (err) {
    console.error("[loadCompanies] Storage fallback threw:", err);
  }

  console.error("[loadCompanies] ❌ no companies found in Firestore or Storage for uid:", uid);
  toast.error("Could not load companies — Firestore and Storage both empty/failed. Check browser console for details.");
  return [];
}

export async function loadClusters(uid: string): Promise<ClusterDoc[]> {
  const db = getFirebaseDb();
  const snap = await getDocs(collection(db, "sessions", uid, "clusters"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as ClusterDoc));
}

export async function loadChatHistory(uid: string): Promise<ChatMessage[]> {
  const db = getFirebaseDb();
  const snap = await getDocs(collection(db, "sessions", uid, "chatHistory"));
  const msgs = snap.docs.map((d) => ({ id: d.id, ...d.data() } as ChatMessage));
  msgs.sort((a, b) => a.timestamp - b.timestamp);
  return msgs;
}

/** Delete a session and all associated Storage files + Firestore subcollections. */
export async function deleteSession(sessionId: string): Promise<void> {
  const db = getFirebaseDb();

  // Delete Firestore subcollections
  for (const coll of ["clusters", "chatHistory"]) {
    const snap = await getDocs(collection(db, "sessions", sessionId, coll));
    if (snap.docs.length > 0) {
      const b = writeBatch(db);
      snap.docs.forEach((d) => b.delete(d.ref));
      await b.commit();
    }
  }

  // Delete session doc
  await deleteDoc(doc(db, "sessions", sessionId));

  // Best-effort delete Storage files
  try {
    const { ref, deleteObject } = await import("firebase/storage");
    const { getFirebaseStorage } = await import("./client");
    const storage = getFirebaseStorage();
    await Promise.allSettled(
      ["companies.csv", "embeddings.json", "embeddings.npz"].map((f) =>
        deleteObject(ref(storage, `sessions/${sessionId}/${f}`))
      )
    );
  } catch {
    // Non-fatal — files may not exist
  }
}

/** Persist session doc fields to Firestore */
export async function persistSession(
  uid: string,
  patch: Partial<SessionDoc>
): Promise<void> {
  const db = getFirebaseDb();
  const { updateDoc } = await import("firebase/firestore");
  await updateDoc(doc(db, "sessions", uid), { ...patch, updatedAt: Date.now() });
}
