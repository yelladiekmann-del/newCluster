/**
 * Port of the cluster naming and description logic from utils.py
 */

import type { CompanyDoc, ClusterDoc } from "@/types";
import { DIMENSIONS } from "@/types";

const GEN_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

async function callGemini(apiKey: string, prompt: string): Promise<string | null> {
  try {
    const res = await fetch(`${GEN_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3 },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  } catch {
    return null;
  }
}

function repairJson(raw: string): string {
  return raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/gi, "")
    .trim()
    .replace(/,\s*([}\]])/g, "$1");
}

/** Build a profile for a cluster: top 3 values per dimension */
function buildClusterProfile(
  companies: CompanyDoc[]
): Record<string, string[]> {
  const profile: Record<string, string[]> = {};
  for (const dim of DIMENSIONS) {
    const values = companies
      .map((c) => c.dimensions[dim])
      .filter((v): v is string => !!v);
    // Count frequency
    const freq: Record<string, number> = {};
    for (const v of values) freq[v] = (freq[v] ?? 0) + 1;
    profile[dim] = Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k]) => k);
  }
  return profile;
}

export interface ClusterNaming {
  clusterIndex: string;
  name: string;
  description: string;
}

/**
 * Name and describe all clusters in one Gemini call each.
 * Returns array of { clusterIndex, name, description }.
 */
export async function nameAllClusters(
  apiKey: string,
  clusterGroups: Array<{ clusterIndex: string; companies: CompanyDoc[] }>
): Promise<ClusterNaming[]> {
  // Build profiles for each cluster
  const profiles = clusterGroups.map(({ clusterIndex, companies }) => ({
    clusterIndex,
    profile: buildClusterProfile(companies),
    count: companies.length,
  }));

  const profileText = profiles
    .map(
      ({ clusterIndex, profile, count }) =>
        `Cluster ${clusterIndex} (${count} companies):\n` +
        DIMENSIONS.map((d) => `  ${d}: ${profile[d]?.join(", ") || "—"}`).join(
          "\n"
        )
    )
    .join("\n\n");

  const namePrompt = `You are a market analyst. Name each cluster with a 2-5 word market segment label.

${profileText}

Return ONLY a JSON object mapping cluster index strings to names.
Example: {"0": "AI-Powered Analytics", "1": "B2B Marketplace"}`;

  const nameText = await callGemini(apiKey, namePrompt);
  let nameMap: Record<string, string> = {};
  if (nameText) {
    try {
      nameMap = JSON.parse(repairJson(nameText));
    } catch {
      // Use numeric fallbacks
    }
  }

  const descPrompt = `You are a market analyst. Write a 2-sentence description for each cluster that summarizes the market segment and the common value proposition.

${profiles
  .map(
    ({ clusterIndex, profile, count }) =>
      `Cluster ${clusterIndex} — "${nameMap[clusterIndex] || `Cluster ${clusterIndex}`}" (${count} companies):\n` +
      DIMENSIONS.map((d) => `  ${d}: ${profile[d]?.join(", ") || "—"}`).join("\n")
  )
  .join("\n\n")}

Return ONLY a JSON object mapping cluster index strings to descriptions.`;

  const descText = await callGemini(apiKey, descPrompt);
  let descMap: Record<string, string> = {};
  if (descText) {
    try {
      descMap = JSON.parse(repairJson(descText));
    } catch {}
  }

  return clusterGroups.map(({ clusterIndex }) => ({
    clusterIndex,
    name: nameMap[clusterIndex] || `Cluster ${clusterIndex}`,
    description: descMap[clusterIndex] || "",
  }));
}
