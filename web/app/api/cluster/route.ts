import type { NextRequest } from "next/server";
import { adminStorage } from "@/lib/firebase/admin";

export const maxDuration = 300;

const ML_URL = process.env.CLOUD_RUN_ML_URL;

/**
 * /api/cluster — SSE streaming endpoint.
 *
 * Streams SSE events so Firebase Hosting's ~60s load-balancer timeout is never
 * hit: a `: heartbeat` comment is sent every 10 s while we wait for the ML
 * service to run UMAP + HDBSCAN (which can take 30-90 s with cold-start).
 *
 * Events:
 *   data: {"type":"progress","stage":"fetching_embeddings"}
 *   data: {"type":"progress","stage":"clustering"}
 *   data: {"type":"done", ...clusterResult}
 *   data: {"type":"error","error":"<message>"}
 */
export async function POST(req: NextRequest) {
  if (!ML_URL) {
    return Response.json({ error: "CLOUD_RUN_ML_URL is not configured" }, { status: 500 });
  }

  const { embeddingsUrl, embeddingsStoragePath, ...rest } = await req.json();

  if (!embeddingsUrl && !embeddingsStoragePath) {
    return Response.json({ error: "Missing embeddingsUrl or embeddingsStoragePath" }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

      // Heartbeat comment every 10 s — keeps Firebase Hosting load balancer alive
      const heartbeat = setInterval(
        () => controller.enqueue(encoder.encode(": heartbeat\n\n")),
        10_000
      );

      try {
        let mlBody: Record<string, unknown>;

        send({ type: "progress", stage: "fetching_embeddings" });

        if (embeddingsStoragePath) {
          // Generate a short-lived signed URL so the ML service can download
          // the matrix directly — avoids forwarding 90+ MB through this route.
          console.log("[api/cluster] Generating signed URL for:", embeddingsStoragePath);
          const bucket = adminStorage().bucket();
          const [signedUrl] = await bucket.file(embeddingsStoragePath).getSignedUrl({
            action: "read",
            expires: Date.now() + 15 * 60 * 1000, // 15 minutes
          });
          console.log("[api/cluster] Signed URL generated, passing to ML service");
          mlBody = { ...rest, embeddingsUrl: signedUrl };
        } else {
          // Legacy: public download URL — pass directly to ML service
          console.log("[api/cluster] Using legacy embeddingsUrl:", embeddingsUrl);
          mlBody = { ...rest, embeddingsUrl };
        }

        const companyCount = (rest as Record<string, unknown[]>).companyIds?.length ?? "?";
        console.log(`[api/cluster] Calling ML service with ${companyCount} companies`);
        send({ type: "progress", stage: "clustering" });

        const mlRes = await fetch(`${ML_URL}/cluster`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mlBody),
        });

        if (!mlRes.ok) {
          const rawText = await mlRes.text();
          console.error("[api/cluster] ML service error", mlRes.status, rawText);

          // Parse FastAPI error format: {"detail": "...", "traceback": "..."}
          let errorMsg = rawText;
          try {
            const parsed = JSON.parse(rawText);
            errorMsg = parsed.traceback
              ? `${parsed.detail}\n\nTraceback:\n${parsed.traceback}`
              : (parsed.detail ?? rawText);
          } catch {
            // plain text — use as-is
          }
          send({ type: "error", error: errorMsg });
          return;
        }

        const result = await mlRes.json();
        console.log(`[api/cluster] Done — ${result.nClusters} clusters, ${result.nOutliers} outliers`);
        send({ type: "done", ...result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[api/cluster] Unexpected error:", msg);
        send({ type: "error", error: msg });
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
