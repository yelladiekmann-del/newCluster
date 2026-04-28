import type { NextRequest } from "next/server";

import { buildClusterSummaries } from "@/lib/server/cluster-summaries";
import { extractFirstJsonObject, parseJsonObject } from "@/lib/server/gemini";
import { getGeminiKey } from "@/lib/server/gemini-key";

export const maxDuration = 300;

const GEN_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

const BATCH_SIZE = 20;
const CONCURRENCY = 4;

interface ResortCompany {
  id: string;
  name: string;
  dimensions: Record<string, string>;
  clusterId: string;
  originalDesc?: string;
}

interface ResortCluster {
  id: string;
  name: string;
  description?: string;
  isOutliers?: boolean;
}

interface BatchAssignment {
  [index: string]: string | Record<string, string> | undefined;
  reasons?: Record<string, string>;
}

interface CandidateCluster {
  clusterId: string;
  clusterName: string;
  score: number;
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
  );
}

function buildClusterTokenMap(
  summaries: Awaited<ReturnType<typeof buildClusterSummaries>>["summaries"]
): Map<string, Set<string>> {
  return new Map(
    summaries.map((summary) => {
      const text = [
        summary.clusterName,
        summary.description,
        ...summary.representativeCompanies,
        ...summary.representativeSnippets,
        ...Object.values(summary.topDimensions).flat(),
      ].join(" ");
      return [summary.clusterId, tokenize(text)];
    })
  );
}

function scoreCandidateClusters(
  company: ResortCompany,
  summaries: Awaited<ReturnType<typeof buildClusterSummaries>>["summaries"],
  clusterTokens: Map<string, Set<string>>,
  clusterNameById: Record<string, string>
): CandidateCluster[] {
  const companyText = [company.originalDesc ?? "", ...Object.values(company.dimensions)].join(" ");
  const companyTokens = tokenize(companyText);

  const scored = summaries.map((summary) => {
    const tokens = clusterTokens.get(summary.clusterId) ?? new Set<string>();
    let overlap = 0;
    for (const token of companyTokens) {
      if (tokens.has(token)) overlap += 1;
    }

    const exactDimensionBoost = Object.values(company.dimensions)
      .filter(Boolean)
      .reduce((sum, value) => {
        const normalized = String(value).toLowerCase();
        const matches = Object.values(summary.topDimensions)
          .flat()
          .some((candidate) => candidate.toLowerCase() === normalized);
        return sum + (matches ? 2 : 0);
      }, 0);

    const currentBoost = company.clusterId === summary.clusterId ? 0.5 : 0;

    return {
      clusterId: summary.clusterId,
      clusterName: clusterNameById[summary.clusterId] ?? summary.clusterName,
      score: overlap + exactDimensionBoost + currentBoost,
    };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, 3);
}

function parseBatchAssignment(raw: string): { assignments: Record<string, string>; reasons: Record<string, string> } {
  const direct = parseJsonObject<BatchAssignment>(raw);
  const extracted = direct ? null : extractFirstJsonObject(raw);
  const parsed = direct ?? (extracted ? parseJsonObject<BatchAssignment>(extracted) : null);

  if (!parsed) {
    console.warn("[api/resort] unable to parse Gemini response", {
      rawExcerpt: raw.slice(0, 300),
    });
    return { assignments: {}, reasons: {} };
  }

  const reasons: Record<string, string> = {};
  if (parsed.reasons && typeof parsed.reasons === "object") {
    Object.assign(reasons, parsed.reasons);
  }

  const assignments: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "reasons") continue;
    if (typeof value === "string" && value.trim()) {
      assignments[key] = value.trim();
    }
  }

  return { assignments, reasons };
}

