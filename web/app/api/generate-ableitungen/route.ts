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

**Headline (x.1):** Max. 8 Wörter, aktiv formuliert. Benennt eine Marktbewegung oder Investment-Implikation.

**Fließtext (x.2):** 1–2 Sätze, max. 35 Wörter. Primärquellen sind **Finanzkennzahlen**: Investitionsvolumina (Mio./Mrd. €), Funding-Wachstum in %, Deal-Anzahlen, Funding-Momentum. Unternehmensanzahlen NICHT verwenden.

## Beispiele (genau dieser Stil)

✅ RICHTIG:
Headline: "KI sichert industrielle Prozessqualität"
Text: "1,8 Mrd. € Investitionen in KI-gestützte Qualitätsprüfung zeigen: Fehler werden direkt im Prozess erkannt und korrigiert, statt im Nachgang geprüft."

Headline: "Service-Plattformen optimieren Betriebskosten"
Text: "Mit 2,2 Mrd. € Gesamtfunding digitalisieren Service-Operations-Plattformen Planung, Einsatzsteuerung und Rückmeldung von Serviceeinsätzen."

Headline: "Hardware-Innovation gewinnt an Dynamik"
Text: "Ein Funding-Wachstum von +31 % bei Automatisierungshardware zeigt: Unternehmen investieren wieder stärker in physische Anlagen, Sensorik und Robotik."

Headline: "Vertikale Integration steigert Gesamteffizienz"
Text: "Das stabile Investitionsniveau bei Manufacturing Execution Systems bestätigt: Produktionsdaten werden systematisch zur Steuerung von Effizienz und Auslastung genutzt."

❌ FALSCH (so NICHT):
Text: "Mit 448 Unternehmen ist der Markt gesättigt." → Unternehmensanzahl statt €-Betrag
Text: "Unternehmen wie X revolutionieren Y." → Produktbeschreibung statt Marktdynamik
Text: "Das Segment erschließt ungenutzte Datenpotenziale." → Buzzwords, kein Geldbetrag

## Regeln
- Primärquelle: €-Beträge, %-Wachstum, Deal-Zahlen aus dem Kontext — keine Unternehmensanzahlen
- Jede Ableitung transportiert eine eigenständige, investitionsrelevante Erkenntnis
- Keine Wiederholungen zwischen den Ableitungen
- Keine Buzzwords: "revolutioniert", "nachhaltig", "transformiert", "erschließt", "ermöglicht"
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
