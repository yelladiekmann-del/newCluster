import type { NextRequest } from "next/server";
import { buildSystemContext, sendChatMessage } from "@/lib/gemini/chat";
import type { ClusterDoc, CompanyDoc, ChatMessage } from "@/types";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get("x-gemini-key");
  if (!apiKey) {
    return Response.json({ error: "Missing x-gemini-key header" }, { status: 401 });
  }

  const {
    clusters,
    companies,
    history,
    message,
    analysisContext,
    marketContext,
  } = (await req.json()) as {
    clusters: ClusterDoc[];
    companies: CompanyDoc[];
    history: ChatMessage[];
    message: string;
    analysisContext: string;
    marketContext: string;
  };

  const systemContext = buildSystemContext(clusters, companies, analysisContext, marketContext);

  const result = await sendChatMessage(apiKey, systemContext, history, message);
  return Response.json(result);
}
