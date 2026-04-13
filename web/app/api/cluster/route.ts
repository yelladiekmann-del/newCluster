import type { NextRequest } from "next/server";
import { GoogleAuth } from "google-auth-library";

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

    const body = await req.json();

    const auth = new GoogleAuth();
    const client = await auth.getIdTokenClient(ML_URL);
    const idToken = await client.getRequestHeaders();

    const mlRes = await fetch(`${ML_URL}/cluster`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...idToken,
      },
      body: JSON.stringify(body),
    });

    if (!mlRes.ok) {
      const text = await mlRes.text();
      return Response.json({ error: text }, { status: mlRes.status });
    }

    const result = await mlRes.json();
    return Response.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api/cluster] Error:", msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
