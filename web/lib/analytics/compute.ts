/**
 * Port of pages/analytics.py _compute() function.
 */

import type { CompanyDoc, ClusterDoc, ClusterMetricsRow, AnalyticsColMap } from "@/types";

// Deal stage scoring (matches legacy SERIES_SCORE)
const SERIES_SCORE: Record<string, number> = {
  "pre-seed": 0, "pre seed": 0, "preseed": 0,
  "seed": 1,
  "series a": 2, "a": 2,
  "series b": 3, "b": 3,
  "series c": 4, "c": 4,
  "series d": 5, "d": 5,
  "series e": 6, "e": 6, "e+": 6,
  "series f": 6, "f": 6, "g": 6,
  "growth": 6, "late stage": 6, "ipo": 7,
};

const GRADUATION_OWNERSHIP = new Set(["acquired/merged", "publicly held"]);
const GRADUATION_FINANCING_SUBS = ["formerly", "private equity-backed"];
const MORTALITY_STATUSES = new Set(["out of business", "bankruptcy"]);

function safeNum(v: unknown): number | null {
  if (v == null || v === "" || v === "N/A") return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function safeYear(v: unknown): number | null {
  const n = safeNum(v);
  if (n == null) return null;
  return n > 1800 && n <= new Date().getFullYear() + 1 ? n : null;
}

function safeDate(v: unknown): Date | null {
  if (!v) return null;
  // Try numeric year
  const asNum = Number(v);
  if (!isNaN(asNum) && asNum > 1800 && asNum < 2100) {
    return new Date(asNum, 0, 1);
  }
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function vcGradFlag(
  row: Record<string, unknown>,
  bsCol: string | undefined,
  osCol: string | undefined,
  fsCol: string | undefined
): boolean {
  const bs = bsCol ? String(row[bsCol] ?? "").trim().toLowerCase() : "";
  const os = osCol ? String(row[osCol] ?? "").trim().toLowerCase() : "";
  const fs = fsCol ? String(row[fsCol] ?? "").trim().toLowerCase() : "";
  if (bs === "out of business" || bs.startsWith("bankruptcy")) return false;
  if (GRADUATION_OWNERSHIP.has(os)) return true;
  if (GRADUATION_FINANCING_SUBS.some((sub) => fs.includes(sub))) return true;
  return false;
}

function mortalityFlag(row: Record<string, unknown>, bsCol: string | undefined): boolean {
  if (!bsCol) return false;
  const bs = String(row[bsCol] ?? "").trim().toLowerCase();
  return MORTALITY_STATUSES.has(bs) || bs.startsWith("bankruptcy");
}

export function computeAnalytics(
  clusters: ClusterDoc[],
  companies: CompanyDoc[],
  dealsData: Record<string, unknown>[] | null,
  colMap: AnalyticsColMap,
  referenceYear?: number
): ClusterMetricsRow[] {
  const refYear = referenceYear ?? new Date().getFullYear();
  const rows: ClusterMetricsRow[] = [];

  for (const cluster of clusters) {
    const members = companies.filter((c) => c.clusterId === cluster.id);
    if (members.length === 0) continue;

    // Company IDs for joining with deals
    const companyIds = new Set<string>(
      colMap.co_id
        ? members.map((m) => String(m.originalData[colMap.co_id!] ?? "")).filter(Boolean)
        : []
    );

    // ── Size ──────────────────────────────────────────────────────────────
    const companyCount = members.length;
    const uniqueCompanies = companyIds.size || companyCount;

    // ── Employees ────────────────────────────────────────────────────────
    const employeeNums = members
      .map((m) => colMap.employees ? safeNum(m.originalData[colMap.employees]) : null)
      .filter((n): n is number => n !== null);
    const avgEmployees = employeeNums.length > 0
      ? Math.round(employeeNums.reduce((a, b) => a + b, 0) / employeeNums.length)
      : null;

    // ── Year founded ─────────────────────────────────────────────────────
    const yearNums = members
      .map((m) => colMap.year_founded ? safeYear(m.originalData[colMap.year_founded]) : null)
      .filter((n): n is number => n !== null);
    const avgYearFounded = yearNums.length > 0
      ? Math.round(yearNums.reduce((a, b) => a + b, 0) / yearNums.length)
      : null;
    const pctRecentlyFounded = yearNums.length > 0
      ? Math.round((yearNums.filter((y) => refYear - y <= 2).length / yearNums.length) * 100)
      : null;

    // ── Funding from companies CSV ────────────────────────────────────────
    const fundingNums = members
      .map((m) => colMap.total_raised ? safeNum(m.originalData[colMap.total_raised]) : null)
      .filter((n): n is number => n !== null);
    const avgFunding = fundingNums.length > 0
      ? fundingNums.reduce((a, b) => a + b, 0) / fundingNums.length
      : null;
    const totalFunding = fundingNums.length > 0
      ? fundingNums.reduce((a, b) => a + b, 0)
      : null;

    // ── Graduation & Mortality ────────────────────────────────────────────
    const hasStatusCols = colMap.business_status || colMap.ownership_status || colMap.financing_status;
    const graduationCount = hasStatusCols
      ? members.filter((m) => vcGradFlag(m.originalData, colMap.business_status, colMap.ownership_status, colMap.financing_status)).length
      : null;
    const mortalityCount = colMap.business_status
      ? members.filter((m) => mortalityFlag(m.originalData, colMap.business_status)).length
      : null;
    const vcGraduationRate = hasStatusCols && members.length > 0
      ? Math.round((graduationCount ?? 0) / members.length * 100)
      : null;
    const mortalityRate = colMap.business_status && members.length > 0
      ? Math.round((mortalityCount ?? 0) / members.length * 100)
      : null;

    // ── Deals ─────────────────────────────────────────────────────────────
    let dealCount: number | null = null;
    let dealMomentum: number | null = null;
    let totalInvested4yr: number | null = null;
    let fundingMomentum: number | null = null;
    let capitalMean: number | null = null;
    let capitalMedian: number | null = null;
    let meanMedianRatio: number | null = null;
    let avgSeriesScore: number | null = null;

    if (dealsData && (colMap.de_co_id || colMap.de_co_name) && colMap.deal_date) {
      const companyNames = new Set(members.map((m) => m.name.toLowerCase().trim()));
      const clusterDeals = dealsData.filter((d) => {
        if (colMap.de_co_id) {
          const id = String(d[colMap.de_co_id] ?? "");
          if (companyIds.has(id)) return true;
        }
        if (colMap.de_co_name) {
          const name = String(d[colMap.de_co_name] ?? "").toLowerCase().trim();
          if (companyNames.has(name)) return true;
        }
        return false;
      });

      // Deal count (unique deal IDs if available)
      if (colMap.deal_id) {
        const uniqueIds = new Set(clusterDeals.map((d) => String(d[colMap.deal_id!] ?? "")));
        dealCount = uniqueIds.size;
      } else {
        dealCount = clusterDeals.length;
      }

      // Year-over-year deal momentum
      const dealYears = clusterDeals.map((d) => safeDate(d[colMap.deal_date!])?.getFullYear() ?? null);
      const prevYearN = dealYears.filter((y) => y === refYear - 1).length;
      const thisYearN = dealYears.filter((y) => y === refYear).length;
      dealMomentum = prevYearN > 0
        ? Math.round(((thisYearN / prevYearN) - 1) * 100)
        : null;

      // Deal sizes
      if (colMap.deal_size) {
        const dealSizes = clusterDeals.map((d) => ({
          size: safeNum(d[colMap.deal_size!]),
          year: safeDate(d[colMap.deal_date!])?.getFullYear() ?? null,
        }));

        const allSizes = dealSizes.map((d) => d.size).filter((n): n is number => n !== null);
        capitalMean = allSizes.length > 0
          ? allSizes.reduce((a, b) => a + b, 0) / allSizes.length
          : null;
        capitalMedian = median(allSizes);
        meanMedianRatio = capitalMean && capitalMedian && capitalMedian > 0
          ? Math.round((capitalMean / capitalMedian) * 100) / 100
          : null;

        // Σ invested last 4 years
        const sizes4yr = dealSizes
          .filter((d) => d.year != null && d.year >= refYear - 3 && d.year <= refYear && d.size != null)
          .map((d) => d.size as number);
        totalInvested4yr = sizes4yr.length > 0 ? sizes4yr.reduce((a, b) => a + b, 0) : null;

        // Funding momentum: (Y + Y-1) vs (Y-2 + Y-3)
        const recSum = dealSizes
          .filter((d) => d.year != null && d.year >= refYear - 1 && d.year <= refYear && d.size != null)
          .reduce((a, d) => a + (d.size as number), 0);
        const prevSum = dealSizes
          .filter((d) => d.year != null && d.year >= refYear - 3 && d.year <= refYear - 2 && d.size != null)
          .reduce((a, d) => a + (d.size as number), 0);
        fundingMomentum = prevSum > 0
          ? Math.round(((recSum / prevSum) - 1) * 100)
          : null;
      }

      // Deal series / market maturity
      if (colMap.series) {
        const scores = clusterDeals
          .map((d) => {
            const s = String(d[colMap.series!] ?? "").trim().toLowerCase();
            return SERIES_SCORE[s] ?? null;
          })
          .filter((n): n is number => n !== null);
        avgSeriesScore = scores.length > 0
          ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
          : null;
      }
    }

    rows.push({
      clusterId: cluster.id,
      clusterName: cluster.name,
      companyCount,
      uniqueCompanies,
      avgEmployees,
      avgYearFounded,
      pctRecentlyFounded,
      dealCount,
      dealMomentum,
      avgFunding,
      totalFunding,
      totalInvested4yr,
      fundingMomentum,
      capitalMean,
      capitalMedian,
      meanMedianRatio,
      avgSeriesScore,
      vcGraduationRate,
      mortalityRate,
    });
  }

  return rows;
}

/** Rank rows by a numeric column. Returns rank 1 = best. */
export function rankRows(
  rows: ClusterMetricsRow[],
  key: keyof ClusterMetricsRow,
  higherIsBetter = true
): Record<string, number> {
  const sorted = [...rows]
    .filter((r) => r[key] != null)
    .sort((a, b) =>
      higherIsBetter
        ? (b[key] as number) - (a[key] as number)
        : (a[key] as number) - (b[key] as number)
    );
  const ranks: Record<string, number> = {};
  sorted.forEach((r, i) => {
    ranks[r.clusterId] = i + 1;
  });
  return ranks;
}
