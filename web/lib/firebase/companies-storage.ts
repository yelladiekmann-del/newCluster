/**
 * Companies are stored as a single enriched CSV in Firebase Storage rather
 * than as individual Firestore documents. This avoids N round-trips during
 * upload and makes saves (dimension extraction, clustering, re-sort) instant.
 *
 * File path: sessions/{uid}/companies.csv
 *
 * Columns:
 *   - All original CSV columns from originalData
 *   - Dimension columns (named exactly as DIMENSIONS constants)
 *   - _clusterId, _umapX, _umapY  (prefixed _ to avoid collision)
 */

import { ref, uploadBytes, getBytes } from "firebase/storage";
import { getFirebaseStorage } from "./client";
import Papa from "papaparse";
import type { CompanyDoc } from "@/types";
import { DIMENSIONS } from "@/types";

const STORAGE_PATH = (uid: string) => `sessions/${uid}/companies.csv`;

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
  await uploadBytes(ref(storage, STORAGE_PATH(uid)), blob);
}

/** Download companies.csv from Storage and reconstruct CompanyDoc[]. */
export async function loadCompaniesFromStorage(
  uid: string,
  companyCol: string
): Promise<CompanyDoc[]> {
  const storage = getFirebaseStorage();
  const bytes = await getBytes(ref(storage, STORAGE_PATH(uid)));
  const text = new TextDecoder().decode(bytes);

  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(text, {
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
        resolve(docs);
      },
      error: reject,
    });
  });
}
