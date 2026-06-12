import type { NextRequest } from "next/server";
import { callGeminiText, parseJsonObject } from "@/lib/server/gemini";

export const maxDuration = 30;

export interface ClusterUspInput {
  clusterId: string;
  clusterName: string;
  /** Representative company for this cluster column */
  companyName: string;
  /** Raw description text from the company CSV (any description-like column), may be empty */
  companyDescription: string;
  /** Total funding of the representative company, formatted */
  companyFunding: string;
}

export interface ClusterUspOutput {
  usps: Record<string, string>; // clusterId → company USP string
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

  const companySummaries = clusters.map((c) => {
    const lines = [
      `Unternehmen: ${c.companyName}`,
      `Cluster: ${c.clusterName}`,
      c.companyFunding !== "—" ? `Total Funding: ${c.companyFunding}` : null,
      c.companyDescription ? `Beschreibung (Rohdaten): ${c.companyDescription.slice(0, 400)}` : null,
    ].filter(Boolean).join("\n");
    return `[${c.clusterId}]\n${lines}`;
  }).join("\n\n");

  const prompt = `Du bist ein erfahrener VC-Analyst bei hy, einer Unternehmensberatung.
Für jedes der folgenden Unternehmen schreibst du eine prägnante Unternehmens-Beschreibung (2–3 Sätze, max. 180 Zeichen).

Anforderungen:
- Beschreibe WAS das Unternehmen konkret macht und für wen (kein Cluster-Level, nur das Unternehmen)
- Aktivische Sprache, keine Buzzwords ("disruptiv", "innovativ", "revolutionär")
- Wenn Rohdaten vorhanden sind: daraus den Kern destillieren, nicht einfach kopieren
- Wenn keine Rohdaten: aus Unternehmensname und Cluster einen plausiblen Ansatz ableiten
- Sprache: Deutsch
- Format: JSON-Objekt mit clusterId als Key, Beschreibungstext als Value

Unternehmensdaten:
${companySummaries}

Antworte NUR mit dem JSON-Objekt, ohne Erklärungen.
Beispiel: {"c1": "Urbantz steuert komplexe Letzte-Meile-Logistik …", "c2": "Nozoli automatisiert …"}`;

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
