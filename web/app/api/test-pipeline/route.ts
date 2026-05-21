/**
 * /api/test-pipeline — Pipeline diagnostic endpoint
 *
 * Streams SSE events as it runs each requested stage so you can watch how a
 * CSV file (or an existing session) moves through the tool in real time.
 *
 * Input (multipart/form-data):
 *   file        — CSV file to test
 *   companyCol  — column used as company name (default: "name")
 *   sampleSize  — limit rows (e.g. 50, 200, 1000) — omit for full file
 *   stages      — comma-separated: "parse,embed"  (default: "parse")
 *                 add "embed" only when you want real Gemini calls
 *
 * Input (application/json, for an existing session):
 *   sessionId   — run against a session already in Firestore
 *   sampleSize  — same as above
 *   stages      — same as above
 *
 * SSE event types:
 *   stage_start  — { stage, total? }
 *   progress     — { stage, done, total, errors?, skipped?, rate_per_sec?, eta_sec? }
 *   stage_done   — { stage, elapsed_ms, summary }
 *   warning      — { message }
 *   report       — { elapsed_ms, company_count, stages }
 *   error        — { message }
 */

import type { NextRequest } from "next/server";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { embedAll } from "@/lib/gemini/embed";
import { getGeminiKey } from "@/lib/server/gemini-key";
import { loadSessionSnapshot } from "@/lib/server/session-data";
import { DIMENSIONS } from "@/types";
import type { CompanyDoc } from "@/types";

export const maxDuration = 300;

// ── Helpers ───────────────────────────────────────────────────────────────────

function coerce(v: unknown): string {
  return v == null ? "" : String(v);
}

function ms(n: number) {
  if (n < 1000) return `${n}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.floor(n / 60_000)}m ${Math.round((n % 60_000) / 1000)}s`;
}

function rowsToCompanyDocs(
  rows: Record<string, string>[],
  companyCol: string,
  sampleSize: number | null
): { companies: CompanyDoc[]; total: number } {
  const all: CompanyDoc[] = rows.map((row, i) => ({
    id: `r${i}`,
    rowIndex: i,
    name: coerce(row[companyCol]),
    originalData: row,
    dimensions: Object.fromEntries(
      DIMENSIONS.filter((d) => row[d] != null && row[d] !== "").map((d) => [d, row[d]])
    ),
    clusterId: null,
    umapX: null,
    umapY: null,
  }));
  return { companies: sampleSize ? all.slice(0, sampleSize) : all, total: all.length };
}

function parseCsv(text: string, companyCol: string, sampleSize: number | null): {
  companies: CompanyDoc[];
  total: number;
  columns: string[];
  errors: Papa.ParseError[];
} {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  const { companies, total } = rowsToCompanyDocs(parsed.data, companyCol, sampleSize);
  return { companies, total, columns: parsed.meta.fields ?? [], errors: parsed.errors };
}

function parseXlsx(buffer: ArrayBuffer, companyCol: string, sampleSize: number | null): {
  companies: CompanyDoc[];
  total: number;
  columns: string[];
  sheetName: string;
} {
  const wb = XLSX.read(buffer, { type: "array" });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, {
    defval: "",
    raw: false, // coerce everything to strings
  });
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  const { companies, total } = rowsToCompanyDocs(rows, companyCol, sampleSize);
  return { companies, total, columns, sheetName };
}

function dimCoverage(companies: CompanyDoc[]): {
  dims: string[];
  missingDims: string[];
  companiesWithAnyDim: number;
} {
  const dims = DIMENSIONS.filter((d) => companies.some((c) => c.dimensions[d]));
  const missingDims = DIMENSIONS.filter((d) => !dims.includes(d));
  const companiesWithAnyDim = companies.filter((c) =>
    Object.keys(c.dimensions).length > 0
  ).length;
  return { dims, missingDims, companiesWithAnyDim };
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const ct = req.headers.get("content-type") ?? "";
  const inputMode = ct.includes("multipart/form-data") ? "file" : "session";
  console.log("[test-pipeline] request received", { inputMode, ts: new Date().toISOString() });

  try {
    return buildStream(req, ct);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[test-pipeline] unhandled error", { msg, inputMode });
    return Response.json({ error: msg }, { status: 500 });
  }
}

