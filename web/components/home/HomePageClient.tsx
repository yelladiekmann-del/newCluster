"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { collection, query, where, orderBy, getDocs } from "firebase/firestore";
import { getFirebaseDb, signInWithGoogle, signOutUser } from "@/lib/firebase/client";
import { createNewSession, resumeSession, resumeSessionFast, deleteSession, clearSignedOutClientState } from "@/lib/firebase/hooks";
import { useSession } from "@/lib/store/session";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Plus, LogOut, ArrowRight, Loader2, GitBranch, Trash2, Upload, Cpu, Network, BarChart3, Layers3, FolderOpen, Sparkles, CheckCircle2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import type { SessionDoc } from "@/types";

const HY_LOGO = "https://innovators.hamburg/wordpress/wp-content/uploads/2022/01/Logo_hy.png";

type SessionRow = SessionDoc & { id: string };

const STEP_LABELS: Record<number, string> = {
  0: "Setup",
  1: "Dimensions",
  2: "Embedded",
  3: "Clustered",
  4: "Analytics",
};

const STEP_BADGE_CLASSES: Record<number, string> = {
  0: "bg-muted text-muted-foreground border-transparent",
  1: "bg-blue-100 text-blue-700 border-transparent",
  2: "bg-purple-100 text-purple-700 border-transparent",
  3: "bg-primary/10 text-primary border-primary/20",
  4: "bg-emerald-100 text-emerald-700 border-transparent",
};

const STEP_ROUTES = ["/setup", "/setup", "/embed", "/review", "/analytics"];

const PIPELINE_STEPS = [
  {
    icon: Upload,
    label: "Setup",
    desc: "Upload a company list and configure AI dimension extraction.",
  },
  {
    icon: Cpu,
    label: "Embed & Cluster",
    desc: "Generate embeddings with Gemini and run HDBSCAN clustering.",
  },
  {
    icon: Network,
    label: "Review & Edit",
    desc: "",
  },
  {
    icon: BarChart3,
    label: "Analytics",
    desc: "Compare clusters on funding, growth, and market metrics.",
  },
];

function normalizeTimestamp(value?: number) {
  if (!value) return null;
  return value < 1e12 ? value * 1000 : value;
}

