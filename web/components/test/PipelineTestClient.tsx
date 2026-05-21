"use client";

import { useState, useCallback, useRef } from "react";
import { createParser } from "eventsource-parser";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Loader2, Upload, CheckCircle2, AlertTriangle, XCircle, ChevronDown, ChevronUp } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type StageStatus = "idle" | "running" | "done" | "error" | "warning";

interface StageState {
  status: StageStatus;
  progress?: { done: number; total: number; errors: number; rate_per_sec: number; eta_sec: number | null; elapsed: string };
  summary?: Record<string, unknown>;
  elapsed_ms?: number;
}

type PipelineEvent =
  | { type: "stage_start"; stage: string; total?: number }
  | { type: "progress"; stage: string; done: number; total: number; errors: number; skipped: number; rate_per_sec: number; eta_sec: number | null; elapsed: string }
  | { type: "stage_done"; stage: string; elapsed_ms: number; summary: Record<string, unknown> }
  | { type: "warning"; message: string }
  | { type: "report"; elapsed_ms: number; elapsed: string; company_count: number; stages_run: string[]; stages: Record<string, Record<string, unknown>> }
  | { type: "error"; message: string };

// ── Helpers ───────────────────────────────────────────────────────────────────

const SAMPLE_PRESETS = [
  { label: "50 (quick smoke test)", value: 50 },
  { label: "200", value: 200 },
  { label: "500", value: 500 },
  { label: "1 000", value: 1000 },
  { label: "5 000", value: 5000 },
  { label: "All rows", value: 0 },
];

function StatusIcon({ status }: { status: StageStatus }) {
  if (status === "running") return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
  if (status === "done") return <CheckCircle2 className="h-4 w-4 text-green-500" />;
  if (status === "warning") return <AlertTriangle className="h-4 w-4 text-amber-500" />;
  if (status === "error") return <XCircle className="h-4 w-4 text-destructive" />;
  return <div className="h-4 w-4 rounded-full border border-border" />;
}

