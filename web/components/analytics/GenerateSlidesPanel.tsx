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
  /** Pre-computed analytics metrics (used to fill KPI fields). */
  analyticsRows: ClusterMetricsRow[];
  /** Raw deal rows from the uploaded deals file. */
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
    invest_volume:   formatGerman(totalInvested / 1e3),  // k€ → Mrd. €
    deals:           totalDeals.toLocaleString("de-DE"),
    companies:       companyCount.toLocaleString("de-DE"),
    average_funding: formatGerman(avgFunding),            // already in Mio. €
  };
}

function mapDealRows(
  dealsData: Record<string, unknown>[],
  colMap: AnalyticsColMap
): DealRow[] {
  const idCol      = colMap.deal_id;
  const nameCol    = colMap.de_co_name;
  const coIdCol    = colMap.de_co_id;
  const dateCol    = colMap.deal_date;
  const sizeCol    = colMap.deal_size;

  return dealsData
    .map((row) => ({
      deal_id:    idCol    ? String(row[idCol]    ?? "") : "",
      company:    nameCol  ? String(row[nameCol]  ?? "") : "",
      company_id: coIdCol  ? String(row[coIdCol]  ?? "") : "",
      deal_date:  dateCol  ? String(row[dateCol]  ?? "") : "",
      deal_size:  sizeCol  ? Number(row[sizeCol])  || 0  : 0,
    }))
    .filter((d) => d.deal_date && d.deal_size > 0);
}

