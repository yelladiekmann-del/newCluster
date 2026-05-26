import type { NextRequest } from "next/server";
import { extractAllDimensions, type CompanyRow } from "@/lib/gemini/extract-dimensions";
import { getGeminiKey } from "@/lib/server/gemini-key";
import { adminDb } from "@/lib/firebase/admin";

export const maxDuration = 300;

// ── Firestore save (server-side, Admin SDK) ────────────────────────────────────
// Admin SDK runs co-located with Firestore → ~10–30× faster than browser writes.
// 500 docs/batch, 10 parallel commits → 5 000 docs in ~2–4 s.

const ADMIN_BATCH_SIZE = 500;
const ADMIN_PARALLEL_COMMITS = 10;

async function saveDimsToFirestore(
  uid: string,
  collectedDims: Map<number, Record<string, string>>,
  rows: CompanyRow[],
  originalIndices?: number[]
): Promise<void> {
  const db = adminDb();

  const entries: { key: string; name: string; rowIndex: number; dims: Record<string, string> }[] = [];
  for (const [apiIndex, dims] of collectedDims) {
    const originalIndex = originalIndices?.[apiIndex] ?? apiIndex;
    entries.push({
      key: `r${originalIndex}`,
      // Save name + rowIndex so loadCompanies works correctly after a page reload.
      // originalData is not available server-side (only name+description are sent).
      name: rows[apiIndex]?.name ?? "",
      rowIndex: originalIndex,
      dims,
    });
  }

  const chunks: (typeof entries)[] = [];
  for (let i = 0; i < entries.length; i += ADMIN_BATCH_SIZE) {
    chunks.push(entries.slice(i, i + ADMIN_BATCH_SIZE));
  }

  for (let g = 0; g < chunks.length; g += ADMIN_PARALLEL_COMMITS) {
    await Promise.all(
      chunks.slice(g, g + ADMIN_PARALLEL_COMMITS).map(async (batch) => {
        const fb = db.batch();
        for (const { key, name, rowIndex, dims } of batch) {
          // set+merge: creates the doc if missing (update throws NOT_FOUND).
          // Saves name + rowIndex so reloaded sessions can sort + display companies.
          fb.set(
            db.doc(`sessions/${uid}/companies/${key}`),
            { name, rowIndex, dimensions: dims, clusterId: null, umapX: null, umapY: null },
            { merge: true }
          );
        }
        await fb.commit();
      })
    );
  }
}

// ── Route handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const apiKey = getGeminiKey();

  const { rows, uid, originalIndices } = (await req.json()) as {
    rows: CompanyRow[];
    uid?: string;
    originalIndices?: number[];
  };

  if (!Array.isArray(rows) || rows.length === 0) {
    return Response.json({ error: "rows must be a non-empty array" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      // Accumulate dims for server-side save
      const collectedDims = new Map<number, Record<string, string>>();

      try {
        await extractAllDimensions(apiKey, rows, (p) => {
          if (Array.isArray(p.entries)) {
            for (const { index, dims } of p.entries) {
              if (dims) collectedDims.set(index, dims);
            }
          }
          send({ type: "progress", ...p });
        });

        // Save to Firestore server-side before signalling done.
        // The browser receives "saving" while we write, then "done" when finished.
        if (uid && collectedDims.size > 0) {
          send({ type: "saving" });
          try {
            await saveDimsToFirestore(uid, collectedDims, rows, originalIndices);
          } catch (err) {
            console.error("[extract-dimensions] Firestore save failed:", err);
            // Non-fatal: client can still update local state from progress.entries
          }
        }

        send({ type: "done" });
      } catch (err) {
        send({ type: "error", message: String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
