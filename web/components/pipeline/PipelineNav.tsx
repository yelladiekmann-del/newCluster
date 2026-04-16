"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { CheckCircle2, ChevronLeft, LogOut, Table2 } from "lucide-react";
import { useSession } from "@/lib/store/session";
import { signOutUser } from "@/lib/firebase/client";
import { clearSignedOutClientState } from "@/lib/firebase/hooks";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const STEPS = [
  { label: "Setup", href: "/setup", step: 0 },
  { label: "Embed & Cluster", href: "/embed", step: 2 },
  { label: "Review & Edit", href: "/review", step: 3 },
  { label: "Analytics", href: "/analytics", step: 4 },
] as const;

export function PipelineNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { pipelineStep, companies, clusters, authUser, spreadsheetUrl, sessionName } = useSession();

  async function handleSignOut() {
    try {
      await signOutUser();
      clearSignedOutClientState();
      router.push("/");
    } catch (err) {
      toast.error("Sign out failed: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  return (
    <aside className="w-56 shrink-0 flex flex-col h-full border-r border-border bg-sidebar px-4 py-6 gap-6">
      {/* Logo + back link */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <img
            src="https://innovators.hamburg/wordpress/wp-content/uploads/2022/01/Logo_hy.png"
            alt="hy"
            className="h-5 w-auto object-contain shrink-0"
          />
          <span className="text-sm font-semibold text-foreground tracking-tight">Clustering Tool</span>
        </div>
        <Link
          href="/"
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary transition-colors w-fit"
        >
          <ChevronLeft className="h-3 w-3" />
          Sessions
        </Link>
      </div>

      <div className="border-t border-sidebar-border -mx-4" />

      {/* Current session name */}
      {sessionName && (
        <div className="px-2.5 -mt-3">
          <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground mb-0.5">
            Current session
          </div>
          <div className="text-xs font-medium text-foreground truncate" title={sessionName}>
            {sessionName}
          </div>
        </div>
      )}

      {/* Step list */}
      <nav className="flex flex-col gap-1">
        {STEPS.map(({ label, href, step }, i) => {
          const done = pipelineStep > step;
          const active = pathname === href;
          const accessible = pipelineStep >= step || active;
          const stepNumber = i + 1;

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
              ) : (
                <span
                  className={cn(
                    "h-4 w-4 shrink-0 rounded-full flex items-center justify-center text-[10px] font-semibold border",
                    active
                      ? "border-primary bg-primary/20 text-primary"
                      : "border-muted-foreground/40 text-muted-foreground"
                  )}
                >
                  {stepNumber}
                </span>
              )}
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Session stats */}
      {companies.length > 0 && (
        <div className="flex flex-col gap-1">
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

      {/* View Sheet link */}
      {spreadsheetUrl && (
        <a
          href={spreadsheetUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary px-2.5 py-1.5 transition-colors"
        >
          <Table2 className="h-3.5 w-3.5" />
          View Sheet ↗
        </a>
      )}

      {/* User footer */}
      {authUser && (
        <div className="mt-auto flex items-center gap-2 px-2.5 py-2 border-t border-border">
          {authUser.photoURL && (
            <img
              src={authUser.photoURL}
              alt=""
              className="h-6 w-6 rounded-full shrink-0"
              referrerPolicy="no-referrer"
            />
          )}
          <span className="text-xs text-muted-foreground truncate flex-1">
            {authUser.displayName ?? authUser.email}
          </span>
          <button
            onClick={handleSignOut}
            title="Sign out"
            className="text-muted-foreground hover:text-primary transition-colors shrink-0"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </aside>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between text-xs px-2.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-primary font-mono font-medium">{value}</span>
    </div>
  );
}