const EMPTY_ABLEITUNGEN: GeneratedAbleitungen = {
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
  const [title,          setTitle]          = useState("Outside-In-Analyse und konkrete Handlungsoptionen");
  const [clientCompany,  setClientCompany]  = useState("");
  const [documentType,   setDocumentType]   = useState("Projektangebot (LoP)");
  const [chapter,        setChapter]        = useState("UNSER ANSATZ");
  const [slideTitle1,    setSlideTitle1]    = useState("ANALYSE DES WAGNISKAPITAL-ÖKOSYSTEMS");
  const [actionTitle1,   setActionTitle1]   = useState("");
  const [sectionTitle1,  setSectionTitle1]  = useState("Investiertes Wagniskapital und Anzahl der Fundings");
  const [sectionTitle2,  setSectionTitle2]  = useState("Ableitungen aus der aktuellen Marktlage");
  const [project,        setProject]        = useState("");

  const [ableitungen, setAbleitungen] = useState<GeneratedAbleitungen>(EMPTY_ABLEITUNGEN);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // ── Loading states ────────────────────────────────────────────────────────────
  const [generatingAbleitungen, setGeneratingAbleitungen] = useState(false);
  const [generatingSlides,      setGeneratingSlides]      = useState(false);
  const [resultUrl,             setResultUrl]             = useState<string | null>(null);

  // ── Generate Ableitungen via Gemini ───────────────────────────────────────────
  const handleGenerateAbleitungen = useCallback(async () => {
    setGeneratingAbleitungen(true);
    try {
      const res = await fetch("/api/generate-ableitungen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid }),
      });
      const json = await res.json() as { ableitungen?: GeneratedAbleitungen; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? "Unknown error");
      setAbleitungen(json.ableitungen!);
      toast.success("5 Ableitungen generiert — bitte prüfen und ggf. anpassen.");
    } catch (err) {
      toast.error(`Fehler: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGeneratingAbleitungen(false);
    }
  }, [uid]);

  // ── Generate Slides ──────────────────────────────────────────────────────────
  const handleGenerateSlides = useCallback(async () => {
    if (!clientCompany.trim()) {
      toast.error("Kundenname (client_company) ist erforderlich.");
      return;
    }
    if (!token) {
      toast.error("Kein Google OAuth Token — bitte neu einloggen.");
      return;
    }

    const dealRows = dealsData ? mapDealRows(dealsData, colMap) : [];

    const data: SlidesData = {
      title,
      client_company: clientCompany,
      document_type:  documentType,
      chapter,
      slide_title1:   slideTitle1,
      action_title_1: actionTitle1,
      section_title1_1: sectionTitle1,
      section_title1_2: sectionTitle2,
      invest_volume:   kpis.invest_volume,
      deals:           kpis.deals,
      companies:       kpis.companies,
      average_funding: kpis.average_funding,
      project,
      dealRows,
      ...ableitungen,
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
      toast.success("Slides erstellt!");
    } catch (err) {
      toast.error(`Fehler: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGeneratingSlides(false);
    }
  }, [token, clientCompany, title, documentType, chapter, slideTitle1, actionTitle1, sectionTitle1, sectionTitle2, project, ableitungen, kpis, dealsData, colMap]);

  const updateAbleitung = (key: keyof GeneratedAbleitungen, value: string) => {
    setAbleitungen((prev) => ({ ...prev, [key]: value }));
  };

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Presentation className="h-5 w-5" />
            Slides generieren
          </DialogTitle>
          <DialogDescription>
            Erstellt eine befüllte Google Slides Präsentation aus deiner Clustering-Analyse.
          </DialogDescription>
        </DialogHeader>

        {resultUrl ? (
          // ── Success state ────────────────────────────────────────────────────
          <div className="flex flex-col items-center gap-4 py-8 text-center">
            <div className="rounded-full bg-foreground/5 p-4">
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
          // ── Form ─────────────────────────────────────────────────────────────
          <div className="space-y-5">
            {/* KPI Preview */}
            <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
              <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Automatisch befüllt aus Analytics
              </p>
              <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                {[
                  { label: "Invest-Volumen", value: `${kpis.invest_volume} Mrd. €` },
                  { label: "Deals",          value: kpis.deals },
                  { label: "Start-ups",      value: kpis.companies },
                  { label: "Ø Funding",      value: `${kpis.average_funding} Mio. €` },
                ].map(({ label, value }) => (
                  <div key={label} className="rounded-lg border border-border/50 bg-background px-3 py-2">
                    <div className="text-[10px] text-muted-foreground">{label}</div>
                    <div className="font-semibold">{value}</div>
                  </div>
                ))}
              </div>
              {!dealsData && (
                <p className="mt-2 text-xs text-muted-foreground">
                  ⚠ Keine Deal-Daten geladen — Chart bleibt leer.
                </p>
              )}
            </div>

            {/* Pflichtfelder */}
            <div className="space-y-3">
              <div>
                <Label htmlFor="client_company">Kundenname *</Label>
                <Input
                  id="client_company"
                  value={clientCompany}
                  onChange={(e) => setClientCompany(e.target.value)}
                  placeholder="z.B. Musterfirma GmbH"
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="action_title_1">Action Title (Kernaussage)</Label>
                <Input
                  id="action_title_1"
                  value={actionTitle1}
                  onChange={(e) => setActionTitle1(e.target.value)}
                  placeholder="z.B. Markt zeigt klare Aufwärtstendenz"
                  className="mt-1"
                />
              </div>
            </div>

            {/* Ableitungen */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>5 Ableitungen</Label>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleGenerateAbleitungen}
                  disabled={generatingAbleitungen}
                  className="gap-2"
                >
                  {generatingAbleitungen ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  {generatingAbleitungen ? "Generiere…" : "Mit KI generieren"}
                </Button>
              </div>
              <div className="space-y-3">
                {([1, 2, 3, 4, 5] as const).map((n) => (
                  <div key={n} className="rounded-xl border border-border/60 bg-muted/20 p-3 space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Ableitung {n}</p>
                    <Input
                      value={ableitungen[`ableitung${n}.1` as keyof GeneratedAbleitungen]}
                      onChange={(e) => updateAbleitung(`ableitung${n}.1` as keyof GeneratedAbleitungen, e.target.value)}
                      placeholder={`Ableitung ${n} — Headline`}
                    />
                    <Textarea
                      value={ableitungen[`ableitung${n}.2` as keyof GeneratedAbleitungen]}
                      onChange={(e) => updateAbleitung(`ableitung${n}.2` as keyof GeneratedAbleitungen, e.target.value)}
                      placeholder={`Ableitung ${n} — Fließtext`}
                      rows={2}
                      className="resize-none"
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Optionale Felder (collapsed) */}
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
                <div className="mt-3 space-y-3">
                  {[
                    { id: "title",        label: "Titel",           value: title,         set: setTitle },
                    { id: "document_type",label: "Dokumententyp",   value: documentType,  set: setDocumentType },
                    { id: "chapter",      label: "Kapitel",         value: chapter,       set: setChapter },
                    { id: "slide_title1", label: "Folientitel",     value: slideTitle1,   set: setSlideTitle1 },
                    { id: "section1_1",   label: "Abschnittstitel Chart", value: sectionTitle1, set: setSectionTitle1 },
                    { id: "section1_2",   label: "Abschnittstitel Ableitungen", value: sectionTitle2, set: setSectionTitle2 },
                    { id: "project",      label: "Projektcode",     value: project,       set: setProject },
                  ].map(({ id, label, value, set }) => (
                    <div key={id}>
                      <Label htmlFor={id}>{label}</Label>
                      <Input
                        id={id}
                        value={value}
                        onChange={(e) => set(e.target.value)}
                        className="mt-1"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {!resultUrl && (
          <DialogFooter>
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
              {generatingSlides ? "Slides werden erstellt…" : "Slides erstellen"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
