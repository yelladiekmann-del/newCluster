/**
 * Companies are stored in two places:
 *   1. Firestore subcollection: sessions/{uid}/companies/{i}  ← primary (always reliable)
 *   2. Firebase Storage:        sessions/{uid}/companies.csv   ← archive / legacy fallback
 *
 * Every full save writes to both. Delta saves only write changed docs to Firestore
 * (Storage archive is not updated — it's non-fatal legacy only).
 * Every load reads Firestore first (fast, always works).
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

/**
 * Reduced from 500 → 100.
 * Firestore enforces a 10 MB per-batch write limit in addition to the 500-doc count limit.
 * With large CompanyDocs (originalData + 8 AI dimension fields), each doc can be 10–25 KB.
 * 500 × 20 KB = 10 MB → crashes at the limit. 100 × 20 KB = 2 MB → 5× safety margin.
 */
const BATCH_SIZE = 100;

/** Max batches committed in parallel. Balances Firestore throughput vs. connection pressure. */
const PARALLEL_COMMITS = 5;

/** Commit an array of CompanyDoc chunks to Firestore in parallel groups. */
async function commitChunks(
  uid: string,
  chunks: { startIdx: number; docs: CompanyDoc[] }[]
): Promise<void> {
  const db = getFirebaseDb();
  for (let g = 0; g < chunks.length; g += PARALLEL_COMMITS) {
    const group = chunks.slice(g, g + PARALLEL_COMMITS);
    await Promise.all(
      group.map(async ({ startIdx, docs: chunkDocs }) => {
        const batch = writeBatch(db);
        chunkDocs.forEach((c, offset) => {
          const safe = JSON.parse(JSON.stringify(c)) as CompanyDoc;
          batch.set(doc(db, "sessions", uid, "companies", `r${startIdx + offset}`), safe);
        });
        await batch.commit();
      })
    );
  }
}

/** Write ALL companies to Firestore subcollection sessions/{uid}/companies */
export async function saveCompaniesToFirestore(
  uid: string,
  companies: CompanyDoc[]
): Promise<void> {
  console.log("[saveCompanies] Firestore — writing", companies.length, "docs to sessions/", uid, "/companies");

  const chunks: { startIdx: number; docs: CompanyDoc[] }[] = [];
  for (let start = 0; start < companies.length; start += BATCH_SIZE) {
    chunks.push({ startIdx: start, docs: companies.slice(start, start + BATCH_SIZE) });
  }

  await commitChunks(uid, chunks);
  console.log("[saveCompanies] Firestore — all", companies.length, "docs written ✓");
}

/**
 * Write ONLY the changed companies to Firestore (delta save).
 * Use this instead of saveCompaniesToFirestore when you know which specific
 * company IDs were modified — avoids rewriting the entire collection on every edit.
 *
 * Callers: AiChatPanel, ResortPanel, CompanyListDialog
 */
export async function saveChangedCompaniesToFirestore(
  uid: string,
  companies: CompanyDoc[],
  changedIds: Set<string>
): Promise<void> {
  if (changedIds.size === 0) return;

  const changed = companies.filter((c) => changedIds.has(c.id));
  console.log("[saveChangedCompanies] Firestore — writing", changed.length, "changed docs");

  const chunks: { startIdx: number; docs: CompanyDoc[] }[] = [];
  for (let i = 0; i < changed.length; i += BATCH_SIZE) {
    const slice = changed.slice(i, i + BATCH_SIZE);
    // Use rowIndex as the Firestore doc key (matches what saveCompaniesToFirestore writes)
    chunks.push({ startIdx: -1, docs: slice }); // startIdx unused — we use rowIndex directly
  }

  const db = getFirebaseDb();
  // For delta saves, write by rowIndex (not positional) to address the correct Firestore doc
  for (let g = 0; g < chunks.length; g += PARALLEL_COMMITS) {
    const group = chunks.slice(g, g + PARALLEL_COMMITS);
    await Promise.all(
      group.map(async ({ docs: chunkDocs }) => {
        const batch = writeBatch(db);
        chunkDocs.forEach((c) => {
          const safe = JSON.parse(JSON.stringify(c)) as CompanyDoc;
          batch.set(doc(db, "sessions", uid, "companies", `r${c.rowIndex}`), safe);
        });
        await batch.commit();
      })
    );
  }
  console.log("[saveChangedCompanies] ✓ wrote", changedIds.size, "changed companies");
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
