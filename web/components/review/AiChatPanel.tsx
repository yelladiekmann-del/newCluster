"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useSession } from "@/lib/store/session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sparkles, Send, Loader2, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
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
import { doc, setDoc, writeBatch } from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import { toast } from "sonner";
import type { ChatMessage, ClusterAction } from "@/types";
import ReactMarkdown from "react-markdown";
import { getNextClusterColor } from "@/lib/cluster-colors";

const SUGGESTED_PROMPTS = [
  "✦ Request cluster review",
  "Which clusters overlap the most?",
  "Compare cluster sizes and gaps",
];

const CLUSTER_REVIEW_PROMPT = `Please review all clusters in this analysis and provide structured recommendations:

**1. KEEP** — List clusters that are well-defined and should remain exactly as they are. Briefly explain why each is cohesive.

**2. DELETE** — List clusters that are too small, too vague, overlap heavily with another, or add no analytical value. Explain why each should be removed.

**3. MERGE** — Identify pairs or groups of clusters that are too similar and should be combined. For each merge, specify which clusters to combine and suggest a name for the result.

**4. ADD** — Identify important market segments that are absent from the current clustering. For each new cluster to add, provide: a proposed name, a concise 2-sentence description, and 3–5 example companies from the dataset that would belong there. The description should start with a category-style phrase like "Companies providing..." or "Platforms enabling..." and should not begin with "This cluster consists of" or similar phrasing.

Ground all recommendations in the specific companies and cluster compositions you know.

After your prose recommendations, append a machine-readable action list using EXACTLY this format (no explanation, no extra text around the tags):

<actions>
[
  {"type": "delete", "clusterName": "<exact cluster name>"},
  {"type": "merge", "sources": ["<cluster A>", "<cluster B>"], "newName": "<merged name>"},
  {"type": "add", "name": "<new cluster name>", "description": "Companies providing .... Unlike nearby clusters, they focus on ....", "companies": ["<company1>", "<company2>", "<company3>"]}
]
</actions>

Only include delete, merge, and add actions — omit KEEP entries entirely. Use exact cluster and company names as they appear in the data.`;

function expandPrompt(p: string): string {
  if (p === "✦ Request cluster review") return CLUSTER_REVIEW_PROMPT;
  return p;
}

