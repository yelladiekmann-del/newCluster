"use client";

import { useState, useCallback, useMemo } from "react";
import {
  ExternalLink,
  Loader2,
  Presentation,
  Sparkles,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import type { SlidesData, DealRow, GeneratedAbleitungen, ClusterSlideData } from "@/lib/slides/types";
import type { YearlyMetric } from "@/app/api/generate-ableitungen/route";
import type { ClusterUspInput, ClusterUspOutput } from "@/app/api/generate-cluster-usps/route";
import type { ClusterMetricsRow, AnalyticsColMap, CompanyDoc, ClusterDoc } from "@/types";
import { safeNum, safeDate } from "@/lib/analytics/compute";
import { getFirebaseStorage } from "@/lib/firebase/client";
import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";

interface GenerateSlidesPanelProps {
  open: boolean;
  onClose: () => void;
  uid: string;
  token: string;
  analyticsRows: ClusterMetricsRow[];
  dealsData: Record<string, unknown>[] | null;
  colMap: AnalyticsColMap;
  companyCount: number;
  companies: CompanyDoc[];
  clusters: ClusterDoc[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatGerman(value: number, decimals = 1): string {
  return value.toFixed(decimals).replace(".", ",");
}

function computeKpis(
  rows: ClusterMetricsRow[],
  companyCount: number
): { invest_volume: string; deals: string; companies: string; average_funding: string } {
  const totalInvested = rows.reduce((s, r) => s + (r.totalInvested4yr ?? 0), 0);
  const totalDeals    = rows.reduce((s, r) => s + (r.dealCount ?? 0), 0);
  const means         = rows.map((r) => r.capitalMean).filter((v): v is number => v != null);
  const avgFunding    = means.length > 0 ? means.reduce((a, b) => a + b, 0) / means.length : 0;

  return {
    invest_volume:   formatGerman(totalInvested / 1e3),
    deals:           totalDeals.toLocaleString("de-DE"),
    companies:       companyCount.toLocaleString("de-DE"),
    average_funding: formatGerman(avgFunding),
  };
}

function mapDealRows(
  dealsData: Record<string, unknown>[],
  colMap: AnalyticsColMap
): DealRow[] {
  return dealsData
    .map((row) => {
      const rawDate  = colMap.deal_date ? row[colMap.deal_date] : undefined;
      const dateObj  = safeDate(rawDate);
      const dealDate = dateObj ? dateObj.toISOString().slice(0, 10) : "";
      const dealSize = colMap.deal_size ? (safeNum(row[colMap.deal_size]) ?? 0) : 0;
      return {
        deal_id:    colMap.deal_id    ? String(row[colMap.deal_id]    ?? "") : "",
        company:    colMap.de_co_name ? String(row[colMap.de_co_name] ?? "") : "",
        company_id: colMap.de_co_id   ? String(row[colMap.de_co_id]   ?? "") : "",
        deal_date:  dealDate,
        deal_size:  dealSize,
      };
    })
    .filter((d) => d.deal_date && d.deal_size > 0);
}

function computeYearlyMetrics(
  dealsData: Record<string, unknown>[],
  colMap: AnalyticsColMap
): YearlyMetric[] {
  const byYear: Record<number, { volume: number; dealCount: number }> = {};

  for (const row of dealsData) {
    const rawDate = colMap.deal_date ? row[colMap.deal_date] : undefined;
    const dateObj = safeDate(rawDate);
    if (!dateObj) continue;

    const size = colMap.deal_size ? (safeNum(row[colMap.deal_size]) ?? 0) : 0;
    if (size <= 0) continue;

    const year = dateObj.getFullYear();
    if (year < 2000 || year > 2035) continue;

    byYear[year] ??= { volume: 0, dealCount: 0 };
    byYear[year].volume    += size;
    byYear[year].dealCount += 1;
  }

  return Object.entries(byYear)
    .map(([y, d]) => ({ year: parseInt(y, 10), volume: d.volume, dealCount: d.dealCount }))
    .sort((a, b) => a.year - b.year);
}

// ── Cluster-Slide helpers ─────────────────────────────────────────────────────

/** Auto-detect an HQ / country column from the company CSV header.
 *  Matches common names (exact or compound), e.g. "Country", "HQ Country",
 *  "country_hq", "headquarters", "Domicile", "Geography". */
function detectHqCol(cols: string[]): string | undefined {
  // Tier 1: prefer columns whose full name is exactly one of the keywords
  const exact = cols.find((c) => /^(country|hq|headquarters?|location|domicile|land|geography|region)$/i.test(c));
  if (exact) return exact;
  // Tier 2: column contains a keyword (handles "HQ Country", "country_name", etc.)
  return cols.find((c) => /\b(country|hq|headquarter|domicile|geography)\b/i.test(c));
}

/** Auto-detect a free-text description column from the company CSV header. */
function detectDescriptionCol(cols: string[]): string | undefined {
  return cols.find((c) =>
    /description|about|overview|pitch|summary|profile|business.desc|short.desc/i.test(c)
  );
}

/** Format a money value the same way AnalyticsTable does. */
function fmtMoney(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/** Pick the most representative company for a cluster (highest total_raised). */
function pickRepresentative(
  clusterId: string,
  companies: CompanyDoc[],
  colMap: AnalyticsColMap
): CompanyDoc | null {
  const members = companies.filter((c) => c.clusterId === clusterId);
  if (!members.length) return null;
  return [...members].sort((a, b) => {
    const ra = colMap.total_raised ? (safeNum(a.originalData[colMap.total_raised]) ?? 0) : 0;
    const rb = colMap.total_raised ? (safeNum(b.originalData[colMap.total_raised]) ?? 0) : 0;
    return rb - ra;
  })[0];
}

/**
 * Export the UMAP scatter as PNG via Plotly, upload to Firebase Storage,
 * and return the public download URL.
 */
async function exportScatterPng(
  companies: CompanyDoc[],
  clusters: ClusterDoc[],
  uid: string
): Promise<string | null> {
  if (!companies.some((c) => c.umapX != null)) return null;

  const Plotly = (await import("plotly.js-dist-min")).default;

  // Build one trace per cluster
  const clusterMap = new Map(clusters.map((c) => [c.id, c]));
  const tracesByCluster: Record<string, { x: number[]; y: number[]; name: string; color: string }> = {};

  for (const co of companies) {
    if (co.umapX == null || co.umapY == null || !co.clusterId || co.clusterId === "outliers") continue;
    const cl = clusterMap.get(co.clusterId);
    if (!cl) continue;
    if (!tracesByCluster[co.clusterId]) {
      tracesByCluster[co.clusterId] = { x: [], y: [], name: cl.name, color: cl.color };
    }
    tracesByCluster[co.clusterId].x.push(co.umapX);
    tracesByCluster[co.clusterId].y.push(co.umapY);
  }

  const data = Object.values(tracesByCluster).map((t) => ({
    type: "scatter" as const,
    mode: "markers" as const,
    name: t.name,
    x: t.x,
    y: t.y,
    marker: { size: 7, color: t.color, opacity: 0.75 },
  }));

  const layout = {
    paper_bgcolor: "#ffffff",
    plot_bgcolor: "#ffffff",
    showlegend: true,
    legend: { x: 1, xanchor: "right" as const, y: 1, font: { size: 10 } },
    margin: { l: 30, r: 160, t: 20, b: 30 },
    xaxis: { showgrid: false, zeroline: false, showticklabels: false },
    yaxis: { showgrid: false, zeroline: false, showticklabels: false },
  };

  // Render into a temporary hidden div
  const div = document.createElement("div");
  div.style.cssText = "position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;";
  document.body.appendChild(div);

  try {
    await Plotly.newPlot(div, data, layout, { staticPlot: true, responsive: false });
    const dataUrl = await Plotly.toImage(div, { format: "png", width: 1600, height: 900, scale: 2 });

    // Convert data URL to blob
    const res = await fetch(dataUrl);
    const blob = await res.blob();

    // Upload to Firebase Storage
    const path = `sessions/${uid}/scatter-export.png`;
    const imgRef = storageRef(getFirebaseStorage(), path);
    await uploadBytes(imgRef, blob, { contentType: "image/png" });
    return await getDownloadURL(imgRef);
  } finally {
    Plotly.purge(div);
    document.body.removeChild(div);
  }
}

const EMPTY_ABLEITUNGEN: GeneratedAbleitungen = {
  actionTitle:   "",
  "ableitung1.1": "", "ableitung1.2": "",
  "ableitung2.1": "", "ableitung2.2": "",
  "ableitung3.1": "", "ableitung3.2": "",
  "ableitung4.1": "", "ableitung4.2": "",
  "ableitung5.1": "", "ableitung5.2": "",
};

// ── Component ─────────────────────────────────────────────────────────────────

export function GenerateSlidesPanel({
  open,
  onClose,
  uid,
  token,
  analyticsRows,
  dealsData,
  colMap,
  companyCount,
  companies,
  clusters,
}: GenerateSlidesPanelProps) {
  const kpis = computeKpis(analyticsRows, companyCount);

  // ── Form state ───────────────────────────────────────────────────────────────
  const [clientCompany,  setClientCompany]  = useState("");
  const [title,          setTitle]          = useState("Outside-In-Analyse und konkrete Handlungsoptionen");
  const [documentType,   setDocumentType]   = useState("Projektangebot (LoP)");
  const [chapter,        setChapter]        = useState("UNSER ANSATZ");
  const [slideTitle1,    setSlideTitle1]    = useState("ANALYSE DES WAGNISKAPITAL-ÖKOSYSTEMS");
  const [sectionTitle1,  setSectionTitle1]  = useState("Investiertes Wagniskapital und Anzahl der Fundings");
  const [sectionTitle2,  setSectionTitle2]  = useState("Ableitungen aus der aktuellen Marktlage");
  const [project,        setProject]        = useState("");

  const [ableitungen, setAbleitungen] = useState<GeneratedAbleitungen>(EMPTY_ABLEITUNGEN);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // ── Cluster slides state ──────────────────────────────────────────────────────
  const [sowhat, setSowhat]         = useState<[string, string, string]>(["", "", ""]);
  const [usps,   setUsps]           = useState<[string, string, string]>(["", "", ""]);
  const [generatingUsps, setGeneratingUsps] = useState(false);

  // ── Top-3 clusters by hyScore ─────────────────────────────────────────────────
  const top3 = useMemo(() =>
    [...analyticsRows]
      .filter((r) => !clusters.find((c) => c.id === r.clusterId)?.isOutliers)
      .sort((a, b) => (b.hyScore ?? 0) - (a.hyScore ?? 0))
      .slice(0, 3),
  [analyticsRows, clusters]);

  // ── Representative company + HQ per cluster ──────────────────────────────────
  const companyCols = useMemo(() =>
    companies.length > 0 ? Object.keys(companies[0].originalData ?? {}) : [],
  [companies]);
  const hqCol  = useMemo(() => detectHqCol(companyCols),          [companyCols]);
  const descCol = useMemo(() => detectDescriptionCol(companyCols), [companyCols]);

  const clusterSlideData: ClusterSlideData[] = useMemo(() => {
    return top3.map((row, i) => {
      const rep = pickRepresentative(row.clusterId, companies, colMap);
      const hq = (hqCol && rep ? String(rep.originalData[hqCol] ?? "") : "") || "—";
      const funding = rep && colMap.total_raised
        ? fmtMoney(safeNum(rep.originalData[colMap.total_raised]))
        : "—";
      return {
        num:         String(i + 1),
        name:        row.clusterName,
        hq,
        funding,
        description: usps[i] || "",   // AI-generated USP fills {{description_n}}
        sowhat:      sowhat[i],
      };
    });
  }, [top3, companies, colMap, hqCol, usps, sowhat]);

  // ── Loading states ────────────────────────────────────────────────────────────
  const [generatingAbleitungen, setGeneratingAbleitungen] = useState(false);
  const [generatingSlides,      setGeneratingSlides]      = useState(false);
  const [slidesStep,            setSlidesStep]            = useState<string>("Wird erstellt…");
  const [resultUrl,             setResultUrl]             = useState<string | null>(null);

  const hasUmapData = useMemo(() => companies.some((c) => c.umapX != null), [companies]);

  // ── Generate Ableitungen + Action Title via Gemini ────────────────────────────
  const handleGenerateAbleitungen = useCallback(async () => {
    if (!dealsData) {
      toast.error("Keine Deal-Daten geladen — bitte zuerst eine Deals-Datei hochladen.");
      return;
    }
    setGeneratingAbleitungen(true);
    try {
      const yearlyMetrics = computeYearlyMetrics(dealsData, colMap);
      const res = await fetch("/api/generate-ableitungen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yearlyMetrics }),
      });
      const json = await res.json() as { ableitungen?: GeneratedAbleitungen; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? "Unknown error");
      setAbleitungen(json.ableitungen!);
      toast.success("Action Title + 5 Ableitungen generiert — bitte prüfen.");
    } catch (err) {
      toast.error(`Fehler: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGeneratingAbleitungen(false);
    }
  }, [dealsData, colMap]);

  // ── Generate Cluster USPs ────────────────────────────────────────────────────
  const handleGenerateUsps = useCallback(async () => {
    if (top3.length === 0) return;
    setGeneratingUsps(true);
    try {
      const payload: ClusterUspInput[] = top3.map((row) => {
        const rep     = pickRepresentative(row.clusterId, companies, colMap);
        const rawDesc = descCol && rep ? String(rep.originalData[descCol] ?? "") : "";
        const funding = rep && colMap.total_raised
          ? fmtMoney(safeNum(rep.originalData[colMap.total_raised]))
          : "—";
        return {
          clusterId:          row.clusterId,
          clusterName:        row.clusterName,
          companyName:        rep?.name ?? row.clusterName,
          companyDescription: rawDesc,
          companyFunding:     funding,
        };
      });

      const res = await fetch("/api/generate-cluster-usps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clusters: payload }),
      });
      const json = await res.json() as ClusterUspOutput & { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? "Unknown error");

      const newUsps:   [string, string, string] = ["", "", ""];
      const newSowhat: [string, string, string] = ["", "", ""];
      top3.forEach((row, i) => {
        newUsps[i]   = json.usps[row.clusterId]   ?? "";
        newSowhat[i] = json.sowhat?.[row.clusterId] ?? "";
      });
      setUsps(newUsps);
      setSowhat(newSowhat);
      toast.success("USPs + So-What generiert — bitte prüfen.");
    } catch (err) {
      toast.error(`Fehler: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGeneratingUsps(false);
    }
  }, [top3, companies, colMap, descCol]);

  // ── Generate Slides ──────────────────────────────────────────────────────────
  const handleGenerateSlides = useCallback(async () => {
    if (!clientCompany.trim()) {
      toast.error("Kundenname ist erforderlich.");
      return;
    }
    if (!token) {
      toast.error("Kein Google OAuth Token — bitte neu einloggen.");
      return;
    }

    setGeneratingSlides(true);
    setSlidesStep("Wird erstellt…");
    try {
      const dealRows = dealsData ? mapDealRows(dealsData, colMap) : [];
      const { actionTitle, ...ableitungenFields } = ableitungen;

      // ── Scatter PNG export (non-blocking: failure just skips the extra slide) ──
      let umapImageUrl: string | undefined;
      if (!hasUmapData) {
        toast.info("Kein UMAP-Scatter — Clustering muss zuerst ausgeführt werden.", { duration: 4000 });
      } else {
        setSlidesStep("Scatter-Chart exportieren…");
        try {
          umapImageUrl = (await exportScatterPng(companies, clusters, uid)) ?? undefined;
          if (!umapImageUrl) toast.warning("Scatter-Export: kein Ergebnis — Folie wird ohne Chart erstellt.");
        } catch (scatterErr) {
          toast.warning(`Scatter-Export fehlgeschlagen: ${scatterErr instanceof Error ? scatterErr.message : String(scatterErr)}`);
        }
        setSlidesStep("Präsentation erstellen…");
      }

      const data: SlidesData = {
        title,
        client_company:    clientCompany,
        document_type:     documentType,
        chapter,
        slide_title1:      slideTitle1,
        action_title_1:    actionTitle,
        section_title1_1:  sectionTitle1,
        section_title1_2:  sectionTitle2,
        invest_volume:     kpis.invest_volume,
        deals:             kpis.deals,
        companies:         kpis.companies,
        average_funding:   kpis.average_funding,
        project,
        dealRows,
        ...ableitungenFields,
        clusterSlides:  clusterSlideData.length > 0 ? clusterSlideData : undefined,
        umapImageUrl,
      };

      const res = await fetch("/api/generate-slides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, data }),
      });
      const json = await res.json() as { url?: string; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? "Unknown error");
      setResultUrl(json.url!);
      toast.success("Präsentation erstellt!");
    } catch (err) {
      toast.error(`Fehler: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGeneratingSlides(false);
    }
  }, [token, clientCompany, title, documentType, chapter, slideTitle1, sectionTitle1, sectionTitle2, project, ableitungen, kpis, dealsData, colMap, clusterSlideData]);

  const updateAbleitung = (key: keyof GeneratedAbleitungen, value: string) => {
    setAbleitungen((prev) => ({ ...prev, [key]: value }));
  };

  const hasContent = ableitungen["ableitung1.1"] !== "" || ableitungen.actionTitle !== "";

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent
          className="max-h-[92vh] overflow-y-auto gap-0 p-0 sm:max-w-none"
          style={{ width: "min(95vw, 64rem)" }}
        >

        {/* ── Header ── */}
        <DialogHeader className="border-b border-border/60 px-8 py-5">
          <DialogTitle className="flex items-center gap-2.5 text-base">
            <Presentation className="h-4 w-4 shrink-0" />
            Slides generieren
          </DialogTitle>
          <DialogDescription className="text-xs">
            Erstellt eine befüllte Google Slides Präsentation aus deiner Clustering-Analyse.
          </DialogDescription>
        </DialogHeader>

        {resultUrl ? (
          // ── Success state ──────────────────────────────────────────────────
          <div className="flex flex-col items-center gap-4 px-8 py-16 text-center">
            <div className="rounded-full bg-foreground/5 p-5">
              <Presentation className="h-8 w-8 text-foreground" />
            </div>
            <div>
              <p className="font-medium">Präsentation fertig!</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Die Datei liegt jetzt in deinem Google Drive.
              </p>
            </div>
            <a
              href={resultUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ size: "sm", className: "gap-2" })}
            >
              <ExternalLink className="h-4 w-4" />
              Slides öffnen
            </a>
            <Button variant="ghost" size="sm" onClick={() => setResultUrl(null)}>
              Neue Präsentation erstellen
            </Button>
          </div>
        ) : (
          <div className="px-8 py-6 space-y-7">

            {/* ── Row 1: Kundenname + KPI strip ────────────────────────────── */}
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              {/* Kundenname */}
              <div className="space-y-1.5">
                <Label htmlFor="client_company" className="text-xs font-medium">
                  Kundenname <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="client_company"
                  value={clientCompany}
                  onChange={(e) => setClientCompany(e.target.value)}
                  placeholder="z.B. Musterfirma GmbH"
                />
              </div>

              {/* KPI strip */}
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Analytics-Kennzahlen
                </p>
                <div className="grid grid-cols-4 gap-1.5">
                  {[
                    { label: "Invest",   value: `${kpis.invest_volume} Mrd. €` },
                    { label: "Deals",    value: kpis.deals },
                    { label: "Start-ups", value: kpis.companies },
                    { label: "Ø Fund.",  value: `${kpis.average_funding} Mio.` },
                  ].map(({ label, value }) => (
                    <div
                      key={label}
                      className="rounded-lg border border-border/50 bg-muted/30 px-2.5 py-2 text-center"
                    >
                      <div className="text-[9px] text-muted-foreground leading-tight">{label}</div>
                      <div className="text-xs font-semibold leading-snug mt-0.5">{value}</div>
                    </div>
                  ))}
                </div>
                {!dealsData && (
                  <p className="text-[11px] text-muted-foreground">
                    ⚠ Keine Deal-Daten geladen — Chart bleibt leer.
                  </p>
                )}
              </div>
            </div>

            {/* ── KI-Generierung ───────────────────────────────────────────── */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Action Title &amp; Ableitungen</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Wird aus Cluster-Beschreibungen und Analytics-Kennzahlen generiert.
                  </p>
                </div>
                <Button
                  variant={hasContent ? "outline" : "default"}
                  size="sm"
                  onClick={handleGenerateAbleitungen}
                  disabled={generatingAbleitungen}
                  className="gap-2 shrink-0"
                >
                  {generatingAbleitungen ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  {generatingAbleitungen
                    ? "Generiere…"
                    : hasContent
                    ? "Neu generieren"
                    : "Mit KI generieren"}
                </Button>
              </div>

              {/* Action Title */}
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Action Title</Label>
                <Textarea
                  value={ableitungen.actionTitle}
                  onChange={(e) => updateAbleitung("actionTitle", e.target.value)}
                  placeholder="Wird automatisch aus den Ableitungen generiert …"
                  rows={2}
                  className="resize-none text-sm"
                />
              </div>

              {/* Ableitungen 2-column grid */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {([1, 2, 3, 4, 5] as const).map((n) => (
                  <div
                    key={n}
                    className={`rounded-xl border border-border/60 bg-muted/20 p-3.5 space-y-2${n === 5 ? " sm:col-span-2 lg:col-span-1" : ""}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-foreground/8 text-[10px] font-semibold text-foreground/60">
                        {n}
                      </span>
                      <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                        Ableitung
                      </span>
                    </div>
                    <Input
                      value={ableitungen[`ableitung${n}.1` as keyof GeneratedAbleitungen]}
                      onChange={(e) =>
                        updateAbleitung(`ableitung${n}.1` as keyof GeneratedAbleitungen, e.target.value)
                      }
                      placeholder="Headline"
                      className="text-sm h-8"
                    />
                    <Textarea
                      value={ableitungen[`ableitung${n}.2` as keyof GeneratedAbleitungen]}
                      onChange={(e) =>
                        updateAbleitung(`ableitung${n}.2` as keyof GeneratedAbleitungen, e.target.value)
                      }
                      placeholder="Fließtext"
                      rows={3}
                      className="resize-none text-sm"
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* ── Representative Clusters ──────────────────────────────────── */}
            {top3.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Representative Clusters</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Top 3 nach hy Score — USP + So What pro Cluster.
                    </p>
                  </div>
                  <Button
                    variant={usps[0] ? "outline" : "default"}
                    size="sm"
                    onClick={handleGenerateUsps}
                    disabled={generatingUsps || top3.length === 0}
                    className="gap-2 shrink-0"
                  >
                    {generatingUsps
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Sparkles className="h-3.5 w-3.5" />}
                    {generatingUsps ? "Generiere…" : usps[0] ? "Neu generieren" : "USPs generieren"}
                  </Button>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {clusterSlideData.map((cs, i) => (
                    <div
                      key={cs.name}
                      className="rounded-xl border border-border/60 bg-muted/20 p-3.5 space-y-2"
                    >
                      <div className="flex items-center gap-2">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-foreground/8 text-[10px] font-semibold text-foreground/60">
                          {i + 1}
                        </span>
                        <span className="text-[11px] font-semibold truncate">{cs.name}</span>
                      </div>
                      <div className="text-[11px] text-muted-foreground space-y-0.5">
                        <div><span className="text-foreground/50">HQ</span> {cs.hq}</div>
                        <div><span className="text-foreground/50">Funding</span> {cs.funding}</div>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          USP <span className="normal-case text-muted-foreground/60">→ {"{"}{"{"}{`description_${i + 1}`}{"}"}{"}"}</span>
                        </Label>
                        <Textarea
                          value={usps[i]}
                          onChange={(e) => {
                            const updated: [string, string, string] = [...usps] as [string, string, string];
                            updated[i] = e.target.value;
                            setUsps(updated);
                          }}
                          placeholder="USP generieren oder manuell eingeben…"
                          rows={3}
                          className="resize-none text-xs"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">So What</Label>
                        <Textarea
                          value={sowhat[i]}
                          onChange={(e) => {
                            const updated: [string, string, string] = [...sowhat] as [string, string, string];
                            updated[i] = e.target.value;
                            setSowhat(updated);
                          }}
                          placeholder="Strategische Empfehlung…"
                          rows={2}
                          className="resize-none text-xs"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Optionale Felder (collapsed) ─────────────────────────────── */}
            <div>
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {showAdvanced ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                Weitere Felder {showAdvanced ? "ausblenden" : "anzeigen"}
              </button>

              {showAdvanced && (
                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {[
                    { id: "title",        label: "Titel",                     value: title,         set: setTitle },
                    { id: "document_type",label: "Dokumententyp",             value: documentType,  set: setDocumentType },
                    { id: "chapter",      label: "Kapitel",                   value: chapter,       set: setChapter },
                    { id: "slide_title1", label: "Folientitel",               value: slideTitle1,   set: setSlideTitle1 },
                    { id: "section1_1",   label: "Abschnittstitel Chart",     value: sectionTitle1, set: setSectionTitle1 },
                    { id: "section1_2",   label: "Abschnittstitel Ableitungen", value: sectionTitle2, set: setSectionTitle2 },
                    { id: "project",      label: "Projektcode",               value: project,       set: setProject },
                  ].map(({ id, label, value, set }) => (
                    <div key={id} className="space-y-1.5">
                      <Label htmlFor={id} className="text-xs">{label}</Label>
                      <Input
                        id={id}
                        value={value}
                        onChange={(e) => set(e.target.value)}
                        className="text-sm"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Footer ── */}
        {!resultUrl && (
          <DialogFooter className="!mx-0 !mb-0 border-t border-border/60 px-8 py-4">
            <Button variant="ghost" onClick={onClose} disabled={generatingSlides}>
              Abbrechen
            </Button>
            <Button
              onClick={handleGenerateSlides}
              disabled={generatingSlides || !clientCompany.trim()}
              className="gap-2"
            >
              {generatingSlides ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Presentation className="h-4 w-4" />
              )}
              {generatingSlides ? slidesStep : "Slides erstellen"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
