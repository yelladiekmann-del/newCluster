import type { ClusterMetricsRow } from "@/types";

export type Direction = "max" | "min" | "neutral";

export interface MetricConfig {
  key: keyof ClusterMetricsRow;
  direction: Direction;
  weight: number; // 0–4
}

export interface GroupConfig {
  group: string;
  weight: number; // 1–6
}

export interface ScoringConfig {
  metrics: MetricConfig[];
  groups: GroupConfig[];
}

export interface ClusterScore {
  clusterId: string;
  clusterName: string;
  color?: string;
  score: number; // 0–100
  groupBreakdown: Record<string, number>;
}

/**
 * Compute a composite 0–100 score per cluster from a ScoringConfig.
 *
 * Algorithm:
 * 1. For each non-Neutral metric, rank clusters (rank 1 = best per direction)
 * 2. Normalize rank → 0–1 (1.0 for #1, 0.0 for last)
 * 3. metricContrib = normScore × metricWeight
 * 4. groupContrib  = Σ(metricContribs in group) × groupWeight
 * 5. totalRaw      = Σ(groupContribs)
 * 6. Normalize totals so max = 100
 */
export function computeScores(
  rows: ClusterMetricsRow[],
  config: ScoringConfig,
  clusterColors?: Record<string, string>
): ClusterScore[] {
  const n = rows.length;
  if (n === 0) return [];

  const groupWeightMap: Record<string, number> = {};
  for (const g of config.groups) groupWeightMap[g.group] = g.weight;

  // Pre-rank each active metric
  const metricRanks: Record<string, Record<string, number>> = {}; // key → clusterId → rank (1=best)
  for (const mc of config.metrics) {
    if (mc.direction === "neutral" || mc.weight === 0) continue;
    const higherIsBetter = mc.direction === "max";
    const valid = rows
      .filter((r) => r[mc.key] != null)
      .sort((a, b) => {
        const av = a[mc.key] as number;
        const bv = b[mc.key] as number;
        return higherIsBetter ? bv - av : av - bv;
      });
    const rankMap: Record<string, number> = {};
    valid.forEach((r, i) => { rankMap[r.clusterId] = i + 1; });
    metricRanks[mc.key as string] = rankMap;
  }

  // Group each metric config by group name
  const metricsByGroup: Record<string, MetricConfig[]> = {};
  for (const mc of config.metrics) {
    // find which group this metric belongs to — look up from METRIC_GROUPS map
    const group = METRIC_GROUP_MAP[mc.key as string] ?? "Other";
    if (!metricsByGroup[group]) metricsByGroup[group] = [];
    metricsByGroup[group].push(mc);
  }

  // Compute raw scores per cluster
  const rawScores: Record<string, number> = {};
  const breakdowns: Record<string, Record<string, number>> = {};

  for (const row of rows) {
    let total = 0;
    const breakdown: Record<string, number> = {};

    for (const [group, metrics] of Object.entries(metricsByGroup)) {
      const gw = groupWeightMap[group] ?? 1;
      let groupSum = 0;

      for (const mc of metrics) {
        if (mc.direction === "neutral" || mc.weight === 0) continue;
        const rankMap = metricRanks[mc.key as string];
        if (!rankMap) continue;
        const rank = rankMap[row.clusterId];
        if (rank == null) continue; // value was null — skip
        const validCount = Object.keys(rankMap).length;
        const normScore = validCount > 1 ? (validCount - rank) / (validCount - 1) : 1;
        groupSum += normScore * mc.weight;
      }

      const groupContrib = groupSum * gw;
      breakdown[group] = groupContrib;
      total += groupContrib;
    }

    rawScores[row.clusterId] = total;
    breakdowns[row.clusterId] = breakdown;
  }

  // Normalize to 0–100
  const maxRaw = Math.max(...Object.values(rawScores), 0);

  return rows
    .map((row) => {
      const raw = rawScores[row.clusterId] ?? 0;
      const score = maxRaw > 0 ? Math.round((raw / maxRaw) * 100) : 0;
      return {
        clusterId: row.clusterId,
        clusterName: row.clusterName,
        color: clusterColors?.[row.clusterId],
        score,
        groupBreakdown: breakdowns[row.clusterId] ?? {},
      };
    })
    .sort((a, b) => b.score - a.score);
}

/** Maps each metric key to its group name (must match COLS in AnalyticsTable). */
export const METRIC_GROUP_MAP: Record<string, string> = {
  companyCount:       "Size",
  uniqueCompanies:    "Size",
  avgEmployees:       "Size",
  avgYearFounded:     "Recency",
  pctRecentlyFounded: "Recency",
  dealCount:          "Deals",
  dealMomentum:       "Deals",
  avgFunding:         "Funding",
  totalFunding:       "Funding",
  totalInvested4yr:   "Funding",
  fundingMomentum:    "Funding",
  capitalMean:        "Capital",
  capitalMedian:      "Capital",
  meanMedianRatio:    "Capital",
  vcGraduationRate:   "Risk",
  mortalityRate:      "Risk",
  hhi:                "Market",
  avgSeriesScore:     "Market",
  avgPatentFamilies:  "Technology",
};

/** Short English justification phrases per metric + direction. */
const JUSTIFICATIONS: Partial<Record<string, { max: string; min: string }>> = {
  companyCount:       { max: "clusters with more companies",        min: "smaller, more focused clusters" },
  uniqueCompanies:    { max: "broader company coverage",            min: "concentrated company base" },
  avgEmployees:       { max: "larger, more established companies",  min: "lean, early-stage companies" },
  avgYearFounded:     { max: "older, more mature companies",        min: "newer, recently founded companies" },
  pctRecentlyFounded: { max: "high current founding activity",      min: "established markets with few new entrants" },
  dealCount:          { max: "active deal flow",                    min: "low deal noise / niche segments" },
  dealMomentum:       { max: "increasing deal activity",            min: "declining deal activity" },
  avgFunding:         { max: "well-funded companies",               min: "capital-efficient early-stage companies" },
  totalFunding:       { max: "large aggregate funding base",        min: "resource-lean segments" },
  totalInvested4yr:   { max: "sustained investor interest",         min: "low recent capital deployment" },
  fundingMomentum:    { max: "rising funding dynamics",             min: "slowing funding environment" },
  capitalMean:        { max: "large individual deal sizes",         min: "small ticket sizes / early stage" },
  capitalMedian:      { max: "high median investment level",        min: "low median deal size" },
  meanMedianRatio:    { max: "high variance / outlier potential",   min: "consistent deal sizing" },
  vcGraduationRate:   { max: "validated, lower-risk companies",     min: "pre-validation, higher upside potential" },
  mortalityRate:      { max: "high churn / disrupted segments",     min: "stable, low failure-rate segments" },
  hhi:                { max: "concentrated market",                 min: "fragmented, competitive landscape" },
  avgSeriesScore:     { max: "mature, later-stage companies",       min: "early-stage companies" },
  avgPatentFamilies:  { max: "high IP defensibility",               min: "accessible, low R&D-intensive markets" },
};

const STRENGTH = [
  "No preference",
  "Slight preference for",
  "Clear preference for",
  "Strong preference for",
  "Very strong preference for",
];

export function buildJustification(key: string, direction: Direction, weight: number): string {
  if (direction === "neutral") {
    return "Ignored — no preference or already covered by another metric";
  }
  const phrase = JUSTIFICATIONS[key]?.[direction];
  if (!phrase) return STRENGTH[weight] ?? "No preference";
  if (weight === 0) return "Ignored — weight set to zero";
  return `${STRENGTH[weight]} ${phrase}`;
}
