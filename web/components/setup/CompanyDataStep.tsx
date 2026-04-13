"use client";

import { useCallback, useState } from "react";
import { Upload, Eye, CheckCircle2 } from "lucide-react";
import Papa from "papaparse";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSession } from "@/lib/store/session";
import { persistSession } from "@/lib/firebase/hooks";
import {
  doc,
  writeBatch,
  collection,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import { toast } from "sonner";
import type { CompanyDoc } from "@/types";
import { DIMENSIONS } from "@/types";
import { ref, uploadBytes } from "firebase/storage";
import { getFirebaseStorage } from "@/lib/firebase/client";

export function CompanyDataStep() {
  const {
    uid,
    companies,
    companyCol,
    descCol,
    setCompanies,
    setCompanyCol,
    setDescCol,
  } = useSession();

  const [columns, setColumns] = useState<string[]>([]);
  const [preview, setPreview] = useState<Record<string, unknown>[]>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleFile = useCallback(
    async (file: File) => {
      setLoading(true);
      try {
        Papa.parse<Record<string, unknown>>(file, {
          header: true,
          skipEmptyLines: true,
          complete: async (results) => {
            try {
            const rows = results.data;
            if (!rows.length) {
              toast.error("File appears to be empty");
              setLoading(false);
              return;
            }

            const cols = Object.keys(rows[0]);
            setColumns(cols);
            setPreview(rows.slice(0, 10));

            // Auto-detect columns
            const nameCol =
              cols.find((c) => /^name$/i.test(c)) ||
              cols.find((c) => /company/i.test(c)) ||
              cols[0];
            const dCol =
              cols.find((c) => /description/i.test(c)) ||
              cols.find((c) => /desc/i.test(c)) ||
              null;

            setCompanyCol(nameCol);
            setDescCol(dCol);

            // Write companies to Firestore
            if (!uid) {
              toast.error("Not signed in yet — please wait a moment and try again");
              setLoading(false);
              return;
            }

            const db = getFirebaseDb();
            // Clear existing companies
            const batchSize = 400; // Firestore batch limit is 500
            const companyDocs: CompanyDoc[] = rows.map((row, i) => ({
              id: `r${i}`,
              rowIndex: i,
              name: String(row[nameCol] ?? ""),
              originalData: row,
              dimensions: {},
              clusterId: null,
              outlierScore: null,
              umapX: null,
              umapY: null,
            }));

            // Write in batches
            for (let i = 0; i < companyDocs.length; i += batchSize) {
              const batch = writeBatch(db);
              const chunk = companyDocs.slice(i, i + batchSize);
              for (const c of chunk) {
                const ref = doc(
                  db,
                  "sessions",
                  uid,
                  "companies",
                  c.id
                );
                batch.set(ref, c);
              }
              await batch.commit();
            }

            setCompanies(companyDocs);

            // Upload original CSV to Storage
            const storage = getFirebaseStorage();
            const storageRef = ref(
              storage,
              `sessions/${uid}/companies.csv`
            );
            await uploadBytes(storageRef, file);

            await persistSession(uid, {
              companyCol: nameCol,
              descCol: dCol,
              pipelineStep: 0,
            });

            toast.success(
              `Loaded ${rows.length.toLocaleString()} companies`
            );
            setLoading(false);
            } catch (err) {
              console.error("[Upload] Failed:", err);
              toast.error("Upload failed — " + (err instanceof Error ? err.message : String(err)));
              setLoading(false);
            }
          },
          error: (err) => {
            toast.error(`Parse error: ${err.message}`);
            setLoading(false);
          },
        });
      } catch (err) {
        toast.error(String(err));
        setLoading(false);
      }
    },
    [uid, setCompanies, setCompanyCol, setDescCol]
  );

  return (
    <>
      <Card>
        <CardContent className="pt-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-semibold">2. Company Data</Label>
            {companies.length > 0 && (
              <Badge variant="secondary" className="text-xs text-primary gap-1">
                <CheckCircle2 className="h-3 w-3" />
                {companies.length.toLocaleString()} rows · {companyCol}
              </Badge>
            )}
          </div>

          {/* Drop zone */}
          <label
            className={`flex flex-col items-center justify-center gap-2 border rounded-lg p-6 cursor-pointer transition-colors ${
              companies.length > 0
                ? "border-primary/50 bg-primary/5 hover:bg-primary/10"
                : "border-dashed border-border hover:border-primary/60 hover:bg-muted/30"
            }`}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files[0];
              if (file) handleFile(file);
            }}
            onDragOver={(e) => e.preventDefault()}
          >
            {companies.length > 0 ? (
              <>
                <CheckCircle2 className="h-5 w-5 text-primary" />
                <span className="text-sm text-primary font-medium">
                  {companies.length.toLocaleString()} companies loaded
                </span>
                <span className="text-xs text-muted-foreground">
                  Drop a new file to replace
                </span>
              </>
            ) : (
              <>
                <Upload className="h-5 w-5 text-muted-foreground" />
                <span className="text-sm text-muted-foreground text-center">
                  Drop CSV / Excel here or{" "}
                  <span className="text-primary">browse</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  .csv, .xlsx, .xls
                </span>
              </>
            )}
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
          </label>

          {loading && (
            <p className="text-xs text-muted-foreground animate-pulse">
              Uploading…
            </p>
          )}

          {/* Column selectors */}
          {columns.length > 0 && (
            <div className="flex gap-3">
              <div className="flex-1 flex flex-col gap-1">
                <Label className="text-xs text-muted-foreground">
                  Company column
                </Label>
                <Select
                  value={companyCol}
                  onValueChange={async (v) => {
                    if (!v) return;
                    setCompanyCol(v);
                    if (uid) await persistSession(uid, { companyCol: v });
                  }}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {columns.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex-1 flex flex-col gap-1">
                <Label className="text-xs text-muted-foreground">
                  Description column
                </Label>
                <Select
                  value={descCol ?? ""}
                  onValueChange={async (v) => {
                    setDescCol(v || null);
                    if (uid) await persistSession(uid, { descCol: v || null });
                  }}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Select…" />
                  </SelectTrigger>
                  <SelectContent>
                    {columns.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {/* Preview */}
          {preview.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="self-start gap-1 text-xs"
              onClick={() => setPreviewOpen(true)}
            >
              <Eye className="h-3 w-3" />
              Preview (first 10 rows)
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Preview dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-4xl max-h-[70vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>Data Preview</DialogTitle>
          </DialogHeader>
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr>
                {columns.slice(0, 6).map((c) => (
                  <th
                    key={c}
                    className="text-left p-2 border-b border-border text-muted-foreground font-medium"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.map((row, i) => (
                <tr key={i} className="hover:bg-muted/30">
                  {columns.slice(0, 6).map((c) => (
                    <td
                      key={c}
                      className="p-2 border-b border-border/50 truncate max-w-[180px]"
                    >
                      {String(row[c] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </DialogContent>
      </Dialog>
    </>
  );
}
