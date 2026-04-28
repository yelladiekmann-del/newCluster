import type { NextRequest } from "next/server";

import { adminDb } from "@/lib/firebase/admin";
import { fetchMarketContext } from "@/lib/server/market-context";
import { getGeminiKey } from "@/lib/server/gemini-key";
import { loadSessionSnapshot } from "@/lib/server/session-data";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const apiKey = getGeminiKey();

  const { uid, analysisContext } = (await req.json()) as {
    uid?: string;
    analysisContext?: string;
  };

  if (!uid) {
    return Response.json({ error: "uid is required" }, { status: 400 });
  }

  try {
    const { clusters, companies } = await loadSessionSnapshot(uid);
    const marketContext = await fetchMarketContext({
      apiKey,
      analysisContext: analysisContext ?? "",
      clusters,
      companies,
    });

    await adminDb().collection("sessions").doc(uid).update({
      chatOnboarded: true,
      chatAnalysisContext: analysisContext ?? "",
      chatMarketContextRaw: marketContext,
      updatedAt: Date.now(),
    });

    return Response.json({ marketContext });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
