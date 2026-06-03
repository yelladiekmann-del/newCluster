"use client";

import { useState, useCallback } from "react";
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
import type { SlidesData, DealRow, GeneratedAbleitungen } from "@/lib/slides/types";
import type { ClusterMetricsRow, AnalyticsColMap } from "@/types";

interface GenerateSlidesPanelProps {
  open: boolean;
  onClose: () => void;
  uid: string;
  token: string;
  analyticsRows: ClusterMetricsRow[];
  dealsData: Record<string, unknown>[] | null;
  colMap: AnalyticsColMap;
  companyCount: number;
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
    .map((row) => ({
      deal_id:    colMap.deal_id   ? String(row[colMap.deal_id]   ?? "") : "",
      company:    colMap.de_co_name ? String(row[colMap.de_co_name] ?? "") : "",
      company_id: colMap.de_co_id  ? String(row[colMap.de_co_id]  ?? "") : "",
      deal_date:  colMap.deal_date  ? String(row[colMap.deal_date]  ?? "") : "",
      deal_size:  colMap.deal_size  ? Number(row[colMap.deal_size])  || 0  : 0,
    }))
    .filter((d) => d.deal_date && d.deal_size > 0);
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

  // ── Loading states ────────────────────────────────────────────────────────────
  const [generatingAbleitungen, setGeneratingAbleitungen] = useState(false);
  const [generatingSlides,      setGeneratingSlides]      = useState(false);
  const [resultUrl,             setResultUrl]             = useState<string | null>(null);

  // ── Generate Ableitungen + Action Title via Gemini ────────────────────────────
  const handleGenerateAbleitungen = useCallback(async () => {
    setGeneratingAbleitungen(true);
    try {
      const res = await fetch("/api/generate-ableitungen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid, analyticsRows }),
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
  }, [uid, analyticsRows]);

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

    const dealRows = dealsData ? mapDealRows(dealsData, colMap) : [];
    const { actionTitle, ...ableitungenFields } = ableitungen;

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
    };

    setGeneratingSlides(true);
    try {
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
  }, [token, clientCompany, title, documentType, chapter, slideTitle1, sectionTitle1, sectionTitle2, project, ableitungen, kpis, dealsData, colMap]);

  const updateAbleitung = (key: keyof GeneratedAbleitungen, value: string) => {
    setAbleitungen((prev) => ({ ...prev, [key]: value }));
  };

  const hasContent = ableitungen["ableitung1.1"] !== "" || ableitungen.actionTitle !== "";

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent
          className="max-h-[92vh] overflow-y-auto p-0"
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
                    className="rounded-xl border border-border/60 bg-muted/20 p-3.5 space-y-2"
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
          <DialogFooter className="border-t border-border/60 px-8 py-4">
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
              {generatingSlides ? "Wird erstellt…" : "Slides erstellen"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
