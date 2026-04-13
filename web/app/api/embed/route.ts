import type { NextRequest } from "next/server";
import { GoogleAuth } from "google-auth-library";

export const maxDuration = 300;

const ML_URL = process.env.CLOUD_RUN_ML_URL;

export async function POST(req: NextRequest) {
  try {
    const apiKey = req.headers.get("x-gemini-key");
    if (!apiKey) {
      return Response.json({ error: "Missing x-gemini-key header" }, { status: 401 });
    }

    if (!ML_URL) {
      return Response.json(
        { error: "CLOUD_RUN_ML_URL is not configured" },
        { status: 500 }
      );
    }

    const body = await req.json();

    // Get an ID token for Cloud Run authentication
    const auth = new GoogleAuth();
    const client = await auth.getIdTokenClient(ML_URL);
    const idToken = await client.getRequestHeaders();

    // Forward to Cloud Run — it streams SSE back
    const mlRes = await fetch(`${ML_URL}/embed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...idToken,
      },
      body: JSON.stringify({ ...body, apiKey }),
    });

    if (!mlRes.ok || !mlRes.body) {
      const text = await mlRes.text();
      return Response.json({ error: text }, { status: mlRes.status });
    }

    // Pass the SSE stream directly to the client
    return new Response(mlRes.body, {
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
