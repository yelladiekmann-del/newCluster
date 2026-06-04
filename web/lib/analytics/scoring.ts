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
  score: number;   // legacy alias — same value as hyScore
  hyScore: number; // 0–100 composite hy Score
  groupBreakdown: Record<string, number>;
}

/**
 * Compute a composite 0–100 hy Score per cluster from a ScoringConfig.
 *
 * Algorithm (Min-Max normalization, matches Google Sheet formula):
 * 1. Per metric: compute min/max across clusters that have a non-null value.
 * 2. Normalize each cluster value to [0, 10]:
 *      - direction "max":  (v - min) / (max - min) × 10
 *      - direction "min":  (max - v) / (max - min) × 10
 *      - single-value or null → 0
 * 3. Multiply normalized score by metric weight → weighted contribution.
 * 4. Sum weighted contributions → rawTotal per cluster.
 * 5. hyScore = round(rawTotal / max(rawTotal across all clusters) × 100)
 */
export function computeScores(
  rows: ClusterMetricsRow[],
  config: ScoringConfig,
  clusterColors?: Record<string, string>
): ClusterScore[] {
  if (rows.length === 0) return [];

  // --- Step 1: collect min/max per active metric ---
  const metricStats: Record<string, { min: number; max: number }> = {};
  for (const mc of config.metrics) {
    if (mc.direction === "neutral" || mc.weight === 0) continue;
    const vals = rows
      .map((r) => r[mc.key] as number | null | undefined)
      .filter((v): v is number => v != null);
    if (vals.length < 2) {
      metricStats[mc.key as string] = { min: vals[0] ?? 0, max: vals[0] ?? 0 };
    } else {
      metricStats[mc.key as string] = { min: Math.min(...vals), max: Math.max(...vals) };
    }
  }

  // --- Steps 2–4: compute rawTotal per cluster ---
  const rawTotals: Record<string, number> = {};
  const breakdowns: Record<string, Record<string, number>> = {};

  for (const row of rows) {
    let rawTotal = 0;
    const breakdown: Record<string, number> = {};

    for (const mc of config.metrics) {
      if (mc.direction === "neutral" || mc.weight === 0) continue;
      const stats = metricStats[mc.key as string];
      if (!stats) continue;

      const v = row[mc.key] as number | null | undefined;
      const range = stats.max - stats.min;

      let normScore = 0;
      if (v != null && range > 0) {
        normScore =
          mc.direction === "max"
            ? (v - stats.min) / range
            : (stats.max - v) / range;
      }

      const weighted = normScore * 10 * mc.weight;
      breakdown[mc.key as string] = weighted;
      rawTotal += weighted;
    }

    rawTotals[row.clusterId] = rawTotal;
    breakdowns[row.clusterId] = breakdown;
  }

  // --- Step 5: normalize to 0–100 ---
  const maxRaw = Math.max(...Object.values(rawTotals), 0);

  return rows
    .map((row) => {
      const raw = rawTotals[row.clusterId] ?? 0;
      const hyScore = maxRaw > 0 ? Math.round((raw / maxRaw) * 100) : 0;
      return {
        clusterId: row.clusterId,
        clusterName: row.clusterName,
        color: clusterColors?.[row.clusterId],
        score: hyScore,
        hyScore,
        groupBreakdown: breakdowns[row.clusterId] ?? {},
      };
    })
    .sort((a, b) => b.hyScore - a.hyScore);
}

/** Default direction map: higher is better unless explicitly overridden. */
const DEFAULT_DIRECTION: Partial<Record<string, Direction>> = {
  avgEmployees:    "min",
  avgFunding:      "min",
  mortalityRate:   "min",
  hhi:             "min",
  avgPatentFamilies: "min",
  avgYearFounded:  "neutral",
  uniqueCompanies: "neutral",
  capitalMean:     "neutral",
  capitalMedian:   "neutral",
  avgSeriesScore:  "neutral",
};

/**
 * Build a default ScoringConfig.
 * Pass `hasDeals: false` to mark deal-only metrics as neutral.
 */
export function buildDefaultScoringConfig(hasDeals = true): ScoringConfig {
  const DEAL_ONLY_KEYS = new Set([
    "dealCount", "dealMomentum", "totalInvested4yr", "fundingMomentum",
    "capitalMean", "capitalMedian", "meanMedianRatio", "avgSeriesScore", "marktreife",
  ]);
  const metrics: MetricConfig[] = Object.keys(METRIC_GROUP_MAP)
    .filter((k) => k !== "uniqueCompanies")
    .map((k) => {
      const isDealsOnly = DEAL_ONLY_KEYS.has(k) && !hasDeals;
      const dir: Direction = isDealsOnly
        ? "neutral"
        : (DEFAULT_DIRECTION[k] ?? "max");
      return { key: k as keyof ClusterMetricsRow, direction: dir, weight: 1 };
    });
  const groups: GroupConfig[] = [...new Set(Object.values(METRIC_GROUP_MAP))].map((g) => ({
    group: g,
    weight: 1,
  }));
  return { metrics, groups };
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
  marktreife:         "Market",
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
  marktreife:         { max: "emerging / immature market",          min: "mature, established market" },
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
