/**
 * Port of the analytics computation logic from pages/analytics.py.
 * All pure TypeScript — no server calls needed.
 */

import type { CompanyDoc, ClusterDoc, ClusterMetricsRow, AnalyticsColMap } from "@/types";

const GRADUATION_STATUSES = new Set([
  "ipo", "acquired", "merged", "public",
]);
const GRADUATION_FINANCING = new Set([
  "ipo", "acquisition", "m&a", "merger",
]);
const MORTALITY_STATUSES = new Set([
  "out of business", "bankrupt", "bankruptcy", "defunct", "closed",
]);

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
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

export function computeAnalytics(
  clusters: ClusterDoc[],
  companies: CompanyDoc[],
  dealsData: Record<string, unknown>[] | null,
  colMap: AnalyticsColMap,
  referenceYear?: number
): ClusterMetricsRow[] {
  const refYear = referenceYear ?? 2025;

  const rows: ClusterMetricsRow[] = [];

  for (const cluster of clusters) {
    const members = companies.filter((c) => c.clusterId === cluster.id);
    if (members.length === 0) continue;

    // Company IDs for joining with deals
    const companyIds = new Set(
      colMap.co_id
        ? members.map((m) => String(m.originalData[colMap.co_id!] ?? ""))
        : []
    );

    // ── Size ──────────────────────────────────────────────────────────────
    const companyCount = members.length;
    const uniqueCompanies = companyIds.size || companyCount;

    // ── Employees ────────────────────────────────────────────────────────
    const employeeNums = members
      .map((m) => (colMap.employees ? safeNum(m.originalData[colMap.employees]) : null))
      .filter((n): n is number => n !== null);
    const avgEmployees =
      employeeNums.length > 0
        ? Math.round(employeeNums.reduce((a, b) => a + b, 0) / employeeNums.length)
        : null;

    // ── Year founded ─────────────────────────────────────────────────────
    const yearNums = members
      .map((m) => (colMap.year_founded ? safeYear(m.originalData[colMap.year_founded]) : null))
      .filter((n): n is number => n !== null);
    const avgYearFounded =
      yearNums.length > 0
        ? Math.round(yearNums.reduce((a, b) => a + b, 0) / yearNums.length)
        : null;
    const pctRecentlyFounded =
      yearNums.length > 0
        ? Math.round(
            (yearNums.filter((y) => refYear - y <= 2).length / yearNums.length) * 100
          )
        : null;

    // ── Funding ──────────────────────────────────────────────────────────
    const fundingNums = members
      .map((m) => (colMap.total_raised ? safeNum(m.originalData[colMap.total_raised]) : null))
      .filter((n): n is number => n !== null);
    const avgFunding =
      fundingNums.length > 0
        ? fundingNums.reduce((a, b) => a + b, 0) / fundingNums.length
        : null;
    const totalFunding =
      fundingNums.length > 0
        ? fundingNums.reduce((a, b) => a + b, 0)
        : null;

    // ── Graduation & Mortality ────────────────────────────────────────────
    const graduationCount = colMap.ownership_status || colMap.financing_status
      ? members.filter((m) => {
          const os = String(m.originalData[colMap.ownership_status ?? ""] ?? "").toLowerCase();
          const fs = String(m.originalData[colMap.financing_status ?? ""] ?? "").toLowerCase();
          return (
            (colMap.ownership_status && GRADUATION_STATUSES.has(os)) ||
            (colMap.financing_status &&
              [...GRADUATION_FINANCING].some((t) => fs.includes(t)))
          );
        }).length
      : null;

    const mortalityCount = colMap.business_status
      ? members.filter((m) => {
          const bs = String(m.originalData[colMap.business_status!] ?? "").toLowerCase();
          return MORTALITY_STATUSES.has(bs);
        }).length
      : null;

    // ── Deals ─────────────────────────────────────────────────────────────
    let dealCount: number | null = null;
    let dealMomentum: number | null = null;
    let fundingVelocity: number | null = null;

    if (dealsData && colMap.de_co_id && colMap.deal_date) {
      const clusterDeals = dealsData.filter((d) => {
        const id = String(d[colMap.de_co_id!] ?? "");
        return companyIds.has(id);
      });

      dealCount = clusterDeals.length;

      // YoY momentum
      const prevYearDeals = clusterDeals.filter((d) => {
        const date = safeDate(d[colMap.deal_date!]);
        return date && date.getFullYear() === refYear - 1;
      }).length;
      const thisYearDeals = clusterDeals.filter((d) => {
        const date = safeDate(d[colMap.deal_date!]);
        return date && date.getFullYear() === refYear;
      }).length;

      if (prevYearDeals > 0) {
        dealMomentum = Math.round(
          ((thisYearDeals - prevYearDeals) / prevYearDeals) * 100
        );
      }

      // Funding velocity
      if (colMap.deal_size) {
        const recentSizes = clusterDeals
          .filter((d) => {
            const date = safeDate(d[colMap.deal_date!]);
            return date && date.getFullYear() === refYear;
          })
          .map((d) => safeNum(d[colMap.deal_size!]))
          .filter((n): n is number => n !== null);
        const prevSizes = clusterDeals
          .filter((d) => {
            const date = safeDate(d[colMap.deal_date!]);
            return date && date.getFullYear() === refYear - 1;
          })
          .map((d) => safeNum(d[colMap.deal_size!]))
          .filter((n): n is number => n !== null);
        const avgRecent =
          recentSizes.length > 0
            ? recentSizes.reduce((a, b) => a + b, 0) / recentSizes.length
            : null;
        const avgPrev =
          prevSizes.length > 0
            ? prevSizes.reduce((a, b) => a + b, 0) / prevSizes.length
            : null;
        if (avgRecent !== null && avgPrev !== null && avgPrev > 0) {
          fundingVelocity = Math.round(((avgRecent - avgPrev) / avgPrev) * 100);
        } else {
          fundingVelocity = avgRecent !== null ? 100 : null;
        }
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
      graduationCount,
      mortalityCount,
      fundingVelocity,
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
