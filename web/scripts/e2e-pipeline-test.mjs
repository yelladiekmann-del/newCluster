/**
 * Full-scale end-to-end pipeline test
 * Runs ALL companies through every stage with real Firebase + Gemini calls.
 *
 * Usage: node --env-file=.env.local scripts/e2e-pipeline-test.mjs
 *
 * Stages:
 *   0  Parse XLSX → CompanyDoc[]
 *   1  Firebase write — real Firestore batch write of all companies
 *   2  Extract dimensions — all companies via /api/extract-dimensions
 *   3  Embed — all extracted companies via /api/embed
 *   4  Cluster — /api/cluster against the saved matrix
 */

import XLSX from "xlsx";
import { readFileSync } from "fs";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, WriteBatch } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const BASE   = "http://localhost:3000";
const FILE   = "/Users/yella.diekmann/Downloads/aerticket_longlist.xlsx";
const TEST_SESSION = `e2e-test-${Date.now()}`;

const DIMS = [
  "Problem Solved","Customer Segment","Core Mechanism","Tech Category",
  "Business Model","Value Shift","Ecosystem Role","Scalability Lever",
];

// ── Colours ───────────────────────────────────────────────────────────────────
const C = { reset:"\x1b[0m", bold:"\x1b[1m", green:"\x1b[32m", red:"\x1b[31m",
            yellow:"\x1b[33m", cyan:"\x1b[36m", dim:"\x1b[2m" };
const ok   = s => console.log(`  ${C.green}✓${C.reset} ${s}`);
const fail = s => console.log(`  ${C.red}✗${C.reset} ${s}`);
const warn = s => console.log(`  ${C.yellow}⚠${C.reset} ${s}`);
const info = s => console.log(`  ${C.dim}→${C.reset} ${s}`);
const head = s => console.log(`\n${C.bold}${C.cyan}━━ ${s} ${C.reset}`);
const tick = s => process.stdout.write(`\r  ${C.dim}${s}${C.reset}    `);
function ms(n) {
  if (n < 1000) return `${n}ms`;
  if (n < 60000) return `${(n/1000).toFixed(1)}s`;
  return `${Math.floor(n/60000)}m ${Math.round((n%60000)/1000)}s`;
}

// ── Firebase Admin init ───────────────────────────────────────────────────────
function initAdmin() {
  if (getApps().length > 0) return;
  const projectId    = process.env.FIREBASE_PROJECT_ID    || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const clientEmail  = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey   = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const bucket       = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;

  if (projectId && clientEmail && privateKey) {
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), storageBucket: bucket });
  } else {
    // Application Default Credentials (gcloud auth application-default login)
    initializeApp({ projectId, storageBucket: bucket });
  }
}

// ── SSE reader ────────────────────────────────────────────────────────────────
async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop();
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      try { onEvent(JSON.parse(line.slice(5).trim())); } catch {}
    }
  }
}

// ── Results ───────────────────────────────────────────────────────────────────
const results = {};
function stageResult(name, passed, details = {}) {
  results[name] = { passed, ...details };
}

// =============================================================================
// MAIN
// =============================================================================
console.log(`\n${C.bold}Full-scale Pipeline E2E — aerticket_longlist.xlsx${C.reset}`);
console.log(`${C.dim}Session: ${TEST_SESSION}  |  Target: ${BASE}${C.reset}\n`);

initAdmin();
const db      = getFirestore();
const storageBucketName = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
const storage = getStorage().bucket(storageBucketName);

// ── 0. Parse ──────────────────────────────────────────────────────────────────
head("STAGE 0 — Parse XLSX");
let t = Date.now();

const wb      = XLSX.readFile(FILE);
const sheet   = wb.Sheets[wb.SheetNames[0]];
const allRows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });

const companies = allRows.map((row, i) => ({
  id:           `r${i}`,
  rowIndex:     i,
  name:         String(row["Companies"] || ""),
  dimensions:   Object.fromEntries(DIMS.filter(d => row[d] && row[d] !== "").map(d => [d, row[d]])),
  originalData: {
    // Keep only useful columns to avoid bloating Firestore docs
    Companies:                              String(row["Companies"]                           || "").slice(0, 200),
    Description:                            String(row["Description"]                         || "").slice(0, 1000),
    "Primary PitchBook Industry Sector":    String(row["Primary PitchBook Industry Sector"]   || ""),
    "Primary PitchBook Industry Group":     String(row["Primary PitchBook Industry Group"]    || ""),
    Keywords:                               String(row["Keywords"]                            || "").slice(0, 300),
    Verticals:                              String(row["Verticals"]                           || "").slice(0, 300),
    "Company Financing Status":             String(row["Company Financing Status"]            || ""),
    "Year Founded":                         String(row["Year Founded"]                        || ""),
    "HQ Country/Territory/Region":          String(row["HQ Country/Territory/Region"]         || ""),
    Employees:                              String(row["Employees"]                           || ""),
  },
  clusterId: null, umapX: null, umapY: null,
}));

ok(`Parsed ${companies.length.toLocaleString()} companies in ${ms(Date.now()-t)}`);
ok(`Sheet: ${wb.SheetNames[0]}`);
stageResult("parse", true, { total: companies.length });

