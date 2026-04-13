"use client";

import { useEffect, useRef } from "react";
import {
  doc,
  setDoc,
  onSnapshot,
  collection,
  getDocs,
  serverTimestamp,
} from "firebase/firestore";
import { getFirebaseDb, ensureSignedIn, onAuthChange } from "./client";
import { useSession } from "@/lib/store/session";
import type { CompanyDoc, ClusterDoc, ChatMessage, SessionDoc } from "@/types";
import { toast } from "sonner";

/** Top-level hook: signs in, creates/restores session, hydrates Zustand store. */
export function useFirebaseSession() {
  const {
    uid,
    setUid,
    setSessionId,
    setPipelineStep,
    setCompanyCol,
    setDescCol,
    setCustomWeights,
    setClusters,
    setCompanies,
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
    setChatMessages,
  } = useSession();

  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // 1. Sign in anonymously
    ensureSignedIn().then(async (newUid) => {
      const db = getFirebaseDb();
      setUid(newUid);
      setSessionId(newUid);

      // Restore API key from sessionStorage
      const stored = sessionStorage.getItem("hy_gemini_key");
      if (stored) {
        useSession.getState().setApiKey(stored);
      }

      const sessionRef = doc(db, "sessions", newUid);

      // 2. Create session doc if it doesn't exist
      const snap = await import("firebase/firestore").then(({ getDoc }) =>
        getDoc(sessionRef)
      );
      if (!snap.exists()) {
        const now = Date.now();
        await setDoc(sessionRef, {
          userId: newUid,
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
        } satisfies Omit<SessionDoc, "userId"> & { userId: string });
      }

      // 3. Live listener — hydrates store on every change
      unsubRef.current = onSnapshot(sessionRef, (s) => {
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
      });

      // 4. Load sub-collections once (companies + clusters)
      await Promise.all([
        loadCompanies(newUid),
        loadClusters(newUid),
        loadChatHistory(newUid),
      ]).then(([companies, clusters, msgs]) => {
        setCompanies(companies);
        setClusters(clusters);
        setChatMessages(msgs);
      });
    }).catch((err: unknown) => {
      console.error("[Firebase] Session init failed:", err);
      toast.error("Session init failed — " + (err instanceof Error ? err.message : String(err)));
    });

    return () => {
      unsubRef.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { uid };
}

async function loadCompanies(uid: string): Promise<CompanyDoc[]> {
  const db = getFirebaseDb();
  const snap = await getDocs(collection(db, "sessions", uid, "companies"));
  const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() } as CompanyDoc));
  docs.sort((a, b) => a.rowIndex - b.rowIndex);
  return docs;
}

async function loadClusters(uid: string): Promise<ClusterDoc[]> {
  const db = getFirebaseDb();
  const snap = await getDocs(collection(db, "sessions", uid, "clusters"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as ClusterDoc));
}

async function loadChatHistory(uid: string): Promise<ChatMessage[]> {
  const db = getFirebaseDb();
  const snap = await getDocs(
    collection(db, "sessions", uid, "chatHistory")
  );
  const msgs = snap.docs.map((d) => ({ id: d.id, ...d.data() } as ChatMessage));
  msgs.sort((a, b) => a.timestamp - b.timestamp);
  return msgs;
}

/** Persist session doc fields to Firestore */
export async function persistSession(
  uid: string,
  patch: Partial<SessionDoc>
): Promise<void> {
  const db = getFirebaseDb();
  await import("firebase/firestore").then(({ updateDoc }) =>
    updateDoc(doc(db, "sessions", uid), { ...patch, updatedAt: Date.now() })
  );
}
