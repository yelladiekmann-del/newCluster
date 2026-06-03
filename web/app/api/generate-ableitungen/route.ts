import type { NextRequest } from "next/server";
import { buildReviewContext } from "@/lib/server/review-context";
import { loadSessionSnapshot } from "@/lib/server/session-data";
import { callGeminiText, parseJsonObject } from "@/lib/server/gemini";
import { getGeminiKey } from "@/lib/server/gemini-key";
import type { GeneratedAbleitungen } from "@/lib/slides/types";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const apiKey = getGeminiKey();
  const { uid } = (await req.json()) as { uid: string };

  if (!uid) {
    return Response.json({ error: "uid is required" }, { status: 400 });
  }

  try {
    const { session, companies, clusters } = await loadSessionSnapshot(uid);

    const reviewContext = buildReviewContext({
      session,
      companies,
      clusters,
      marketContext: session.chatMarketContextRaw ?? "",
    });

    // Build a compact cluster overview for the prompt
    const clusterOverview = reviewContext.clusterSummaries
      .map(
        (s) =>
          `**${s.clusterName}** (${s.companyCount} Unternehmen): ${s.description || "—"}\n` +
          `  Beispiele: ${s.representativeCompanies.slice(0, 4).join(", ")}`
      )
      .join("\n\n");

    const prompt = `Du bist ein erfahrener VC-Marktanalyst bei hy, einer Strategie- und Innovationsberatung.

Auf Basis dieser Marktlandschaft aus ${reviewContext.companyCount} Unternehmen in ${reviewContext.clusterCount} Cluster-Segmenten schreibst du 5 Markt-Ableitungen für einen Investor-Report.

${reviewContext.marketContext ? `Marktkontext:\n${reviewContext.marketContext}\n\n` : ""}Cluster-Übersicht:
${clusterOverview}

## Format jeder Ableitung

**Headline (x.1):**
- Max. 8 Wörter, aktiv formuliert, keine Substantivketten
- Benennt eine Marktbewegung oder Investment-Implikation — kein Produktfeature
- Beispiel gut: "Konsolidierungsdruck zwingt Service-Plattformen zur Differenzierung"
- Beispiel schlecht: "Service-Plattformen optimieren die Lieferkette nachhaltig"

**Fließtext (x.2):**
- Genau 1–2 kurze Sätze, max. 35 Wörter gesamt
- Investorenperspektive: Was bedeutet dieser Trend? Welche Implikation hat er?
- Mindestens eine konkrete Zahl, ein Zeitbezug oder ein Segment-Name aus dem Datensatz
- Kein Buzzword-Stil, keine Beschreibung was Unternehmen tun ("XY revolutioniert Z")
- Beispiel gut: "Mit >2 Mrd. € Gesamtfunding zeigt das Segment: Kapitaleinsatz verschiebt sich von Hardware zu Betriebssoftware. Wer dort noch nicht positioniert ist, verliert Marktanteile."
- Beispiel schlecht: "Unternehmen wie X und Y ermöglichen durch Z eine schnellere Markteinführung und minimieren die Entwicklungskosten für industrielle Kunden."

## Regeln
- Jede Ableitung transportiert eine eigenständige, investitionsrelevante Erkenntnis
- Keine Wiederholungen zwischen den Ableitungen
- Kein Buzzword-Stil (keine "revolutioniert", "nachhaltig", "transformiert", "erschließt")
- Auf Deutsch

Antworte NUR mit diesem JSON-Objekt (kein Markdown, keine Erklärung):
{
  "ableitung1.1": "...",
  "ableitung1.2": "...",
  "ableitung2.1": "...",
  "ableitung2.2": "...",
  "ableitung3.1": "...",
  "ableitung3.2": "...",
  "ableitung4.1": "...",
  "ableitung4.2": "...",
  "ableitung5.1": "...",
  "ableitung5.2": "..."
}`;

    const raw = await callGeminiText({
      apiKey,
      prompt,
      temperature: 0.4,
      model: "gemini-2.5-flash",
      thinkingBudget: 0,
    });

    const parsed = parseJsonObject<GeneratedAbleitungen>(raw);
    if (!parsed) {
      return Response.json({ error: "Gemini returned unparseable response" }, { status: 500 });
    }

    return Response.json({ ableitungen: parsed });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[generate-ableitungen]", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
