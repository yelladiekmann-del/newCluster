import type { PortfolioReviewContext } from "@/types/ai";

function formatCluster(summary: PortfolioReviewContext["clusterSummaries"][number]): string {
  const dimensions = Object.entries(summary.topDimensions)
    .filter(([, values]) => values.length > 0)
    .map(([dimension, values]) => `  ${dimension}: ${values.join(" / ")}`)
    .join("\n");

  return `## ${summary.clusterName} (${summary.companyCount} companies)
Description: ${summary.description || "—"}
Cohesion score: ${summary.cohesionScore ?? "n/a"}
Representative companies: ${summary.representativeCompanies.join(", ") || "—"}
Representative snippets:
${summary.representativeSnippets.map((snippet) => `  - ${snippet}`).join("\n") || "  - —"}
Top dimensions:
${dimensions || "  —"}
Nearest neighboring clusters: ${summary.nearestClusterNames.join(", ") || "—"}`;
}

function actionFormatBlock(): string {
  return `<actions>
[
  {"type": "delete", "clusterName": "Exact Cluster Name"},
  {"type": "merge", "sources": ["Cluster A", "Cluster B"], "newName": "Combined Name"},
  {"type": "add", "name": "New Cluster Name", "description": "2-sentence description", "companies": ["Company A", "Company B"]}
]
</actions>`;
}

export function buildChatSystemPrompt(context: PortfolioReviewContext): string {
  return `You are an expert market analyst assistant with complete knowledge of this clustering analysis.
Answer conversationally like a knowledgeable colleague, but ground your answers in the specific clusters, representative companies, and market context provided here.
When suggesting structural changes, include them in an ${actionFormatBlock()} block using exact names from the data.

Analysis context: ${context.analysisContext || "General portfolio review"}

Market context:
${context.marketContext || "No live market context available."}

Dataset summary:
- ${context.companyCount} companies
- ${context.clusterCount} named clusters
- ${context.outlierCount} outliers

Top overlap candidates:
${context.overlapCandidates.map((candidate) => `- ${candidate.clusterAName} <> ${candidate.clusterBName}: ${candidate.reason}`).join("\n") || "- None flagged"}

Gap hints:
${context.gapHints.map((hint) => `- ${hint}`).join("\n") || "- None flagged"}

Outlier examples: ${context.outlierExamples.join(", ") || "None"}

Cluster profiles:
${context.clusterSummaries.map(formatCluster).join("\n\n")}`;
}

export function buildStructuredReviewUserMessage(userMessage: string): string {
  return `${userMessage}

Make your recommendations specific and evidence-based. After your prose, include a valid ${actionFormatBlock()} block if you recommend deletes, merges, or additions.`;
}
