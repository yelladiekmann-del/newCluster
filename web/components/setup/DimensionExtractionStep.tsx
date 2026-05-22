"use client";

import { useState, useCallback } from "react";
import { Sparkles, CheckCircle2, Loader2, Download } from "lucide-react";
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

  const [progress, setProgress] = useState<{ done: number; total: number; errors: number } | null>(
    null
  );
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);

  const run = useCallback(async () => {
    if (!uid || !descCol) return;
    setRunning(true);
    setSaving(false);
    setProgress({ done: 0, total: companies.length, errors: 0 });

    const rows = companies.map((c) => ({
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

      // Results are accumulated incrementally from progress.entries — each SSE
      // progress event carries the batch results it just finished. This means we
      // never depend on a single large `done` payload that could be lost if the
      // stream is truncated (was the root cause of Regenerate appearing to hang).
      const receivedDims = new Map<number, Record<string, string>>();
      let finalDone = 0;

      const parser = createParser({
        onEvent: (event) => {
          const data = JSON.parse(event.data);
          if (data.type === "progress") {
            finalDone = data.done;
            setProgress({ done: data.done, total: data.total, errors: data.errors });
            // Accumulate batch results as they arrive
            if (Array.isArray(data.entries)) {
              for (const { index, dims } of data.entries) {
                receivedDims.set(index, dims ?? {});
              }
            }
          } else if (data.type === "error") {
            toast.error(`Extraction error: ${data.message}`);
          }
          // `done` event is now a bare completion signal — no payload needed
        },
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }

      // Validate we received results for all companies
      const receivedCount = receivedDims.size;
      if (receivedCount === 0) {
        toast.error("No results received — extraction may have timed out. Please try again.");
        return;
      }
      if (receivedCount < companies.length) {
        toast.warning(
          `Partial extraction: received ${receivedCount}/${companies.length} companies. Results saved for completed rows.`
        );
      }

      // Save — show a separate "Saving…" status so users don't think the spinner
      // is frozen during the Firestore batch write (can be 5–10 s for large datasets)
      setSaving(true);
      const updatedCompanies = companies.map((c, i) => ({
        ...c,
        dimensions: receivedDims.get(i) ?? c.dimensions,
      }));

      await saveChangedCompaniesToFirestore(
        uid,
        updatedCompanies,
        // Only write companies that actually got new results
        new Set([...receivedDims.keys()].map((i) => updatedCompanies[i]?.id).filter(Boolean) as string[])
      );

      setCompanies(updatedCompanies);
      const nextStep = Math.max(pipelineStep, 1) as 1;
      setPipelineStep(nextStep);
      await persistSession(uid, { pipelineStep: nextStep });
      toast.success(
        receivedCount === companies.length
          ? "Dimensions extracted"
          : `Dimensions extracted for ${receivedCount} companies`
      );
    } catch (err) {
      toast.error(String(err));
    } finally {
      setRunning(false);
      setSaving(false);
    }
  }, [uid, descCol, companies, setCompanies, pipelineStep, setPipelineStep]);

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
        <div className="flex items-center justify-between">
          <Label className="text-sm font-semibold">3. AI Dimensions</Label>
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
                <span>Extracting… {progress.done}/{progress.total}</span>
              ) : (
                <span>Starting…</span>
              )}
              {progress && progress.errors > 0 && (
                <span className="text-destructive">{progress.errors} errors</span>
              )}
            </div>
            <Progress value={saving ? 100 : pct} className="h-1.5" />
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 flex-wrap">
          <Button
            size="sm"
            disabled={running || companies.length === 0}
            onClick={run}
            className="gap-1.5"
          >
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {hasDimensions ? "Regenerate" : "Generate dimensions"}
          </Button>

          {hasDimensions && (
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
