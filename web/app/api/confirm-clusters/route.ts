import type { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase/admin";

export const maxDuration = 60;

// Flexible: only the fields provided will be written (Firestore `update` semantics).
// `id` is the document key; all other fields are passed through as-is.
type CompanyClusterUpdate = { id: string } & Record<string, unknown>;

// Admin SDK is co-located with Firestore — ~10–30× faster than browser writes.
// 500 docs/batch, 10 parallel commits → 5 000 docs in ~2–4 s.
const BATCH_SIZE = 500;
const PARALLEL_COMMITS = 10;

export async function POST(req: NextRequest) {
  try {
    const { uid, updates } = (await req.json()) as {
      uid: string;
      updates: CompanyClusterUpdate[];
    };

    if (!uid || !Array.isArray(updates) || updates.length === 0) {
      return Response.json({ error: "uid and updates required" }, { status: 400 });
    }

    console.log("[confirm-clusters] saving", updates.length, "company updates for session", uid);
    const t = Date.now();
    const db = adminDb();

    const chunks: CompanyClusterUpdate[][] = [];
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      chunks.push(updates.slice(i, i + BATCH_SIZE));
    }

    for (let g = 0; g < chunks.length; g += PARALLEL_COMMITS) {
      await Promise.all(
        chunks.slice(g, g + PARALLEL_COMMITS).map(async (batch) => {
          const fb = db.batch();
          for (const { id, ...fields } of batch) {
            // set+merge instead of update: creates the doc if missing (update throws NOT_FOUND)
            fb.set(db.doc(`sessions/${uid}/companies/${id}`), fields, { merge: true });
          }
          await fb.commit();
        })
      );
    }

    console.log("[confirm-clusters] done —", updates.length, "docs in", Date.now() - t, "ms");
    return Response.json({ ok: true, updated: updates.length });
  } catch (err) {
    console.error("[confirm-clusters] failed:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
