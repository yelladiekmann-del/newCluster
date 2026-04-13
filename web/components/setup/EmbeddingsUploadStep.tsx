"use client";

import { useCallback } from "react";
import { Upload, CheckCircle2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
    <Card>
      <CardContent className="pt-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-semibold text-muted-foreground">
            5. Pre-computed Embeddings{" "}
            <span className="font-normal text-muted-foreground/70">(optional)</span>
          </Label>
          {npzPreloaded && (
            <Badge variant="secondary" className="text-xs text-primary gap-1">
              <CheckCircle2 className="h-3 w-3" />
              Embeddings loaded
            </Badge>
          )}
        </div>

        <label className="flex items-center gap-3 border border-dashed border-border rounded-lg p-4 cursor-pointer hover:border-primary/60 hover:bg-muted/30 transition-colors">
          <Upload className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm text-muted-foreground">
            Upload a saved <code className="font-mono text-xs">.npz</code> to skip the embed step
          </span>
          <input
            type="file"
            accept=".npz"
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
