"use client";

import { useCallback } from "react";
import { FileUploadZone } from "@/components/ui/file-upload-zone";
import { Label } from "@/components/ui/label";
import { useSession } from "@/lib/store/session";
import { persistSession } from "@/lib/firebase/hooks";
import { ref, uploadBytes } from "firebase/storage";
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

  const handleFile = useCallback(
    async (file: File) => {
      if (!uid) return;
      if (!file.name.endsWith(".npz")) {
        toast.error("Please upload a .npz file");
        return;
      }
      try {
        const storage = getFirebaseStorage();
        const storageRef = ref(storage, `sessions/${uid}/embeddings.npz`);
        await uploadBytes(storageRef, file);
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
      />
    </div>
  );
}
