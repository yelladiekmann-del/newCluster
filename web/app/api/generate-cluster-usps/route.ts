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
  usps:   Record<string, string>; // clusterId → company USP (max 120 chars)
  sowhat: Record<string, string>; // clusterId → strategic So What (max 100 chars)
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
Für jedes der folgenden Unternehmen erzeugst du zwei Texte:

1. USP (Feld "usps"): Prägnante Unternehmens-Beschreibung, max. 110 Zeichen.
   - Was macht das Unternehmen konkret und für wen? (kein Cluster-Level, nur das Unternehmen)
   - Aktive Sprache, keine Buzzwords ("disruptiv", "innovativ", "revolutionär")
   - Wenn Rohdaten vorhanden: Kern destillieren, nicht kopieren
   - Wenn keine Rohdaten: aus Name + Cluster plausiblen Ansatz ableiten

2. So What (Feld "sowhat"): Strategische Implikation für einen Unternehmensberater, max. 90 Zeichen.
   - Ein kurzer, pointierter Satz: Was bedeutet dieses Unternehmen / dieser Cluster für den Markt?
   - Beispiel: "Automatisierungsdruck steigt — traditionelle Hersteller müssen reagieren."

Sprache: Deutsch
Format: JSON mit zwei Objekten "usps" und "sowhat", jeweils clusterId als Key.

Unternehmensdaten:
${companySummaries}

Antworte NUR mit dem JSON, ohne Erklärungen.
Beispiel: {"usps":{"c1":"Urbantz steuert Letzte-Meile-Logistik für Retailer.","c2":"Nozoli automatisiert Buchhaltung für KMU."},"sowhat":{"c1":"Last-Mile-Kosten werden zum Wettbewerbsfaktor.","c2":"Buchhalter-Engpass treibt SaaS-Adoption."}}`;

  try {
    const raw = await callGeminiText({
      apiKey,
      prompt,
      temperature: 0.4,
      thinkingBudget: 0,
    });

    const parsed = parseJsonObject<{ usps?: Record<string, string>; sowhat?: Record<string, string> }>(raw);
    if (!parsed) throw new Error("Could not parse Gemini response as JSON");

    const usps:   Record<string, string> = {};
    const sowhat: Record<string, string> = {};
    for (const c of clusters) {
      usps[c.clusterId]   = parsed.usps?.[c.clusterId]   ?? "";
      sowhat[c.clusterId] = parsed.sowhat?.[c.clusterId] ?? "";
    }

    return Response.json({ usps, sowhat } satisfies ClusterUspOutput);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[generate-cluster-usps]", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
