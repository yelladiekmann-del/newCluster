import type { NextRequest } from "next/server";
import { callGeminiText, parseJsonObject } from "@/lib/server/gemini";

export const maxDuration = 30;

export interface ClusterUspInput {
  clusterId: string;
  name: string;
  description: string;
  metrics: {
    companyCount?: number | null;
    hyScore?: number | null;
    dealMomentum?: number | null;
    fundingMomentum?: number | null;
    totalFunding?: number | null;
    avgFunding?: number | null;
    vcGraduationRate?: number | null;
    mortalityRate?: number | null;
  };
}

export interface ClusterUspOutput {
  usps: Record<string, string>; // clusterId → USP string
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });
  }

  let clusters: ClusterUspInput[];
  try {
    const body = await req.json() as { clusters: ClusterUspInput[] };
    clusters = body.clusters;
    if (!Array.isArray(clusters) || clusters.length === 0) throw new Error("empty");
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const clusterSummaries = clusters.map((c) => {
    const m = c.metrics;
    const lines = [
      `Cluster: ${c.name}`,
      `Beschreibung: ${c.description}`,
      m.companyCount != null   ? `Unternehmen: ${m.companyCount}` : null,
      m.hyScore != null        ? `hy Score: ${m.hyScore}/100` : null,
      m.dealMomentum != null   ? `Deal Momentum: ${m.dealMomentum > 0 ? "+" : ""}${m.dealMomentum}% (YoY)` : null,
      m.fundingMomentum != null? `Funding Momentum: ${m.fundingMomentum > 0 ? "+" : ""}${m.fundingMomentum}%` : null,
      m.totalFunding != null   ? `Total Funding: $${(m.totalFunding / 1e6).toFixed(0)}M` : null,
      m.vcGraduationRate != null ? `VC Graduation Rate: ${m.vcGraduationRate}%` : null,
    ].filter(Boolean).join("\n");
    return `[${c.clusterId}]\n${lines}`;
  }).join("\n\n");

  const prompt = `Du bist ein erfahrener VC-Analyst bei hy, einer Unternehmensberatung.
Für jeden der folgenden Cluster schreibst du einen prägnanten USP-Satz (1–2 Sätze, max. 160 Zeichen).

Anforderungen:
- Erkläre den konkreten Mehrwert / das Alleinstellungsmerkmal des Clusters
- Nutze die Metriken als Kontext, nenn sie aber nicht direkt
- Kein Buzzword-Bingo, kein "disruptiv" oder "innovativ"
- Sprache: Deutsch, aktiv, präzise
- Format: JSON-Objekt mit clusterId als Key, USP-String als Value

Cluster-Daten:
${clusterSummaries}

Antworte NUR mit dem JSON-Objekt, ohne Erklärungen.
Beispiel: {"cluster-abc": "Plattformen, die …", "cluster-xyz": "Hardware-Layer für …"}`;

  try {
    const raw = await callGeminiText({
      apiKey,
      prompt,
      temperature: 0.4,
      thinkingBudget: 0,
    });

    const parsed = parseJsonObject<Record<string, string>>(raw);
    if (!parsed) throw new Error("Could not parse Gemini response as JSON");

    const usps: Record<string, string> = {};
    for (const c of clusters) {
      usps[c.clusterId] = parsed[c.clusterId] ?? "";
    }

    return Response.json({ usps } satisfies ClusterUspOutput);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[generate-cluster-usps]", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
