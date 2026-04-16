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

export function EmbeddingsUploadStep() {
  const {
    uid,
    npzPreloaded,
    setNpzPreloaded,
    setEmbeddingsStoragePath,
    setPipelineStep,
    pipelineStep,
  } = useSession();

  const [uploadPct, setUploadPct] = useState<number | null>(null);

  const handleFile = useCallback(
    async (file: File) => {
      if (!uid) {
        toast.error("Select or create a session before uploading embeddings.");
        return;
      }
      if (!file.name.endsWith(".npz")) {
        toast.error("Please upload a .npz file");
        return;
      }
      try {
        const storage = getFirebaseStorage();
        const storageRef = ref(storage, `sessions/${uid}/embeddings.npz`);
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

        const path = `sessions/${uid}/embeddings.npz`;
        setEmbeddingsStoragePath(path);
        setNpzPreloaded(true);
        const nextStep = Math.max(pipelineStep, 2) as 2;
        setPipelineStep(nextStep);
        await persistSession(uid, {
          embeddingsStoragePath: path,
          npzPreloaded: true,
          pipelineStep: nextStep,
        });
        toast.success("Embeddings restored from .npz");
      } catch (err) {
        setUploadPct(null);
        toast.error(String(err));
      }
    },
    [uid, setEmbeddingsStoragePath, setNpzPreloaded, pipelineStep, setPipelineStep]
  );

  return (
    <div className="flex flex-col gap-2">
      <Label className="text-xs font-medium text-muted-foreground">
        Pre-computed Embeddings
        <span className="ml-1 font-normal opacity-70">(optional)</span>
      </Label>
      <FileUploadZone
        accept=".npz"
        onFile={handleFile}
        loaded={npzPreloaded}
        loadedLabel="Embeddings loaded"
        replaceLabel="Drop a new .npz to replace"
        idleLabel="Upload a saved .npz to skip the embed step"
        hint=".npz"
        disabled={!uid || uploadPct !== null}
        disabledReason={
          !uid
            ? "Embeddings upload is disabled until a session is active."
            : uploadPct !== null
            ? "An embeddings upload is already in progress."
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
    </div>
  );
}
