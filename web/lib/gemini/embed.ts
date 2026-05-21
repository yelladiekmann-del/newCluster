/**
 * Port of utils.py embedding functions.
 * Calls Gemini Embedding API directly — no Cloud Run needed.
 */

import { DIMENSIONS } from "@/types";
import type { Dimension } from "@/types";

const EMBED_MODEL = "gemini-embedding-001";
const BATCH_EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents`;
const DIM_PER_FIELD = 256;

/**
 * How many companies to embed in parallel.
 * Each company now makes ONE batch API call (all 8 dims at once), so we can
 * safely run more concurrently than before. 20 parallel batch calls ≈ 160
 * dimension embeddings in flight — well within rate limits.
 */
const COMPANY_CONCURRENCY = 20;

const DEFAULT_WEIGHTS: Record<Dimension, number> = {
  "Problem Solved":    1.4,
  "Customer Segment":  1.2,
  "Core Mechanism":    1.3,
  "Tech Category":     1.1,
  "Business Model":    1.2,
  "Value Shift":       0.9,
  "Ecosystem Role":    0.7,
  "Scalability Lever": 0.8,
};

// ── Typed embedding error ─────────────────────────────────────────────────────

export class EmbedError extends Error {
  constructor(
    public readonly reason: "api_error" | "quota_exhausted" | "empty_response",
    message: string
  ) {
    super(message);
    this.name = "EmbedError";
  }
}

// ── Semaphore for total API concurrency control ───────────────────────────────

class Semaphore {
  private count: number;
  private queue: (() => void)[] = [];

  constructor(count: number) {
    this.count = count;
  }

  acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    if (this.queue.length > 0) {
      this.queue.shift()!();
    } else {
      this.count++;
    }
  }
}

// ── Batch embedding (all dimensions for one company in one API call) ──────────

/**
 * Sends all dimension texts for ONE company in a single batchEmbedContents call.
 * Returns one vector per input text (null if the API returned an empty embedding).
 *
 * Using batchEmbedContents instead of per-text embedContent reduces API calls
 * from (companies × 8) to just (companies × 1) — an 8× reduction that keeps
 * us well within Gemini's RPM quota even at 10 k companies.
 *
 * Throws EmbedError on non-retryable failures or quota exhaustion.
 */
async function batchEmbedTexts(
  texts: string[],
  apiKey: string,
  sem: Semaphore,
  dim = DIM_PER_FIELD
): Promise<(number[] | null)[]> {
  const requests = texts.map((text) => ({
    model: `models/${EMBED_MODEL}`,
    content: { parts: [{ text }] },
    taskType: "CLUSTERING",
    outputDimensionality: dim,
  }));

  for (let attempt = 0; attempt < 5; attempt++) {
    await sem.acquire();
    let res: Response;
    try {
      res = await fetch(`${BATCH_EMBED_URL}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests }),
      });
    } finally {
      sem.release();
    }

    if (res.status === 429) {
      // Rate limited — exponential back-off and retry
      await sleep((2 ** attempt) * 1000 + Math.random() * 1000);
      continue;
    }

    if (!res.ok) {
      throw new EmbedError(
        "api_error",
        `Gemini batch API returned ${res.status} for embedding request`
      );
    }

    const json = await res.json();
    const embeddings: { values?: number[] }[] = json?.embeddings ?? [];
    return embeddings.map((e) => {
      const values = e?.values ?? [];
      return values.length ? l2Normalize(values) : null;
    });
  }

  // All 5 attempts hit 429 → quota exhausted
  throw new EmbedError(
    "quota_exhausted",
    "Gemini API rate limit exceeded after 5 retries. Your quota may be exhausted — wait and re-embed."
  );
}

// ── Per-dimension embedding for one company ───────────────────────────────────

/**
 * Embeds all 8 dimensions for a single company in ONE batch API call.
 *
 * CRITICAL: always allocates ALL 8 dimension slots, initialised to zero vectors.
 * If a company is missing some dimensions (partial extraction), those slots stay
 * as zero vectors. This guarantees every company produces exactly
 * DIMENSIONS.length × DIM_PER_FIELD = 2048 values — a homogeneous matrix.
 * Without this, companies with 7/8 dims produce 1792-dim rows, causing NumPy's
 * "inhomogeneous shape" crash in the ML service when building the feature matrix.
 *
 * Throws EmbedError if the batch call fails (callers track this as a company-level error).
 */
