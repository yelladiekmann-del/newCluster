"use client";

import { useCallback, useState } from "react";
import { Upload, CheckCircle2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useSession } from "@/lib/store/session";
import { persistSession } from "@/lib/firebase/hooks";
import { ref, uploadBytes } from "firebase/storage";
import { getFirebaseStorage } from "@/lib/firebase/client";
import { toast } from "sonner";

export function DealsDataStep() {
  const { uid, dealsStoragePath, setDealsStoragePath } = useSession();
  const [rowCount, setRowCount] = useState<number | null>(null);

  const handleFile = useCallback(
    async (file: File) => {
      if (!uid) return;
      try {
        const storage = getFirebaseStorage();
        const storageRef = ref(storage, `sessions/${uid}/deals.csv`);
        await uploadBytes(storageRef, file);
        const path = `sessions/${uid}/deals.csv`;
        setDealsStoragePath(path);
        await persistSession(uid, { dealsStoragePath: path });

        // Count rows (rough estimate from text)
        const text = await file.text();
        const lines = text.split("\n").filter((l) => l.trim()).length - 1;
        setRowCount(Math.max(0, lines));
        toast.success(`Deals data uploaded (${lines.toLocaleString()} rows)`);
      } catch (err) {
        toast.error(String(err));
      }
    },
    [uid, setDealsStoragePath]
  );

  return (
    <Card>
      <CardContent className="pt-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-semibold text-muted-foreground">
            4. Deals Data{" "}
            <span className="font-normal text-muted-foreground/70">(optional)</span>
          </Label>
          {dealsStoragePath && (
            <Badge variant="secondary" className="text-xs text-primary gap-1">
              <CheckCircle2 className="h-3 w-3" />
              {rowCount !== null ? `${rowCount.toLocaleString()} rows` : "Uploaded"}
            </Badge>
          )}
        </div>

        <label className="flex items-center gap-3 border border-dashed border-border rounded-lg p-4 cursor-pointer hover:border-primary/60 hover:bg-muted/30 transition-colors">
          <Upload className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm text-muted-foreground">
            Upload deals CSV for funding & momentum analytics
          </span>
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
      </CardContent>
    </Card>
  );
}
