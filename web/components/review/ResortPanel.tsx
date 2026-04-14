"use client";

import { useState, useCallback } from "react";
import { useSession } from "@/lib/store/session";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { doc, writeBatch } from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import { createParser } from "eventsource-parser";
import { toast } from "sonner";
import { RefreshCw, Shuffle, ChevronDown, ChevronUp } from "lucide-react";

interface SortReport {
  nSwitched: number;
  nOutliersBefore: number;
  nOutliersAfter: number;
  pulledIn: number;
  switches: { company: string; from: string; to: string; reason?: string }[];
}

export function ResortPanel() {
  const { uid, apiKey, companies, clusters } = useSession();

  const [includeOutliers, setIncludeOutliers] = useState(false);
  const [sorting, setSorting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<SortReport | null>(null);
  const [reportExpanded, setReportExpanded] = useState(false);

  const clusterNameById = Object.fromEntries(clusters.map((c) => [c.id, c.name]));
  const clusterIdByName = Object.fromEntries(clusters.map((c) => [c.name, c.id]));

  const handleSort = useCallback(async () => {
    if (!apiKey || !uid) return;
    setSorting(true);
    setProgress(null);
    setReport(null);

    try {
      const res = await fetch("/api/resort", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-gemini-key": apiKey },
        body: JSON.stringify({
          sessionId: uid,
          companies: companies.map((c) => ({
            id: c.id,
            name: c.name,
            dimensions: c.dimensions,
            clusterId: c.clusterId ?? "outliers",
          })),
          clusters: clusters.map((c) => ({ id: c.id, name: c.name })),
          includeOutliers,
        }),
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => res.statusText);
        toast.error(`Re-sort failed: ${errText}`);
        return;
      }

      let finalAssignments: Record<string, string> = {};
      let finalReasons: Record<string, string> = {};

      const parser = createParser({
        onEvent: (event) => {
          const data = JSON.parse(event.data);
          if (data.type === "progress") {
            setProgress({ done: data.done, total: data.total });
          } else if (data.type === "done") {
            finalAssignments = data.assignments;
            finalReasons = data.reasons;
          } else if (data.type === "error") {
            toast.error(`Re-sort error: ${data.message}`);
          }
        },
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }

      if (Object.keys(finalAssignments).length === 0) return;

      // Apply assignments to Firestore + local state
      const db = getFirebaseDb();
      const { companies: currentCompanies, clusters: currentClusters, setCompanies, setClusters } =
        useSession.getState();

      const switches: SortReport["switches"] = [];
      const nOutliersBefore = currentCompanies.filter((c) => c.clusterId === "outliers").length;

      // Batch writes in groups of 400
      let batch = writeBatch(db);
      let batchCount = 0;

      const updatedCompanies = currentCompanies.map((company) => {
        const newClusterName = finalAssignments[company.id];
        if (!newClusterName) return company;

        const oldClusterName = clusterNameById[company.clusterId ?? ""] ?? "Outliers";
        const newClusterId =
          newClusterName === "Outliers" ? "outliers" : (clusterIdByName[newClusterName] ?? company.clusterId);

        if (newClusterId === company.clusterId) return company;

        switches.push({
          company: company.name,
          from: oldClusterName,
          to: newClusterName,
          reason: finalReasons[company.id],
        });

        batch.update(doc(db, "sessions", uid, "companies", company.id), {
          clusterId: newClusterId,
        });
        batchCount++;

        if (batchCount >= 400) {
          batch.commit();
          batch = writeBatch(db);
          batchCount = 0;
        }

        return { ...company, clusterId: newClusterId };
      });

      if (batchCount > 0) await batch.commit();

      setCompanies(updatedCompanies);

      // Recompute cluster counts
      const countMap: Record<string, number> = {};
      updatedCompanies.forEach((c) => {
        const cid = c.clusterId ?? "outliers";
        countMap[cid] = (countMap[cid] ?? 0) + 1;
      });
      setClusters(currentClusters.map((c) => ({ ...c, companyCount: countMap[c.id] ?? 0 })));

      const nOutliersAfter = updatedCompanies.filter((c) => c.clusterId === "outliers").length;
      const pulledIn = Math.max(0, nOutliersBefore - nOutliersAfter);

      setReport({
        nSwitched: switches.length,
        nOutliersBefore,
        nOutliersAfter,
        pulledIn,
        switches,
      });

      toast.success(`Re-sort complete — ${switches.length} companies moved`);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSorting(false);
    }
  }, [apiKey, uid, companies, clusters, includeOutliers, clusterNameById, clusterIdByName]);

  const progressPct = progress ? Math.round((progress.done / progress.total) * 100) : 0;
  const nonOutlierClusters = clusters.filter((c) => !c.isOutliers);

  return (
    <div className="px-6 py-4 border-t border-border">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Shuffle className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">Re-sort via Gemini</h2>
          <span className="text-xs text-muted-foreground">
            Reassigns all companies to best-fit clusters
          </span>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <Switch
              id="include-outliers"
              checked={includeOutliers}
              onCheckedChange={setIncludeOutliers}
              disabled={sorting}
            />
            <Label htmlFor="include-outliers" className="text-xs text-muted-foreground cursor-pointer">
              Include outliers
            </Label>
          </div>
          <Button
            size="sm"
            onClick={handleSort}
            disabled={!apiKey || sorting || nonOutlierClusters.length < 2}
            className="gap-1.5"
          >
            {sorting ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Shuffle className="h-3.5 w-3.5" />
            )}
            {sorting ? "Sorting…" : "▶ Sort now"}
          </Button>
        </div>
      </div>

      {/* Progress */}
      {sorting && progress && (
        <div className="flex flex-col gap-1 mb-3">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Processing batch {progress.done}/{progress.total}…</span>
            <span>{progressPct}%</span>
          </div>
          <Progress value={progressPct} className="h-1.5" />
        </div>
      )}

      {/* Sort report */}
      {report && (
        <div className="rounded-lg border border-border bg-card p-3 flex flex-col gap-2">
          {/* Summary chips */}
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
              {report.nSwitched} companies moved
            </span>
            <span className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
              {report.nOutliersAfter} outliers remaining
            </span>
            {report.pulledIn > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-green-500/10 text-green-600 font-medium">
                {report.pulledIn} pulled in from outliers
              </span>
            )}
          </div>

          {/* Expand/collapse switch list */}
          {report.switches.length > 0 && (
            <>
              <button
                onClick={() => setReportExpanded((v) => !v)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors w-fit"
              >
                {reportExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                {reportExpanded ? "Hide" : "Show"} {report.switches.length} switches
              </button>

              {reportExpanded && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-muted-foreground border-b border-border">
                        <th className="text-left pb-1 pr-3">Company</th>
                        <th className="text-left pb-1 pr-3">From</th>
                        <th className="text-left pb-1 pr-3">To</th>
                        <th className="text-left pb-1">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.switches.map((s, i) => (
                        <tr key={i} className="border-b border-border/40 last:border-0">
                          <td className="py-1 pr-3 font-medium">{s.company}</td>
                          <td className="py-1 pr-3 text-muted-foreground">{s.from}</td>
                          <td className="py-1 pr-3 text-primary">{s.to}</td>
                          <td className="py-1 text-muted-foreground italic">{s.reason ?? ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
