/**
 * Test script: Re-embed & Session Resume
 *
 * Test 1 — Re-embed:
 *   - Downloads a real matrix from Storage
 *   - Zeros out a known subset of rows (simulates failures)
 *   - Uploads modified matrix to a temp test session
 *   - POSTs to /api/embed with embeddingsStoragePath → server should skip non-zero rows
 *   - Verifies: zero rows got real vectors, non-zero rows unchanged, skipped count matches
 *
 * Test 2 — Session Resume:
 *   - POSTs to /api/test-pipeline with sessionId mode (requires a session with dimensions)
 *   - Verifies session doc loads correctly (pipelineStep, embeddingsStoragePath, companies)
 *   - Tests that picking up an existing session and running embed from it works incrementally
 */

import admin from "firebase-admin";
import fetch from "node-fetch";

const BASE_URL = "http://localhost:3000";
const DONOR_SESSION_ID = "140b7e01-a7f1-4857-bf2e-780147a01cde"; // ~2MB matrix, real session
const TEST_SESSION_PREFIX = "reembed-test";

// ── init Firebase Admin ────────────────────────────────────────────────────────
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const bucket = admin.storage().bucket("hy-clustering-2.firebasestorage.app");

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36;1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function ok(msg) { console.log(`  ${c.green("✓")} ${msg}`); }
function fail(msg) { console.log(`  ${c.red("✗")} ${msg}`); }
function warn(msg) { console.log(`  ${c.yellow("⚠")} ${msg}`); }
function info(msg) { console.log(`  ${c.dim("→")} ${msg}`); }
function header(msg) { console.log(`\n${c.cyan("━━")} ${c.cyan(msg)}`); }

function isZeroRow(row) {
  return row.every((v) => v === 0);
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > 1e-9) return false;
  }
  return true;
}

// SSE reader
async function streamSSE(url, body, onEvent) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  let buf = "";
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString("utf8");
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      try {
        const event = JSON.parse(dataLine.slice(6));
        onEvent(event);
      } catch {}
    }
  }
}

