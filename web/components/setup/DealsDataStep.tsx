"use client";

import { useCallback, useState } from "react";
import { FileUploadZone } from "@/components/ui/file-upload-zone";
import { Progress } from "@/components/ui/progress";
import { Label } from "@/components/ui/label";
import { useSession } from "@/lib/store/session";
import { persistSession } from "@/lib/firebase/hooks";
import { ref, uploadBytesResumable } from "firebase/storage";
import { getFirebaseStorage } from "@/lib/firebase/client";
import { toast } from "sonner";

export function DealsDataStep() {
  const { uid, dealsStoragePath, setDealsStoragePath } = useSession();
  const [rowCount, setRowCount] = useState<number | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);

  const handleFile = useCallback(
    async (file: File) => {
      if (!uid) return;
      try {
        const storage = getFirebaseStorage();
        const storageRef = ref(storage, `sessions/${uid}/deals.csv`);
        const task = uploadBytesResumable(storageRef, file);

        setUploadPct(0);
        await new Promise<void>((resolve, reject) => {
          task.on(
            "state_changed",
            (snap) => setUploadPct(Math.round((snap.bytesTransferred / snap.totalBytes) * 100)),
            reject,
            resolve
          );
        });
        setUploadPct(null);

        const path = `sessions/${uid}/deals.csv`;
        setDealsStoragePath(path);
        await persistSession(uid, { dealsStoragePath: path });

        const text = await file.text();
        const lines = text.split("\n").filter((l) => l.trim()).length - 1;
        setRowCount(Math.max(0, lines));
        toast.success(`Deals data uploaded (${lines.toLocaleString()} rows)`);
      } catch (err) {
        setUploadPct(null);
        toast.error(String(err));
      }
    },
    [uid, setDealsStoragePath]
  );

  return (
    <div className="flex flex-col gap-2">
      <Label className="text-xs font-medium text-muted-foreground">
        Deals Data
        <span className="ml-1 font-normal opacity-70">(optional)</span>
      </Label>
      <FileUploadZone
        accept=".csv,.xlsx,.xls"
        onFile={handleFile}
        loaded={!!dealsStoragePath}
        loadedLabel={rowCount !== null ? `${rowCount.toLocaleString()} deals loaded` : "Deals data uploaded"}
        replaceLabel="Drop a new file to replace"
        idleLabel="Upload deals CSV for funding & momentum analytics"
        hint=".csv, .xlsx, .xls"
        disabled={uploadPct !== null}
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
    </div>
  );
}
