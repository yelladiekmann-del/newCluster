"use client";

import { Tooltip } from "@base-ui/react/tooltip";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Low-level re-exports ──────────────────────────────────────────────────────

export const TooltipProvider = Tooltip.Provider;
export const TooltipRoot = Tooltip.Root;
export const TooltipTrigger = Tooltip.Trigger;
export const TooltipPortal = Tooltip.Portal;
export const TooltipPositioner = Tooltip.Positioner;
export const TooltipPopup = Tooltip.Popup;

// ── Styled tooltip popup ──────────────────────────────────────────────────────

interface TooltipContentProps {
  children: React.ReactNode;
  className?: string;
}

export function TooltipContent({ children, className }: TooltipContentProps) {
  return (
    <Tooltip.Portal>
      <Tooltip.Positioner sideOffset={6}>
        <Tooltip.Popup
          className={cn(
            "z-50 max-w-xs rounded-lg bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md border border-border",
            "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 transition-opacity duration-100",
            className
          )}
        >
          {children}
        </Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  );
}

// ── Convenience: inline info icon with tooltip ────────────────────────────────

interface InfoTooltipProps {
  content: string;
  className?: string;
}

export function InfoTooltip({ content, className }: InfoTooltipProps) {
  return (
    <Tooltip.Provider>
      <Tooltip.Root>
        <Tooltip.Trigger
          className={cn(
            "inline-flex items-center justify-center text-muted-foreground/60 hover:text-muted-foreground transition-colors cursor-default ml-1",
            className
          )}
          aria-label={content}
        >
          <Info className="h-3 w-3" />
        </Tooltip.Trigger>
        <TooltipContent>{content}</TooltipContent>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
