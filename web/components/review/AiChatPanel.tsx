"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useSession } from "@/lib/store/session";
import { persistSession } from "@/lib/firebase/hooks";
import { fetchMarketContext, buildSystemContext } from "@/lib/gemini/chat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Sparkles, Send, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { doc, collection, setDoc, writeBatch } from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import { toast } from "sonner";
import type { ChatMessage, ClusterAction } from "@/types";
import { getFirebaseStorage } from "@/lib/firebase/client";

const SUGGESTED_PROMPTS = [
  "✦ Request cluster review",
  "Which clusters overlap the most?",
  "Compare cluster sizes and gaps",
];

export function AiChatPanel() {
  const {
    uid, apiKey, clusters, companies,
    chatMessages, addChatMessage, setChatMessages,
    chatOnboarded, setChatOnboarded,
    chatAnalysisContext, setChatAnalysisContext,
    chatMarketContextRaw, setChatMarketContextRaw,
  } = useSession();

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [contextInput, setContextInput] = useState("");
  const [pendingActions, setPendingActions] = useState<ClusterAction[] | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  // ── Onboarding ──────────────────────────────────────────────────────────

  const handleStartAnalysis = useCallback(async () => {
    if (!apiKey || !uid) return;
    setLoading(true);
    try {
      const market = await fetchMarketContext(apiKey, contextInput, companies);
      setChatMarketContextRaw(market);
      setChatAnalysisContext(contextInput);
      setChatOnboarded(true);

      await persistSession(uid, {
        chatOnboarded: true,
        chatAnalysisContext: contextInput,
        chatMarketContextRaw: market,
      });

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

  const handleSend = useCallback(async (messageText?: string) => {
    const text = messageText ?? input.trim();
    if (!text || !apiKey || loading) return;
    setInput("");
    setLoading(true);

    const userMsg: ChatMessage = {
      id: `msg_${Date.now()}`,
      role: "user",
      content: text,
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
          clusters,
          companies,
          history: chatMessages,
          message: text,
          analysisContext: chatAnalysisContext,
          marketContext: chatMarketContextRaw,
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
  }, [apiKey, uid, input, loading, clusters, companies, chatMessages, chatAnalysisContext, chatMarketContextRaw, addChatMessage]);

  // ── Apply actions ────────────────────────────────────────────────────────

  const applyAction = useCallback(async (action: ClusterAction) => {
    if (!uid) return;
    const db = getFirebaseDb();
    const batch = writeBatch(db);

    const { clusters: currentClusters, companies: currentCompanies, setClusters, setCompanies } = useSession.getState();

    if (action.type === "delete") {
      const target = currentClusters.find(c => c.name === action.clusterName);
      if (!target) { toast.error(`Cluster "${action.clusterName}" not found`); return; }
      const affected = currentCompanies.filter(c => c.clusterId === target.id);
      for (const c of affected) {
        batch.update(doc(db, "sessions", uid, "companies", c.id), { clusterId: "outliers" });
      }
      batch.delete(doc(db, "sessions", uid, "clusters", target.id));
      await batch.commit();
      setCompanies(currentCompanies.map(c => c.clusterId === target.id ? { ...c, clusterId: "outliers" } : c));
      setClusters(currentClusters.filter(c => c.id !== target.id).map(c => c.id === "outliers" ? { ...c, companyCount: c.companyCount + affected.length } : c));
      toast.success(`Deleted "${action.clusterName}"`);
    }

    if (action.type === "merge") {
      const sources = action.sources.map(name => currentClusters.find(c => c.name === name)).filter(Boolean);
      if (sources.length < 2) { toast.error("Could not find source clusters to merge"); return; }
      // Create new cluster
      const newId = `merged_${Date.now()}`;
      const newCluster = { id: newId, name: action.newName, description: "", color: "#26B4D2", isOutliers: false, companyCount: 0 };
      batch.set(doc(db, "sessions", uid, "clusters", newId), newCluster);
      let count = 0;
      for (const src of sources) {
        if (!src) continue;
        const affected = currentCompanies.filter(c => c.clusterId === src.id);
        count += affected.length;
        for (const c of affected) {
          batch.update(doc(db, "sessions", uid, "companies", c.id), { clusterId: newId });
        }
        batch.delete(doc(db, "sessions", uid, "clusters", src.id));
      }
      batch.update(doc(db, "sessions", uid, "clusters", newId), { companyCount: count });
      await batch.commit();
      const sourceIds = new Set(sources.map(s => s?.id));
      setCompanies(currentCompanies.map(c => sourceIds.has(c.clusterId ?? "") ? { ...c, clusterId: newId } : c));
      setClusters([...currentClusters.filter(c => !sourceIds.has(c.id)), { ...newCluster, companyCount: count }]);
      toast.success(`Merged into "${action.newName}"`);
    }

    if (action.type === "add") {
      const newId = `added_${Date.now()}`;
      const newCluster = { id: newId, name: action.name, description: action.description, color: "#8B5CF6", isOutliers: false, companyCount: 0 };
      batch.set(doc(db, "sessions", uid, "clusters", newId), newCluster);
      const matchedCompanies = currentCompanies.filter(c => action.companies.some(name => c.name.toLowerCase() === name.toLowerCase()));
      for (const c of matchedCompanies) {
        batch.update(doc(db, "sessions", uid, "companies", c.id), { clusterId: newId });
      }
      batch.update(doc(db, "sessions", uid, "clusters", newId), { companyCount: matchedCompanies.length });
      await batch.commit();
      const matchedIds = new Set(matchedCompanies.map(c => c.id));
      setCompanies(currentCompanies.map(c => matchedIds.has(c.id) ? { ...c, clusterId: newId } : c));
      setClusters([...currentClusters, { ...newCluster, companyCount: matchedCompanies.length }]);
      toast.success(`Added cluster "${action.name}" with ${matchedCompanies.length} companies`);
    }
  }, [uid]);

  const applyAllActions = async () => {
    if (!pendingActions) return;
    for (const action of pendingActions) {
      await applyAction(action);
    }
    setPendingActions(null);
  };

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
      <div className="px-5 py-3 border-b border-border flex items-center gap-2">
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
              onClick={() => handleSend(p)}
              className="text-xs px-2.5 py-1 rounded-full border border-border text-muted-foreground hover:text-primary hover:border-primary transition-colors"
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
              {msg.content}
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
            {pendingActions.map((action, i) => (
              <div key={i} className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {action.type === "delete" && `Delete "${action.clusterName}"`}
                  {action.type === "merge" && `Merge → "${action.newName}"`}
                  {action.type === "add" && `Add cluster "${action.name}"`}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-xs"
                  onClick={() => {
                    applyAction(action);
                    setPendingActions((prev) => prev?.filter((_, j) => j !== i) ?? null);
                  }}
                >
                  Apply
                </Button>
              </div>
            ))}
            <div className="flex gap-2 mt-1">
              <Button size="sm" className="h-7 text-xs gap-1" onClick={applyAllActions}>
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
      <div className="px-4 pb-4 pt-2 border-t border-border flex gap-2">
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
    </div>
  );
}