function fmtDate(value?: number) {
  const normalized = normalizeTimestamp(value);
  if (!normalized) return "—";
  return new Date(normalized).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtTime(value?: number) {
  const normalized = normalizeTimestamp(value);
  if (!normalized) return null;
  return new Date(normalized).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtRelative(value?: number) {
  const normalized = normalizeTimestamp(value);
  if (!normalized) return "No recent activity";
  const diffMs = Date.now() - normalized;
  if (diffMs < 0) return "Updated today";
  const day = 24 * 60 * 60 * 1000;
  if (diffMs < day) return "Updated today";
  if (diffMs < 2 * day) return "Updated yesterday";
  const days = Math.floor(diffMs / day);
  if (days < 30) return `Updated ${days} days ago`;
  const months = Math.floor(days / 30);
  return `Updated ${months} month${months === 1 ? "" : "s"} ago`;
}

function getStepProgress(step: number) {
  const clamped = Math.max(0, Math.min(4, step));
  return (clamped / 4) * 100;
}

function getNextActionLabel(step: number) {
  switch (step) {
    case 0:
      return "Continue setup";
    case 1:
      return "Finish setup";
    case 2:
      return "Open embed & cluster";
    case 3:
      return "Review clusters";
    case 4:
      return "Open analytics";
    default:
      return "Resume session";
  }
}

function StatPill({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3 shadow-sm">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-2 text-xl font-semibold text-foreground">{value}</div>
    </div>
  );
}

// ── Sign-in view ──────────────────────────────────────────────────────────────

function SignInView() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn() {
    setLoading(true);
    setError(null);
    try {
      const { accessToken } = await signInWithGoogle();
      if (accessToken) {
        sessionStorage.setItem("hy_google_token", accessToken);
        useSession.getState().setGoogleAccessToken(accessToken);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md flex flex-col gap-8">
        {/* Hero */}
        <div className="flex flex-col items-center text-center gap-4">
          <img src={HY_LOGO} alt="hy" className="h-8 w-auto object-contain" />
          <div>
            <h1 className="text-2xl font-bold text-foreground">Clustering Tool</h1>
            <p className="text-sm text-muted-foreground mt-1">
              AI-powered market landscape mapping for venture investors
            </p>
          </div>
          {/* 3-step description */}
          <div className="flex flex-col gap-2 text-sm text-left w-full max-w-xs mt-1">
            {[
              "① Upload a company list",
              "② Extract AI dimensions & embed",
              "③ Discover natural market clusters",
            ].map((step) => (
              <div key={step} className="flex items-center gap-2 text-muted-foreground">
                <span>{step}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Sign-in card */}
        <Card>
          <CardContent className="pt-6 flex flex-col gap-4">
            <div className="text-center">
              <p className="text-sm font-medium text-foreground">Sign in to continue</p>
              <p className="text-xs text-muted-foreground mt-0.5">Access restricted to @hy.co accounts</p>
            </div>
            {error && (
              <p className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">
                {error}
              </p>
            )}
            <Button onClick={handleSignIn} disabled={loading} className="w-full gap-2">
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Signing in…
                </>
              ) : (
                "Sign in with Google"
              )}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ── Pipeline steps strip ──────────────────────────────────────────────────────

function PipelineStrip() {
  return (
    <div className="mb-4 grid gap-2.5">
      {PIPELINE_STEPS.map(({ icon: Icon, label, desc }, i) => (
        <div
          key={label}
          className="flex rounded-xl border border-border/70 bg-muted/15 px-3.5 py-3"
        >
          <div className="grid w-full gap-x-3 gap-y-1 md:grid-cols-[auto_auto_minmax(0,160px)_1fr] md:items-center">
            <span className="text-[11px] font-bold text-primary/60 font-mono">0{i + 1}</span>
            <Icon className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="text-sm font-semibold leading-tight text-foreground">{label}</span>
            <p className="text-xs leading-5 text-muted-foreground">{desc}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function SessionCard({
  session,
  resuming,
  deleting,
  onResume,
  onDelete,
}: {
  session: SessionRow;
  resuming: string | null;
  deleting: string | null;
  onResume: (id: string) => void;
  onDelete: (session: SessionRow) => void;
}) {
  const progress = getStepProgress(session.pipelineStep);
  const nextAction = getNextActionLabel(session.pipelineStep);
  const isBusy = resuming === session.id || deleting === session.id;
  const stepIndex = Math.max(0, Math.min(PIPELINE_STEPS.length - 1, session.pipelineStep === 4 ? 3 : Math.max(session.pipelineStep - 1, 0)));
  const stageCopy =
    session.pipelineStep >= 4
      ? "Analytics unlocked"
      : PIPELINE_STEPS[stepIndex]?.desc ?? "Continue the clustering workflow.";

  return (
    <Card className="group/card relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-muted/25 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lg">
      <div className="absolute inset-x-0 top-0 h-16 bg-[radial-gradient(circle_at_top_left,hsl(var(--foreground)/0.06),transparent_58%)] opacity-80" />
      <CardHeader className="relative gap-3 border-b border-border/60 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="secondary"
                className={`shrink-0 text-[11px] ${STEP_BADGE_CLASSES[session.pipelineStep] ?? STEP_BADGE_CLASSES[0]}`}
              >
                {STEP_LABELS[session.pipelineStep] ?? "Unknown"}
              </Badge>
              <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                {fmtRelative(session.updatedAt)}
                {fmtTime(session.updatedAt) && (
                  <span className="ml-1 normal-case tracking-normal">
                    at {fmtTime(session.updatedAt)}
                  </span>
                )}
              </span>
            </div>
            <p className="mt-3 line-clamp-2 text-lg font-semibold leading-snug text-foreground">
              {session.name ?? "Untitled session"}
            </p>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">{stageCopy}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
            disabled={deleting === session.id}
            onClick={() => onDelete(session)}
          >
            {deleting === session.id ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
          </Button>
        </div>
        <div className="text-xs text-muted-foreground">Created {fmtDate(session.createdAt)}</div>
      </CardHeader>

      <CardContent className="relative flex flex-1 flex-col gap-3 py-3">
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-xl border border-border/70 bg-muted/15 px-3 py-2.5">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Companies</div>
            <div className="mt-1.5 text-base font-semibold text-foreground">
              {session.companyCount != null ? session.companyCount.toLocaleString() : "—"}
            </div>
          </div>
          <div className="rounded-xl border border-border/70 bg-muted/15 px-3 py-2.5">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Clusters</div>
            <div className="mt-1.5 text-base font-semibold text-foreground">
              {session.clusterCount != null ? session.clusterCount.toLocaleString() : "—"}
            </div>
          </div>
          <div className="rounded-xl border border-border/70 bg-muted/15 px-3 py-2.5">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Progress</div>
            <div className="mt-1.5 text-base font-semibold text-foreground">{Math.round(progress)}%</div>
          </div>
        </div>

        <div className="rounded-2xl border border-border/70 bg-background/70 p-3.5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-foreground">Pipeline status</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {session.pipelineStep >= 4 ? "This session has completed the core pipeline." : nextAction}
              </div>
            </div>
            {session.pipelineStep >= 4 ? (
              <div className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Complete
              </div>
            ) : (
              <div className="text-xs font-medium text-muted-foreground">
                Step {Math.max(1, session.pipelineStep + 1)} / 5
              </div>
            )}
          </div>
          <div className="mt-2.5">
            <Progress value={progress} className="h-2 bg-muted/70" />
          </div>
        </div>
      </CardContent>

      <CardFooter className="relative mt-auto flex items-center justify-end gap-3 border-t border-border/60 bg-muted/25 px-4 py-3">
        <Button
          size="sm"
          onClick={() => onResume(session.id)}
          disabled={isBusy}
          className="gap-2"
        >
          {resuming === session.id ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </>
          ) : (
            <>
              {nextAction}
              <ArrowRight className="h-3.5 w-3.5" />
            </>
          )}
        </Button>
      </CardFooter>
    </Card>
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
  const [deleting, setDeleting] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SessionRow | null>(null);

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
    setDialogOpen(false);
    setCreating(true);
    try {
      await createNewSession(authUid, newName.trim() || "Untitled session");
      router.push("/setup");
    } finally {
      setCreating(false);
      setNewName("");
    }
  }

  async function handleResume(sessionId: string) {
    setResuming(sessionId);
    try {
      const step = await resumeSessionFast(sessionId);
      router.push(STEP_ROUTES[step] ?? "/setup");
    } finally {
      setResuming(null);
    }
  }

  async function handleDelete(session: SessionRow) {
    setDeleting(session.id);
    setDeleteTarget(null);
    try {
      await deleteSession(session.id);
      setSessions((prev) => prev.filter((s) => s.id !== session.id));
      toast.success(`"${session.name ?? "Untitled session"}" deleted`);
    } catch (err) {
      toast.error("Failed to delete session: " + String(err));
    } finally {
      setDeleting(null);
    }
  }

  async function handleSignOut() {
    try {
      await signOutUser();
      clearSignedOutClientState();
    } catch (err) {
      toast.error("Sign out failed: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <img src={HY_LOGO} alt="hy" className="h-7 w-auto object-contain" />
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
      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-6 py-8">
        <section className="relative overflow-hidden rounded-[28px] border border-border/70 bg-gradient-to-br from-background via-background to-muted/35 shadow-sm">
          <div className="absolute inset-x-0 top-0 h-28 bg-[radial-gradient(circle_at_top_left,hsl(var(--foreground)/0.06),transparent_58%)]" />
          <div className="relative grid gap-6 px-6 py-7 lg:grid-cols-[1.15fr_0.85fr] lg:px-8">
            <div className="space-y-4">
              <div className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/80 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
                <Layers3 className="h-3.5 w-3.5" />
                Session Workspace
              </div>
              <div>
                <h2 className="max-w-3xl text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                  Organize every market map as a reusable working session.
                </h2>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
                  Each session tracks one landscape from raw company upload through clustering, review, and analytics.
                  Pick up where you left off, compare parallel theses, or spin up a new segment study in one click.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <StatPill icon={FolderOpen} label="Sessions" value={sessions.length.toLocaleString()} />
                <StatPill
                  icon={GitBranch}
                  label="In progress"
                  value={sessions.filter((session) => session.pipelineStep < 4).length.toLocaleString()}
                />
                <StatPill
                  icon={Sparkles}
                  label="Analytics-ready"
                  value={sessions.filter((session) => session.pipelineStep >= 4).length.toLocaleString()}
                />
              </div>
            </div>

            <Card className="border-border/70 bg-background/85 shadow-sm">
              <CardHeader className="border-b border-border/60 pb-4">
                <div className="space-y-1">
                  <div className="text-base font-semibold text-foreground">Pipeline overview</div>
                  <p className="text-sm text-muted-foreground">
                    Every session moves through the same clustering workflow.
                  </p>
                </div>
              </CardHeader>
              <CardContent className="pt-4">
                <PipelineStrip />
                <Button onClick={() => setDialogOpen(true)} disabled={creating} className="w-full gap-2">
                  {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  {creating ? "Creating…" : "New Session"}
                </Button>
              </CardContent>
            </Card>
          </div>
        </section>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading sessions…
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-6 text-center">
            <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center">
              <GitBranch className="h-8 w-8 text-muted-foreground/50" />
            </div>
            <div>
              <p className="font-semibold text-foreground">No sessions yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Create your first session to start mapping a company landscape with AI.
              </p>
            </div>
            {/* Pipeline overview — only shown to new users */}
            <div className="w-full max-w-2xl">
              <PipelineStrip />
            </div>
            <Button onClick={() => setDialogOpen(true)} disabled={creating} className="gap-1.5">
              <Plus className="h-4 w-4" />
              Start your first session
            </Button>
          </div>
        ) : (
          <section className="space-y-4">
            <div className="flex items-end justify-between gap-4">
              <div>
                <h3 className="text-xl font-semibold text-foreground">Your sessions</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Open a session to continue exactly where its clustering workflow currently stands.
                </p>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {sessions.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                resuming={resuming}
                deleting={deleting}
                onResume={handleResume}
                onDelete={setDeleteTarget}
              />
            ))}
            </div>
          </section>
        )}
      </main>

      {/* New session dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setNewName(""); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New Session</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-1">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="session-name" className="text-sm">Session name</Label>
              <Input
                id="session-name"
                placeholder="e.g. Q2 2025 Fintech"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleNew()}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDialogOpen(false); setNewName(""); }}>
              Cancel
            </Button>
            <Button onClick={handleNew} className="gap-1.5">
              <ArrowRight className="h-3.5 w-3.5" />
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete session?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &ldquo;{deleteTarget?.name ?? "Untitled session"}&rdquo; and all its data — companies, clusters, and embeddings. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && handleDelete(deleteTarget)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Root export ───────────────────────────────────────────────────────────────

export function HomePageClient() {
  const authResolved = useSession((s) => s.authResolved);
  const authUser = useSession((s) => s.authUser);

  if (!authResolved) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Restoring session…
        </div>
      </div>
    );
  }

  if (!authUser) return <SignInView />;
  return <SessionsView authUid={authUser.uid} />;
}
