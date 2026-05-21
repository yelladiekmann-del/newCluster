import type { NextRequest } from "next/server";
import { embedAll } from "@/lib/gemini/embed";
import { getGeminiKey } from "@/lib/server/gemini-key";
import { adminStorage } from "@/lib/firebase/admin";

export const maxDuration = 300;

const STORAGE_PATH = (uid: string) => `sessions/${uid}/embeddings.json`;

async function downloadExistingMatrix(storagePath: string): Promise<number[][] | null> {
  try {
    const bucket = adminStorage().bucket();
    const file = bucket.file(storagePath);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [buffer] = await file.download();
    return JSON.parse(buffer.toString("utf8")) as number[][];
  } catch (err) {
    console.warn("[embed] Could not download existing matrix (non-fatal):", err);
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = getGeminiKey();
    const body = await req.json();
    const { companies, weights, sessionId, embeddingsStoragePath: inputStoragePath } = body as {
      companies: Array<{ id: string; dimensions: Record<string, string> }>;
      weights?: Record<string, number> | null;
      sessionId: string;
      /** Storage path from a previous run. Non-zero rows will be skipped (incremental re-embed). */
      embeddingsStoragePath?: string | null;
    };

    if (!companies?.length) {
      return Response.json({ error: "companies is empty" }, { status: 400 });
    }
    if (!sessionId) {
      return Response.json({ error: "sessionId is required" }, { status: 400 });
    }

    // Download existing matrix server-side — non-zero rows are skipped by embedAll
    const existingMatrix = inputStoragePath
      ? await downloadExistingMatrix(inputStoragePath)
      : null;

    // Accumulate matrix server-side — never sent to client (saves hundreds of MB of bandwidth)
    const matrix: number[][] = existingMatrix ? [...existingMatrix] : [];
    const storagePath = inputStoragePath ?? STORAGE_PATH(sessionId);

    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (data: object) =>
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));

        try {
          for await (const event of embedAll(companies, apiKey, weights, existingMatrix)) {
            if (event.type === "progress") {
              // Accumulate row server-side; strip from client-bound event
              matrix[event.done - 1] = event.row;
              const { row: _row, ...clientEvent } = event;
              send(clientEvent);
            } else if (event.type === "done") {
              // Upload final matrix to Storage before sending done
              try {
                const bucket = adminStorage().bucket();
                await bucket.file(storagePath).save(JSON.stringify(matrix), {
                  contentType: "application/json",
                  resumable: false,
                });
              } catch (uploadErr) {
                console.error("[embed] matrix upload failed:", uploadErr);
              }
              send({ ...event, embeddingsStoragePath: storagePath });
            } else {
              send(event);
            }
          }
        } catch (err) {
          send({ type: "error", message: err instanceof Error ? err.message : String(err) });
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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api/embed] Error:", msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
