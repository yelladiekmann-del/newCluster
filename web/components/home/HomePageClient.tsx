"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { collection, query, where, orderBy, getDocs } from "firebase/firestore";
import { getFirebaseDb, signInWithGoogle, signOutUser } from "@/lib/firebase/client";
import { createNewSession, resumeSession, deleteSession } from "@/lib/firebase/hooks";
import { useSession } from "@/lib/store/session";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Plus, LogOut, ArrowRight, Clock, Loader2, GitBranch, Trash2, Upload, Cpu, Network, BarChart3 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
    desc: "Inspect clusters on a UMAP map and refine them with AI assistance.",
  },
  {
    icon: BarChart3,
    label: "Analytics",
    desc: "Compare clusters on funding, growth, and market metrics.",
  },
];

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
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
      {PIPELINE_STEPS.map(({ icon: Icon, label, desc }, i) => (
        <div
          key={label}
          className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/30 px-4 py-3"
        >
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold text-primary/60 font-mono">0{i + 1}</span>
            <Icon className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-semibold text-foreground">{label}</span>
          </div>
          <p className="text-[11px] text-muted-foreground leading-snug">{desc}</p>
        </div>
      ))}
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
      const step = await resumeSession(sessionId);
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
    await signOutUser();
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
      <main className="flex-1 px-6 py-8 max-w-5xl mx-auto w-full">
        <div className="flex items-start justify-between mb-5">
          <div>
            <h2 className="text-xl font-bold">Sessions</h2>
            <p className="text-sm text-muted-foreground mt-0.5 max-w-xl">
              Each session maps a company list through the full AI pipeline: dimension extraction → embedding → clustering → analytics.
            </p>
          </div>
          <Button onClick={() => setDialogOpen(true)} disabled={creating} className="gap-1.5 shrink-0 ml-4">
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {creating ? "Creating…" : "New Session"}
          </Button>
        </div>

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
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sessions.map((s) => (
              <Card
                key={s.id}
                className="flex flex-col transition-shadow hover:shadow-md"
              >
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <Badge
                      variant="secondary"
                      className={`shrink-0 text-xs ${STEP_BADGE_CLASSES[s.pipelineStep] ?? STEP_BADGE_CLASSES[0]}`}
                    >
                      {STEP_LABELS[s.pipelineStep] ?? "Unknown"}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0 -mr-1 -mt-1"
                      disabled={deleting === s.id}
                      onClick={() => setDeleteTarget(s)}
                    >
                      {deleting === s.id
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Trash2 className="h-3.5 w-3.5" />
                      }
                    </Button>
                  </div>
                  <div className="mt-1">
                    <p className="text-sm font-semibold leading-snug">
                      {s.name ?? "Untitled session"}
                    </p>
                    <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {new Date(s.createdAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pb-3 flex-1 flex flex-col gap-1">
                  {s.companyCol && (
                    <p className="text-xs text-muted-foreground">
                      Column: <span className="text-foreground font-mono">{s.companyCol}</span>
                    </p>
                  )}
                  {(s.companyCount != null || s.clusterCount != null) && (
                    <p className="text-xs text-muted-foreground">
                      {s.companyCount != null && `${s.companyCount.toLocaleString()} companies`}
                      {s.companyCount != null && s.clusterCount != null && " · "}
                      {s.clusterCount != null && `${s.clusterCount} clusters`}
                    </p>
                  )}
                </CardContent>
                <CardFooter className="pt-0">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleResume(s.id)}
                    disabled={resuming === s.id || deleting === s.id}
                    className="w-full gap-1.5"
                  >
                    {resuming === s.id ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Loading…
                      </>
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
  const authUser = useSession((s) => s.authUser);

  if (!authUser) return <SignInView />;
  return <SessionsView authUid={authUser.uid} />;
}
