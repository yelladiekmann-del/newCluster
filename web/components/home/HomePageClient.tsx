"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { collection, query, where, orderBy, getDocs } from "firebase/firestore";
import { getFirebaseDb, signInWithGoogle, signOutUser } from "@/lib/firebase/client";
import { createNewSession, resumeSession } from "@/lib/firebase/hooks";
import { useSession } from "@/lib/store/session";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Plus, LogOut, ArrowRight, Clock } from "lucide-react";
import type { SessionDoc } from "@/types";

type SessionRow = SessionDoc & { id: string };

const STEP_LABELS: Record<number, string> = {
  0: "Setup",
  1: "Dimensions",
  2: "Embedded",
  3: "Clustered",
  4: "Analytics",
};

const STEP_ROUTES = ["/setup", "/setup", "/embed", "/review", "/analytics"];

// ── Sign-in view ──────────────────────────────────────────────────────────────

function SignInView() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn() {
    setLoading(true);
    setError(null);
    try {
      await signInWithGoogle();
      // onAuthChange in useFirebaseSession will update authUser in the store
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-sm flex flex-col gap-6 px-4">
        {/* Logo */}
        <div className="text-center">
          <p className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
            Cluster
          </p>
          <h1 className="text-2xl font-bold text-primary">Intelligence</h1>
          <p className="text-sm text-muted-foreground mt-2">
            Sign in with your @hy.co Google account to continue.
          </p>
        </div>

        <Card>
          <CardContent className="pt-6 flex flex-col gap-3">
            {error && (
              <p className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">
                {error}
              </p>
            )}
            <Button onClick={handleSignIn} disabled={loading} className="w-full gap-2">
              {loading ? "Signing in…" : "Sign in with Google"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ── Sessions view ─────────────────────────────────────────────────────────────

function SessionsView({ authUid }: { authUid: string }) {
  const router = useRouter();
  const authUser = useSession((s) => s.authUser!);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [resuming, setResuming] = useState<string | null>(null);

  useEffect(() => {
    const db = getFirebaseDb();
    const q = query(
      collection(db, "sessions"),
      where("userId", "==", authUid),
      orderBy("updatedAt", "desc")
    );
    getDocs(q)
      .then((snap) =>
        setSessions(snap.docs.map((d) => ({ id: d.id, ...d.data() } as SessionRow)))
      )
      .finally(() => setLoading(false));
  }, [authUid]);

  async function handleNew() {
    setCreating(true);
    try {
      await createNewSession(authUid);
      router.push("/setup");
    } finally {
      setCreating(false);
    }
  }

  async function handleResume(sessionId: string) {
    setResuming(sessionId);
    try {
      const step = await resumeSession(sessionId);
      router.push(STEP_ROUTES[step] ?? "/setup");
    } finally {
      setResuming(null);
    }
  }

  async function handleSignOut() {
    await signOutUser();
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <p className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
            Cluster
          </p>
          <span className="text-base font-bold text-primary leading-none">Intelligence</span>
        </div>
        <div className="flex items-center gap-3">
          {authUser.photoURL && (
            <img
              src={authUser.photoURL}
              alt=""
              className="h-7 w-7 rounded-full"
              referrerPolicy="no-referrer"
            />
          )}
          <span className="text-sm text-muted-foreground hidden sm:block">
            {authUser.displayName ?? authUser.email}
          </span>
          <Button variant="outline" size="sm" onClick={handleSignOut} className="gap-1.5">
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </Button>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 px-6 py-8 max-w-5xl mx-auto w-full">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-bold">Sessions</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Each session is an independent clustering run.
            </p>
          </div>
          <Button onClick={handleNew} disabled={creating} className="gap-1.5">
            <Plus className="h-4 w-4" />
            {creating ? "Creating…" : "New Session"}
          </Button>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading sessions…</p>
        ) : sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
            <p className="text-muted-foreground text-sm">No sessions yet.</p>
            <Button onClick={handleNew} disabled={creating} className="gap-1.5">
              <Plus className="h-4 w-4" />
              Start your first session
            </Button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sessions.map((s) => (
              <Card key={s.id} className="flex flex-col">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium">
                        {new Date(s.createdAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </p>
                      <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        Updated {new Date(s.updatedAt).toLocaleDateString()}
                      </div>
                    </div>
                    <Badge variant="secondary" className="shrink-0 text-xs">
                      {STEP_LABELS[s.pipelineStep] ?? "Unknown"}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="pb-3 flex-1">
                  {s.companyCol && (
                    <p className="text-xs text-muted-foreground">
                      Column: <span className="text-foreground font-mono">{s.companyCol}</span>
                    </p>
                  )}
                </CardContent>
                <CardFooter className="pt-0">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleResume(s.id)}
                    disabled={resuming === s.id}
                    className="w-full gap-1.5"
                  >
                    {resuming === s.id ? (
                      "Loading…"
                    ) : (
                      <>
                        Resume
                        <ArrowRight className="h-3.5 w-3.5" />
                      </>
                    )}
                  </Button>
                </CardFooter>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

// ── Root export ───────────────────────────────────────────────────────────────

export function HomePageClient() {
  const authUser = useSession((s) => s.authUser);

  if (!authUser) return <SignInView />;
  return <SessionsView authUid={authUser.uid} />;
}
