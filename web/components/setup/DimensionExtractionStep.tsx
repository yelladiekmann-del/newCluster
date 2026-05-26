"use client";

import { useState, useCallback } from "react";
import { Sparkles, CheckCircle2, Loader2, Download, ChevronDown, ChevronUp, AlertTriangle, RefreshCw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useSession } from "@/lib/store/session";
import { persistSession } from "@/lib/firebase/hooks";
import { DIMENSIONS } from "@/types";
import { saveChangedCompaniesToFirestore } from "@/lib/firebase/companies-storage";
import { toast } from "sonner";
import { saveAs } from "file-saver";
import Papa from "papaparse";
import { createParser } from "eventsource-parser";

const DIM_PILLS = DIMENSIONS;

export function DimensionExtractionStep() {
  const { uid, companies, descCol, companyCol, setCompanies, pipelineStep, setPipelineStep } =
    useSession();

  const hasDimensions =
    companies.length > 0 &&
    companies[0]?.dimensions &&
    Object.keys(companies[0].dimensions).length > 0;

  const [progress, setProgress] = useState<{ done: number; total: number; errors: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failedListOpen, setFailedListOpen] = useState(false);

  // Companies that still have zero dimensions — shown after a run so the user
  // can review them before deciding to retry.
  const failedCompanies = companies.filter(
    (c) => Object.keys(c.dimensions ?? {}).length === 0
  );

  // ── Core extraction function ────────────────────────────────────────────────
  // `retryFailedOnly`: if true, only sends companies with 0 dims (targeted retry).
  //                    if false, sends all companies (first run or full regenerate).
  const runExtraction = useCallback(async (retryFailedOnly: boolean) => {
    if (!uid || !descCol) return;
    setRunning(true);
    setSaving(false);
    setFailedListOpen(false);

    const toExtract = retryFailedOnly
      ? companies
          .map((c, originalIndex) => ({ c, originalIndex }))
          .filter(({ c }) => Object.keys(c.dimensions ?? {}).length === 0)
      : companies.map((c, originalIndex) => ({ c, originalIndex }));

    if (toExtract.length === 0) {
      toast.success("All companies already have dimensions — nothing to retry.");
      setRunning(false);
      return;
    }

    setProgress({ done: 0, total: toExtract.length, errors: 0 });

    const rows = toExtract.map(({ c }) => ({
      name: c.name,
      description: String(c.originalData[descCol] ?? ""),
    }));

    try {
      const res = await fetch("/api/extract-dimensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });

      if (!res.ok || !res.body) {
        toast.error("Extraction request failed");
        return;
      }

      // Results arrive incrementally via progress.entries.
      // Key: ORIGINAL company index (remapped from API's 0-based index).
      const receivedDims = new Map<number, Record<string, string>>();

      const parser = createParser({
        onEvent: (event) => {
          const data = JSON.parse(event.data);
          if (data.type === "progress") {
            setProgress({ done: data.done, total: data.total, errors: data.errors });
            if (Array.isArray(data.entries)) {
              for (const { index, dims } of data.entries) {
                const originalIndex = toExtract[index]?.originalIndex;
                if (originalIndex !== undefined) {
                  receivedDims.set(originalIndex, dims ?? {});
                }
              }
            }
          } else if (data.type === "error") {
            toast.error(`Extraction error: ${data.message}`);
          }
        },
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }

      if (receivedDims.size === 0) {
        toast.error("No results received — extraction may have timed out. Please try again.");
        return;
      }

      setSaving(true);
      const updatedCompanies = companies.map((c, i) => ({
        ...c,
        dimensions: receivedDims.has(i) ? receivedDims.get(i)! : c.dimensions,
      }));

      await saveChangedCompaniesToFirestore(
        uid,
        updatedCompanies,
        new Set([...receivedDims.keys()].map((i) => updatedCompanies[i]?.id).filter(Boolean) as string[])
      );

      setCompanies(updatedCompanies);
      const nextStep = Math.max(pipelineStep, 1) as 1;
      setPipelineStep(nextStep);
      await persistSession(uid, { pipelineStep: nextStep });

      const stillFailed = updatedCompanies.filter(
        (c) => Object.keys(c.dimensions ?? {}).length === 0
      );

      if (stillFailed.length > 0) {
        setFailedListOpen(true); // auto-open the failed list after a run
        toast.warning(`${stillFailed.length} companies could not be extracted — see list below.`);
      } else {
        toast.success(retryFailedOnly ? "All failed companies extracted successfully." : "Dimensions extracted.");
      }
    } catch (err) {
      toast.error(String(err));
    } finally {
      setRunning(false);
      setSaving(false);
    }
  }, [uid, descCol, companies, setCompanies, pipelineStep, setPipelineStep]);

  const handleGenerate  = useCallback(() => runExtraction(false), [runExtraction]);
  const handleRetryFailed = useCallback(() => runExtraction(true),  [runExtraction]);

  const downloadEnriched = useCallback(() => {
    const rows = companies.map((c) => ({
      [companyCol]: c.name,
      ...c.originalData,
      ...c.dimensions,
    }));
    const csv = Papa.unparse(rows);
    saveAs(new Blob([csv], { type: "text/csv" }), "companies_enriched.csv");
  }, [companies, companyCol]);

  const pct = progress ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <Card>
      <CardContent className="pt-4 flex flex-col gap-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <Label className="text-sm font-semibold">AI Dimensions</Label>
          {hasDimensions && !running && (
            <Badge variant="secondary" className="text-xs text-primary gap-1">
              <CheckCircle2 className="h-3 w-3" />
              {DIMENSIONS.length} dimensions extracted
            </Badge>
          )}
        </div>

        {/* Dimension pills */}
        <div className="flex flex-wrap gap-1.5">
          {DIM_PILLS.map((d) => (
            <span
              key={d}
              className="px-2 py-0.5 rounded-full text-[11px] bg-muted text-muted-foreground border border-border"
            >
              {d}
            </span>
          ))}
        </div>

        {/* Progress */}
        {running && (
          <div className="flex flex-col gap-1">
            <div className="flex justify-between text-xs text-muted-foreground">
              {saving ? (
                <span className="text-primary">Saving to database…</span>
              ) : progress ? (
                <span>Extracting… {progress.done.toLocaleString()}/{progress.total.toLocaleString()}</span>
              ) : (
                <span>Starting…</span>
              )}
              {progress && progress.errors > 0 && (
                <span className="text-amber-500">{progress.errors} skipped</span>
              )}
            </div>
            <Progress value={saving ? 100 : pct} className="h-1.5" />
          </div>
        )}

        {/* Failed companies panel — shown after a run if some companies got 0 dims */}
        {!running && failedCompanies.length > 0 && hasDimensions && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 text-sm">
            <button
              type="button"
              onClick={() => setFailedListOpen((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-2 text-amber-600 hover:text-amber-700 transition-colors"
            >
              <span className="flex items-center gap-1.5 font-medium">
                <AlertTriangle className="h-3.5 w-3.5" />
                {failedCompanies.length} companies could not be extracted
              </span>
              {failedListOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>

            {failedListOpen && (
              <div className="px-3 pb-3 flex flex-col gap-2">
                <p className="text-xs text-muted-foreground">
                  These companies have no extractable description. Retrying will attempt them again — if they keep failing, the description column may be empty or unrecognisable.
                </p>
                <ul className="text-xs text-muted-foreground space-y-0.5 max-h-32 overflow-y-auto">
                  {failedCompanies.map((c) => (
                    <li key={c.id} className="truncate">· {c.name}</li>
                  ))}
                </ul>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleRetryFailed}
                  disabled={running}
                  className="mt-1 gap-1.5 self-start border-amber-500/50 text-amber-600 hover:bg-amber-500/10"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Retry failed ({failedCompanies.length})
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Main actions */}
        <div className="flex gap-2 flex-wrap">
          <Button
            size="sm"
            disabled={running || companies.length === 0}
            onClick={handleGenerate}
            className="gap-1.5"
          >
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {hasDimensions ? "Regenerate all" : "Generate dimensions"}
          </Button>

          {hasDimensions && !running && (
            <Button
              variant="outline"
              size="sm"
              onClick={downloadEnriched}
              className="gap-1.5"
            >
              <Download className="h-3.5 w-3.5" />
              Download enriched CSV
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
