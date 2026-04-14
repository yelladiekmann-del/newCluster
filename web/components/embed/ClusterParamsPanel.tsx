"use client";

import { useState } from "react";
import { useSession } from "@/lib/store/session";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Info } from "lucide-react";

const PARAMS = [
  {
    key: "minClusterSize" as const,
    label: "Min cluster size",
    min: 2,
    max: 30,
    step: 1,
    tip: "Minimum companies needed to form a cluster. Lower → more, smaller clusters. Higher → fewer, larger clusters.",
  },
  {
    key: "minSamples" as const,
    label: "Min samples",
    min: 1,
    max: 20,
    step: 1,
    tip: "Controls how conservative HDBSCAN is. Higher → stricter density requirement, more companies become outliers.",
  },
  {
    key: "clusterEpsilon" as const,
    label: "Cluster epsilon",
    min: 0,
    max: 2,
    step: 0.1,
    tip: "Merges clusters within this distance threshold. 0 = pure HDBSCAN. Increasing it reduces the number of clusters by merging nearby ones.",
  },
] as const;

function Tooltip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="text-muted-foreground hover:text-primary transition-colors"
        tabIndex={0}
      >
        <Info className="h-3 w-3" />
      </button>
      {open && (
        <span className="absolute left-5 top-1/2 -translate-y-1/2 z-50 w-56 rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md leading-relaxed">
          {text}
        </span>
      )}
    </span>
  );
}

export function ClusterParamsPanel() {
  const { clusterParams, setClusterParams } = useSession();

  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-3">
      {PARAMS.map(({ key, label, min, max, step, tip }) => (
        <div key={key} className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">{label}</Label>
              <Tooltip text={tip} />
            </div>
            <span className="text-xs font-mono text-foreground">
              {clusterParams[key]}
            </span>
          </div>
          <Slider
            min={min}
            max={max}
            step={step}
            value={[clusterParams[key]]}
            onValueChange={(vals) =>
              setClusterParams({ [key]: Array.isArray(vals) ? (vals[0] ?? clusterParams[key]) : vals })
            }
            className="h-1.5"
          />
        </div>
      ))}
    </div>
  );
}