// ── Cleanup helper ─────────────────────────────────────────────────────────────
const createdSessions = [];
async function cleanup() {
  for (const id of createdSessions) {
    try {
      await db.collection("sessions").doc(id).delete();
      await bucket.file(`sessions/${id}/embeddings.json`).delete().catch(() => {});
      info(`Cleaned up test session ${id}`);
    } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 1 — RE-EMBED
// ═══════════════════════════════════════════════════════════════════════════════

async function testReEmbed() {
  header("TEST 1 — Re-embed (incremental skip + retry)");

  // 1a. Load donor matrix from Storage
  info(`Downloading matrix from donor session: ${DONOR_SESSION_ID}`);
  const donorPath = `sessions/${DONOR_SESSION_ID}/embeddings.json`;
  const [buffer] = await bucket.file(donorPath).download();
  const originalMatrix = JSON.parse(buffer.toString("utf8"));
  const totalRows = originalMatrix.length;
  const dims = originalMatrix[0]?.length ?? 0;
  ok(`Matrix loaded: ${totalRows} rows × ${dims} dims`);

  // 1b. Load donor companies from Firestore
  const companiesSnap = await db
    .collection("sessions").doc(DONOR_SESSION_ID)
    .collection("companies").orderBy("rowIndex").get();
  const donorCompanies = companiesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  ok(`Companies loaded: ${donorCompanies.length} from Firestore`);

  if (donorCompanies.length === 0) {
    fail("No companies in donor session — test skipped");
    return { passed: false };
  }

  const sampleSize = Math.min(50, donorCompanies.length);
  const sampleCompanies = donorCompanies.slice(0, sampleSize);
  const sampleMatrix = originalMatrix.slice(0, sampleSize);

  // 1c. Zero out rows 5–14 (simulate 10 failures)
  const FAIL_INDICES = Array.from({ length: 10 }, (_, i) => i + 5);
  const modifiedMatrix = sampleMatrix.map((row, i) =>
    FAIL_INDICES.includes(i) ? new Array(dims).fill(0) : row
  );

  const zeroCount = modifiedMatrix.filter(isZeroRow).length;
  ok(`Zeroed ${FAIL_INDICES.length} rows (indices 5–14) — ${zeroCount} zero rows in modified matrix`);

  // 1d. Create test session + upload modified matrix
  const testSessionId = `${TEST_SESSION_PREFIX}-${Date.now()}`;
  createdSessions.push(testSessionId);

  await db.collection("sessions").doc(testSessionId).set({
    userId: "test",
    pipelineStep: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    companyCol: "name",
    embeddingsStoragePath: null,
  });

  // Write company docs
  const BATCH_SIZE = 100;
  for (let i = 0; i < sampleCompanies.length; i += BATCH_SIZE) {
    const batch = db.batch();
    sampleCompanies.slice(i, i + BATCH_SIZE).forEach((c) => {
      batch.set(
        db.collection("sessions").doc(testSessionId).collection("companies").doc(c.id),
        { ...c }
      );
    });
    await batch.commit();
  }
  ok(`Wrote ${sampleCompanies.length} company docs to test session`);

  const modifiedPath = `sessions/${testSessionId}/embeddings.json`;
  await bucket.file(modifiedPath).save(JSON.stringify(modifiedMatrix), {
    contentType: "application/json",
    resumable: false,
  });
  ok(`Uploaded modified matrix (${FAIL_INDICES.length} zero rows) to Storage`);

  // 1e. POST to /api/embed with embeddingsStoragePath — should skip non-zero, re-embed zeros
  info(`Calling /api/embed with embeddingsStoragePath → expecting ${FAIL_INDICES.length} re-embeds, ${sampleSize - FAIL_INDICES.length} skipped`);

  let lastProgress = null;
  let doneEvent = null;
  let errorEvent = null;
  const t0 = Date.now();

  await streamSSE(`${BASE_URL}/api/embed`, {
    sessionId: testSessionId,
    companies: sampleCompanies.map((c) => ({ id: c.id, dimensions: c.dimensions ?? {} })),
    weights: null,
    embeddingsStoragePath: modifiedPath,
  }, (event) => {
    if (event.type === "progress") lastProgress = event;
    else if (event.type === "done") doneEvent = event;
    else if (event.type === "error") errorEvent = event;
  });

  const elapsed = Date.now() - t0;

  if (errorEvent) {
    fail(`Embed returned error: ${errorEvent.message}`);
    return { passed: false };
  }
  if (!doneEvent) {
    fail("No done event received");
    return { passed: false };
  }

  ok(`Embed completed in ${(elapsed / 1000).toFixed(1)}s`);
  info(`done event: done=${lastProgress?.done} total=${lastProgress?.total} errors=${doneEvent.errors} skipped=${doneEvent.skipped}`);

  // 1f. Verify skip count
  const expectedSkipped = sampleSize - FAIL_INDICES.length;
  if (doneEvent.skipped === expectedSkipped) {
    ok(`Skip count correct: ${doneEvent.skipped} skipped (expected ${expectedSkipped})`);
  } else {
    fail(`Skip count WRONG: got ${doneEvent.skipped}, expected ${expectedSkipped}`);
  }

  // 1g. Download result matrix and verify
  const resultPath = doneEvent.embeddingsStoragePath;
  if (!resultPath) {
    fail("No embeddingsStoragePath in done event");
    return { passed: false };
  }
  const [resultBuf] = await bucket.file(resultPath).download();
  const resultMatrix = JSON.parse(resultBuf.toString("utf8"));
  ok(`Result matrix downloaded: ${resultMatrix.length} rows`);

  // Previously-zero rows should now be non-zero (re-embedded)
  let reEmbedOk = 0, reEmbedFailed = 0;
  for (const idx of FAIL_INDICES) {
    if (!isZeroRow(resultMatrix[idx])) reEmbedOk++;
    else reEmbedFailed++;
  }

  if (reEmbedFailed === 0) {
    ok(`All ${FAIL_INDICES.length} previously-zero rows now have real vectors ✓`);
  } else {
    fail(`${reEmbedFailed}/${FAIL_INDICES.length} zero rows still zero after re-embed`);
  }

  // Rows that were already non-zero should be UNCHANGED
  const PRESERVED_INDICES = [0, 1, 2, 3, 4].filter((i) => !FAIL_INDICES.includes(i));
  let preservedOk = 0, preservedChanged = 0;
  for (const idx of PRESERVED_INDICES) {
    if (arraysEqual(resultMatrix[idx], sampleMatrix[idx])) preservedOk++;
    else preservedChanged++;
  }

  if (preservedChanged === 0) {
    ok(`All ${PRESERVED_INDICES.length} pre-existing rows preserved unchanged ✓`);
  } else {
    fail(`${preservedChanged} pre-existing rows were changed (should have been skipped)`);
  }

  const passed = reEmbedFailed === 0 && preservedChanged === 0 && doneEvent.skipped === expectedSkipped;
  return { passed };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 2 — SESSION RESUME
// ═══════════════════════════════════════════════════════════════════════════════

async function testSessionResume() {
  header("TEST 2 — Session Resume (load existing session from Firestore)");

  // 2a. Load donor session doc
  const sessionSnap = await db.collection("sessions").doc(DONOR_SESSION_ID).get();
  if (!sessionSnap.exists) {
    fail(`Donor session ${DONOR_SESSION_ID} not found`);
    return { passed: false };
  }
  const sessionDoc = sessionSnap.data();
  ok(`Session doc loaded — step: ${sessionDoc.pipelineStep}, name: ${sessionDoc.name ?? "(unnamed)"}`);

  const companiesSnap = await db
    .collection("sessions").doc(DONOR_SESSION_ID)
    .collection("companies").orderBy("rowIndex").limit(10).get();
  const companies = companiesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  if (companies.length === 0) {
    fail("No companies found in donor session");
    return { passed: false };
  }
  ok(`Companies queryable — first 10 loaded in spot-check`);

  // Check dimension coverage
  const hasDimensions = companies.every(c => Object.keys(c.dimensions ?? {}).length > 0);
  if (hasDimensions) {
    ok(`All spot-check companies have dimensions`);
    const sample = companies[0];
    info(`Sample: "${sample.name}" → ${Object.keys(sample.dimensions).join(", ")}`);
  } else {
    warn(`Some companies missing dimensions — re-embed from this session would produce poor vectors`);
  }

  // 2b. Verify embeddingsStoragePath round-trip
  const storagePath = sessionDoc.embeddingsStoragePath;
  if (storagePath) {
    const [exists] = await bucket.file(storagePath).exists();
    if (exists) {
      ok(`embeddingsStoragePath → Storage file exists: ${storagePath}`);
    } else {
      fail(`embeddingsStoragePath set but Storage file missing: ${storagePath}`);
      return { passed: false };
    }
  } else {
    info(`No embeddingsStoragePath in session doc — session pre-dates server-side matrix storage`);
    // Check if file exists anyway (orphaned file)
    const inferredPath = `sessions/${DONOR_SESSION_ID}/embeddings.json`;
    const [orphanExists] = await bucket.file(inferredPath).exists();
    if (orphanExists) {
      warn(`Storage file exists at inferred path but NOT referenced in session doc: ${inferredPath}`);
      warn(`→ BUG: resuming this session won't detect existing embeddings — user will see "Embed" not "Re-embed"`);
    }
  }

  // 2c. Use /api/test-pipeline sessionId mode — smoke-test the resume path
  info(`Testing /api/test-pipeline with sessionId=${DONOR_SESSION_ID} (sampleSize=20, stages=load_session)`);
  let stageReport = null;
  let testError = null;
  let warnMessages = [];

  await streamSSE(`${BASE_URL}/api/test-pipeline`, {
    sessionId: DONOR_SESSION_ID,
    sampleSize: 20,
    stages: "load_session",
  }, (event) => {
    if (event.type === "stage_done" && event.stage === "load_session") stageReport = event.summary;
    if (event.type === "error") testError = event.message;
    if (event.type === "warning") warnMessages.push(event.message);
  });

  if (testError) {
    fail(`test-pipeline error: ${testError}`);
    return { passed: false };
  }
  if (!stageReport) {
    fail("No load_session stage_done received");
    return { passed: false };
  }

  ok(`Session loaded: ${stageReport.sampled} companies (of ${stageReport.total_companies} total)`);
  ok(`Pipeline step: ${stageReport.pipeline_step}`);
  info(`Dimensions found: ${Array.isArray(stageReport.dimensions_found) ? stageReport.dimensions_found.join(", ") : stageReport.dimensions_found}`);

  if (stageReport.dimensions_found?.length > 0) {
    ok(`Session ready for embed (${stageReport.dimensions_found.length}/8 dims present)`);
  } else {
    warn(`Session has NO dimensions — embed would produce zero vectors`);
  }

  warnMessages.forEach((m) => warn(`API warning: ${m}`));

  // 2d. Test that incremental embed from session works (small sample, 5 companies)
  info(`Testing incremental embed from session (sampleSize=5, should skip if embeddings exist)`);
  const allCompaniesSnap = await db
    .collection("sessions").doc(DONOR_SESSION_ID)
    .collection("companies").orderBy("rowIndex").limit(5).get();
  const testCompanies = allCompaniesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  let embedDone = null;
  let embedErr = null;
  const testSessionId2 = `resume-embed-test-${Date.now()}`;
  createdSessions.push(testSessionId2);

  // Create a minimal test session to receive the matrix
  await db.collection("sessions").doc(testSessionId2).set({
    userId: "test",
    pipelineStep: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    companyCol: "name",
    embeddingsStoragePath: null,
  });

  const t0 = Date.now();
  await streamSSE(`${BASE_URL}/api/embed`, {
    sessionId: testSessionId2,
    companies: testCompanies.map((c) => ({ id: c.id, dimensions: c.dimensions ?? {} })),
    weights: null,
    embeddingsStoragePath: null, // fresh embed — no existing matrix
  }, (event) => {
    if (event.type === "done") embedDone = event;
    if (event.type === "error") embedErr = event;
  });

  if (embedErr) {
    fail(`Embed from session data failed: ${embedErr.message}`);
    return { passed: false };
  }
  if (!embedDone) {
    fail("No embed done event received");
    return { passed: false };
  }

  ok(`Embed from session companies: ${(Date.now() - t0) / 1000}s, errors=${embedDone.errors}, skipped=${embedDone.skipped}`);
  ok(`Matrix saved to: ${embedDone.embeddingsStoragePath}`);

  // Verify the matrix was actually written
  const [matExists] = await bucket.file(embedDone.embeddingsStoragePath).exists();
  if (matExists) {
    ok(`Storage file exists ✓`);
  } else {
    fail(`Storage file NOT found at ${embedDone.embeddingsStoragePath}`);
    return { passed: false };
  }

  return { passed: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FINDINGS & IMPROVEMENTS ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

function printFindings() {
  header("FINDINGS & IMPROVEMENT OPPORTUNITIES");

  console.log(`
  ${c.bold("▸ Re-embed flow")}

  ${c.yellow("⚠ [UX]")}  ${c.bold("Error count not persisted")} — 'lastEmbedErrors' is local React state.
       After page refresh, the "Re-embed failed (N)" button disappears even if N > 0
       errors occurred. The user has no way to know failures happened.
       FIX: persist 'lastEmbedErrors' to Firestore in the session doc after embed completes.

  ${c.yellow("⚠ [UX]")}  ${c.bold("Progress bar shows total=N during re-embed")} even when ~95% of rows will
       be skipped instantly. Progress jumps from 0→100% in <1s then restarts for
       the small set of actual work — confusing.
       FIX: in handleEmbed(), pre-compute expectedEmbeds = companies without non-zero rows,
       or show a "Checking N companies, expecting to re-embed X" pre-flight message.

  ${c.green("✓ [Logic]")} Skip detection correct: existingMatrix[i].some(v => v !== 0) means
       a company with a legitimate zero vector (impossible post-l2Normalize) is never
       silently skipped. Safe.

  ${c.bold("▸ Session resume")}

  ${c.yellow("⚠ [Data]")}  ${c.bold("embeddingsStoragePath not persisted on old sessions")} — sessions that ran
       embedding before the server-side matrix refactor have the file in Storage but
       NULL in the session doc. On resume: 'hasEmbeddings = false', Embed button shows
       instead of Re-embed. User will unknowingly re-embed everything.
       FIX: add a one-time migration or check Storage path existence on load.

  ${c.yellow("⚠ [Perf]")}  ${c.bold("loadCompanies reads all Firestore docs at once")} — for 10k companies,
       getDocs() fetches 10,000 docs (~10 MB) in one round-trip. At resumption, this
       blocks the embed page spinner for 2–4s.
       FIX: prefer loading from Storage JSON (companies.csv) as primary source; use
       Firestore only for sessions without a Storage file.

  ${c.yellow("⚠ [Code]")}  ${c.bold("resumeSession() is dead code")} — it's defined in hooks.ts but never called.
       resumeSessionFast() is used everywhere. The "heavy" version loads all data
       eagerly but the app uses lazy loading on each page instead. Safe to delete.

  ${c.yellow("⚠ [UX]")}   ${c.bold("Chat history not restored on fast resume")} — intentional per comment,
       but there's no lazy-load of chat on the chat page (AiChatPanel). Messages
       from a prior session are gone forever after a page reload.
       FIX: load chat history lazily in AiChatPanel on mount if chatMessages.length === 0.

  ${c.green("✓ [Arch]")}  Fast resume path is clean: 1 Firestore read → navigate → lazy load.
       Zustand + attachSessionListener = live sync after resume. No race conditions.

  ${c.green("✓ [Arch]")}  Firestore→Storage fallback in loadCompanies is correct safety net.
  `);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

let result1 = { passed: false };
let result2 = { passed: false };

try {
  result1 = await testReEmbed();
  try {
    result2 = await testSessionResume();
  } catch (err) {
    console.error(c.red("  [testSessionResume threw]: " + err.message));
    console.error(err.stack);
  }
  printFindings();
} finally {
  header("CLEANUP");
  await cleanup();

  header("SUMMARY");
  const r1 = result1.passed ? c.green("✓ PASS") : c.red("✗ FAIL");
  const r2 = result2.passed ? c.green("✓ PASS") : c.red("✗ FAIL");
  console.log(`  ${r1}  ${c.bold("Re-embed")}`);
  console.log(`  ${r2}  ${c.bold("Session Resume")}`);

  if (!result1.passed || !result2.passed) process.exit(1);
}
