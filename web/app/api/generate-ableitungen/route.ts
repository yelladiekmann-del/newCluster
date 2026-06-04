import type { NextRequest } from "next/server";
import type { GeneratedAbleitungen } from "@/lib/slides/types";

export const maxDuration = 30;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface YearlyMetric {
  year: number;
  volume: number;    // Mio. €
  dealCount: number;
}

// ── Format helpers ────────────────────────────────────────────────────────────

function fmtVol(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace(".", ",")} Mrd.`;
  return `${Math.round(v)} Mio.`;
}

function fmtPct(v: number): string {
  const abs = Math.abs(v * 100).toFixed(0);
  if (v > 0) return `+${abs}%`;
  if (v < 0) return `−${abs}%`;
  return "0%";
}

// ── Rule engine ───────────────────────────────────────────────────────────────

function applyRules(yearly: YearlyMetric[]): GeneratedAbleitungen {
  if (yearly.length < 2) {
    return {
      actionTitle:     "",
      "ableitung1.1": "", "ableitung1.2": "",
      "ableitung2.1": "", "ableitung2.2": "",
      "ableitung3.1": "", "ableitung3.2": "",
      "ableitung4.1": "", "ableitung4.2": "",
      "ableitung5.1": "", "ableitung5.2": "",
    };
  }

  const last  = yearly[yearly.length - 1];
  const prev  = yearly[yearly.length - 2];
  const first = yearly[0];

  const volumeYoY = (last.volume    - prev.volume)    / (prev.volume    || 1);
  const dealYoY   = (last.dealCount - prev.dealCount) / (prev.dealCount || 1);

  const peakYear = yearly.reduce((p, c) => (c.volume > p.volume ? c : p));

  const spanYears = last.year - first.year;
  const cagr = spanYears > 0 && first.volume > 0
    ? Math.pow(last.volume / first.volume, 1 / spanYears) - 1
    : 0;

  const allVolume  = yearly.reduce((s, y) => s + y.volume,    0);
  const allDeals   = yearly.reduce((s, y) => s + y.dealCount, 0);
  const ltAvgDeal  = allDeals   > 0 ? allVolume  / allDeals   : 0;
  const lastAvgDeal = last.dealCount > 0 ? last.volume / last.dealCount : 0;

  // ── Action Title ─────────────────────────────────────────────────────────────

  let actionTitle: string;
  if (peakYear.year === last.year && Math.abs(dealYoY) < 0.1) {
    actionTitle = `Rekordjahr ${last.year}: Das Investitionsvolumen erreicht ein Allzeithoch — bei nahezu konstanter Deal-Anzahl`;
  } else if (volumeYoY >= 0.2 && dealYoY >= 0.2) {
    actionTitle = `Breiter Kapitalzufluss ${last.year}: Sowohl Volumen als auch Deal-Frequenz steigen signifikant`;
  } else if (volumeYoY >= 0.2 && Math.abs(dealYoY) < 0.1) {
    actionTitle = `Das Investitionsvolumen steigt ${last.year} um ${fmtPct(volumeYoY)} — die Anzahl der Deals bleibt stabil`;
  } else if (volumeYoY <= -0.2) {
    actionTitle = `Deutliche Korrektur ${last.year}: Investoren ziehen Kapital ab, der Markt konsolidiert sich`;
  } else {
    actionTitle = `Der Markt stabilisiert sich ${last.year} — Volumen und Deal-Aktivität auf konstantem Niveau`;
  }

  // ── Ableitung 1: Volumen-Trend ────────────────────────────────────────────────

  let a1h: string, a1b: string;
  if (volumeYoY >= 0.2) {
    a1h = "Kapitalzufluss beschleunigt sich deutlich";
    a1b = `Das Investitionsvolumen stieg von €${fmtVol(prev.volume)} (${prev.year}) auf €${fmtVol(last.volume)} (${last.year}) — ein Zuwachs von ${fmtPct(volumeYoY)}. Der Markt zieht signifikant mehr Kapital an, was auf wachsendes institutionelles Vertrauen hindeutet.`;
  } else if (volumeYoY <= -0.2) {
    a1h = "Investitionsvolumen unter Korrektur";
    a1b = `Das Funding fiel von €${fmtVol(prev.volume)} auf €${fmtVol(last.volume)} (${fmtPct(volumeYoY)}). Diese Korrektur signalisiert eine selektivere Kapitalallokation — Investoren priorisieren Profitabilität über Wachstum.`;
  } else {
    a1h = "Kapitalflüsse auf stabilem Niveau";
    a1b = `Mit €${fmtVol(last.volume)} im Jahr ${last.year} bewegt sich das Volumen nahe am Vorjahr (${fmtPct(volumeYoY)}). Der Markt befindet sich in einer Konsolidierungsphase mit gleichbleibender Investorenaktivität.`;
  }

  // ── Ableitung 2: Deal-Anzahl ──────────────────────────────────────────────────

  let a2h: string, a2b: string;
  if (dealYoY <= -0.2) {
    a2h = "Weniger Deals, höhere Selektivität";
    a2b = `Die Anzahl der Finanzierungsrunden ging von ${prev.dealCount} auf ${last.dealCount} zurück (${fmtPct(dealYoY)}). Investoren konzentrieren Kapital auf weniger, dafür reifere Unternehmen — ein Zeichen zunehmender Marktreife.`;
  } else if (dealYoY >= 0.2) {
    a2h = "Dealaktivität nimmt spürbar zu";
    a2b = `${last.dealCount} Finanzierungsrunden in ${last.year} gegenüber ${prev.dealCount} im Vorjahr (${fmtPct(dealYoY)}). Die breitere Dealbasis deutet auf ein wachsendes Startup-Ökosystem und diversifiziertes Investoreninteresse hin.`;
  } else {
    a2h = "Stabile Transaktionsfrequenz";
    a2b = `Mit ${last.dealCount} Deals in ${last.year} bleibt die Aktivität konstant. Der Markt zeigt keine Überhitzung, aber auch keinen Rückzug — ein Gleichgewicht zwischen Angebot und Nachfrage.`;
  }

  // ── Ableitung 3: Durchschnittliche Rundengröße ───────────────────────────────

  let a3h: string, a3b: string;
  const avgDealDiff = ltAvgDeal > 0 ? (lastAvgDeal - ltAvgDeal) / ltAvgDeal : 0;
  if (lastAvgDeal > ltAvgDeal * 1.1) {
    a3h = "Durchschnittliche Rundengröße steigt";
    a3b = `Die mittlere Dealgröße liegt bei €${fmtVol(lastAvgDeal)} — ${fmtPct(avgDealDiff)} gegenüber dem Langzeitschnitt (€${fmtVol(ltAvgDeal)}). Größere Runden deuten auf Later-Stage-Dominanz und wachsende Skalierungsambitionen der Portfoliounternehmen hin.`;
  } else if (lastAvgDeal < ltAvgDeal * 0.9) {
    a3h = "Kleinere Runden dominieren";
    a3b = `Mit €${fmtVol(lastAvgDeal)} pro Deal liegt die durchschnittliche Rundengröße unter dem Langzeitschnitt von €${fmtVol(ltAvgDeal)}. Early-Stage-Investments gewinnen an Gewicht, was auf Pipeline-Aufbau hindeutet.`;
  } else {
    a3h = "Dealgrößen im Marktdurchschnitt";
    a3b = `Die durchschnittliche Rundengröße von €${fmtVol(lastAvgDeal)} entspricht dem Langzeitschnitt (€${fmtVol(ltAvgDeal)}). Die Stage-Verteilung bleibt ausgewogen — kein Shift zu extrem großen oder kleinen Runden erkennbar.`;
  }

  // ── Ableitung 4: Peak-Analyse ─────────────────────────────────────────────────

  let a4h: string, a4b: string;
  if (peakYear.year === last.year) {
    a4h = "Neues Allzeithoch erreicht";
    a4b = `${last.year} markiert mit €${fmtVol(last.volume)} das höchste jemals gemessene Investitionsvolumen. Der Markt befindet sich in einer Expansionsphase — getrieben durch neue Anwendungsfelder und regulatorische Klarheit.`;
  } else {
    const pctBelowPeak = (last.volume - peakYear.volume) / peakYear.volume;
    const trend = pctBelowPeak > -0.2
      ? "eine schrittweise Annäherung an historische Höchststände"
      : "eine deutliche Normalisierung nach dem Boom";
    a4h = `Peak-Volumen lag in ${peakYear.year}`;
    a4b = `Das bisherige Hoch von €${fmtVol(peakYear.volume)} wurde ${peakYear.year} erreicht. Aktuell liegt der Markt ${fmtPct(pctBelowPeak)} darunter — ${trend}.`;
  }

  // ── Ableitung 5: CAGR-Outlook ─────────────────────────────────────────────────

  let a5h: string, a5b: string;
  if (cagr > 0.15) {
    a5h = "Langfristiger Wachstumspfad intakt";
    a5b = `Die durchschnittliche jährliche Wachstumsrate (CAGR) liegt bei ${fmtPct(cagr)} seit ${first.year}. Trotz zyklischer Schwankungen bestätigt der Trendvektor eine strukturell wachsende Kapitalallokation in den Sektor.`;
  } else if (cagr > 0) {
    a5h = "Moderates Wachstum als neue Baseline";
    a5b = `Mit einer CAGR von ${fmtPct(cagr)} seit ${first.year} wächst der Markt solide, aber nicht explosiv. Investoren sollten mit stabilen, aber nicht exponentiellen Returns rechnen — Fokus auf operative Exzellenz statt Hypergrowth.`;
  } else {
    a5h = "Strukturelle Neubewertung erkennbar";
    a5b = `Der negative Langzeittrend (CAGR ${fmtPct(cagr)}) deutet auf eine fundamentale Marktverschiebung hin. Kapital fließt selektiver — nur Unternehmen mit klarer Marktposition und Profitabilitätspfad ziehen weiterhin Funding an.`;
  }

  return {
    actionTitle,
    "ableitung1.1": a1h, "ableitung1.2": a1b,
    "ableitung2.1": a2h, "ableitung2.2": a2b,
    "ableitung3.1": a3h, "ableitung3.2": a3b,
    "ableitung4.1": a4h, "ableitung4.2": a4b,
    "ableitung5.1": a5h, "ableitung5.2": a5b,
  };
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { yearlyMetrics } = (await req.json()) as { yearlyMetrics?: YearlyMetric[] };

  if (!yearlyMetrics || yearlyMetrics.length < 2) {
    return Response.json(
      { error: "Keine ausreichenden Deal-Daten — bitte zuerst eine Deals-Datei hochladen." },
      { status: 400 }
    );
  }

  return Response.json({ ableitungen: applyRules(yearlyMetrics) });
}
