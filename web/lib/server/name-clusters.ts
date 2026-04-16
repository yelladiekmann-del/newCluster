import type { ClusterNamingResult, ClusterSummary } from "@/types/ai";

import { callGeminiText, extractFirstJsonObject, parseJsonObject } from "./gemini";

function formatSummary(summary: ClusterSummary): string {
  const dimensionLines = Object.entries(summary.topDimensions)
    .filter(([, values]) => values.length > 0)
    .map(([dimension, values]) => `  ${dimension}: ${values.join(" / ")}`)
    .join("\n");
  const snippets = summary.representativeSnippets.map((snippet) => `  - ${snippet}`).join("\n");
  return `CLUSTER ${summary.clusterId} (${summary.companyCount} companies)
Current name: ${summary.clusterName}
Representative companies: ${summary.representativeCompanies.join(", ") || "—"}
Representative snippets:
${snippets || "  - —"}
Top dimensions:
${dimensionLines || "  —"}`;
}

function hasDuplicateNames(names: Record<string, string>): boolean {
  const values = Object.values(names)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return new Set(values).size !== values.length;
}

function synthesizeDescription(summary: ClusterSummary, name: string): string {
  const topThemes = Object.values(summary.topDimensions)
    .flat()
    .filter(Boolean)
    .slice(0, 2);
  const representativeCompanies = summary.representativeCompanies.slice(0, 3).join(", ");
  const themeText = topThemes.length > 0 ? topThemes.join(" and ") : "shared operating patterns";
  if (representativeCompanies) {
    return `${name} covers companies such as ${representativeCompanies}, focused on ${themeText}. They share a similar value proposition and market position within this segment.`;
  }
  return `${name} covers companies focused on ${themeText}. They share a similar value proposition and market position within this segment.`;
}

async function generateNames(
  apiKey: string,
  summaries: ClusterSummary[]
): Promise<Record<string, string>> {
  const prompt = `You are a market intelligence analyst naming clusters of companies.

Below are ${summaries.length} clusters with their dominant characteristics, representative companies, and sample descriptions.
Assign each cluster a SHORT, DISTINCTIVE market-category name (2-5 words) that:
- Captures what makes THIS cluster unique versus the others
- Stays at a similar level of abstraction across the full set
- Reads like a real market segment, not an internal tag
- Has NO duplicates

${summaries.map(formatSummary).join("\n\n")}

Return ONLY a JSON object mapping cluster id strings to names, like:
{"0": "Embedded Lending Infrastructure", "1": "SMB Expense Automation"}
No explanation, no markdown, just JSON.`;

  return parseJsonObject<Record<string, string>>(await callGeminiText({ apiKey, prompt, temperature: 0.2 })) ?? {};
}

async function normalizeNames(
  apiKey: string,
  summaries: ClusterSummary[],
  currentNames: Record<string, string>
): Promise<Record<string, string>> {
  const prompt = `You are refining a portfolio of market segment names.

Current names:
${summaries.map((summary) => `- ${summary.clusterId}: ${currentNames[summary.clusterId] || `Cluster ${summary.clusterId}`}`).join("\n")}

Cluster evidence:
${summaries.map(formatSummary).join("\n\n")}

Revise the names only where needed so the final set:
- has no duplicates
- avoids generic labels
- feels parallel in abstraction level
- stays concise (2-5 words)

Return ONLY a JSON object mapping cluster id strings to the final names.`;

  return parseJsonObject<Record<string, string>>(await callGeminiText({ apiKey, prompt, temperature: 0.2 })) ?? currentNames;
}

async function generateDescriptions(
  apiKey: string,
  summaries: ClusterSummary[],
  names: Record<string, string>,
  logContext?: { uid?: string }
): Promise<Record<string, string>> {
  const prompt = `You are a market intelligence analyst describing clusters of companies.

Below are ${summaries.length} clusters with their dominant characteristics.
For each cluster, write exactly 2 short sentences that:
- explain what type of companies belong to this cluster
- describe the shared value proposition or operating model
- briefly distinguish this cluster from nearby clusters
- are specific, concrete, and useful for a business analyst
- stay concise enough to fit comfortably in a small overview card
- avoid long enumerations of subcategories, examples, or excessive detail
- begin with a category-style phrase like "Companies providing..." or "Platforms enabling..."
- do NOT begin with phrases like "This cluster consists of", "This cluster includes", or "This segment contains"

${summaries
  .map(
    (summary) => `CLUSTER ${summary.clusterId} — "${names[summary.clusterId] || summary.clusterName}" (${summary.companyCount} companies)
Nearest clusters: ${summary.nearestClusterNames.join(", ") || "—"}
Representative companies: ${summary.representativeCompanies.join(", ") || "—"}
Representative snippets:
${summary.representativeSnippets.map((snippet) => `  - ${snippet}`).join("\n") || "  - —"}
Top dimensions:
${Object.entries(summary.topDimensions)
  .filter(([, values]) => values.length > 0)
  .map(([dimension, values]) => `  ${dimension}: ${values.join(" / ")}`)
  .join("\n") || "  —"}`
  )
  .join("\n\n")}

Return ONLY a JSON object mapping cluster id strings to descriptions:
{"0": "Companies providing .... Unlike nearby clusters, they focus on ....", "1": "Platforms enabling .... They stand apart because ....", "...": "..."}
No explanation, no markdown, just the JSON.`;

  const raw = await callGeminiText({ apiKey, prompt, temperature: 0.3 });
  return parseClusterDescriptions(raw, names, summaries, logContext);
}

