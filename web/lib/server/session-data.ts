import Papa from "papaparse";

import { adminDb, adminStorage } from "@/lib/firebase/admin";
import type { ClusterDoc, CompanyDoc, SessionDoc } from "@/types";
import { DIMENSIONS } from "@/types";

const COMPANIES_STORAGE_PATH = (uid: string) => `sessions/${uid}/companies.csv`;

function coerceString(value: unknown): string {
  if (value == null) return "";
  return String(value);
}

async function loadCompaniesFromStorage(
  uid: string,
  companyCol: string
): Promise<CompanyDoc[]> {
  const bucket = adminStorage().bucket();
  const file = bucket.file(COMPANIES_STORAGE_PATH(uid));
  const [exists] = await file.exists();
  if (!exists) return [];

  const [buffer] = await file.download();
  const text = buffer.toString("utf8");
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });

  return parsed.data.map((row, i) => ({
    id: `r${i}`,
    rowIndex: i,
    name: coerceString(row[companyCol]),
    originalData: row,
    dimensions: Object.fromEntries(
      DIMENSIONS.filter((d) => row[d] != null && row[d] !== "").map((d) => [d, row[d]])
    ),
    clusterId: row._clusterId ? String(row._clusterId) : null,
    umapX: row._umapX ? Number(row._umapX) : null,
    umapY: row._umapY ? Number(row._umapY) : null,
  }));
}

async function loadCompaniesFromFirestore(uid: string): Promise<CompanyDoc[]> {
  const snap = await adminDb().collection("sessions").doc(uid).collection("companies").get();
  return snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() } as CompanyDoc))
    .sort((a, b) => a.rowIndex - b.rowIndex);
}

async function loadClusters(uid: string): Promise<ClusterDoc[]> {
  const snap = await adminDb().collection("sessions").doc(uid).collection("clusters").get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() } as ClusterDoc));
}

export interface SessionSnapshot {
  session: SessionDoc;
  companies: CompanyDoc[];
  clusters: ClusterDoc[];
}

export async function loadSessionSnapshot(uid: string): Promise<SessionSnapshot> {
  const sessionRef = adminDb().collection("sessions").doc(uid);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) {
    throw new Error("Session not found");
  }

  const session = sessionSnap.data() as SessionDoc;
  const companyCol = session.companyCol ?? "name";
  const companies = await loadCompaniesFromStorage(uid, companyCol);
  const clusters = await loadClusters(uid);

  return {
    session,
    companies: companies.length > 0 ? companies : await loadCompaniesFromFirestore(uid),
    clusters,
  };
}
