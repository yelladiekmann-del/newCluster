"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Sparkles, Loader2, Download } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { FileUploadZone } from "@/components/ui/file-upload-zone";
import { useSession } from "@/lib/store/session";
import { persistSession } from "@/lib/firebase/hooks";
import { saveCompaniesToStorage } from "@/lib/firebase/companies-storage";
import { toast } from "sonner";
import type { CompanyDoc } from "@/types";
import { DIMENSIONS } from "@/types";
import { ref, uploadBytesResumable } from "firebase/storage";
import { getFirebaseStorage } from "@/lib/firebase/client";
import { parseTabularFile, rowsToCsv } from "@/lib/tabular-upload";
import { saveAs } from "file-saver";
import Papa from "papaparse";
import { createParser } from "eventsource-parser";

export function CompanyDataStep() {
  const {
    authUser,
    uid,
    apiKey,
    companies,
    companyCol,
    descCol,
    setCompanies,
    setCompanyCol,
    setDescCol,
    pipelineStep,
    setPipelineStep,
  } = useSession();

  const [uploadPct, setUploadPct] = useState<number | null>(null);

  // Dimension extraction state
  const [extractProgress, setExtractProgress] = useState<{ done: number; total: number; errors: number } | null>(null);
  const [extracting, setExtracting] = useState(false);
  const autoExtractTriggered = useRef(false);
  const hasActiveSession = !!uid;

  const hasDimensions =
    companies.length > 0 &&
    !!companies[0]?.dimensions &&
    Object.keys(companies[0].dimensions).length > 0;

  useEffect(() => {
    setUploadPct(null);
    setExtractProgress(null);
    setExtracting(false);
    autoExtractTriggered.current = false;
  }, [uid]);

  const runExtraction = useCallback(async (companiesSnap = companies) => {
    const currentApiKey = useSession.getState().apiKey;
    const currentDescCol = useSession.getState().descCol;
    const currentUid = useSession.getState().uid;
    if (!currentApiKey || !currentUid || !currentDescCol || companiesSnap.length === 0) return;

    setExtracting(true);
    setExtractProgress({ done: 0, total: companiesSnap.length, errors: 0 });

    const rows = companiesSnap.map((c) => ({
      name: c.name,
      description: String(c.originalData[currentDescCol] ?? ""),
    }));

    try {
      const res = await fetch("/api/extract-dimensions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-gemini-key": currentApiKey },
        body: JSON.stringify({ rows }),
      });

      if (!res.ok || !res.body) {
        toast.error("Dimension extraction failed");
        return;
      }

      let results: Array<Record<string, string>> = [];
      const parser = createParser({
        onEvent: (event) => {
          const data = JSON.parse(event.data);
          if (data.type === "progress") {
            setExtractProgress({ done: data.done, total: data.total, errors: data.errors });
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

      if (results.length === companiesSnap.length) {
        const updatedCompanies = companiesSnap.map((c, i) => ({ ...c, dimensions: results[i] ?? {} }));

        setCompanies(updatedCompanies);
        await saveCompaniesToStorage(currentUid, updatedCompanies);

        const nextStep = Math.max(pipelineStep, 1) as 1;
        setPipelineStep(nextStep);
        await persistSession(currentUid, { pipelineStep: nextStep });
        toast.success("AI dimensions extracted");
      }
    } catch (err) {
      toast.error(String(err));
    } finally {
      setExtracting(false);
      setExtractProgress(null);
    }
  }, [companies, pipelineStep, setPipelineStep, setCompanies]);

  const handleFile = useCallback(
    async (file: File) => {
      if (!uid) {
        toast.error("Select or create a session before uploading company data.");
        return;
      }

      console.info("[CompanyDataStep] file_selected", {
        uid,
        name: file.name,
        size: file.size,
      });
      try {
        const parsed = await parseTabularFile(file);
        const rows = parsed.rows;
        console.info("[CompanyDataStep] parse_completed", {
          uid,
          fileName: file.name,
          rowCount: rows.length,
          source: parsed.source,
          sheetName: parsed.sheetName,
          headerRow: parsed.headerRow,
        });
        if (!rows.length) { toast.error("File appears to be empty"); return; }

        const cols = parsed.columns;

        const nameCol =
          cols.find((c) => /^companies$/i.test(c)) ||
          cols.find((c) => /^company$/i.test(c)) ||
          cols.find((c) => /^name$/i.test(c)) ||
          cols.find((c) => /company/i.test(c)) ||
          cols[0];
        const dCol =
          cols.find((c) => /description/i.test(c)) ||
          cols.find((c) => /desc/i.test(c)) ||
          null;

        const dimCols = DIMENSIONS.filter((d) => cols.includes(d));
        const dimsAlreadyPresent = dimCols.length >= 4;

        const companyDocs: CompanyDoc[] = rows.map((row, i) => ({
          id: `r${i}`,
          rowIndex: i,
          name: String(row[nameCol] ?? ""),
          originalData: row,
          dimensions: dimsAlreadyPresent
            ? Object.fromEntries(dimCols.map((d) => [d, String(row[d] ?? "")]))
            : {},
          clusterId: null,
          umapX: null,
          umapY: null,
        }));

        setCompanyCol(nameCol);
        setDescCol(dCol);
        autoExtractTriggered.current = false;
        setCompanies(companyDocs);
        setUploadPct(0);

        const csv = rowsToCsv(rows);
        const blob = new Blob([csv], { type: "text/csv" });

        try {
          console.info("[CompanyDataStep] upload_started", { uid, fileName: file.name });
          const storage = getFirebaseStorage();
          const task = uploadBytesResumable(ref(storage, `sessions/${uid}/companies.csv`), blob);
          await new Promise<void>((resolve, reject) => {
            task.on(
              "state_changed",
              (snap) => setUploadPct(Math.round((snap.bytesTransferred / snap.totalBytes) * 100)),
              reject,
              resolve
            );
          });
          setUploadPct(null);
          await persistSession(uid, { companyCol: nameCol, descCol: dCol, pipelineStep: 0, companyCount: rows.length });
          console.info("[CompanyDataStep] upload_completed", {
            uid,
            fileName: file.name,
            rowCount: rows.length,
          });
          toast.success(`${rows.length.toLocaleString()} companies loaded`);

          if (!dimsAlreadyPresent && dCol && useSession.getState().apiKey && !autoExtractTriggered.current) {
            autoExtractTriggered.current = true;
            runExtraction(companyDocs);
          }
        } catch (err) {
          console.error("[CompanyDataStep] upload_failed", {
            uid,
            fileName: file.name,
            message: err instanceof Error ? err.message : String(err),
          });
          toast.error("Save failed — " + (err instanceof Error ? err.message : String(err)));
          setUploadPct(null);
        }
      } catch (err) {
        console.error("[CompanyDataStep] parse_failed", {
          uid,
          fileName: file.name,
          message: err instanceof Error ? err.message : String(err),
        });
        toast.error(`Parse error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [uid, setCompanies, setCompanyCol, setDescCol, runExtraction]
  );

  const downloadEnriched = useCallback(() => {
    const rows = companies.map((c) => ({
      [companyCol]: c.name,
      ...c.originalData,
      ...c.dimensions,
    }));
    const csv = Papa.unparse(rows);
    saveAs(new Blob([csv], { type: "text/csv" }), "companies_enriched.csv");
  }, [companies, companyCol]);

  const extractPct = extractProgress
    ? Math.round((extractProgress.done / extractProgress.total) * 100)
    : 0;

  return (
    <>
      <Card>
        <CardContent className="pt-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-semibold">Company Data</Label>
            {companies.length > 0 && (
              <Badge variant="secondary" className="text-xs text-primary gap-1">
                <CheckCircle2 className="h-3 w-3" />
                {companies.length.toLocaleString()} companies
              </Badge>
            )}
          </div>

          {!hasActiveSession && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {authUser
                ? "Choose or create a session before uploading company data."
                : "Sign in and create a session before uploading company data."}
            </div>
          )}

          <FileUploadZone
            accept=".csv,.xlsx,.xls"
            onFile={handleFile}
            loaded={companies.length > 0}
            loadedLabel={`${companies.length.toLocaleString()} companies loaded`}
            replaceLabel="Drop a new file to replace"
            idleLabel="Drop CSV / Excel here or browse"
            hint=".csv, .xlsx, .xls"
            disabled={!hasActiveSession || uploadPct !== null}
            disabledReason={
              !hasActiveSession
                ? "Upload is disabled until a session is active."
                : uploadPct !== null
                ? "A company upload is already in progress."
                : undefined
            }
          />

          {uploadPct !== null && (
            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Uploading…</span>
                <span>{uploadPct}%</span>
              </div>
              <Progress value={uploadPct} className="h-1.5" />
            </div>
          )}

          {/* Dimension extraction — inline */}
          {companies.length > 0 && (
            <div className="border-t border-border pt-3 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                  <span className="text-xs font-medium">AI Dimensions</span>
                  {hasDimensions && !extracting && (
                    <Badge variant="secondary" className="text-xs text-primary gap-1 ml-1">
                      <CheckCircle2 className="h-3 w-3" />
                      {DIMENSIONS.length} extracted
                    </Badge>
                  )}
                </div>
                <div className="flex gap-2">
                  {hasDimensions && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={downloadEnriched}
                      className="gap-1 text-xs h-7"
                    >
                      <Download className="h-3 w-3" />
                      Export CSV
                    </Button>
                  )}
                  <Button
                    size="sm"
                    disabled={!apiKey || extracting || companies.length === 0}
                    onClick={() => runExtraction()}
                    className="gap-1.5 h-7 text-xs"
                  >
                    {extracting ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Sparkles className="h-3 w-3" />
                    )}
                    {hasDimensions ? "Regenerate" : "Extract now"}
                  </Button>
                </div>
              </div>

              {extracting && extractProgress && (
                <div className="flex flex-col gap-1">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Extracting AI dimensions… {extractProgress.done}/{extractProgress.total}</span>
                    {extractProgress.errors > 0 && (
                      <span className="text-destructive">{extractProgress.errors} errors</span>
                    )}
                  </div>
                  <Progress value={extractPct} className="h-1.5" />
                </div>
              )}

              {!extracting && !hasDimensions && (
                <p className="text-xs text-muted-foreground">
                  {!apiKey
                    ? "Enter your API key above to enable AI dimension extraction."
                    : !descCol
                    ? "No description column detected — extraction requires a description."
                    : "Extraction will start automatically after upload."}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