// ── 1. Firebase upload ────────────────────────────────────────────────────────
// Real app behaviour: CompanyDataStep writes CSV to Firebase Storage only.
// Firestore company docs are NOT pre-created — extraction creates them.
head("STAGE 1 — Session setup (mirrors real app: Storage CSV only, no Firestore company docs)");
t = Date.now();

const BATCH_SIZE      = 100;
const PARALLEL_GROUPS = 5;
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const collRef = db.collection("sessions").doc(TEST_SESSION).collection("companies");

info(`Writing session doc to sessions/${TEST_SESSION}…`);
await db.collection("sessions").doc(TEST_SESSION).set({
  userId:               "e2e-test",
  createdAt:            Date.now(),
  updatedAt:            Date.now(),
  pipelineStep:         0,
  companyCol:           "Companies",
  descCol:              "Description",
  name:                 `E2E Test — ${new Date().toISOString()}`,
  chatAnalysisContext:  "E2E test — automated portfolio review of aerticket longlist companies",
  chatMarketContextRaw: "",
  chatOnboarded:        true,
  clustersConfirmed:    false,
});
ok("Session doc written");

// Verify no company docs exist yet — confirms we mirror the real upload-only flow
const preCheckSnap = await collRef.limit(1).get();
if (preCheckSnap.empty) {
  ok("Firestore companies subcollection empty ✓ — extraction will create docs (real app flow)");
} else {
  warn("Companies already exist in Firestore before extraction — test may not catch missing-doc bugs");
}

const uploadElapsed = Date.now() - t;
stageResult("upload", true, { session_doc: "written", company_docs_in_firestore: "none (correct)", elapsed: ms(uploadElapsed) });

// ── 2. Extract dimensions ─────────────────────────────────────────────────────
head("STAGE 2 — Extract Dimensions (Gemini · all companies)");
t = Date.now();

const needsExtraction = companies.filter(c => Object.keys(c.dimensions).length === 0);
info(`${needsExtraction.length.toLocaleString()} companies need extraction`);

