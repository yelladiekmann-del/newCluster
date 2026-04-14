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
import { doc, writeBatch } from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import { toast } from "sonner";
import { saveAs } from "file-saver";
import Papa from "papaparse";
import { createParser } from "eventsource-parser";

const DIM_PILLS = DIMENSIONS;

export function DimensionExtractionStep() {
  const { uid, apiKey, companies, descCol, companyCol, setCompanies, pipelineStep, setPipelineStep } =
    useSession();

  const hasDimensions =
    companies.length > 0 &&
    companies[0]?.dimensions &&
    Object.keys(companies[0].dimensions).length > 0;

  const [progress, setProgress] = useState<{ done: number; total: number; errors: number } | null>(
    null
  );
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    if (!apiKey || !uid || !descCol) return;
    setRunning(true);
    setProgress({ done: 0, total: companies.length, errors: 0 });

    const rows = companies.map((c) => ({
      name: c.name,
      description: String(c.originalData[descCol] ?? ""),
    }));

    try {
      const res = await fetch("/api/extract-dimensions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-gemini-key": apiKey,
        },
        body: JSON.stringify({ rows }),
      });

      if (!res.ok || !res.body) {
        toast.error("Extraction request failed");
        setRunning(false);
        return;
      }

      let results: Array<Record<string, string>> = [];

      const parser = createParser({
        onEvent: (event) => {
          const data = JSON.parse(event.data);
          if (data.type === "progress") {
            setProgress({ done: data.done, total: data.total, errors: data.errors });
          } else if (data.type === "done") {
            results = data.results;
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

      // Write dimensions back to companies
      if (results.length === companies.length) {
        const db = getFirebaseDb();
        const updatedCompanies = companies.map((c, i) => ({
          ...c,
          dimensions: results[i] ?? {},
        }));

        // Batch write to Firestore
        const batchSize = 400;
        for (let i = 0; i < updatedCompanies.length; i += batchSize) {
          const batch = writeBatch(db);
          for (const c of updatedCompanies.slice(i, i + batchSize)) {
            batch.update(doc(db, "sessions", uid, "companies", c.id), {
              dimensions: c.dimensions,
            });
          }
          await batch.commit();
        }

        setCompanies(updatedCompanies);
        const nextStep = Math.max(pipelineStep, 1) as 1;
        setPipelineStep(nextStep);
        await persistSession(uid, { pipelineStep: nextStep });
        toast.success("Dimensions extracted");
      }
    } catch (err) {
      toast.error(String(err));
    } finally {
      setRunning(false);
    }
  }, [apiKey, uid, descCol, companies, setCompanies, pipelineStep, setPipelineStep]);

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
        {running && progress && (
          <div className="flex flex-col gap-1">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Extracting… {progress.done}/{progress.total}</span>
              {progress.errors > 0 && (
                <span className="text-destructive">{progress.errors} errors</span>
              )}
            </div>
            <Progress value={pct} className="h-1.5" />
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 flex-wrap">
          <Button
            size="sm"
            disabled={!apiKey || running || companies.length === 0}
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

        {!apiKey && (
          <p className="text-xs text-muted-foreground">
            Add your Gemini API key above to enable dimension extraction.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
