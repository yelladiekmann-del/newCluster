import type { NextRequest } from "next/server";

export const maxDuration = 300;

const GEN_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

const BATCH_SIZE = 20;
const CONCURRENCY = 8;

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
}

interface BatchAssignment {
  [index: string]: string | Record<string, string> | undefined;
  reasons?: Record<string, string>;
}

async function assignBatch(
  apiKey: string,
  batch: ResortCompany[],
  batchOffset: number,
  clusterBlock: string,
  validNames: string[],
  includeOutliers: boolean
): Promise<{ assignments: Record<string, string>; reasons: Record<string, string> }> {
  const companiesBlock = batch
    .map((c, i) => {
      const idx = String(batchOffset + i);
      const currentCluster = c.clusterId === "outliers" ? "Outliers" : validNames.find(() => true) ?? c.clusterId;
      const dimStr = Object.entries(c.dimensions)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join("; ")
        .slice(0, 600);
      const desc = c.originalDesc ? c.originalDesc.slice(0, 600) : dimStr;
      return `  "${idx}": ${c.name} (currently: "${currentCluster}") — ${desc}`;
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

  try {
    const parsed: BatchAssignment = JSON.parse(raw.trim());
    const reasons: Record<string, string> = {};
    if (parsed.reasons && typeof parsed.reasons === "object") {
      Object.assign(reasons, parsed.reasons);
      delete parsed.reasons;
    }
    return { assignments: parsed as Record<string, string>, reasons };
  } catch {
    return { assignments: {}, reasons: {} };
  }
}

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get("x-gemini-key");
  if (!apiKey) return Response.json({ error: "Missing x-gemini-key" }, { status: 401 });

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

    // Build cluster block
    const clusterBlock = nonOutlierClusters
      .map((c) => `"${c.name}"`)
      .join(", ");

    // Filter companies
    const targetCompanies = includeOutliers
      ? companies
      : companies.filter((c) => c.clusterId !== "outliers");

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

        try {
          for (let wave = 0; wave < totalBatches; wave += CONCURRENCY) {
            const waveIndices = Array.from(
              { length: Math.min(CONCURRENCY, totalBatches - wave) },
              (_, i) => wave + i
            );

            const results = await Promise.allSettled(
              waveIndices.map((batchIdx) => {
                const offset = batchIdx * BATCH_SIZE;
                const batch = targetCompanies.slice(offset, offset + BATCH_SIZE);
                return assignBatch(
                  apiKey,
                  batch,
                  offset,
                  clusterBlock,
                  validNames,
                  includeOutliers
                );
              })
            );

            for (let i = 0; i < results.length; i++) {
              const result = results[i];
              const batchIdx = waveIndices[i];
              const offset = batchIdx * BATCH_SIZE;
              const batch = targetCompanies.slice(offset, offset + BATCH_SIZE);

              if (result.status === "fulfilled") {
                const { assignments, reasons } = result.value;
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
              }

              doneBatches++;
              send({ type: "progress", done: doneBatches, total: totalBatches });
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