export function AiChatPanel() {
  const {
    uid, apiKey, clusters, companies,
    chatMessages, addChatMessage,
    chatOnboarded, setChatOnboarded,
    setChatAnalysisContext,
    setChatMarketContextRaw,
  } = useSession();

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [contextInput, setContextInput] = useState("");
  const [pendingActions, setPendingActions] = useState<ClusterAction[] | null>(null);
  const [applyConfirm, setApplyConfirm] = useState<{ actions: ClusterAction[]; label: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  // ── Onboarding ──────────────────────────────────────────────────────────

  const handleStartAnalysis = useCallback(async () => {
    if (!apiKey || !uid) return;
    setLoading(true);
    try {
      const res = await fetch("/api/chat/context", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-gemini-key": apiKey },
        body: JSON.stringify({
          uid,
          analysisContext: contextInput,
        }),
      });
      if (!res.ok) throw new Error(`Context API error ${res.status}`);
      const { marketContext: market } = (await res.json()) as { marketContext: string };
      setChatMarketContextRaw(market);
      setChatAnalysisContext(contextInput);
      setChatOnboarded(true);

      // Greet the user
      const greeting: ChatMessage = {
        id: `msg_${Date.now()}`,
        role: "assistant",
        content: `I now have full context on your ${companies.length.toLocaleString()} companies across ${clusters.filter(c => !c.isOutliers).length} clusters${market ? ", plus fresh market research" : ""}. What would you like to explore?`,
        timestamp: Date.now(),
        actions: null,
      };
      addChatMessage(greeting);
      await setDoc(doc(getFirebaseDb(), "sessions", uid, "chatHistory", greeting.id), greeting);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setLoading(false);
    }
  }, [apiKey, uid, contextInput, companies, clusters, setChatMarketContextRaw, setChatAnalysisContext, setChatOnboarded, addChatMessage]);

  // ── Send message ─────────────────────────────────────────────────────────

  const handleSend = useCallback(async (messageText?: string, displayOverride?: string, mode: "chat" | "review" = "chat") => {
    const text = messageText ?? input.trim();
    if (!text || !apiKey || loading) return;
    setInput("");
    setLoading(true);

    const userMsg: ChatMessage = {
      id: `msg_${Date.now()}`,
      role: "user",
      content: displayOverride ?? text,   // short label shown in bubble; full prompt sent to API
      timestamp: Date.now(),
      actions: null,
    };
    addChatMessage(userMsg);
    if (uid) {
      await setDoc(doc(getFirebaseDb(), "sessions", uid, "chatHistory", userMsg.id), userMsg);
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-gemini-key": apiKey },
        body: JSON.stringify({
          uid,
          history: chatMessages,
          message: text,
          mode,
        }),
      });

      if (!res.ok) throw new Error(`Chat API error ${res.status}`);
      const { text: responseText, actions } = await res.json();

      const assistantMsg: ChatMessage = {
        id: `msg_${Date.now() + 1}`,
        role: "assistant",
        content: responseText,
        timestamp: Date.now(),
        actions: actions ?? null,
      };
      addChatMessage(assistantMsg);
      if (uid) {
        await setDoc(doc(getFirebaseDb(), "sessions", uid, "chatHistory", assistantMsg.id), assistantMsg);
      }

      if (actions && actions.length > 0) {
        setPendingActions(actions);
      }
    } catch (err) {
      toast.error(String(err));
    } finally {
      setLoading(false);
    }
  }, [apiKey, uid, input, loading, chatMessages, addChatMessage]);

  // ── Apply actions ────────────────────────────────────────────────────────

  /**
   * Apply a single action with its own Firestore commit + state update.
   * Used for individual "Apply" buttons on each suggested action.
   */
  const applyAction = useCallback(async (action: ClusterAction) => {
    if (!uid) return;
    const db = getFirebaseDb();
    const batch = writeBatch(db);
    const { clusters: currentClusters, companies: currentCompanies, setClusters, setCompanies } = useSession.getState();
    const { saveCompaniesToStorage } = await import("@/lib/firebase/companies-storage");

    if (action.type === "delete") {
      const target = currentClusters.find(c => c.name === action.clusterName);
      if (!target) { toast.error(`Cluster "${action.clusterName}" not found`); return; }
      batch.delete(doc(db, "sessions", uid, "clusters", target.id));
      await batch.commit();
      const affected = currentCompanies.filter(c => c.clusterId === target.id).length;
      const updatedCompanies = currentCompanies.map(c => c.clusterId === target.id ? { ...c, clusterId: "outliers" } : c);
      setCompanies(updatedCompanies);
      setClusters(currentClusters.filter(c => c.id !== target.id).map(c => c.id === "outliers" ? { ...c, companyCount: c.companyCount + affected } : c));
      await saveCompaniesToStorage(uid, updatedCompanies);
      toast.success(`Deleted "${action.clusterName}"`);
    }

    if (action.type === "merge") {
      const sources = action.sources.map(name => currentClusters.find(c => c.name === name)).filter(Boolean);
      if (sources.length < 2) { toast.error("Could not find source clusters to merge"); return; }
      const newId = `merged_${crypto.randomUUID()}`;
      const sourceIds = new Set(sources.map(s => s?.id));
      const count = currentCompanies.filter(c => sourceIds.has(c.clusterId ?? "")).length;
      const newCluster = {
        id: newId,
        name: action.newName,
        description: action.description ?? `Merged cluster combining ${sources.map(s => s?.name).join(" & ")}.`,
        color: getNextClusterColor(currentClusters),
        isOutliers: false,
        companyCount: count,
      };
      batch.set(doc(db, "sessions", uid, "clusters", newId), newCluster);
      for (const src of sources) {
        if (src) batch.delete(doc(db, "sessions", uid, "clusters", src.id));
      }
      await batch.commit();
      const updatedCompanies = currentCompanies.map(c => sourceIds.has(c.clusterId ?? "") ? { ...c, clusterId: newId } : c);
      setCompanies(updatedCompanies);
      setClusters([...currentClusters.filter(c => !sourceIds.has(c.id)), newCluster]);
      await saveCompaniesToStorage(uid, updatedCompanies);
      toast.success(`Merged into "${action.newName}"`);
    }

    if (action.type === "add") {
      const newId = `added_${crypto.randomUUID()}`;
      const matchedCompanies = currentCompanies.filter(c => action.companies.some(name => c.name.toLowerCase() === name.toLowerCase()));
      const newCluster = {
        id: newId,
        name: action.name,
        description: action.description,
        color: getNextClusterColor(currentClusters),
        isOutliers: false,
        companyCount: matchedCompanies.length,
      };
      batch.set(doc(db, "sessions", uid, "clusters", newId), newCluster);
      await batch.commit();
      const matchedIds = new Set(matchedCompanies.map(c => c.id));
      const updatedCompanies = currentCompanies.map(c => matchedIds.has(c.id) ? { ...c, clusterId: newId } : c);
      setCompanies(updatedCompanies);
      setClusters([...currentClusters, newCluster]);
      await saveCompaniesToStorage(uid, updatedCompanies);
      toast.success(`Added cluster "${action.name}" with ${matchedCompanies.length} companies`);
    }
  }, [uid]);

  /**
   * Apply multiple actions in a single Firestore batch commit + one state update.
   * Used by "Apply All" to avoid N sequential round-trips.
   */
  const applyAllActions = useCallback(async (actions: ClusterAction[]) => {
    if (!uid || actions.length === 0) return;
    const db = getFirebaseDb();
    const batch = writeBatch(db);
    const { saveCompaniesToStorage } = await import("@/lib/firebase/companies-storage");

    // Thread running state through all actions so each one sees the result of the previous
    let clusters = useSession.getState().clusters;
    let companies = useSession.getState().companies;

    for (const action of actions) {
      if (action.type === "delete") {
        const target = clusters.find(c => c.name === action.clusterName);
        if (!target) continue;
        batch.delete(doc(db, "sessions", uid, "clusters", target.id));
        const affected = companies.filter(c => c.clusterId === target.id).length;
        companies = companies.map(c => c.clusterId === target.id ? { ...c, clusterId: "outliers" } : c);
        clusters = clusters.filter(c => c.id !== target.id).map(c => c.id === "outliers" ? { ...c, companyCount: c.companyCount + affected } : c);
      }

      if (action.type === "merge") {
        const sources = action.sources.map(name => clusters.find(c => c.name === name)).filter(Boolean);
        if (sources.length < 2) continue;
        const newId = `merged_${crypto.randomUUID()}`;
        const sourceIds = new Set(sources.map(s => s?.id));
        const count = companies.filter(c => sourceIds.has(c.clusterId ?? "")).length;
        const newCluster = {
          id: newId,
          name: action.newName,
          description: action.description ?? `Merged cluster combining ${sources.map(s => s?.name).join(" & ")}.`,
          color: getNextClusterColor(clusters),
          isOutliers: false,
          companyCount: count,
        };
        batch.set(doc(db, "sessions", uid, "clusters", newId), newCluster);
        for (const src of sources) {
          if (src) batch.delete(doc(db, "sessions", uid, "clusters", src.id));
        }
        companies = companies.map(c => sourceIds.has(c.clusterId ?? "") ? { ...c, clusterId: newId } : c);
        clusters = [...clusters.filter(c => !sourceIds.has(c.id)), newCluster];
      }

      if (action.type === "add") {
        const newId = `added_${crypto.randomUUID()}`;
        const matchedCompanies = companies.filter(c => action.companies.some(name => c.name.toLowerCase() === name.toLowerCase()));
        const matchedIds = new Set(matchedCompanies.map(c => c.id));
        const newCluster = {
          id: newId,
          name: action.name,
          description: action.description,
          color: getNextClusterColor(clusters),
          isOutliers: false,
          companyCount: matchedCompanies.length,
        };
        batch.set(doc(db, "sessions", uid, "clusters", newId), newCluster);
        companies = companies.map(c => matchedIds.has(c.id) ? { ...c, clusterId: newId } : c);
        clusters = [...clusters, newCluster];
      }
    }

    // Single round-trip: one Firestore commit, one state update, one storage save
    await batch.commit();
    const { setClusters, setCompanies } = useSession.getState();
    setCompanies(companies);
    setClusters(clusters);
    await saveCompaniesToStorage(uid, companies);
    toast.success(`Applied ${actions.length} action${actions.length !== 1 ? "s" : ""}`);
  }, [uid]);

  // ── Render ───────────────────────────────────────────────────────────────

  if (!chatOnboarded) {
    return (
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">AI Assistant</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          I have full knowledge of {companies.length.toLocaleString()} companies across{" "}
          {clusters.filter(c => !c.isOutliers).length} clusters. Tell me who this analysis is for to get started.
        </p>
        <Input
          placeholder="e.g. early-stage VC evaluating logistics SaaS…"
          value={contextInput}
          onChange={(e) => setContextInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleStartAnalysis()}
          className="text-sm"
        />
        <Button
          onClick={handleStartAnalysis}
          disabled={loading || !apiKey}
          className="gap-1.5 self-start"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          Start analysis →
        </Button>
        {!apiKey && <p className="text-xs text-destructive">API key required</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-5 py-3 border-b border-border/70 flex items-center gap-2 bg-muted/20">
        <Sparkles className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">AI Assistant</span>
        <span className="text-xs text-muted-foreground ml-auto">
          {companies.length} companies · {clusters.filter(c => !c.isOutliers).length} clusters
        </span>
      </div>

      {/* Suggested prompts */}
      {chatMessages.length <= 1 && (
        <div className="flex flex-wrap gap-1.5 px-4 pt-3">
          {SUGGESTED_PROMPTS.map((p) => (
            <button
              key={p}
              onClick={() =>
                handleSend(
                  expandPrompt(p),
                  p,
                  p === "✦ Request cluster review" ? "review" : "chat"
                )
              }
              className="text-xs px-2.5 py-1 rounded-full border border-border/70 bg-background text-muted-foreground hover:text-primary hover:border-primary transition-colors"
            >
              {p}
            </button>
          ))}
        </div>
      )}

      {/* Chat history */}
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3 min-h-0">
        {chatMessages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col gap-1 ${msg.role === "user" ? "items-end" : "items-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed ${
                msg.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-foreground"
              }`}
            >
              {msg.role === "assistant" ? (
                <div className="chat-markdown">
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                </div>
              ) : (
                msg.content
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Thinking…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Pending actions */}
      {pendingActions && pendingActions.length > 0 && (
        <div className="px-4 pb-2">
          <div className="rounded-lg border border-border bg-card p-3 flex flex-col gap-2">
            <p className="text-xs font-semibold">Suggested actions</p>
            {pendingActions.map((action, i) => {
              const actionLabel =
                action.type === "delete" ? `Delete "${action.clusterName}"` :
                action.type === "merge" ? `Merge → "${action.newName}"` :
                `Add cluster "${action.name}"`;
              return (
                <div key={i} className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">{actionLabel}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-xs"
                    onClick={() => setApplyConfirm({ actions: [action], label: actionLabel })}
                  >
                    Apply
                  </Button>
                </div>
              );
            })}
            <div className="flex gap-2 mt-1">
              <Button
                size="sm"
                className="h-7 text-xs gap-1"
                onClick={() => setApplyConfirm({ actions: pendingActions, label: `Apply all ${pendingActions.length} actions` })}
              >
                <CheckCircle2 className="h-3 w-3" />
                Apply all
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs gap-1 text-muted-foreground"
                onClick={() => setPendingActions(null)}
              >
                <XCircle className="h-3 w-3" />
                Dismiss
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Input */}
      <div className="px-4 pb-4 pt-2 border-t border-border/70 flex gap-2 bg-muted/10">
        <Input
          placeholder="Ask anything about the clusters…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
          className="text-xs"
        />
        <Button
          size="icon"
          disabled={!input.trim() || loading}
          onClick={() => handleSend()}
          className="shrink-0"
        >
          <Send className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Apply-actions confirmation dialog */}
      <AlertDialog open={!!applyConfirm} onOpenChange={(o) => !o && setApplyConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Apply cluster changes?
            </AlertDialogTitle>
            <AlertDialogDescription>
              <span className="flex flex-col gap-1 text-sm">
                {applyConfirm?.actions.map((a, i) => (
                  <span key={i} className="text-foreground">
                    {a.type === "delete" && `• Delete cluster "${a.clusterName}"`}
                    {a.type === "merge" && `• Merge ${a.sources.join(", ")} → "${a.newName}"`}
                    {a.type === "add" && `• Add cluster "${a.name}" (${a.companies.length} companies)`}
                  </span>
                ))}
                <span className="text-muted-foreground text-xs mt-1">This cannot be undone.</span>
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!applyConfirm) return;
                const actionsToApply = applyConfirm.actions;
                setApplyConfirm(null);
                if (actionsToApply.length === 1) {
                  await applyAction(actionsToApply[0]);
                } else {
                  await applyAllActions(actionsToApply);
                }
                setPendingActions((prev) =>
                  prev?.filter((a) => !actionsToApply.includes(a)) ?? null
                );
              }}
            >
              Apply
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