async function getPerDimensionEmbedding(
  dimensions: Record<string, string>,
  weights: Record<string, number>,
  apiKey: string,
  sem: Semaphore
): Promise<number[]> {
  // Build text array aligned with DIMENSIONS order.
  // Empty/trivial texts (< 3 chars) are represented by an empty string sentinel.
  const texts = DIMENSIONS.map((d) => {
    const val = String(dimensions[d] ?? "").trim().slice(0, 8000);
    return val.length >= 3 ? val : "";
  });

  const nonEmptyCount = texts.filter((t) => t.length >= 3).length;
  if (nonEmptyCount === 0) {
    // All dimensions missing — return a zero vector (not a failure)
    return new Array(DIM_PER_FIELD * DIMENSIONS.length).fill(0);
  }

  // Only send non-empty texts to the API; track their canonical dimension indices.
  const batchIndices: number[] = []; // batchIndex → canonical DIMENSIONS index
  const batchTexts: string[] = [];
  texts.forEach((t, i) => {
    if (t.length >= 3) {
      batchIndices.push(i);
      batchTexts.push(t);
    }
  });

  // ONE API call for all non-empty dimensions of this company.
  const batchResults = await batchEmbedTexts(batchTexts, apiKey, sem);

  // Write results into canonical slots; empty/failed slots stay as zero vectors.
  const parts: number[][] = DIMENSIONS.map(() => new Array(DIM_PER_FIELD).fill(0));
  batchIndices.forEach((dimIdx, batchIdx) => {
    const vec = batchResults[batchIdx];
    if (vec) {
      const d = DIMENSIONS[dimIdx];
      const w = weights[d] ?? 1.0;
      parts[dimIdx] = vec.map((v) => v * w);
    }
  });

  const combined = ([] as number[]).concat(...parts);
  return l2Normalize(combined);
}

// ── Batch embed all companies (with SSE progress) ─────────────────────────────

export interface CompanyInput {
  id: string;
  dimensions: Record<string, string>;
}

export interface EmbedProgress {
  type: "progress";
  done: number;
  total: number;
  errors: number;
  skipped: number;
  // Each row is streamed inline to avoid a large final payload
  row: number[];
}

export interface EmbedDone {
  type: "done";
  errors: number;
  skipped: number;
}

export type EmbedEvent = EmbedProgress | EmbedDone;

/**
 * Embed all companies, yielding SSE progress events.
 *
 * @param existingMatrix  Previously saved feature matrix. Rows that are non-zero are
 *                        considered already embedded and will be skipped (incremental re-embed).
 *                        Pass null/undefined to force full re-embed.
 */
export async function* embedAll(
  companies: CompanyInput[],
  apiKey: string,
  weights?: Record<string, number> | null,
  existingMatrix?: number[][] | null
): AsyncGenerator<EmbedEvent> {
  const w = weights ?? DEFAULT_WEIGHTS;
  let errors = 0;
  let skipped = 0;

  // Shared semaphore caps total concurrent Gemini batch API calls.
  // With batchEmbedContents each company = 1 call, so the semaphore size
  // equals COMPANY_CONCURRENCY (20 concurrent batch calls in flight).
  const sem = new Semaphore(COMPANY_CONCURRENCY);

  // Ordered result buffer for in-order SSE streaming despite parallel processing
  const results: (number[] | null)[] = new Array(companies.length).fill(null);
  let nextToYield = 0;

  // Process companies in parallel batches
  for (let batchStart = 0; batchStart < companies.length; batchStart += COMPANY_CONCURRENCY) {
    const batchEnd = Math.min(batchStart + COMPANY_CONCURRENCY, companies.length);
    const batchIndices = Array.from({ length: batchEnd - batchStart }, (_, i) => batchStart + i);

    // Run this batch in parallel
    await Promise.all(
      batchIndices.map(async (i) => {
        const existing = existingMatrix?.[i];
        // Skip if already embedded (non-zero vector from a previous run)
        if (existing && existing.length > 0 && existing.some((v) => v !== 0)) {
          results[i] = existing;
          skipped++;
          return;
        }

        try {
          const vec = await getPerDimensionEmbedding(companies[i].dimensions, w, apiKey, sem);
          results[i] = vec;
        } catch (err) {
          if (err instanceof EmbedError) {
            console.warn(`[embed] Company ${companies[i].id} failed: ${err.reason} — ${err.message}`);
          } else {
            console.warn(`[embed] Company ${companies[i].id} unexpected error:`, err);
          }
          results[i] = new Array(DIM_PER_FIELD * DIMENSIONS.length).fill(0);
          errors++;
        }
      })
    );

    // Yield all in-order results from this batch
    while (nextToYield < batchEnd && results[nextToYield] !== null) {
      const row = results[nextToYield]!;
      yield {
        type: "progress",
        done: nextToYield + 1,
        total: companies.length,
        errors,
        skipped,
        row: row.map((v) => Math.round(v * 1e5) / 1e5),
      };
      nextToYield++;
    }
  }

  yield { type: "done", errors, skipped };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function l2Normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm > 0 ? v.map((x) => x / norm) : v;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