function logDescriptionIssue(
  event: string,
  details: {
    uid?: string;
    clusterCount: number;
    recoveryPath: string;
    raw: string;
  }
) {
  console.warn("[name-clusters] description-generation issue", {
    event,
    uid: details.uid ?? null,
    clusterCount: details.clusterCount,
    recoveryPath: details.recoveryPath,
    rawExcerpt: details.raw.slice(0, 300),
  });
}

function remapNameKeyedDescriptions(
  parsed: Record<string, unknown>,
  names: Record<string, string>
): { mapped: Record<string, string>; remapped: boolean } {
  const nameToId = new Map(
    Object.entries(names).map(([id, name]) => [name.trim().toLowerCase(), id])
  );
  const mapped: Record<string, string> = {};
  let remapped = false;

  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") continue;
    if (key in names) {
      mapped[key] = value.trim();
      continue;
    }
    const clusterId = nameToId.get(key.trim().toLowerCase());
    if (clusterId) {
      mapped[clusterId] = value.trim();
      remapped = true;
    }
  }

  return { mapped, remapped };
}

function parseClusterDescriptions(
  raw: string,
  names: Record<string, string>,
  summaries: ClusterSummary[],
  logContext?: { uid?: string }
): Record<string, string> {
  const clusterCount = summaries.length;

  const direct = parseJsonObject<Record<string, unknown>>(raw);
  if (direct) {
    const { mapped, remapped } = remapNameKeyedDescriptions(direct, names);
    if (Object.keys(mapped).length > 0) {
      if (remapped) {
        logDescriptionIssue("name_keyed_json", {
          uid: logContext?.uid,
          clusterCount,
          recoveryPath: "direct_json_name_remap",
          raw,
        });
      }
      return mapped;
    }
  }

  const extracted = extractFirstJsonObject(raw);
  if (extracted) {
    const recovered = parseJsonObject<Record<string, unknown>>(extracted);
    if (recovered) {
      const { mapped, remapped } = remapNameKeyedDescriptions(recovered, names);
      if (Object.keys(mapped).length > 0) {
        logDescriptionIssue(remapped ? "name_keyed_json" : "mixed_text_json", {
          uid: logContext?.uid,
          clusterCount,
          recoveryPath: remapped ? "substring_json_name_remap" : "substring_json",
          raw,
        });
        return mapped;
      }
    }
  }

  logDescriptionIssue("non_json_or_empty", {
    uid: logContext?.uid,
    clusterCount,
    recoveryPath: "fallback_only",
    raw,
  });
  return {};
}

export async function nameClustersFromSummaries(
  apiKey: string,
  summaries: ClusterSummary[],
  logContext?: { uid?: string }
): Promise<ClusterNamingResult[]> {
  let names = await generateNames(apiKey, summaries);
  if (hasDuplicateNames(names)) {
    names = await normalizeNames(apiKey, summaries, names);
  }

  const descriptions = await generateDescriptions(apiKey, summaries, names, logContext);
  const fallbackCount = summaries.filter((summary) => !descriptions[summary.clusterId]?.trim()).length;
  console.info("[name-clusters] description-generation summary", {
    uid: logContext?.uid ?? null,
    clusterCount: summaries.length,
    resolvedCount: summaries.length - fallbackCount,
    fallbackCount,
    status:
      fallbackCount === 0
        ? "full_success"
        : fallbackCount === summaries.length
        ? "full_fallback"
        : "partial_fallback",
  });

  return summaries.map((summary) => ({
    clusterIndex: summary.clusterId,
    name: names[summary.clusterId] || `Cluster ${summary.clusterId}`,
    description:
      descriptions[summary.clusterId]?.trim() ||
      synthesizeDescription(summary, names[summary.clusterId] || `Cluster ${summary.clusterId}`),
  }));
}
