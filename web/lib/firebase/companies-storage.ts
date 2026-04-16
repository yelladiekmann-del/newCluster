/**
 * Companies are stored in two places:
 *   1. Firestore subcollection: sessions/{uid}/companies/{i}  ← primary (always reliable)
 *   2. Firebase Storage:        sessions/{uid}/companies.csv   ← archive / legacy fallback
 *
 * Every save writes to both. Every load reads Firestore first (fast, always works).
 * Storage is only used as a fallback for sessions that pre-date dual-write.
 */

import { ref, uploadBytes, getBytes, getDownloadURL } from "firebase/storage";
import { getFirebaseStorage, getFirebaseDb } from "./client";
import { writeBatch, doc } from "firebase/firestore";
import Papa from "papaparse";
import { toast } from "sonner";
import type { CompanyDoc } from "@/types";
import { DIMENSIONS } from "@/types";

const STORAGE_PATH = (uid: string) => `sessions/${uid}/companies.csv`;

// ── Firestore subcollection (primary) ─────────────────────────────────────────

const BATCH_SIZE = 500; // Firestore max writes per batch

/** Write companies to Firestore subcollection sessions/{uid}/companies */
export async function saveCompaniesToFirestore(
  uid: string,
  companies: CompanyDoc[]
): Promise<void> {
  const db = getFirebaseDb();
  console.log("[saveCompanies] Firestore — writing", companies.length, "docs to sessions/", uid, "/companies");
  // Chunk into batches of ≤ 500
  for (let start = 0; start < companies.length; start += BATCH_SIZE) {
    const chunk = companies.slice(start, start + BATCH_SIZE);
    const batch = writeBatch(db);
    chunk.forEach((c, offset) => {
      const idx = start + offset;
      // Strip undefined values — Firestore rejects them
      const safe = JSON.parse(JSON.stringify(c)) as CompanyDoc;
      batch.set(doc(db, "sessions", uid, "companies", `r${idx}`), safe);
    });
    await batch.commit();
    console.log("[saveCompanies] Firestore — batch committed", start, "–", start + chunk.length - 1);
  }
  console.log("[saveCompanies] Firestore — all", companies.length, "docs written ✓");
}

// ── Storage (archive) ─────────────────────────────────────────────────────────

/** Serialize CompanyDoc[] to an enriched CSV and upload to Storage. */
export async function saveCompaniesToStorage(
  uid: string,
  companies: CompanyDoc[]
): Promise<void> {
  const rows = companies.map((c) => ({
    ...c.originalData,
    ...c.dimensions,
    _clusterId: c.clusterId ?? "",
    _umapX: c.umapX ?? "",
    _umapY: c.umapY ?? "",
  }));

  const csv = Papa.unparse(rows);
  const blob = new Blob([csv], { type: "text/csv" });
  const storage = getFirebaseStorage();

  // 1. Write to Firestore (primary — always reliable)
  try {
    await saveCompaniesToFirestore(uid, companies);
  } catch (err) {
    console.error("[saveCompanies] Firestore write FAILED:", err);
    toast.error("Failed to save companies to database: " + (err instanceof Error ? err.message : String(err)));
    throw err; // Re-throw so caller knows the save failed
  }

  // 2. Write to Storage (archive / legacy fallback)
  try {
    await uploadBytes(ref(storage, STORAGE_PATH(uid)), blob);
    console.log("[saveCompanies] Storage —", blob.size, "bytes written");
  } catch (err) {
    // Non-fatal: Firestore is the source of truth
    console.warn("[saveCompanies] Storage upload failed (non-fatal):", err);
  }
}

/** Upload featureMatrix JSON to Storage and return a public download URL. */
export async function saveEmbeddingsToStorage(
  uid: string,
  matrix: number[][]
): Promise<string> {
  const blob = new Blob([JSON.stringify(matrix)], { type: "application/json" });
  const r = ref(getFirebaseStorage(), `sessions/${uid}/embeddings.json`);
  await uploadBytes(r, blob);
  return getDownloadURL(r);
}

/**
 * Download companies.csv from Storage and reconstruct CompanyDoc[].
 * This is only called as a fallback when the Firestore subcollection is empty
 * (i.e. sessions created before the dual-write migration).
 */
export async function loadCompaniesFromStorage(
  uid: string,
  companyCol: string
): Promise<CompanyDoc[]> {
  console.log("[loadCompanies] Storage fallback — downloading companies.csv for uid:", uid);
  const storage = getFirebaseStorage();
  const storageRef = ref(storage, STORAGE_PATH(uid));
  const bytes = await getBytes(storageRef);
  const csvText = new TextDecoder().decode(bytes);
  console.log("[loadCompanies] Storage — downloaded", bytes.byteLength, "bytes");

  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(csvText, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const docs: CompanyDoc[] = results.data.map((row, i) => ({
          id: `r${i}`,
          rowIndex: i,
          name: String(row[companyCol] ?? ""),
          originalData: row,
          dimensions: Object.fromEntries(
            DIMENSIONS.filter((d) => d in row && row[d] !== "").map((d) => [d, row[d]])
          ),
          clusterId: row._clusterId !== "" ? row._clusterId : null,
          umapX: row._umapX !== "" && row._umapX != null ? Number(row._umapX) : null,
          umapY: row._umapY !== "" && row._umapY != null ? Number(row._umapY) : null,
        }));
        console.log("[loadCompanies] Storage — parsed", docs.length, "rows");
        resolve(docs);
      },
      error: (err: Error) => {
        console.error("[loadCompanies] Storage — Papa.parse error:", err);
        reject(err);
      },
    });
  });
}
