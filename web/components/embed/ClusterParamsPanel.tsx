"use client";

import { useSession } from "@/lib/store/session";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";

export function ClusterParamsPanel() {
  const { clusterParams, setClusterParams } = useSession();

  const params = [
    { key: "minClusterSize", label: "Min cluster size", min: 2, max: 30, step: 1 },
    { key: "minSamples", label: "Min samples", min: 1, max: 20, step: 1 },
    { key: "clusterEpsilon", label: "Cluster epsilon", min: 0, max: 2, step: 0.1 },
    { key: "umapClusterDims", label: "UMAP cluster dims", min: 5, max: 50, step: 1 },
  ] as const;

  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-3">
      {params.map(({ key, label, min, max, step }) => (
        <div key={key} className="flex flex-col gap-1">
          <div className="flex justify-between">
            <Label className="text-xs text-muted-foreground">{label}</Label>
            <span className="text-xs font-mono text-foreground">
              {clusterParams[key]}
            </span>
          </div>
          <Slider
            min={min}
            max={max}
            step={step}
            value={[clusterParams[key]]}
            onValueChange={(vals) => setClusterParams({ [key]: Array.isArray(vals) ? (vals[0] ?? clusterParams[key]) : vals })}
            className="h-1.5"
          />
        </div>
      ))}
    </div>
  );
}
