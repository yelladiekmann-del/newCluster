import type { ClusterDoc, CompanyDoc } from "@/types";

import { callGeminiText } from "./gemini";

export async function fetchMarketContext(params: {
  apiKey: string;
  analysisContext: string;
  clusters: ClusterDoc[];
  companies: CompanyDoc[];
}): Promise<string> {
  const { apiKey, analysisContext, clusters, companies } = params;
  const namedClusters = clusters.filter((cluster) => !cluster.isOutliers);
  const samples = namedClusters
    .map((cluster) => {
      const sample = companies.find((company) => company.clusterId === cluster.id);
      return sample ? `${cluster.name}: ${sample.name}` : null;
    })
    .filter(Boolean)
    .slice(0, 12);

  const prompt = `You are a market research analyst. A company portfolio has been organized into these market segments.

Segments: ${namedClusters.map((cluster) => cluster.name).join(", ")}
Sample companies by segment: ${samples.join("; ")}
${analysisContext ? `Analysis context: ${analysisContext}` : ""}

Search the web and provide a focused market landscape overview in 200-300 words that covers:
1. The broader market domain this portfolio represents
2. The major segment types typically present in this market, including any that appear missing here
3. Important incumbents or solution categories buyers compare
4. Common buyer pain points and evaluation criteria

Ground the overview in the likely market represented by these clusters.`;

  try {
    return await callGeminiText({
      apiKey,
      prompt,
      tools: [{ google_search: {} }],
      temperature: 0.3,
    });
  } catch {
    return "";
  }
}
