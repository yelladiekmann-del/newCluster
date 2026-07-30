"use client";

import { useSession } from "@/lib/store/session";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { InfoTooltip } from "@/components/ui/tooltip";
import { DIMENSIONS, DEFAULT_WEIGHTS } from "@/types";
import type { Dimension } from "@/types";
import { RotateCcw } from "lucide-react";
import { DIM_DESCRIPTIONS } from "@/lib/dimension-descriptions";

const PRESETS: { label: string; weights: Record<Dimension, number> }[] = [
  {
    label: "Balanced",
    weights: { ...DEFAULT_WEIGHTS },
  },
  {
    label: "Tech-first",
    weights: {
      "Problem Solved":    1.5,
      "Customer Segment":  0.8,
      "Core Mechanism":    1.5,
      "Tech Category":     1.5,
      "Business Model":    0.8,
      "Value Shift":       0.8,
      "Ecosystem Role":    0.8,
      "Scalability Lever": 0.8,
    },
  },
  {
    label: "Market-fit",
    weights: {
      "Problem Solved":    1.0,
      "Customer Segment":  1.5,
      "Core Mechanism":    0.8,
      "Tech Category":     0.8,
      "Business Model":    1.5,
      "Value Shift":       1.3,
      "Ecosystem Role":    0.8,
      "Scalability Lever": 0.8,
    },
  },
];

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

      {/* Preset buttons */}
      <div className="flex gap-1.5 flex-wrap">
        {PRESETS.map((preset) => (
          <Button
            key={preset.label}
            variant="outline"
            size="sm"
            className="h-6 text-[11px] px-2.5"
            onClick={() => setCustomWeights({ ...preset.weights })}
          >
            {preset.label}
          </Button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        {DIMENSIONS.map((dim) => {
          const isModified = customWeights[dim] !== DEFAULT_WEIGHTS[dim];
          return (
            <div key={dim} className="flex flex-col gap-1">
              <div className="flex justify-between items-center">
                <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
                  {dim}
                  <InfoTooltip content={DIM_DESCRIPTIONS[dim] ?? dim} />
                </span>
                <span className="flex items-center gap-1.5">
                  {isModified && (
                    <span className="text-[10px] text-muted-foreground/50">
                      default: {DEFAULT_WEIGHTS[dim].toFixed(1)}
                    </span>
                  )}
                  <span className="text-xs font-mono text-foreground">
                    {customWeights[dim]?.toFixed(1)}
                  </span>
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
          );
        })}
      </div>
    </div>
  );
}
