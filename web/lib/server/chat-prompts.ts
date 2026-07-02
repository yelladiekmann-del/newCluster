import type { PortfolioReviewContext } from "@/types/ai";

/** Translate a raw cohesion score into a plain-language signal for the model.
 *  The score is hidden — we give the model a qualitative cue so it can reason
 *  about focus without citing raw numbers in its prose. */
function cohesionLabel(score: number | null): string {
  if (score == null) return "unknown";
  if (score >= 0.65) return "very tight — strong shared focus across members";
  if (score >= 0.50) return "cohesive — members mostly aligned on core dimensions";
  if (score >= 0.35) return "mixed — notable variation in what members do";
  return "broad — members vary significantly in problem and mechanism";
}

function formatCluster(summary: PortfolioReviewContext["clusterSummaries"][number]): string {
  const companyLines = summary.allCompanies
    .map((c) => `  - ${c.name}${c.description ? `: ${c.description}` : ""}`)
    .join("\n");

  return `## ${summary.clusterName} (${summary.companyCount} companies)
Description: ${summary.description || "—"}
Internal focus: ${cohesionLabel(summary.cohesionScore)}
Nearest neighboring clusters: ${summary.nearestClusterNames.join(", ") || "—"}

Companies:
${companyLines || "  —"}`;
}

function actionFormatBlock(): string {
  return `<actions>
[
  {"type": "delete", "clusterName": "Exact Cluster Name"},
  {"type": "merge", "sources": ["Cluster A", "Cluster B"], "newName": "Combined Name", "description": "Companies providing .... Unlike nearby clusters, they focus on ...."},
  {"type": "add", "name": "New Cluster Name", "description": "Companies providing .... Unlike nearby clusters, they focus on ....", "companies": ["Company A", "Company B"]}
]
</actions>`;
}

export function buildChatSystemPrompt(context: PortfolioReviewContext): string {
  return `You are an expert market analyst assistant with complete knowledge of this clustering analysis.
Answer conversationally like a knowledgeable colleague, but ground your answers in the specific clusters, representative companies, and market context provided here.
When suggesting structural changes, include them in an ${actionFormatBlock()} block using exact names from the data.
For any merged or newly added cluster, include a "description" field in the same style as the initial cluster naming flow:
- exactly 2 short sentences
- specific, concrete, and useful for a business analyst
- concise enough for a small overview card
- first sentence should start with a category-style phrase like "Companies providing..." or "Platforms enabling..."
- second sentence should briefly distinguish the new cluster from nearby clusters
- do NOT begin with phrases like "This cluster consists of", "This cluster includes", or "This segment contains"

IMPORTANT — reasoning style:
- Do NOT cite raw metric numbers (cohesion scores, overlap percentages, similarity scores) in your responses. These are internal signals only.
- Ground every observation in specific companies and what they actually do: their problem domain, customer segment, core mechanism, or business model.
- A recommendation is only useful if it names companies and explains what they have in common, not why an algorithm flagged them.

Analysis context: ${context.analysisContext || "General portfolio review"}

Market context:
${context.marketContext || "No live market context available."}

Dataset summary:
- ${context.companyCount} companies
- ${context.clusterCount} named clusters
- ${context.outlierCount} outliers

Clusters to look at more closely (possible overlaps or gaps):
${context.overlapCandidates.map((candidate) => `- ${candidate.clusterAName} and ${candidate.clusterBName}: ${candidate.reason}`).join("\n") || "- None flagged"}

Gap hints:
${context.gapHints.map((hint) => `- ${hint}`).join("\n") || "- None flagged"}

Unassigned companies (outliers):
${context.outlierCompanies.length > 0
  ? context.outlierCompanies.map((c) => `  - ${c.name}${c.description ? `: ${c.description}` : ""}`).join("\n")
  : "  None"}

Cluster profiles:
${context.clusterSummaries.map(formatCluster).join("\n\n")}`;
}

export function buildStructuredReviewUserMessage(userMessage: string): string {
  return `${userMessage}

Ground every recommendation in specific company names and what those companies actually do — their problem domain, customers, or mechanism. Avoid citing statistical or algorithmic signals.
After your prose, include a valid ${actionFormatBlock()} block if you recommend deletes, merges, or additions.`;
}