async function assignBatch(
  apiKey: string,
  batch: ResortCompany[],
  batchOffset: number,
  clusterBlock: string,
  clusterNameById: Record<string, string>,
  validNames: string[],
  includeOutliers: boolean,
  candidateMap?: Record<string, string[]>
): Promise<{ assignments: Record<string, string>; reasons: Record<string, string> }> {
  const companiesBlock = batch
    .map((c, i) => {
      const idx = String(batchOffset + i);
      const currentCluster =
        c.clusterId === "outliers" ? "Outliers" : clusterNameById[c.clusterId] ?? c.clusterId;
      const dimStr = Object.entries(c.dimensions)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join("; ")
        .slice(0, 600);
      const desc = c.originalDesc ? c.originalDesc.slice(0, 600) : dimStr;
      const candidates = candidateMap?.[c.id]?.length
        ? `\n     likely segments: ${candidateMap[c.id].join(", ")}`
        : "";
      return `  "${idx}": ${c.name} (currently: "${currentCluster}") — ${desc}${candidates}`;
    })
    .join("\n");

  const outlierInstruction = includeOutliers
    ? `If a company clearly fits none of the segments, assign it "Outliers".`
    : `Every company MUST be assigned to exactly one of the segments listed.`;

  const validNamesStr = JSON.stringify(includeOutliers ? [...validNames, "Outliers"] : validNames);

  const prompt = `You are a market analyst. Assign each company to the best-fitting market segment based on its description.

MARKET SEGMENTS:
${clusterBlock}

COMPANIES TO ASSIGN:
${companiesBlock}

${outlierInstruction}
Valid segment names: ${validNamesStr}

Return ONLY a JSON object where keys are the company numbers (as strings) and values are the exact segment name:
{"0": "Segment Name", "1": "Other Segment", ...}
Additionally, if any assignment is non-obvious (e.g. moving away from the current segment), add an optional "reasons" key with brief explanations (≤8 words each):
{"0": "Segment A", "reasons": {"0": "KYC focus fits compliance cluster"}}
Omit "reasons" entirely if all assignments are clear. No markdown, just the JSON.`;

  const res = await fetch(`${GEN_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1 },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) throw new Error(`Gemini error ${res.status}`);
  const data = await res.json();
  const raw: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";

  return parseBatchAssignment(raw);
}

export async function POST(req: NextRequest) {
  const apiKey = getGeminiKey();

  try {
    const body = await req.json();
    const {
      companies,
      clusters,
      includeOutliers = false,
    }: {
      companies: ResortCompany[];
      clusters: ResortCluster[];
      includeOutliers: boolean;
    } = body;

    const nonOutlierClusters = clusters.filter((c) => c.id !== "outliers");
    const validNames = nonOutlierClusters.map((c) => c.name);
    const clusterNameById = Object.fromEntries(clusters.map((cluster) => [cluster.id, cluster.name]));

    const pseudoClusters = clusters.map((cluster) => ({
      id: cluster.id,
      name: cluster.name,
      description: cluster.description ?? "",
      color: "",
      isOutliers: cluster.id === "outliers" || !!cluster.isOutliers,
      companyCount: companies.filter((company) => company.clusterId === cluster.id).length,
    }));

    const pseudoCompanies = companies.map((company, index) => ({
      id: company.id,
      rowIndex: index,
      name: company.name,
      originalData: { __desc: company.originalDesc ?? "" },
      dimensions: company.dimensions,
      clusterId: company.clusterId ?? null,
      umapX: null,
      umapY: null,
    }));

    const { summaries } = buildClusterSummaries(pseudoClusters, pseudoCompanies, "__desc");
    const clusterTokens = buildClusterTokenMap(summaries);
    const clusterBlock = summaries
      .map((summary) => {
        const topDimensions = Object.entries(summary.topDimensions)
          .filter(([, values]) => values.length > 0)
          .map(([dimension, values]) => `  ${dimension}: ${values.join(" / ")}`)
          .join("\n");
        const snippets = summary.representativeSnippets
          .map((snippet) => `  - ${snippet}`)
          .join("\n");
        const analystDescription = summary.description?.trim()
          ? summary.description
          : `Companies focused on ${Object.values(summary.topDimensions).flat().slice(0, 2).join(" and ") || "a related operating model"}. They share a similar value proposition within this market segment.`;
        return `"${summary.clusterName}" (${summary.companyCount} companies)
Description: ${analystDescription}
Representative companies: ${summary.representativeCompanies.join(", ") || "—"}
Representative snippets:
${snippets || "  - —"}
Top dimensions:
${topDimensions || "  —"}`;
      })
      .join("\n\n");

    // Filter companies
    const targetCompanies = includeOutliers
      ? companies
      : companies.filter((c) => c.clusterId !== "outliers");
    const candidateMap = Object.fromEntries(
      targetCompanies.map((company) => [
        company.id,
        scoreCandidateClusters(company, summaries, clusterTokens, clusterNameById).map((candidate) => candidate.clusterName),
      ])
    );

    const totalBatches = Math.ceil(targetCompanies.length / BATCH_SIZE);

    // Stream SSE
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: object) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );
        };

        const allAssignments: Record<string, string> = {};
        const allReasons: Record<string, string> = {};
        let doneBatches = 0;
        let doneCompanies = 0;

        try {
          send({
            type: "progress",
            doneBatches,
            totalBatches,
            doneCompanies,
            totalCompanies: targetCompanies.length,
          });

          for (let wave = 0; wave < totalBatches; wave += CONCURRENCY) {
            const waveIndices = Array.from(
              { length: Math.min(CONCURRENCY, totalBatches - wave) },
              (_, i) => wave + i
            );

            await Promise.all(
              waveIndices.map(async (batchIdx) => {
                const offset = batchIdx * BATCH_SIZE;
                const batch = targetCompanies.slice(offset, offset + BATCH_SIZE);
                try {
                  const { assignments, reasons } = await assignBatch(
                    apiKey,
                    batch,
                    offset,
                    clusterBlock,
                    clusterNameById,
                    validNames,
                    includeOutliers,
                    candidateMap
                  );

                  batch.forEach((company, localIdx) => {
                    const key = String(offset + localIdx);
                    const clusterName = assignments[key];
                    if (clusterName) {
                      allAssignments[company.id] = clusterName;
                    }
                    if (reasons[key]) {
                      allReasons[company.id] = reasons[key];
                    }
                  });
                } catch (error) {
                  console.warn("[api/resort] batch assignment failed", {
                    batchIdx,
                    message: error instanceof Error ? error.message : String(error),
                  });
                } finally {
                  doneBatches += 1;
                  doneCompanies += batch.length;
                  send({
                    type: "progress",
                    doneBatches,
                    totalBatches,
                    doneCompanies,
                    totalCompanies: targetCompanies.length,
                  });
                }
              })
            );
          }

          const secondPassCandidates = targetCompanies.filter((company) => {
            const assignedName = allAssignments[company.id];
            const topCandidates = candidateMap[company.id] ?? [];
            if (company.clusterId === "outliers") {
              return assignedName === "Outliers" || !assignedName;
            }
            if (!assignedName || topCandidates.length === 0) return false;
            const currentName = clusterNameById[company.clusterId] ?? company.clusterId;
            return assignedName === currentName && topCandidates[0] !== currentName;
          });

          if (secondPassCandidates.length > 0) {
            const secondPassBlock = `You are re-checking borderline assignments, especially likely outliers and companies that may better fit another cluster.\nPrioritize the closest matching named segment when the evidence is strong.\n\n${clusterBlock}`;
            for (let offset = 0; offset < secondPassCandidates.length; offset += BATCH_SIZE) {
              const batch = secondPassCandidates.slice(offset, offset + BATCH_SIZE);
              try {
                const { assignments, reasons } = await assignBatch(
                  apiKey,
                  batch,
                  offset,
                  secondPassBlock,
                  clusterNameById,
                  validNames,
                  includeOutliers,
                  candidateMap
                );
                batch.forEach((company, localIdx) => {
                  const key = String(offset + localIdx);
                  const clusterName = assignments[key];
                  if (clusterName) allAssignments[company.id] = clusterName;
                  if (reasons[key]) allReasons[company.id] = reasons[key];
                });
              } catch (error) {
                console.warn("[api/resort] second-pass assignment failed", {
                  message: error instanceof Error ? error.message : String(error),
                });
              }
            }
          }

          send({ type: "done", assignments: allAssignments, reasons: allReasons });
        } catch (err) {
          send({ type: "error", message: err instanceof Error ? err.message : String(err) });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api/resort] Error:", msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
