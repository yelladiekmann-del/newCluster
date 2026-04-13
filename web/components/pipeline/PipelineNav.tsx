"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CheckCircle2, Circle, Loader2 } from "lucide-react";
import { useSession } from "@/lib/store/session";
import { cn } from "@/lib/utils";

const STEPS = [
  { label: "Setup", href: "/setup", step: 0 },
  { label: "Embed & Cluster", href: "/embed", step: 2 },
  { label: "Review & Edit", href: "/review", step: 3 },
  { label: "Analytics", href: "/analytics", step: 4 },
] as const;

export function PipelineNav() {
  const pathname = usePathname();
  const { pipelineStep, companies, clusters } = useSession();

  return (
    <aside className="w-56 shrink-0 flex flex-col h-full border-r border-border bg-sidebar px-4 py-6 gap-6">
      {/* Logo */}
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
          Cluster
        </span>
        <span className="text-base font-bold text-primary leading-none">
          Intelligence
        </span>
      </div>

      {/* Progress bar */}
      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-[11px] text-muted-foreground mb-1">
          <span>Pipeline</span>
          <span>{Math.round((pipelineStep / 4) * 100)}%</span>
        </div>
        <div className="h-1 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all duration-500"
            style={{ width: `${(pipelineStep / 4) * 100}%` }}
          />
        </div>
      </div>

      {/* Step list */}
      <nav className="flex flex-col gap-1">
        {STEPS.map(({ label, href, step }) => {
          const done = pipelineStep > step;
          const active = pathname === href;
          const accessible = pipelineStep >= step || active;

          return (
            <Link
              key={href}
              href={accessible ? href : "#"}
              aria-disabled={!accessible}
              className={cn(
                "flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm transition-colors",
                active
                  ? "bg-sidebar-accent text-primary font-medium"
                  : accessible
                  ? "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-primary"
                  : "text-muted-foreground cursor-default pointer-events-none opacity-50"
              )}
            >
              {done ? (
                <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
              ) : active ? (
                <Circle className="h-4 w-4 text-primary shrink-0 fill-primary/20" />
              ) : (
                <Circle className="h-4 w-4 text-muted-foreground shrink-0" />
              )}
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Session stats */}
      {companies.length > 0 && (
        <div className="mt-auto flex flex-col gap-1">
          <div className="text-[11px] text-muted-foreground uppercase tracking-wide font-semibold mb-1">
            Session
          </div>
          <Stat label="Companies" value={companies.length} />
          {clusters.length > 0 && (
            <Stat
              label="Clusters"
              value={clusters.filter((c) => !c.isOutliers).length}
            />
          )}
        </div>
      )}
    </aside>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between text-xs px-2.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground font-mono font-medium">{value}</span>
    </div>
  );
}
