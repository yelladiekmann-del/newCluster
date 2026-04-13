/**
 * Port of cluster_chat.py
 * Builds the full context and calls Gemini with the chat history.
 * Parses <actions>...</actions> blocks from responses.
 */

import type { ClusterDoc, CompanyDoc, ClusterAction, ChatMessage } from "@/types";
import { DIMENSIONS } from "@/types";

const GEN_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

// ── Context builder ──────────────────────────────────────────────────────────

export function buildSystemContext(
  clusters: ClusterDoc[],
  companies: CompanyDoc[],
  analysisContext: string,
  marketContext: string
): string {
  const nonOutlierClusters = clusters.filter((c) => !c.isOutliers);

  const clusterSummary = nonOutlierClusters
    .map((c) => {
      const members = companies.filter((co) => co.clusterId === c.id);
      const profileLines = DIMENSIONS.map((dim) => {
        const vals = members
          .map((m) => m.dimensions[dim])
          .filter(Boolean)
          .slice(0, 3)
          .join(", ");
        return vals ? `  ${dim}: ${vals}` : null;
      })
        .filter(Boolean)
        .join("\n");
      return `## ${c.name} (${c.companyCount} companies)\n${c.description}\n${profileLines}`;
    })
    .join("\n\n");

  const totalOutliers = companies.filter((c) => c.clusterId === "outliers").length;

  return `You are an expert market intelligence analyst with full knowledge of this company clustering analysis.

${analysisContext ? `## Analysis Context\n${analysisContext}\n\n` : ""}
${marketContext ? `## Market Context\n${marketContext}\n\n` : ""}
## Dataset Summary
Total companies: ${companies.length}
Clusters: ${nonOutlierClusters.length}
Outliers: ${totalOutliers}

## Cluster Profiles
${clusterSummary}

## Your capabilities
- Answer questions about the clusters, companies, and market landscape
- Suggest cluster improvements (merges, splits, deletions, additions)
- When suggesting structural changes, include them in an <actions>...</actions> JSON block

## Action format (only include when suggesting structural changes)
<actions>
[
  {"type": "delete", "clusterName": "Exact Cluster Name"},
  {"type": "merge", "sources": ["Cluster A", "Cluster B"], "newName": "Combined Name"},
  {"type": "add", "name": "New Cluster Name", "description": "2-sentence description", "companies": ["Company A", "Company B"]}
]
</actions>`;
}

// ── Market context search ────────────────────────────────────────────────────

export async function fetchMarketContext(
  apiKey: string,
  analysisContext: string,
  companies: CompanyDoc[]
): Promise<string> {
  const sampleNames = companies
    .filter((c) => c.clusterId !== "outliers")
    .slice(0, 10)
    .map((c) => c.name)
    .join(", ");

  const prompt = `Research the market landscape for this company portfolio.

Context: ${analysisContext || "General market analysis"}
Sample companies: ${sampleNames}

Search for recent market trends, key players, and market segments relevant to these companies.
Write a 200-300 word market overview that will help contextualize this clustering analysis.`;

  try {
    const res = await fetch(`${GEN_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.3 },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return "";
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  } catch {
    return "";
  }
}

// ── Chat call ────────────────────────────────────────────────────────────────

export interface ChatResponse {
  text: string;
  actions: ClusterAction[] | null;
}

export async function sendChatMessage(
  apiKey: string,
  systemContext: string,
  history: ChatMessage[],
  userMessage: string
): Promise<ChatResponse> {
  // Convert history to Gemini format (max 20 turns)
  const recentHistory = history.slice(-40); // 20 turns × 2 messages
  const contents = [
    ...recentHistory.map((m) => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: m.content }],
    })),
    { role: "user" as const, parts: [{ text: userMessage }] },
  ];

  const res = await fetch(`${GEN_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemContext }] },
      contents,
      generationConfig: { temperature: 0.5 },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    throw new Error(`Gemini chat error ${res.status}`);
  }

  const data = await res.json();
  const rawText: string =
    data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  // Extract <actions>...</actions>
  const actionsMatch = rawText.match(/<actions>([\s\S]*?)<\/actions>/);
  let actions: ClusterAction[] | null = null;
  let displayText = rawText;

  if (actionsMatch) {
    displayText = rawText.replace(/<actions>[\s\S]*?<\/actions>/, "").trim();
    try {
      actions = JSON.parse(actionsMatch[1].trim());
    } catch {
      actions = null;
    }
  }

  return { text: displayText, actions };
}
