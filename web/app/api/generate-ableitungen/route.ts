import type { NextRequest } from "next/server";
import { buildReviewContext } from "@/lib/server/review-context";
import { loadSessionSnapshot } from "@/lib/server/session-data";
import { callGeminiText, parseJsonObject } from "@/lib/server/gemini";
import { getGeminiKey } from "@/lib/server/gemini-key";
import type { GeneratedAbleitungen } from "@/lib/slides/types";
import type { ClusterMetricsRow } from "@/types";

export const maxDuration = 60;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(value: number | null | undefined, decimals = 1): string {
  if (value == null) return "—";
  return value.toFixed(decimals).replace(".", ",");
}

function fmtPct(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${(value * 100).toFixed(1).replace(".", ",")} %`;
}

function fmtInt(value: number | null | undefined): string {
  if (value == null) return "—";
  return Math.round(value).toLocaleString("de-DE");
}

function fmtMomentum(value: number | null | undefined): string {
  if (value == null) return "—";
  const pct = (value * 100).toFixed(1).replace(".", ",");
  return value >= 0 ? `+${pct} %` : `${pct} %`;
}

/**
 * Builds a compact markdown benchmark table from ClusterMetricsRow[].
 * Mirrors the "Detailed benchmark table" shown on the Analytics page.
 */
function buildBenchmarkTable(rows: ClusterMetricsRow[]): string {
  if (!rows.length) return "";

  const lines: string[] = [
    "| Cluster | # Deals | Deal Momentum | Capital 4J (Mio. €) | Funding Momentum | Ø Deal (Mio. €) | Ø Funding (Mio. €) | Total Funding (Mio. €) | Marktreife | Mortalität | VC Grad. | HHI |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];

  for (const r of rows) {
    lines.push(
      `| ${r.clusterName} ` +
      `| ${fmtInt(r.dealCount)} ` +
      `| ${fmtMomentum(r.dealMomentum)} ` +
      `| ${fmt(r.totalInvested4yr != null ? r.totalInvested4yr / 1e3 : null, 1)} ` +
      `| ${fmtMomentum(r.fundingMomentum)} ` +
      `| ${fmt(r.capitalMean)} ` +
      `| ${fmt(r.avgFunding)} ` +
      `| ${fmt(r.totalFunding != null ? r.totalFunding / 1e3 : null, 1)} ` +
      `| ${fmtPct(r.marktreife)} ` +
      `| ${fmtPct(r.mortalityRate)} ` +
      `| ${fmtPct(r.vcGraduationRate)} ` +
      `| ${fmt(r.hhi)} |`
    );
  }

  return lines.join("\n");
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const apiKey = getGeminiKey();
  const { uid, analyticsRows } = (await req.json()) as {
    uid: string;
    analyticsRows?: ClusterMetricsRow[];
  };

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

    // Cluster-Übersicht (Beschreibungen + Beispielunternehmen)
    const clusterOverview = reviewContext.clusterSummaries
      .map(
        (s) =>
          `**${s.clusterName}** (${s.companyCount} Unternehmen): ${s.description || "—"}\n` +
          `  Beispiele: ${s.representativeCompanies.slice(0, 4).join(", ")}`
      )
      .join("\n\n");

    // Benchmark-Tabelle aus Analytics (falls vom Client mitgeschickt)
    const benchmarkTable =
      analyticsRows && analyticsRows.length > 0
        ? buildBenchmarkTable(analyticsRows)
        : null;

    const prompt = `Du bist ein erfahrener VC-Marktanalyst bei hy, einer Strategie- und Innovationsberatung.

Auf Basis dieser Marktlandschaft aus ${reviewContext.companyCount} Unternehmen in ${reviewContext.clusterCount} Cluster-Segmenten schreibst du 5 Markt-Ableitungen für einen Investor-Report.

${reviewContext.marketContext ? `Marktkontext:\n${reviewContext.marketContext}\n\n` : ""}## Cluster-Übersicht
${clusterOverview}

${benchmarkTable ? `## Benchmark-Kennzahlen (alle Cluster im Vergleich)

Legende: Capital 4J = investiertes Kapital der letzten 4 Jahre in Mio. €; Marktreife = Capital 4J / Total Funding; Mortalität = Anteil inaktiver Unternehmen; VC Grad. = Anteil erfolgreicher VC-Exits; HHI = Marktkonzentration (0–1).

${benchmarkTable}

` : ""}## Format jeder Ableitung

**Headline (x.1):** Max. 8 Wörter, aktiv formuliert. Benennt eine Marktbewegung oder Investment-Implikation.

**Fließtext (x.2):** 1–2 Sätze, max. 35 Wörter. Primärquellen sind **Finanzkennzahlen aus der Benchmark-Tabelle**: Investitionsvolumina (Mio./Mrd. €), Funding-Momentum (%), Deal-Anzahlen, Marktreife-Werte. Unternehmensanzahlen NICHT verwenden.

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
- Primärquelle: Zahlen aus der Benchmark-Tabelle (€-Beträge, %-Wachstum, Deal-Zahlen) — keine Unternehmensanzahlen
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
