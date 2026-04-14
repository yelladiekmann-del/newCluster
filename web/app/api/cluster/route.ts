import type { NextRequest } from "next/server";

export const maxDuration = 300;

const ML_URL = process.env.CLOUD_RUN_ML_URL;

export async function POST(req: NextRequest) {
  try {
    if (!ML_URL) {
      return Response.json(
        { error: "CLOUD_RUN_ML_URL is not configured" },
        { status: 500 }
      );
    }

    const { embeddingsUrl, embeddingsStoragePath, ...rest } = await req.json();

    if (!embeddingsUrl && !embeddingsStoragePath) {
      return Response.json({ error: "Missing embeddingsUrl or embeddingsStoragePath" }, { status: 400 });
    }

    let mlBody: Record<string, unknown>;

    if (embeddingsUrl) {
      // Download featureMatrix JSON from Firebase Storage URL (server-to-server, no ingress limit)
      console.log("[api/cluster] Fetching embeddings from Storage URL...");
      const matrixRes = await fetch(embeddingsUrl);
      if (!matrixRes.ok) {
        console.error("[api/cluster] Storage fetch failed:", matrixRes.status, await matrixRes.text());
        return Response.json({ error: "Could not fetch embeddings from Storage" }, { status: 500 });
      }
      const featureMatrix = await matrixRes.json();
      console.log(`[api/cluster] Fetched matrix: ${featureMatrix.length} rows × ${featureMatrix[0]?.length ?? 0} cols`);
      mlBody = { ...rest, featureMatrix };
    } else {
      // NPZ preloaded — pass storage path to ML service for direct download
      mlBody = { ...rest, embeddingsStoragePath };
    }

    console.log(`[api/cluster] Sending to ML service: companyIds=${(rest as Record<string, unknown[]>).companyIds?.length ?? "?"}`);

    const mlRes = await fetch(`${ML_URL}/cluster`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mlBody),
    });

    if (!mlRes.ok) {
      const rawText = await mlRes.text();
      console.error("[api/cluster] ML service error", mlRes.status, rawText);
      // Parse FastAPI error format: { detail: "..." } or { detail: "...", traceback: "..." }
      let errorMsg = rawText;
      try {
        const parsed = JSON.parse(rawText);
        errorMsg = parsed.traceback
          ? `${parsed.detail}\n\nTraceback:\n${parsed.traceback}`
          : (parsed.detail ?? rawText);
      } catch {
        // not JSON — use raw text as-is
      }
      return Response.json({ error: errorMsg }, { status: mlRes.status });
    }

    const result = await mlRes.json();
    return Response.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api/cluster] Error:", msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