function SummaryTable({ data }: { data: Record<string, unknown> }) {
  return (
    <table className="w-full text-xs mt-2">
      <tbody>
        {Object.entries(data).map(([k, v]) => (
          <tr key={k} className="border-b border-border/40 last:border-0">
            <td className="py-0.5 pr-4 text-muted-foreground font-mono">{k}</td>
            <td className="py-0.5 font-medium break-all">
              {Array.isArray(v) ? (v as string[]).join(", ") || "—" : String(v ?? "—")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function PipelineTestClient() {
  const [file, setFile] = useState<File | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [companyCol, setCompanyCol] = useState("name");
  const [sampleSize, setSampleSize] = useState(200);
  const [runEmbed, setRunEmbed] = useState(false);
  const [dragging, setDragging] = useState(false);

  const [running, setRunning] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [stages, setStages] = useState<Record<string, StageState>>({});
  const [report, setReport] = useState<PipelineEvent & { type: "report" } | null>(null);
  const [expandedStages, setExpandedStages] = useState<Set<string>>(new Set());

  const fileInputRef = useRef<HTMLInputElement>(null);

  const toggleExpand = (stage: string) =>
    setExpandedStages((prev) => {
      const next = new Set(prev);
      next.has(stage) ? next.delete(stage) : next.add(stage);
      return next;
    });

  const updateStage = useCallback((stage: string, patch: Partial<StageState>) =>
    setStages((prev) => ({ ...prev, [stage]: { ...prev[stage], ...patch } })), []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f && /\.(csv|xlsx|xls)$/i.test(f.name)) setFile(f);
  }, []);

  const handleRun = useCallback(async () => {
    if (!file && !sessionId.trim()) return;
    setRunning(true);
    setWarnings([]);
    setFatalError(null);
    setStages({});
    setReport(null);
    setExpandedStages(new Set());

    try {
      const stagesParam = ["parse", ...(runEmbed ? ["embed"] : [])].join(",");

      let res: Response;
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("companyCol", companyCol);
        if (sampleSize > 0) fd.append("sampleSize", String(sampleSize));
        fd.append("stages", stagesParam);
        res = await fetch("/api/test-pipeline", { method: "POST", body: fd });
      } else {
        res = await fetch("/api/test-pipeline", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: sessionId.trim(),
            sampleSize: sampleSize > 0 ? sampleSize : undefined,
            stages: stagesParam,
          }),
        });
      }

      if (!res.ok || !res.body) {
        setFatalError(`Request failed: ${res.status} ${res.statusText}`);
        return;
      }

      const parser = createParser({
        onEvent: (evt) => {
          const data = JSON.parse(evt.data) as PipelineEvent;

          if (data.type === "stage_start") {
            updateStage(data.stage, { status: "running" });
          } else if (data.type === "progress") {
            updateStage(data.stage, {
              status: "running",
              progress: {
                done: data.done,
                total: data.total,
                errors: data.errors,
                rate_per_sec: data.rate_per_sec,
                eta_sec: data.eta_sec,
                elapsed: data.elapsed,
              },
            });
          } else if (data.type === "stage_done") {
            updateStage(data.stage, { status: "done", summary: data.summary, elapsed_ms: data.elapsed_ms });
            // Auto-expand the first stage that has results
            setExpandedStages((prev) => prev.size === 0 ? new Set([data.stage]) : prev);
          } else if (data.type === "warning") {
            setWarnings((w) => [...w, data.message]);
          } else if (data.type === "report") {
            setReport(data);
          } else if (data.type === "error") {
            setFatalError(data.message);
          }
        },
      });

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(dec.decode(value, { stream: true }));
      }
    } catch (err) {
      setFatalError(String(err));
    } finally {
      setRunning(false);
    }
  }, [file, sessionId, companyCol, sampleSize, runEmbed, updateStage]);

  const hasInput = !!file || sessionId.trim().length > 0;
  const stageEntries = Object.entries(stages);

  return (
    <div className="max-w-2xl mx-auto px-6 py-10 flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">Pipeline Diagnostics</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Upload a CSV (or paste a session ID) to trace how companies move through each stage.
        </p>
      </div>

      {/* Input — file OR session */}
      <div className="flex flex-col gap-3">
        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-8 cursor-pointer transition-colors ${
            dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
          }`}
        >
          <Upload className="h-6 w-6 text-muted-foreground" />
          {file ? (
            <span className="text-sm font-medium">{file.name} <span className="text-muted-foreground">({(file.size / 1024).toFixed(0)} KB)</span></span>
          ) : (
            <span className="text-sm text-muted-foreground">Drop a CSV or XLSX here, or click to browse</span>
          )}
          <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <div className="flex-1 border-t border-border" />
          <span>or</span>
          <div className="flex-1 border-t border-border" />
        </div>

        <input
          type="text"
          placeholder="Session ID (from an existing session)"
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {/* Options */}
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">Company name column</label>
          <input
            type="text"
            value={companyCol}
            onChange={(e) => setCompanyCol(e.target.value)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">Sample size</label>
          <select
            value={sampleSize}
            onChange={(e) => setSampleSize(Number(e.target.value))}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {SAMPLE_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Stage toggles */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">Stages to run</span>
        <div className="flex gap-3 flex-wrap">
          <div className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full bg-primary/10 text-primary font-medium">
            <CheckCircle2 className="h-3 w-3" /> Parse
          </div>
          <button
            type="button"
            onClick={() => setRunEmbed((v) => !v)}
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border transition-colors font-medium ${
              runEmbed
                ? "bg-primary/10 border-primary/30 text-primary"
                : "bg-background border-border text-muted-foreground hover:border-primary/30"
            }`}
          >
            {runEmbed ? <CheckCircle2 className="h-3 w-3" /> : <div className="h-3 w-3 rounded-full border border-current" />}
            Embed (uses Gemini quota)
          </button>
        </div>
      </div>

      {/* Run button */}
      <Button onClick={handleRun} disabled={!hasInput || running} className="self-start gap-1.5">
        {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
        {running ? "Running…" : "▶ Run diagnostics"}
      </Button>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {warnings.map((w, i) => (
            <div key={i} className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      {/* Fatal error */}
      {fatalError && (
        <div className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>{fatalError}</span>
        </div>
      )}

      {/* Stage cards */}
      {stageEntries.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Stages</h2>
          {stageEntries.map(([name, state]) => {
            const expanded = expandedStages.has(name);
            return (
              <div key={name} className="rounded-lg border border-border bg-card overflow-hidden">
                {/* Header row */}
                <div className="flex items-center gap-3 px-4 py-3">
                  <StatusIcon status={state.status} />
                  <span className="text-sm font-medium capitalize flex-1">{name.replace(/_/g, " ")}</span>
                  {state.elapsed_ms != null && (
                    <span className="text-xs text-muted-foreground">
                      {state.elapsed_ms < 1000 ? `${state.elapsed_ms}ms` : `${(state.elapsed_ms / 1000).toFixed(1)}s`}
                    </span>
                  )}
                  {state.summary && (
                    <button onClick={() => toggleExpand(name)} className="text-muted-foreground hover:text-foreground">
                      {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>
                  )}
                </div>

                {/* Progress bar */}
                {state.status === "running" && state.progress && (
                  <div className="px-4 pb-3 flex flex-col gap-1">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>
                        {state.progress.done.toLocaleString()} / {state.progress.total.toLocaleString()} companies
                        {state.progress.errors > 0 && (
                          <span className="ml-2 text-destructive font-medium">{state.progress.errors} errors</span>
                        )}
                      </span>
                      <span>
                        {state.progress.rate_per_sec > 0 && `${state.progress.rate_per_sec}/s`}
                        {state.progress.eta_sec != null && state.progress.eta_sec > 0 && (
                          <span className="ml-1.5 text-muted-foreground">
                            ETA {state.progress.eta_sec < 60
                              ? `${state.progress.eta_sec}s`
                              : `${Math.floor(state.progress.eta_sec / 60)}m ${state.progress.eta_sec % 60}s`}
                          </span>
                        )}
                      </span>
                    </div>
                    <Progress
                      value={Math.round((state.progress.done / state.progress.total) * 100)}
                      className="h-1.5"
                    />
                  </div>
                )}

                {/* Summary table */}
                {expanded && state.summary && (
                  <div className="px-4 pb-3 border-t border-border/50">
                    <SummaryTable data={state.summary} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Final report */}
      {report && (
        <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Report</h2>
            <span className="text-xs text-muted-foreground">{report.elapsed} total</span>
          </div>

          <div className="flex flex-wrap gap-2 text-xs">
            <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
              {report.company_count.toLocaleString()} companies
            </span>
            {report.stages_run.map((s) => (
              <span key={s} className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                {s}
              </span>
            ))}
          </div>

          {/* Per-stage verdict */}
          {Object.entries(report.stages).map(([stage, summary]) => {
            const verdict = summary.verdict as string | undefined;
            const ready = summary.ready_for_embed as boolean | undefined;
            if (!verdict && ready === undefined) return null;
            return (
              <div key={stage} className={`text-xs px-3 py-2 rounded-md ${
                verdict?.startsWith("✓") || ready === true
                  ? "bg-green-500/10 text-green-700 dark:text-green-400"
                  : "bg-amber-500/10 text-amber-700 dark:text-amber-400"
              }`}>
                <strong>{stage}:</strong>{" "}
                {verdict ?? (ready ? "Ready for embedding" : "Missing dimensions — run extraction first")}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
