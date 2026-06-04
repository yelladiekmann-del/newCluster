"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { FileUploadZone } from "@/components/ui/file-upload-zone";
import { useSession } from "@/lib/store/session";
import { persistSession } from "@/lib/firebase/hooks";
import { saveCompaniesToFirestore } from "@/lib/firebase/companies-storage";
import { toast } from "sonner";
import type { CompanyDoc } from "@/types";
import { DIMENSIONS } from "@/types";
import { ref, uploadBytesResumable } from "firebase/storage";
import { getFirebaseStorage } from "@/lib/firebase/client";
import { parseTabularFile, rowsToCsv } from "@/lib/tabular-upload";

export function CompanyDataStep() {
  const {
    authUser,
    uid,
    companies,
    setCompanies,
    setCompanyCol,
    setDescCol,
  } = useSession();

  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const hasActiveSession = !!uid;

  useEffect(() => {
    setUploadPct(null);
  }, [uid]);

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

          // Save companies with originalData to Firestore so resume after re-login
          // uses the fast Firestore path instead of the slow Storage CSV fallback.
          // Non-fatal: extract-dimensions will write Firestore docs anyway (without originalData).
          try {
            await saveCompaniesToFirestore(uid, companyDocs);
            console.info("[CompanyDataStep] Firestore pre-save done", { rowCount: rows.length });
          } catch (fsErr) {
            console.warn("[CompanyDataStep] Firestore pre-save failed (non-fatal):", fsErr);
          }

          console.info("[CompanyDataStep] upload_completed", {
            uid,
            fileName: file.name,
            rowCount: rows.length,
          });
          toast.success(`${rows.length.toLocaleString()} companies loaded`);
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
    [uid, setCompanies, setCompanyCol, setDescCol]
  );

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
        </CardContent>
      </Card>
    </>
  );
}
