/**
 * Port of dimension_extraction.py
 * Calls Gemini 2.5 Flash to extract 8 business dimensions per company.
 * Processes in batches of 20 with fallback to per-company extraction.
 */

import type { Dimension } from "@/types";
import { DIMENSIONS } from "@/types";

const GEN_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

const BATCH_SIZE = 20;

export interface CompanyRow {
  name: string;
  description: string;
}

export type DimensionResult = Partial<Record<Dimension, string>>;

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

// ── Prompt builders ──────────────────────────────────────────────────────────

function buildBatchPrompt(rows: CompanyRow[]): string {
  const companiesList = rows
    .map(
      (r, i) =>
        `${i + 1}. ${r.name}: ${r.description?.slice(0, 500) || "(no description)"}`
    )
    .join("\n");

  return `You are a startup analyst. For each company below, extract exactly 8 dimensions as a JSON array. Return ONLY a JSON array with no markdown formatting.

Each element must be a JSON object with these exact keys:
- "Problem Solved": core problem addressed, ≤8 words
- "Customer Segment": who benefits, be concrete (e.g. "mid-market logistics ops teams")
- "Core Mechanism": how it works, ≤10 words
- "Tech Category": single best fit from: AI/ML, SaaS, Marketplace, Fintech, Healthtech, Edtech, Hardware, API/Infrastructure, Logistics, Analytics, Other
- "Business Model": single best fit from: B2B SaaS, B2C, Marketplace, API/Usage-based, Hardware, Professional Services, Hybrid
- "Value Shift": legacy/incumbent displaced, ≤8 words
- "Ecosystem Role": single from: Enabler, Optimizer, Disruptor, Infrastructure
- "Scalability Lever": single from: Network effects, Data flywheel, Platform, Distribution, Automation, Regulatory moat, Brand

Companies:
${companiesList}

Return a JSON array of ${rows.length} objects, one per company, in the same order.`;
}

function buildSinglePrompt(row: CompanyRow): string {
  return `You are a startup analyst. Extract 8 dimensions for this company and return ONLY a JSON object with no markdown.

Company: ${row.name}
Description: ${row.description?.slice(0, 500) || "(no description)"}

Return a single JSON object with these exact keys:
- "Problem Solved": ≤8 words
- "Customer Segment": concrete segment
- "Core Mechanism": ≤10 words
- "Tech Category": AI/ML | SaaS | Marketplace | Fintech | Healthtech | Edtech | Hardware | API/Infrastructure | Logistics | Analytics | Other
- "Business Model": B2B SaaS | B2C | Marketplace | API/Usage-based | Hardware | Professional Services | Hybrid
- "Value Shift": ≤8 words
- "Ecosystem Role": Enabler | Optimizer | Disruptor | Infrastructure
- "Scalability Lever": Network effects | Data flywheel | Platform | Distribution | Automation | Regulatory moat | Brand`;
}

// ── JSON repair ──────────────────────────────────────────────────────────────

function repairJson(raw: string): string {
  // Strip markdown fences
  let s = raw.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
  // Remove trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, "$1");
  return s;
}

// ── Gemini caller ────────────────────────────────────────────────────────────

async function callGemini(
  apiKey: string,
  prompt: string,
  attempt = 0
): Promise<string | null> {
  try {
    const res = await fetch(`${GEN_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 },
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (res.status === 429 && attempt < 4) {
      await new Promise((r) =>
        setTimeout(r, Math.pow(2, attempt) * 1000 + Math.random() * 500)
      );
      return callGemini(apiKey, prompt, attempt + 1);
    }

    if (!res.ok) return null;

    const data: GeminiResponse = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  } catch {
    return null;
  }
}

// ── Batch extraction ─────────────────────────────────────────────────────────

async function extractBatch(
  apiKey: string,
  rows: CompanyRow[]
): Promise<DimensionResult[]> {
  const text = await callGemini(apiKey, buildBatchPrompt(rows));
  if (!text) return rows.map(() => ({}));

  try {
    const parsed = JSON.parse(repairJson(text));
    if (Array.isArray(parsed) && parsed.length === rows.length) {
      return parsed.map((item) => pickDimensions(item));
    }
  } catch {
    // Fallthrough to per-company
  }

  // Fallback: extract per-company in parallel
  const results = await Promise.all(
    rows.map((r) => extractSingle(apiKey, r))
  );
  return results;
}

async function extractSingle(
  apiKey: string,
  row: CompanyRow
): Promise<DimensionResult> {
  const text = await callGemini(apiKey, buildSinglePrompt(row));
  if (!text) return {};

  try {
    const parsed = JSON.parse(repairJson(text));
    return pickDimensions(parsed);
  } catch {
    return {};
  }
}

function pickDimensions(obj: Record<string, unknown>): DimensionResult {
  const result: DimensionResult = {};
  for (const dim of DIMENSIONS) {
    if (typeof obj[dim] === "string") {
      result[dim] = (obj[dim] as string).trim();
    }
  }
  return result;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface ExtractionProgress {
  done: number;
  total: number;
  errors: number;
}

/**
 * Extract dimensions for all rows, calling `onProgress` after each batch.
 * Returns an array of DimensionResult in the same order as `rows`.
 */
export async function extractAllDimensions(
  apiKey: string,
  rows: CompanyRow[],
  onProgress?: (p: ExtractionProgress) => void
): Promise<DimensionResult[]> {
  const results: DimensionResult[] = new Array(rows.length).fill({});
  let done = 0;
  let errors = 0;

  // Process BATCH_SIZE companies at a time, sequentially to respect rate limits
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const batchResults = await extractBatch(apiKey, batch);

    for (let j = 0; j < batch.length; j++) {
      results[i + j] = batchResults[j];
      if (Object.keys(batchResults[j]).length === 0) errors++;
      done++;
    }

    onProgress?.({ done, total: rows.length, errors });
  }

  return results;
}
