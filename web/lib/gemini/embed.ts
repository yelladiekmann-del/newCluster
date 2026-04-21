/**
 * Port of utils.py embedding functions.
 * Calls Gemini Embedding API directly — no Cloud Run needed.
 */

import { DIMENSIONS } from "@/types";
import type { Dimension } from "@/types";

const EMBED_MODEL = "gemini-embedding-001";
const EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent`;
const DIM_PER_FIELD = 256;

/** How many companies to embed in parallel. 10 companies × 8 dims = 80 concurrent Gemini calls max. */
const COMPANY_CONCURRENCY = 10;

/** Per-company internal dimension concurrency (unchanged). */
const DIM_CONCURRENCY = 8;

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

// ── Single embedding ──────────────────────────────────────────────────────────

/**
 * Embed a single text string.
 * Returns a zero vector ONLY for genuinely empty text (< 3 chars).
 * Throws EmbedError for API failures or quota exhaustion — callers must handle.
 */
async function getEmbedding(
  text: string,
  apiKey: string,
  sem: Semaphore,
  dim = DIM_PER_FIELD
): Promise<number[]> {
  const clean = String(text ?? "").trim().slice(0, 8000);
  // Legitimately empty — return zeros (not a failure)
  if (clean.length < 3) return new Array(dim).fill(0);

  const payload = {
    model: `models/${EMBED_MODEL}`,
    content: { parts: [{ text: clean }] },
    taskType: "CLUSTERING",
    outputDimensionality: dim,
  };

  for (let attempt = 0; attempt < 5; attempt++) {
    await sem.acquire();
    let res: Response;
    try {
      res = await fetch(`${EMBED_URL}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } finally {
      sem.release();
    }

    if (res.status === 429) {
      // Rate limited — back off and retry
      await sleep((2 ** attempt) * 1000 + Math.random() * 1000);
      continue;
    }

    if (!res.ok) {
      // Non-retryable API error
      throw new EmbedError(
        "api_error",
        `Gemini API returned ${res.status} for embedding request`
      );
    }

    const json = await res.json();
    const values: number[] = json?.embedding?.values ?? [];
    if (!values.length) {
      throw new EmbedError("empty_response", "Gemini API returned an empty embedding vector");
    }
    return l2Normalize(values);
  }

  // All 5 attempts hit 429 → quota exhausted
  throw new EmbedError(
    "quota_exhausted",
    "Gemini API rate limit exceeded after 5 retries. Your quota may be exhausted — wait and re-embed."
  );
}

// ── Per-dimension embedding for one company ───────────────────────────────────

/**
 * Embeds all 8 dimensions for a single company in parallel.
 * Throws EmbedError if any dimension fails (callers track this as a company-level error).
 */
async function getPerDimensionEmbedding(
  dimensions: Record<string, string>,
  weights: Record<string, number>,
  apiKey: string,
  sem: Semaphore
): Promise<number[]> {
  const dims = DIMENSIONS.filter((d) => dimensions[d] !== undefined);
  if (!dims.length) return new Array(DIM_PER_FIELD * DIMENSIONS.length).fill(0);

  // Embed all dimensions in parallel (batched by DIM_CONCURRENCY)
  // Errors propagate — do NOT catch here
  const parts: number[][] = new Array(dims.length);
  for (let i = 0; i < dims.length; i += DIM_CONCURRENCY) {
    const chunk = dims.slice(i, i + DIM_CONCURRENCY);
    const vecs = await Promise.all(
      chunk.map((d) => getEmbedding(dimensions[d] ?? "unknown", apiKey, sem, DIM_PER_FIELD))
    );
    chunk.forEach((d, j) => {
      const w = weights[d] ?? 1.0;
      parts[i + j] = vecs[j].map((v) => v * w);
    });
  }

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

  // Shared semaphore caps total concurrent Gemini API calls
  // COMPANY_CONCURRENCY companies × DIM_CONCURRENCY dims = max concurrent calls
  const sem = new Semaphore(COMPANY_CONCURRENCY * DIM_CONCURRENCY);

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
