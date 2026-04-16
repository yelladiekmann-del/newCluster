import type { ClusterNamingResult, ClusterSummary } from "@/types/ai";

import { callGeminiText, extractFirstJsonObject, parseJsonObject } from "./gemini";

function formatSummary(summary: ClusterSummary): string {
  const dimensionLines = Object.entries(summary.topDimensions)
    .filter(([, values]) => values.length > 0)
    .map(([dimension, values]) => `  ${dimension}: ${values.join(" / ")}`)
    .join("\n");
  const snippets = summary.representativeSnippets.map((snippet) => `  - ${snippet}`).join("\n");
  return `CLUSTER ${summary.clusterId} (${summary.companyCount} companies)
Representative companies: ${summary.representativeCompanies.join(", ") || "—"}
Nearest clusters: ${summary.nearestClusterNames.join(", ") || "—"}
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

/**
 * Single Gemini call that returns both name and description for every cluster.
 * Replaces the previous 2–3 sequential calls (generateNames → normalizeNames → generateDescriptions).
 * thinkingBudget=0 disables gemini-2.5-flash reasoning mode for fast structured output.
 */
async function generateNamesAndDescriptions(
  apiKey: string,
  summaries: ClusterSummary[],
): Promise<{ names: Record<string, string>; descriptions: Record<string, string> }> {
  const prompt = `You are a market intelligence analyst naming and describing clusters of companies.

Below are ${summaries.length} clusters with their dominant characteristics, representative companies, and sample descriptions.

For EACH cluster provide:
1. A SHORT, DISTINCTIVE market-category name (2–5 words)
2. Exactly 2 sentences describing what type of companies belong here and what sets them apart

Name requirements:
- Captures what makes THIS cluster unique versus the others
- Same level of abstraction across all clusters
- Reads like a real market segment (e.g. "Embedded Lending Infrastructure", "SMB Expense Automation")
- NO duplicates — every name must be unique

Description requirements:
- Begin with a phrase like "Companies providing..." or "Platforms enabling..."
- Specific, concrete, and useful for a business analyst
- Briefly distinguish from the nearest clusters listed
- Exactly 2 sentences, no long enumerations

${summaries.map(formatSummary).join("\n\n")}

Return ONLY a JSON object like:
{"0": {"name": "Embedded Lending Infrastructure", "description": "Companies providing... They stand apart from..."}, "1": {"name": "...", "description": "..."}}
No explanation, no markdown, just the JSON.`;

  const raw = await callGeminiText({ apiKey, prompt, temperature: 0.25, model: "gemini-2.0-flash" });

  const parsed =
    parseJsonObject<Record<string, { name?: string; description?: string }>>(raw) ??
    parseJsonObject<Record<string, { name?: string; description?: string }>>(extractFirstJsonObject(raw) ?? "") ??
    {};

  const names: Record<string, string> = {};
  const descriptions: Record<string, string> = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (value?.name) names[id] = value.name.trim();
    if (value?.description) descriptions[id] = value.description.trim();
  }
  return { names, descriptions };
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

  return parseJsonObject<Record<string, string>>(await callGeminiText({ apiKey, prompt, temperature: 0.2, model: "gemini-2.0-flash" })) ?? currentNames;
}

export async function nameClustersFromSummaries(
  apiKey: string,
  summaries: ClusterSummary[],
  logContext?: { uid?: string }
): Promise<ClusterNamingResult[]> {
  let { names, descriptions } = await generateNamesAndDescriptions(apiKey, summaries);

  // Dedup safety net — only triggers a second call if the combined prompt returned duplicates
  if (hasDuplicateNames(names)) {
    names = await normalizeNames(apiKey, summaries, names);
  }

  const fallbackCount = summaries.filter((s) => !descriptions[s.clusterId]?.trim()).length;
  console.info("[name-clusters] naming summary", {
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