if (needsExtraction.length === 0) {
  ok("All companies already have dimensions — skipping");
  stageResult("extract", true, { skipped: true });
} else {
  const extractPayload = {
    rows: needsExtraction.map(c => ({
      name:        c.name,
      description: String(c.originalData["Description"] || "").slice(0, 800),
    })),
    uid:             TEST_SESSION,
    originalIndices: needsExtraction.map(c => c.rowIndex),
  };

  // Regression test: verify that extract-dimensions handles missing Firestore docs (set+merge, not update).
  info(`Regression check: extract-dimensions with uid + non-existent doc key…`);
  try {
    const phantomExtractRes = await fetch(`${BASE}/api/extract-dimensions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rows: [{ name: "PhantomCo", description: "A test company that does not exist in Firestore." }],
        uid: TEST_SESSION,
        originalIndices: [99999], // doc r99999 does not exist
      }),
    });
    if (phantomExtractRes.ok || phantomExtractRes.body) {
      // Drain the stream and check for errors
      let sawError = false;
      await readSSE(phantomExtractRes, evt => { if (evt.type === "error") sawError = true; });
      if (!sawError) ok("set+merge handles missing doc in extract-dimensions ✓");
      else fail("REGRESSION: extract-dimensions SSE error for missing doc — update() used instead of set+merge");
    } else {
      fail(`REGRESSION: extract-dimensions returned ${phantomExtractRes.status} for missing doc`);
    }
  } catch (e) {
    fail(`REGRESSION: extract-dimensions threw for missing doc: ${e.message}`);
  }
  // Delete phantom doc created by regression check (prevent contaminating Stage 5 naming)
  try { await collRef.doc("r99999").delete(); } catch {}

  info(`Sending ${needsExtraction.length.toLocaleString()} rows to /api/extract-dimensions…`);
  info(`Body size: ~${(JSON.stringify(extractPayload).length / 1024 / 1024).toFixed(1)} MB`);

  let extractDone = 0, extractErrors = 0, extractTotal = needsExtraction.length;
  // Results are now streamed incrementally via progress.entries (not in the done event)
  const extractMap = new Map(); // index → dims
  let extractStreamDone = false;
  let lastProgressAt = Date.now();

  let extractOk = false;
  try {
    const res = await fetch(`${BASE}/api/extract-dimensions`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(extractPayload),
    });

    if (!res.ok || !res.body) {
      const txt = await res.text().catch(() => res.statusText);
      fail(`Extract returned ${res.status}: ${txt.slice(0, 300)}`);
      stageResult("extract", false, { error: txt.slice(0,300) });
    } else {
      // ── SSE contract checks ─────────────────────────────────────────────
      // These mirror the EXACT parsing logic in CompanyDataStep.tsx and
      // DimensionExtractionStep.tsx. A failure here means the component would
      // crash or silently produce empty results for the user.
      let progressEventsWithEntries = 0;
      let progressEventsWithoutEntries = 0;
      let doneEventSeen = false;

      await readSSE(res, evt => {
        if (evt.type === "progress") {
          extractDone   = evt.done   ?? extractDone;
          extractTotal  = evt.total  ?? extractTotal;
          extractErrors = evt.errors ?? extractErrors;

          // Contract: every progress event must have `entries` array
          if (!Array.isArray(evt.entries)) {
            progressEventsWithoutEntries++;
          } else {
            progressEventsWithEntries++;
            for (const { index, dims } of evt.entries) {
              // Contract: index must be a number, dims must be an object
              if (typeof index !== "number") fail(`REGRESSION: progress.entries[].index is not a number (got ${typeof index})`);
              if (typeof dims !== "object" || dims === null) fail(`REGRESSION: progress.entries[].dims is not an object`);
              extractMap.set(index, dims ?? {});
            }
          }

          const now = Date.now();
          if (now - lastProgressAt > 3000 || extractDone === extractTotal) {
            const elapsed = now - t;
            const rate    = elapsed > 0 ? Math.round((extractDone/elapsed)*1000) : 0;
            const eta     = rate > 0 ? Math.round((extractTotal-extractDone)/rate) : "?";
            tick(`extracting ${extractDone.toLocaleString()}/${extractTotal.toLocaleString()} · ${rate}/s · ETA ${typeof eta === "number" ? ms(eta*1000) : eta}`);
            lastProgressAt = now;
          }
        } else if (evt.type === "done") {
          doneEventSeen = true;
          extractStreamDone = true;
          process.stdout.write("\r");

          // Contract: done event must NOT carry `results` payload.
          // If it does, the old component path (data.results) would silently
          // work, masking a regression when we remove it again.
          if (evt.results !== undefined) {
            fail("REGRESSION: done event carries 'results' payload — component uses incremental progress.entries, not done.results");
          }
          // Contract: done event must not carry unexpected keys
          const allowedDoneKeys = new Set(["type"]);
          const extraKeys = Object.keys(evt).filter(k => !allowedDoneKeys.has(k));
          if (extraKeys.length > 0) {
            warn(`done event has unexpected keys: ${extraKeys.join(", ")} — component may ignore them`);
          }
        } else if (evt.type === "error") {
          process.stdout.write("\r");
          fail(`Extraction error: ${evt.message}`);
        }
      });

      // ── Post-stream contract checks ──────────────────────────────────────
      process.stdout.write("\r");
      if (!doneEventSeen)    fail("REGRESSION: SSE stream ended without a done event — component spinner would hang forever");
      if (progressEventsWithoutEntries > 0) fail(`REGRESSION: ${progressEventsWithoutEntries} progress events missing 'entries' array — component Map would stay empty`);
      if (progressEventsWithEntries === 0)  fail("REGRESSION: no progress events with entries received — component would save 0 results");
      // Simulate the component's guard: receivedDims.size > 0
      if (extractMap.size === 0)            fail("REGRESSION: extractMap empty after stream — component would show 'No results received' toast");
      // Simulate: companies.map((c, i) => ({ ...c, dimensions: receivedDims.get(i) ?? c.dimensions }))
      // If any index is out of range, dims would fall back to existing — not a crash but worth flagging
      const outOfRange = [...extractMap.keys()].filter(i => i >= needsExtraction.length);
      if (outOfRange.length > 0) fail(`REGRESSION: ${outOfRange.length} entries have index >= companies.length — component would silently drop them`);

      const extractResults = extractMap.size > 0
        ? needsExtraction.map((_, idx) => extractMap.get(idx) ?? {})
        : null;

      if (extractResults) {
        // Merge back into companies
        extractResults.forEach((dims, idx) => {
          if (needsExtraction[idx]) needsExtraction[idx].dimensions = dims ?? {};
        });

        const withAllDims  = extractResults.filter(r => Object.keys(r||{}).length === 8).length;
        const withSomeDims = extractResults.filter(r => Object.keys(r||{}).length > 0).length;
        const nEmpty       = extractResults.filter(r => Object.keys(r||{}).length === 0).length;
        const elapsed      = Date.now() - t;

        ok(`Extraction complete in ${ms(elapsed)}`);
        ok(`${withAllDims.toLocaleString()} / ${extractResults.length.toLocaleString()} got all 8 dims`);
        ok(`${withSomeDims.toLocaleString()} got ≥1 dim  |  ${nEmpty.toLocaleString()} empty (errors)`);
        ok(`Error rate: ${Math.round((nEmpty/extractResults.length)*100)}%`);
        ok(`Throughput: ${Math.round((extractResults.length/(elapsed/1000))).toLocaleString()} companies/sec`);

        if (withAllDims > 0) {
          const sample = extractResults.find(r => Object.keys(r||{}).length === 8) || {};
          info(`Sample dims: ${Object.entries(sample).map(([k,v])=>`${k}: "${String(v).slice(0,40)}"`).join(" | ").slice(0,200)}`);
        }

        stageResult("extract", withSomeDims > 0, {
          total:        extractResults.length,
          all_8_dims:   withAllDims,
          partial:      withSomeDims - withAllDims,
          empty_errors: nEmpty,
          error_rate:   `${Math.round((nEmpty/extractResults.length)*100)}%`,
          elapsed:      ms(elapsed),
          rate_per_sec: Math.round((extractResults.length/(elapsed/1000))),
        });
        extractOk = withSomeDims > 0;

        // ── Verify that extract-dimensions wrote complete Firestore docs server-side ──
        // The API route now saves docs via Admin SDK (set+merge).
        // Each doc must have: name, rowIndex, dimensions — so loadCompanies works
        // correctly after a page reload without needing a Storage CSV merge.
        head("STAGE 2b — Verify Firestore docs from extraction (spot-check)");
        const tVerify = Date.now();
        const extracted = needsExtraction.filter(c => Object.keys(c.dimensions).length > 0);
        const sampleSize = Math.min(5, extracted.length);
        const sampled = extracted.slice(0, sampleSize);
        info(`Spot-checking ${sampleSize} Firestore docs written by /api/extract-dimensions…`);
        let verifyPassed = true;

        try {
          for (const c of sampled) {
            const docSnap = await collRef.doc(`r${c.rowIndex}`).get();
            if (!docSnap.exists) {
              fail(`REGRESSION: doc r${c.rowIndex} was NOT created by extract-dimensions — server-side save broken`);
              verifyPassed = false;
              continue;
            }
            const d = docSnap.data();
            const hasName     = typeof d.name === "string" && d.name.length > 0;
            const hasRowIndex = typeof d.rowIndex === "number";
            const hasDims     = d.dimensions && Object.keys(d.dimensions).length > 0;
            if (!hasName)     { fail(`REGRESSION: r${c.rowIndex} missing 'name' — loadCompanies reload would show blank rows`);      verifyPassed = false; }
            if (!hasRowIndex) { fail(`REGRESSION: r${c.rowIndex} missing 'rowIndex' — loadCompanies reload sort would break`);        verifyPassed = false; }
            if (!hasDims)     { fail(`REGRESSION: r${c.rowIndex} missing 'dimensions' — embedding step would receive empty dims`);    verifyPassed = false; }
            if (hasName && hasRowIndex && hasDims) {
              ok(`r${c.rowIndex}: name="${d.name.slice(0,30)}"  rowIndex=${d.rowIndex}  dims=${Object.keys(d.dimensions).length} ✓`);
            }
          }
          const verifyElapsed = Date.now() - tVerify;
          if (verifyPassed) ok(`All ${sampleSize} docs verified in ${ms(verifyElapsed)}`);
          stageResult("verify_extract_docs", verifyPassed, { checked: sampleSize, elapsed: ms(verifyElapsed) });
        } catch (err) {
          fail(`Verify failed: ${err.message}`);
          stageResult("verify_extract_docs", false, { error: err.message });
        }
      } else {
        fail("No extraction results received (timeout or empty response)");
        stageResult("extract", false, { error: "no results" });
      }
    }
  } catch (err) {
    process.stdout.write("\r");
    fail(`Extract request failed: ${err.message}`);
    stageResult("extract", false, { error: err.message });
  }
}

// ── 3. Embed ──────────────────────────────────────────────────────────────────
head("STAGE 3 — Embed (Gemini · all extracted companies)");
t = Date.now();

const embeddable = companies.filter(c => Object.keys(c.dimensions).length > 0);
info(`${embeddable.length.toLocaleString()} companies have dimensions (out of ${companies.length.toLocaleString()})`);

if (embeddable.length === 0) {
  fail("No companies with dimensions — extraction must have failed");
  stageResult("embed", false, { error: "no dimensions" });
} else {
  const embedPayload = {
    sessionId:            TEST_SESSION,
    embeddingsStoragePath: null,
    companies:            embeddable.map(c => ({ id: c.id, dimensions: c.dimensions })),
  };
  info(`Body size: ~${(JSON.stringify(embedPayload).length / 1024 / 1024).toFixed(1)} MB`);
  info(`Expected time at 9/sec: ~${ms(Math.round(embeddable.length/9)*1000)}`);
  warn("Timeout risk: maxDuration=300s — will report if stream cuts off early");

  let embedDone = 0, embedErrors = 0, embedTotal = embeddable.length;
  let embedStoragePath = null;
  let lastEmbedProgressAt = Date.now();
  let streamEndedEarly = false;

  try {
    const res = await fetch(`${BASE}/api/embed`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(embedPayload),
    });

    if (!res.ok || !res.body) {
      const txt = await res.text().catch(() => res.statusText);
      fail(`Embed returned ${res.status}: ${txt.slice(0,300)}`);
      stageResult("embed", false, { error: txt.slice(0,300) });
    } else {
      let gotDone = false;
      await readSSE(res, evt => {
        if (evt.type === "progress") {
          embedDone   = evt.done;
          embedTotal  = evt.total;
          embedErrors = evt.errors;
          const now = Date.now();
          if (now - lastEmbedProgressAt > 5000 || evt.done === evt.total) {
            const elapsed = now - t;
            const rate    = elapsed > 0 ? Math.round((embedDone/elapsed)*1000) : 0;
            const eta     = rate > 0 ? Math.round((embedTotal-embedDone)/rate) : 0;
            tick(`embedding ${embedDone.toLocaleString()}/${embedTotal.toLocaleString()} · ${rate}/s · ETA ${ms(eta*1000)} · errors ${embedErrors}`);
            lastEmbedProgressAt = now;
          }
        } else if (evt.type === "done") {
          embedStoragePath = evt.embeddingsStoragePath;
          gotDone = true;
          process.stdout.write("\r");
        } else if (evt.type === "error") {
          process.stdout.write("\r");
          fail(`Embed error: ${evt.message}`);
        }
      });

      if (!gotDone && embedDone < embedTotal) {
        streamEndedEarly = true;
        process.stdout.write("\r");
        fail(`Stream ended at ${embedDone}/${embedTotal} — likely hit 300s maxDuration timeout`);
      }

      const elapsed = Date.now() - t;
      const errPct  = embedTotal > 0 ? Math.round((embedErrors/embedTotal)*100) : 0;
      const rate    = elapsed > 0 ? Math.round((embedDone/elapsed)*1000) : 0;

      if (embedDone > 0) {
        if (!streamEndedEarly) ok(`Embedding complete in ${ms(elapsed)}`);
        ok(`${embedDone.toLocaleString()} embedded · ${embedErrors} errors (${errPct}%) · ${rate}/sec`);
        if (embedStoragePath) ok(`Matrix → Storage: ${embedStoragePath}`);
        else warn("No storage path (stream may have cut off before done event)");

        // Verify the matrix file actually exists in Storage
        if (embedStoragePath) {
          try {
            const [exists] = await storage.file(embedStoragePath).exists();
            if (exists) {
              const [meta] = await storage.file(embedStoragePath).getMetadata();
              ok(`Storage file verified: ${(Number(meta.size)/1024/1024).toFixed(1)} MB`);
            } else {
              fail("Storage file does not exist after embed");
            }
          } catch (err) {
            warn(`Storage verification failed: ${err.message}`);
          }
        }

        stageResult("embed", !streamEndedEarly && embedErrors < embedTotal, {
          total:          embeddable.length,
          done:           embedDone,
          errors:         embedErrors,
          error_rate:     `${errPct}%`,
          rate_per_sec:   rate,
          elapsed:        ms(elapsed),
          timed_out:      streamEndedEarly,
          storage_path:   embedStoragePath,
        });
      } else {
        fail("No embedding progress received");
        stageResult("embed", false, { error: "no progress events" });
      }
    }
  } catch (err) {
    process.stdout.write("\r");
    fail(`Embed request failed: ${err.message}`);
    stageResult("embed", false, { error: err.message });
  }
}

// ── 4. Cluster ────────────────────────────────────────────────────────────────
head("STAGE 4 — Cluster (ML service)");
t = Date.now();

// Declared at outer scope so Stage 5 can read it
let clusterResult = null;

const embedResult = results["embed"];
if (!embedResult?.storage_path) {
  warn("Skipping cluster — no storage path from embed stage");
  stageResult("cluster", false, { error: "no storage path" });
} else {
  info(`Storage path: ${embedResult.storage_path}`);
  info(`Company IDs: ${embeddable.length.toLocaleString()}`);

  let clusterError = null;
  try {
    const res = await fetch(`${BASE}/api/cluster`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        sessionId:            TEST_SESSION,
        companyIds:           embeddable.map(c => c.id),
        embeddingsStoragePath: embedResult.storage_path,
        minClusterSize:       15,
        minSamples:           5,
        clusterEpsilon:       0.5,
      }),
    });

    if (!res.ok || !res.body) {
      const txt = await res.text().catch(() => res.statusText);
      fail(`Cluster returned ${res.status}: ${txt.slice(0,300)}`);
      stageResult("cluster", false, { error: txt.slice(0,300) });
    } else {
      await readSSE(res, evt => {
        if (evt.type === "progress") {
          tick(`cluster stage: ${evt.stage}…`);
        } else if (evt.type === "done") {
          clusterResult = evt;
          process.stdout.write("\r");
        } else if (evt.type === "error") {
          clusterError = evt.error;
          process.stdout.write("\r");
        }
      });

      const elapsed = Date.now() - t;
      if (clusterResult) {
        ok(`Clustering complete in ${ms(elapsed)}`);
        ok(`${clusterResult.nClusters} clusters · ${clusterResult.nOutliers} outliers (${Math.round(clusterResult.nOutliers/embeddable.length*100)}%)`);
        if (clusterResult.metrics?.silhouette != null)
          ok(`Silhouette: ${clusterResult.metrics.silhouette.toFixed(3)}`);
        if (clusterResult.metrics?.daviesBouldin != null)
          info(`Davies-Bouldin: ${clusterResult.metrics.daviesBouldin.toFixed(3)} (lower=better)`);
        ok(`UMAP 2D for ${clusterResult.embedded2d?.length ?? 0} companies`);
        stageResult("cluster", true, {
          nClusters:  clusterResult.nClusters,
          nOutliers:  clusterResult.nOutliers,
          outlier_pct:`${Math.round(clusterResult.nOutliers/embeddable.length*100)}%`,
          silhouette: clusterResult.metrics?.silhouette?.toFixed(3),
          elapsed:    ms(elapsed),
        });
      } else {
        fail(`Cluster error: ${clusterError ?? "no result received"}`);
        stageResult("cluster", false, { error: clusterError ?? "empty" });
      }
    }
  } catch (err) {
    fail(`Cluster request failed: ${err.message}`);
    stageResult("cluster", false, { error: err.message });
  }
}

// ── 4b. Confirm clusters (server-side save) ───────────────────────────────────
head("STAGE 4b — Confirm Clusters (server-side Firestore save)");
t = Date.now();

const clusterStageResultForSave = results["cluster"];
if (!clusterStageResultForSave?.passed || !clusterResult) {
  warn("Skipping confirm-clusters — cluster stage did not succeed");
  stageResult("confirm_clusters", false, { error: "cluster stage failed" });
} else {
  const clusterLabels = clusterResult?.labels ?? [];
  const embedded2d    = clusterResult?.embedded2d ?? [];

  // Build the same payload the browser sends to /api/confirm-clusters
  const updates = embeddable.map((c, i) => ({
    id:        c.id,
    clusterId: clusterLabels[i] === -1 ? "outliers" : String(clusterLabels[i] ?? "outliers"),
    umapX:     embedded2d[i]?.[0] ?? null,
    umapY:     embedded2d[i]?.[1] ?? null,
  }));

  // Regression test: verify that confirm-clusters handles missing docs (set+merge, not update).
  // Simulate a doc that was never written to Firestore by injecting a phantom ID.
  const phantomUpdate = { id: "r_PHANTOM_NONEXISTENT", clusterId: "0", umapX: 0, umapY: 0 };
  info(`Regression check: confirm-clusters with 1 non-existent doc (should not throw NOT_FOUND)…`);
  try {
    const phantomRes = await fetch(`${BASE}/api/confirm-clusters`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid: TEST_SESSION, updates: [phantomUpdate] }),
    });
    if (phantomRes.ok) ok("set+merge handles missing doc ✓ (no NOT_FOUND error)");
    else fail(`REGRESSION: confirm-clusters returned ${phantomRes.status} for missing doc — update() used instead of set+merge`);
  } catch (e) {
    fail(`REGRESSION: confirm-clusters threw for missing doc: ${e.message}`);
  }
  // Delete phantom doc immediately — prevent it contaminating Stage 5 name-clusters
  try { await collRef.doc("r_PHANTOM_NONEXISTENT").delete(); } catch {}

  info(`Calling /api/confirm-clusters with ${updates.length.toLocaleString()} company updates…`);

  try {
    const confirmRes = await fetch(`${BASE}/api/confirm-clusters`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ uid: TEST_SESSION, updates }),
    });

    const elapsed = Date.now() - t;

    if (!confirmRes.ok) {
      const txt = await confirmRes.text().catch(() => confirmRes.statusText);
      fail(`confirm-clusters returned ${confirmRes.status}: ${txt.slice(0, 300)}`);
      stageResult("confirm_clusters", false, { error: txt.slice(0, 300) });
    } else {
      const { updated } = await confirmRes.json();
      ok(`Cluster results saved in ${ms(elapsed)}`);
      ok(`Docs updated: ${updated.toLocaleString()}  ·  Rate: ${Math.round(updated / (elapsed / 1000)).toLocaleString()} docs/sec`);
      stageResult("confirm_clusters", true, {
        docs:         updated,
        elapsed:      ms(elapsed),
        rate_per_sec: Math.round(updated / (elapsed / 1000)),
      });

      // Merge cluster data back into local companies array so Stage 5 reads correct labels
      updates.forEach(({ id, clusterId, umapX, umapY }) => {
        const c = embeddable.find(x => x.id === id);
        if (c) { c.clusterId = clusterId; c.umapX = umapX; c.umapY = umapY; }
      });
    }
  } catch (err) {
    fail(`confirm-clusters request failed: ${err.message}`);
    stageResult("confirm_clusters", false, { error: err.message });
  }
}

// ── 5. Name Clusters ──────────────────────────────────────────────────────────
head("STAGE 5 — Name Clusters (Gemini)");
t = Date.now();

const clusterStageResult = results["cluster"];
if (!clusterStageResult?.passed || !results["cluster"]) {
  warn("Skipping naming — cluster stage did not succeed");
  stageResult("naming", false, { error: "cluster stage failed" });
} else {

  try {
    info(`Calling /api/name-clusters for ${clusterStageResult.nClusters} clusters…`);
    const namingRes = await fetch(`${BASE}/api/name-clusters`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ uid: TEST_SESSION }),
    });

    const elapsed = Date.now() - t;

    if (!namingRes.ok) {
      const txt = await namingRes.text().catch(() => namingRes.statusText);
      fail(`name-clusters returned ${namingRes.status}: ${txt.slice(0, 300)}`);
      stageResult("naming", false, { error: txt.slice(0, 300) });
    } else {
      const { results: namings } = await namingRes.json();
      ok(`Naming complete in ${ms(elapsed)}`);
      ok(`${namings.length} clusters named`);

      // Print each cluster name + description for quality review
      console.log();
      namings.forEach((n, i) => {
        console.log(`  ${C.bold}[${i+1}] ${n.name}${C.reset}`);
        console.log(`  ${C.dim}${n.description}${C.reset}`);
        console.log();
      });

      // Quality checks
      const uniqueNames = new Set(namings.map(n => n.name.toLowerCase().trim()));
      const hasDuplicates = uniqueNames.size < namings.length;
      const genericTerms = ["platform", "solution", "tool", "system", "software", "saas", "ai-powered", "ai powered"];
      const genericCount = namings.filter(n =>
        genericTerms.some(t => n.name.toLowerCase().includes(t))
      ).length;
      const shortDescriptions = namings.filter(n => (n.description ?? "").length < 40).length;

      if (!hasDuplicates) ok("All names unique ✓");
      else fail(`${namings.length - uniqueNames.size} duplicate names`);
      if (genericCount === 0) ok("No generic names (Platform/Solution/SaaS) ✓");
      else warn(`${genericCount}/${namings.length} names contain generic terms`);
      if (shortDescriptions === 0) ok("All descriptions substantive (>40 chars) ✓");
      else warn(`${shortDescriptions} descriptions too short`);

      stageResult("naming", !hasDuplicates, {
        nClusters:      namings.length,
        duplicates:     hasDuplicates ? "YES" : "none",
        generic_names:  genericCount,
        elapsed:        ms(elapsed),
      });

      // Save cluster docs to Firestore — mirrors what the frontend does after naming.
      // Required for Stage 6 (/api/test-chat) which loads clusters from Firestore.
      const tSaveCluster = Date.now();
      info(`Saving ${namings.length} cluster docs to Firestore…`);
      try {
        const CLUSTER_COLORS = ["#6366f1","#f59e0b","#10b981","#ef4444","#3b82f6","#8b5cf6","#ec4899","#14b8a6","#f97316","#84cc16","#06b6d4","#e11d48","#7c3aed"];
        const clustersRef = db.collection("sessions").doc(TEST_SESSION).collection("clusters");
        const cb = db.batch();
        namings.forEach((n, i) => {
          const clusterId = n.clusterIndex ?? String(i);
          const memberCount = embeddable.filter(c => c.clusterId === clusterId).length;
          cb.set(clustersRef.doc(clusterId), {
            id:           clusterId,
            name:         n.name,
            description:  n.description,
            color:        CLUSTER_COLORS[i % CLUSTER_COLORS.length],
            isOutliers:   false,
            companyCount: memberCount,
          });
        });
        // outliers pseudo-cluster
        const outlierCount = embeddable.filter(c => c.clusterId === "outliers").length;
        cb.set(clustersRef.doc("outliers"), { id: "outliers", name: "Outliers", description: "", color: "#6b7280", isOutliers: true, companyCount: outlierCount });
        await cb.commit();
        ok(`Cluster docs saved in ${ms(Date.now() - tSaveCluster)} (${namings.length + 1} docs incl. outliers)`);
      } catch (saveErr) {
        warn(`Cluster doc save failed (non-fatal for naming, fatal for chat): ${saveErr.message}`);
      }
    }
  } catch (err) {
    fail(`Naming request failed: ${err.message}`);
    stageResult("naming", false, { error: err.message });
  }
}

// ── 6. Chat review prompt quality ────────────────────────────────────────────
// Uses /api/test-chat to verify the system context is well-formed and that
// the cluster review response is substantive (content-based, not metric-based).
head("STAGE 6 — Chat review prompt quality (/api/test-chat)");
t = Date.now();

const clusterResultForChat = results["confirm_clusters"];
if (!clusterResultForChat?.passed) {
  warn("Skipping chat test — confirm-clusters stage did not succeed");
  stageResult("chat_review", false, { error: "confirm-clusters failed" });
} else {
  try {
    // ── 6a: dry run — check context is built correctly ─────────────────────
    const dryRes = await fetch(`${BASE}/api/test-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid: TEST_SESSION, dryRun: true }),
    });
    if (!dryRes.ok) {
      const txt = await dryRes.text().catch(() => dryRes.statusText);
      fail(`test-chat dryRun returned ${dryRes.status}: ${txt.slice(0, 200)}`);
      stageResult("chat_review", false, { error: `dryRun ${dryRes.status}` });
    } else {
      const { context, systemPrompt, elapsed: dryElapsed } = await dryRes.json();
      ok(`Context built in ${ms(dryElapsed)} — ${context.clusterCount} clusters · ${context.companyCount} companies`);

      // Verify context completeness
      if (context.clusterCount === 0) fail("REGRESSION: no clusters in chat context");
      else ok(`Cluster names: ${context.clusterNames.slice(0, 5).join(", ")}…`);
      if (context.overlapCandidates.length > 0)
        ok(`Overlap candidates: ${context.overlapCandidates.map(c => `${c.a} <> ${c.b}`).join(" | ")}`);
      if (context.gapHints.length > 0)
        info(`Gap hints: ${context.gapHints.slice(0, 3).join(" | ")}`);

      // Verify cohesion scores are NOT exposed as raw numbers in system prompt
      const rawScorePattern = /cohesion score:\s*\d+\.\d+/i;
      if (rawScorePattern.test(systemPrompt)) {
        fail("REGRESSION: raw cohesion score found in system prompt — model will cite numbers");
      } else {
        ok("No raw cohesion scores in system prompt ✓");
      }
      // Verify qualitative label is present instead
      if (systemPrompt.includes("Internal focus:")) {
        ok("Qualitative cohesion labels present ✓");
      } else {
        fail("REGRESSION: 'Internal focus' label missing from system prompt");
      }
      // Verify overlap candidates use substantive reason (not percentages)
      const percentReason = /\d+% overlap/i;
      if (context.overlapCandidates.some(c => percentReason.test(c.reason))) {
        fail("REGRESSION: overlap candidate reason still uses raw percentage");
      } else if (context.overlapCandidates.length > 0) {
        ok(`Overlap reasons are substantive: "${context.overlapCandidates[0].reason}" ✓`);
      }
      // Verify anti-metrics instruction in system prompt
      if (systemPrompt.includes("Do NOT cite raw metric numbers")) {
        ok("Anti-metrics instruction present in system prompt ✓");
      } else {
        fail("REGRESSION: anti-metrics instruction missing from system prompt");
      }

      // ── 6b: live run — check response quality ─────────────────────────────
      info("Calling Gemini with cluster review prompt (live)…");
      const liveRes = await fetch(`${BASE}/api/test-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: TEST_SESSION, mode: "review" }),
      });
      if (!liveRes.ok) {
        const txt = await liveRes.text().catch(() => liveRes.statusText);
        fail(`test-chat live returned ${liveRes.status}: ${txt.slice(0, 200)}`);
        stageResult("chat_review", false, { error: `live ${liveRes.status}` });
      } else {
        const { response, actions, actionsRaw, actionsParseError, qualityFlags, elapsed: liveElapsed } = await liveRes.json();
        ok(`Gemini responded in ${ms(liveElapsed)}`);
        ok(`Response length: ${response?.length ?? 0} chars · ${(response?.split(" ") ?? []).length} words`);
        if (actions && actions.length > 0) ok(`Actions parsed: ${actions.length} (${actions.map(a => a.type).join(", ")})`);
        else if (actionsRaw) {
          warn(`<actions> block found but produced 0 valid actions`);
          if (actionsParseError) info(`  parse error: ${actionsParseError}`);
          info(`  raw (first 600 chars): ${actionsRaw.slice(0, 600)}`);
        } else {
          warn("No <actions> block in response");
        }

        // Quality flags from the route itself
        if (qualityFlags?.length > 0) {
          for (const flag of qualityFlags) {
            if (flag.startsWith("WARN:")) fail(flag);
            else info(flag);
          }
        }

        // Content check: does the response name specific clusters?
        const namedClusters = context.clusterNames.filter(name => response?.includes(name)).length;
        if (namedClusters >= 3) ok(`Response mentions ${namedClusters} cluster names by name ✓`);
        else warn(`Response only mentions ${namedClusters} cluster names — may be too generic`);

        // Metric leakage check: raw decimal numbers near "cohes" or "score"
        const metricLeak = /\b0\.\d{2}\b.*?(cohes|score|metric|percent)|(cohes|score|metric|percent).*?\b0\.\d{2}\b/i;
        if (metricLeak.test(response ?? "")) {
          fail("REGRESSION: response cites raw decimal metrics despite anti-metrics instruction");
        } else {
          ok("No raw metric citations in response ✓");
        }

        const elapsed = Date.now() - t;
        stageResult("chat_review", true, {
          context_clusters: context.clusterCount,
          response_words:   (response?.split(" ") ?? []).length,
          actions_count:    actions?.length ?? 0,
          cluster_mentions: namedClusters,
          quality_flags:    qualityFlags?.filter(f => f.startsWith("WARN:")).length ?? 0,
          elapsed:          ms(elapsed),
        });
      }
    }
  } catch (err) {
    fail(`Chat review test failed: ${err.message}`);
    stageResult("chat_review", false, { error: err.message });
  }
}

// ── Cleanup test session ───────────────────────────────────────────────────────
head("CLEANUP");
info(`Deleting test session ${TEST_SESSION} from Firestore…`);
try {
  // Delete companies in chunks (can be 5k+ docs)
  const snap = await db.collection("sessions").doc(TEST_SESSION).collection("companies").get();
  const chunks = chunk(snap.docs, 400);
  for (const ch of chunks) {
    const b = db.batch();
    ch.forEach(d => b.delete(d.ref));
    await b.commit();
  }
  await db.collection("sessions").doc(TEST_SESSION).delete();
  // Delete storage file if it exists
  const sp = results["embed"]?.storage_path;
  if (sp) await storage.file(sp).delete().catch(() => {});
  ok(`Test session deleted (${snap.docs.length} company docs + session doc + storage)`);
} catch (err) {
  warn(`Cleanup failed (non-fatal): ${err.message}`);
}

// ── Summary ───────────────────────────────────────────────────────────────────
head("SUMMARY");
const order = ["parse","upload","extract","verify_extract_docs","embed","cluster","confirm_clusters","naming","chat_review"];
let allPassed = true;
for (const s of order) {
  const r = results[s];
  if (!r) continue;
  const icon   = r.passed ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
  const detail = Object.entries(r)
    .filter(([k]) => !["passed"].includes(k))
    .map(([k,v]) => `${k}=${v}`)
    .join("  ");
  console.log(`  ${icon}  ${C.bold}${s.padEnd(10)}${C.reset}  ${r.passed ? C.dim : C.red}${detail}${C.reset}`);
  if (!r.passed) allPassed = false;
}
console.log();
if (allPassed) {
  console.log(`${C.green}${C.bold}All stages passed ✓${C.reset}`);
} else {
  const failed = order.filter(s => results[s] && !results[s].passed);
  console.log(`${C.red}${C.bold}Failed stages: ${failed.join(", ")}${C.reset}`);
}
console.log();
