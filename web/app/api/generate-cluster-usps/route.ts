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
  usps:   Record<string, string>; // clusterId → company USP (max ~110 chars)
  sowhat: Record<string, string>; // clusterId → strategic So What (max ~90 chars)
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

  // Use simple numeric keys ("1", "2", "3") so Gemini doesn't mangle real cluster IDs.
  const companySummaries = clusters.map((c, idx) => {
    const lines = [
      `Unternehmen: ${c.companyName}`,
      `Cluster: ${c.clusterName}`,
      c.companyFunding !== "—" ? `Total Funding: ${c.companyFunding}` : null,
      c.companyDescription ? `Beschreibung (Rohdaten): ${c.companyDescription.slice(0, 400)}` : null,
    ].filter(Boolean).join("\n");
    return `[${idx + 1}]\n${lines}`;
  }).join("\n\n");

  const prompt = `Du bist ein erfahrener VC-Analyst bei hy, einer Unternehmensberatung.
Für jedes der folgenden Unternehmen erzeugst du zwei Texte:

1. USP (Feld "usps"): Prägnante Unternehmens-Beschreibung, max. 110 Zeichen.
   - Was macht das Unternehmen konkret und für wen? (kein Cluster-Level, nur das Unternehmen)
   - Aktive Sprache, keine Buzzwords ("disruptiv", "innovativ", "revolutionär")
   - Wenn Rohdaten vorhanden: Kern destillieren, nicht kopieren
   - Wenn keine Rohdaten: aus Unternehmensname + Cluster einen plausiblen Ansatz ableiten

2. So What (Feld "sowhat"): Strategische Implikation, max. 90 Zeichen.
   - Ein pointierter Satz: Was bedeutet dieser Cluster / dieses Unternehmen für den Markt?

Sprache: Deutsch
Format: JSON mit zwei Objekten "usps" und "sowhat".
Verwende als Key exakt die Zahl aus den eckigen Klammern (z.B. "1", "2", "3").

Unternehmensdaten:
${companySummaries}

Antworte NUR mit dem JSON, ohne Erklärungen.
Beispiel fuer 2 Eintraege:
{"usps":{"1":"Urbantz steuert Letzte-Meile-Logistik fuer Retailer.","2":"Nozoli automatisiert Buchhaltung fuer KMU."},"sowhat":{"1":"Last-Mile-Kosten werden zum Wettbewerbsfaktor.","2":"Buchhalter-Engpass treibt SaaS-Adoption."}}`;

  try {
    const raw = await callGeminiText({
      apiKey,
      prompt,
      temperature: 0.4,
      thinkingBudget: 0,
    });

    const parsed = parseJsonObject<{ usps?: Record<string, string>; sowhat?: Record<string, string> }>(raw);
    if (!parsed) throw new Error("Could not parse Gemini response as JSON");

    // Map back from numeric key ("1", "2", …) to the original clusterId
    const usps:   Record<string, string> = {};
    const sowhat: Record<string, string> = {};
    clusters.forEach((c, idx) => {
      const key = String(idx + 1);
      usps[c.clusterId]   = parsed.usps?.[key]   ?? "";
      sowhat[c.clusterId] = parsed.sowhat?.[key] ?? "";
    });

    return Response.json({ usps, sowhat } satisfies ClusterUspOutput);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[generate-cluster-usps]", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
