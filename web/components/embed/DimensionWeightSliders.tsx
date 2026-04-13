"use client";

import { useSession } from "@/lib/store/session";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { DIMENSIONS, DEFAULT_WEIGHTS } from "@/types";
import { RotateCcw } from "lucide-react";

export function DimensionWeightSliders() {
  const { customWeights, setCustomWeights } = useSession();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Increase the weight of dimensions that matter most for clustering.
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs gap-1"
          onClick={() => setCustomWeights({ ...DEFAULT_WEIGHTS })}
        >
          <RotateCcw className="h-3 w-3" />
          Reset
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        {DIMENSIONS.map((dim) => (
          <div key={dim} className="flex flex-col gap-1">
            <div className="flex justify-between">
              <span className="text-xs text-muted-foreground">{dim}</span>
              <span className="text-xs font-mono text-foreground">
                {customWeights[dim]?.toFixed(1)}
              </span>
            </div>
            <Slider
              min={0}
              max={2}
              step={0.1}
              value={[customWeights[dim] ?? 1.0]}
              onValueChange={(vals) =>
                setCustomWeights({ ...customWeights, [dim]: Array.isArray(vals) ? (vals[0] ?? 1.0) : vals })
              }
              className="h-1.5"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
