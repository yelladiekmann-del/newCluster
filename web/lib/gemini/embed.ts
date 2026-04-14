/**
 * Port of utils.py embedding functions.
 * Calls Gemini Embedding API directly — no Cloud Run needed.
 */

import { DIMENSIONS } from "@/types";
import type { Dimension } from "@/types";

const EMBED_MODEL = "gemini-embedding-001";
const EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent`;
const DIM_PER_FIELD = 256;
const CONCURRENCY = 8; // parallel dimension embeds per company

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

// ── Single embedding ──────────────────────────────────────────────────────────

async function getEmbedding(
  text: string,
  apiKey: string,
  dim = DIM_PER_FIELD
): Promise<number[]> {
  const clean = String(text ?? "").trim().slice(0, 8000);
  if (clean.length < 3) return new Array(dim).fill(0);

  const payload = {
    model: `models/${EMBED_MODEL}`,
    content: { parts: [{ text: clean }] },
    taskType: "CLUSTERING",
    outputDimensionality: dim,
  };

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${EMBED_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.status === 429) {
      await sleep((2 ** attempt) * 1000 + Math.random() * 1000);
      continue;
    }
    if (!res.ok) return new Array(dim).fill(0);

    const json = await res.json();
    const values: number[] = json?.embedding?.values ?? [];
    if (!values.length) return new Array(dim).fill(0);
    return l2Normalize(values);
  }
  return new Array(dim).fill(0);
}

// ── Per-dimension embedding for one company ───────────────────────────────────

async function getPerDimensionEmbedding(
  dimensions: Record<string, string>,
  weights: Record<string, number>,
  apiKey: string
): Promise<number[]> {
  const dims = DIMENSIONS.filter((d) => dimensions[d] !== undefined);
  if (!dims.length) return new Array(DIM_PER_FIELD * DIMENSIONS.length).fill(0);

  // Embed all dimensions in parallel (batched by CONCURRENCY)
  const parts: number[][] = new Array(dims.length);
  for (let i = 0; i < dims.length; i += CONCURRENCY) {
    const chunk = dims.slice(i, i + CONCURRENCY);
    const vecs = await Promise.all(
      chunk.map((d) => getEmbedding(dimensions[d] ?? "unknown", apiKey, DIM_PER_FIELD))
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
  // Each row is streamed inline to avoid a large final payload
  row: number[];
}

export interface EmbedDone {
  type: "done";
}

export type EmbedEvent = EmbedProgress | EmbedDone;

export async function* embedAll(
  companies: CompanyInput[],
  apiKey: string,
  weights?: Record<string, number> | null
): AsyncGenerator<EmbedEvent> {
  const w = weights ?? DEFAULT_WEIGHTS;
  let errors = 0;

  for (let i = 0; i < companies.length; i++) {
    let vec: number[];
    try {
      vec = await getPerDimensionEmbedding(companies[i].dimensions, w, apiKey);
    } catch {
      vec = new Array(DIM_PER_FIELD * DIMENSIONS.length).fill(0);
      errors++;
    }
    // Round to 5 decimal places to keep event payloads small
    yield {
      type: "progress",
      done: i + 1,
      total: companies.length,
      errors,
      row: vec.map((v) => Math.round(v * 1e5) / 1e5),
    };
  }

  yield { type: "done" };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function l2Normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm > 0 ? v.map((x) => x / norm) : v;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
