import type { NextRequest } from "next/server";
import { nameAllClusters } from "@/lib/gemini/name-clusters";
import type { CompanyDoc } from "@/types";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get("x-gemini-key");
  if (!apiKey) {
    return Response.json({ error: "Missing x-gemini-key header" }, { status: 401 });
  }

  const { clusterGroups } = (await req.json()) as {
    clusterGroups: Array<{ clusterIndex: string; companies: CompanyDoc[] }>;
  };

  if (!Array.isArray(clusterGroups) || clusterGroups.length === 0) {
    return Response.json({ error: "clusterGroups must be non-empty" }, { status: 400 });
  }

  const results = await nameAllClusters(apiKey, clusterGroups);
  return Response.json({ results });
}
