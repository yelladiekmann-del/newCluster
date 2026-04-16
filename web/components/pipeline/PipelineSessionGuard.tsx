"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/lib/store/session";
import { PipelineNav } from "./PipelineNav";

export function PipelineSessionGuard({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const authResolved = useSession((s) => s.authResolved);
  const authUser = useSession((s) => s.authUser);
  const sessionId = useSession((s) => s.sessionId);
  const warnedRef = useRef(false);

  useEffect(() => {
    if (!authResolved) return;
    if (!authUser) {
      router.replace("/");
      return;
    }
    if (!sessionId) {
      if (!warnedRef.current) {
        toast.warning("Select or create a session before opening pipeline pages.");
        warnedRef.current = true;
      }
      router.replace("/");
    }
  }, [authResolved, authUser, pathname, router, sessionId]);

  if (!authResolved || !authUser || !sessionId) {
    return (
      <div className="flex h-screen items-center justify-center bg-background px-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Preparing your workspace…
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <PipelineNav />
      <main className="flex-1 overflow-y-auto bg-background">
        {children}
      </main>
    </div>
  );
}