function buildStream(req: NextRequest, ct: string): Response {
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) =>
        controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));

      const pipelineStart = Date.now();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stageReports: Record<string, any> = {};

      try {
        // ── Read inputs ────────────────────────────────────────────────────
        let companies: CompanyDoc[] = [];
        let stages: string[] = ["parse"];
        let sampleSize: number | null = null;

        if (ct.includes("multipart/form-data")) {
          const fd = await req.formData();
          const file = fd.get("file") as File | null;
          const companyCol = (fd.get("companyCol") as string | null) || "name";
          sampleSize = fd.get("sampleSize") ? Number(fd.get("sampleSize")) : null;
          stages = ((fd.get("stages") as string | null) || "parse")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

          if (!file) {
            send({ type: "error", message: "No file provided in the form upload." });
            controller.close();
            return;
          }

          // ── Stage: parse ─────────────────────────────────────────────────
          send({ type: "stage_start", stage: "parse" });
          const t0 = Date.now();

          const isXlsx = file.name.toLowerCase().endsWith(".xlsx") || file.name.toLowerCase().endsWith(".xls");
          let total: number;
          let columns: string[];
          let parseErrors = 0;
          let sheetName: string | undefined;

          if (isXlsx) {
            const buffer = await file.arrayBuffer();
            const result = parseXlsx(buffer, companyCol, sampleSize);
            companies = result.companies;
            total = result.total;
            columns = result.columns;
            sheetName = result.sheetName;
          } else {
            const csvText = await file.text();
            const result = parseCsv(csvText, companyCol, sampleSize);
            companies = result.companies;
            total = result.total;
            columns = result.columns;
            parseErrors = result.errors.length;
          }

          if (companies.length === 0) {
            send({ type: "error", message: "File parsed to 0 rows. Check the companyCol setting and file contents." });
            controller.close();
            return;
          }

          const cov = dimCoverage(companies);
          stageReports.parse = {
            elapsed_ms: Date.now() - t0,
            elapsed: ms(Date.now() - t0),
            file_name: file.name,
            file_size_kb: Math.round(file.size / 1024),
            file_type: isXlsx ? "xlsx" : "csv",
            ...(sheetName ? { sheet: sheetName } : {}),
            total_rows: total,
            sampled: companies.length,
            truncated: total > companies.length,
            columns_found: columns.length,
            ...(parseErrors > 0 ? { parse_errors: parseErrors } : {}),
            dimensions_found: cov.dims.length > 0 ? cov.dims : "none",
            dimensions_missing: cov.missingDims,
            companies_with_dimensions: cov.companiesWithAnyDim,
            companies_without_dimensions: companies.length - cov.companiesWithAnyDim,
            ready_for_embed: cov.dims.length > 0,
            next_step: cov.dims.length === 0
              ? "Run 'Extract Dimensions' in the app — use the 'Description' column as input"
              : "Ready — click Embed to generate vectors",
          };

          send({ type: "stage_done", stage: "parse", elapsed_ms: Date.now() - t0, summary: stageReports.parse });

          if (cov.dims.length === 0) {
            send({
              type: "warning",
              message:
                `No AI dimension columns found in this CSV. ` +
                `Columns present: ${columns.slice(0, 10).join(", ")}${columns.length > 10 ? "…" : ""}. ` +
                `Run "Extract Dimensions" in the app first, then re-export and re-test.`,
            });
          }
        } else {
          // JSON / session path
          const body = await req.json();
          const sessionId = body.sessionId as string | undefined;
          sampleSize = body.sampleSize ?? null;
          stages = ((body.stages as string | undefined) || "parse")
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean);

          if (!sessionId) {
            send({ type: "error", message: "Provide either a CSV file or a sessionId." });
            controller.close();
            return;
          }

          send({ type: "stage_start", stage: "load_session" });
          const t0 = Date.now();

          const snap = await loadSessionSnapshot(sessionId);
          const all = snap.companies;
          companies = sampleSize ? all.slice(0, sampleSize) : all;

          if (companies.length === 0) {
            send({ type: "error", message: "Session has no companies." });
            controller.close();
            return;
          }

          const cov = dimCoverage(companies);
          stageReports.load_session = {
            elapsed_ms: Date.now() - t0,
            elapsed: ms(Date.now() - t0),
            total_companies: all.length,
            sampled: companies.length,
            clusters: snap.clusters.length,
            pipeline_step: snap.session.pipelineStep,
            dimensions_found: cov.dims,
            dimensions_missing: cov.missingDims,
            companies_with_dimensions: cov.companiesWithAnyDim,
            ready_for_embed: cov.dims.length > 0,
          };

          send({ type: "stage_done", stage: "load_session", elapsed_ms: Date.now() - t0, summary: stageReports.load_session });

          if (cov.dims.length === 0) {
            send({
              type: "warning",
              message: "This session has no AI dimensions yet. Run dimension extraction first.",
            });
          }

          // Treat "parse" as done — session is loaded
          stages = stages.filter((s) => s !== "parse");
        }

        // ── Stage: embed ───────────────────────────────────────────────────
        if (stages.includes("embed")) {
          const cov = dimCoverage(companies);
          if (cov.dims.length === 0) {
            send({
              type: "warning",
              message: "Skipping embed stage — no dimension columns present. Embeddings would all be zero vectors.",
            });
          } else {
            send({ type: "stage_start", stage: "embed", total: companies.length });
            const t0 = Date.now();
            const apiKey = getGeminiKey();

            const inputs = companies.map((c) => ({ id: c.id, dimensions: c.dimensions }));

            let finalErrors = 0;
            let finalSkipped = 0;
            let finalDone = 0;

            for await (const event of embedAll(inputs, apiKey)) {
              if (event.type === "progress") {
                finalErrors = event.errors;
                finalSkipped = event.skipped;
                finalDone = event.done;

                // Send every 50 companies (or the last one)
                if (event.done % 50 === 0 || event.done === companies.length) {
                  const elapsed = Date.now() - t0;
                  const rate = elapsed > 0 ? Math.round((event.done / elapsed) * 1000) : 0;
                  const remaining = event.total - event.done;
                  send({
                    type: "progress",
                    stage: "embed",
                    done: event.done,
                    total: event.total,
                    errors: event.errors,
                    skipped: event.skipped,
                    elapsed_ms: elapsed,
                    elapsed: ms(elapsed),
                    rate_per_sec: rate,
                    eta_sec: rate > 0 ? Math.round(remaining / rate) : null,
                  });
                }
              }
            }

            const elapsed = Date.now() - t0;
            const successCount = finalDone - finalErrors;
            const errorPct = finalDone > 0 ? Math.round((finalErrors / finalDone) * 100) : 0;
            const rate = elapsed > 0 ? Math.round((finalDone / elapsed) * 1000) : 0;

            stageReports.embed = {
              elapsed_ms: elapsed,
              elapsed: ms(elapsed),
              total: companies.length,
              success: successCount,
              errors: finalErrors,
              skipped: finalSkipped,
              error_rate: `${errorPct}%`,
              success_rate: `${100 - errorPct}%`,
              rate_per_sec: rate,
              verdict:
                errorPct === 0
                  ? "✓ All embeddings succeeded"
                  : errorPct >= 10
                  ? `⚠ High error rate (${errorPct}%) — Gemini quota likely exhausted`
                  : `⚠ ${finalErrors} failures — consider re-embedding`,
            };

            console.log("[test-pipeline] embed done", {
              total: companies.length,
              errors: finalErrors,
              elapsed_ms: Date.now() - t0,
            });
            send({ type: "stage_done", stage: "embed", elapsed_ms: elapsed, summary: stageReports.embed });
          }
        }

        // ── Final report ───────────────────────────────────────────────────
        const totalElapsed = Date.now() - pipelineStart;
        console.log("[test-pipeline] run complete", {
          elapsed_ms: totalElapsed,
          company_count: companies.length,
          stages: Object.keys(stageReports),
        });
        send({
          type: "report",
          elapsed_ms: totalElapsed,
          elapsed: ms(totalElapsed),
          company_count: companies.length,
          stages_run: Object.keys(stageReports),
          stages: stageReports,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[test-pipeline] stream error", { msg });
        send({ type: "error", message: msg });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
