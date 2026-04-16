/**
 * High-level sync functions called from pipeline pages.
 * All functions are fire-and-forget safe — they throw on error so callers can .catch(() => {}).
 */

import type { CompanyDoc, ClusterDoc, ClusterMetricsRow } from "@/types";
import {
  createSpreadsheet,
  setValues,
  addSheet,
  batchUpdate,
  addScatterChart,
} from "./api";

// ── Helpers ──────────────────────────────────────────────────────────────────

function todayLabel(): string {
  return new Date().toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function boldFreezeRequests(sheetId: number, columnCount: number) {
  return [
    // Bold row 1
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: columnCount },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: "userEnteredFormat.textFormat.bold",
      },
    },
    // Freeze row 1
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: "gridProperties.frozenRowCount",
      },
    },
  ];
}

function setColumnWidth(sheetId: number, columnIndex: number, widthPx: number) {
  return {
    updateDimensionProperties: {
      range: {
        sheetId,
        dimension: "COLUMNS",
        startIndex: columnIndex,
        endIndex: columnIndex + 1,
      },
      properties: { pixelSize: widthPx },
      fields: "pixelSize",
    },
  };
}

async function ensureSheetOk(res: Response): Promise<void> {
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`Sheets API ${res.status}: ${body}`);
  }
}

async function getSheetProperties(
  token: string,
  spreadsheetId: string
): Promise<Array<{ title: string; sheetId: number }>> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  await ensureSheetOk(res);
  const meta = await res.json();
  return (meta.sheets as { properties: { title: string; sheetId: number } }[]).map((sheet) => sheet.properties);
}

async function getOrCreateSheet(
  token: string,
  spreadsheetId: string,
  title: string
): Promise<number> {
  const sheets = await getSheetProperties(token, spreadsheetId);
  const existing = sheets.find((sheet) => sheet.title === title);
  if (existing) return existing.sheetId;
  return addSheet(token, spreadsheetId, title);
}

async function clearSheet(token: string, spreadsheetId: string, title: string): Promise<void> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`${title}!A1:ZZ10000`)}:clear`,
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
  );
  await ensureSheetOk(res);
}

// ── syncSetupToSheet ─────────────────────────────────────────────────────────

/**
 * Spreadsheet naming convention:
 *   {Session Name} · {N} cos · {Mon YYYY}
 *
 * If no session name is available:
 *   Cluster Analysis · {N} cos · {Mon YYYY}
 *
 * Examples:
 *   "IoT Landscape 2025 · 124 cos · Apr 2026"
 *   "Cluster Analysis · 87 cos · Apr 2026"
 */
function buildSpreadsheetTitle(sessionName: string | null | undefined, companyCount: number): string {
  const label = sessionName?.trim() || "Cluster Analysis";
  const month = new Date().toLocaleDateString(undefined, { month: "short", year: "numeric" });
  return `${label} · ${companyCount} cos · ${month}`;
}

/** Called after Setup → Continue. Creates the spreadsheet and writes the "Companies" tab. */
export async function syncSetupToSheet(
  token: string,
  companies: CompanyDoc[],
  sessionName?: string | null
): Promise<{ spreadsheetId: string; spreadsheetUrl: string }> {
  const n = companies.length;
  const title = buildSpreadsheetTitle(sessionName, n);

  const { spreadsheetId, spreadsheetUrl } = await createSpreadsheet(token, title, "Companies");

  // Build header from non-empty dimension keys
  const dimKeys = Array.from(
    new Set(companies.flatMap((c) => Object.keys(c.dimensions ?? {})))
  ).filter((k) => companies.some((c) => c.dimensions?.[k as keyof typeof c.dimensions]));

  const header = ["Company", ...dimKeys];
  const rows = companies.map((c) => [
    c.name,
    ...dimKeys.map((k) => c.dimensions?.[k as keyof typeof c.dimensions] ?? ""),
  ]);

  await setValues(token, spreadsheetId, "Companies!A1", [header, ...rows]);

  await batchUpdate(token, spreadsheetId, [
    ...boldFreezeRequests(0, header.length),
    setColumnWidth(0, 0, 220),
  ]);

  return { spreadsheetId, spreadsheetUrl };
}

// ── syncClustersToSheet ──────────────────────────────────────────────────────

/**
 * Called after Confirm & name clusters.
 * Adds "Cluster Assignments" and "Cluster Summary" tabs with a UMAP scatter chart.
 */
export async function syncClustersToSheet(
  token: string,
  spreadsheetId: string,
  companies: CompanyDoc[],
  clusters: ClusterDoc[]
): Promise<void> {
  const clusterById = Object.fromEntries(clusters.map((c) => [c.id, c]));

  // ── Cluster Assignments tab ──────────────────────────────────────────────
  const assignmentsSheetId = await addSheet(token, spreadsheetId, "Cluster Assignments");

  const assignHeader = ["Company", "Cluster", "UMAP X", "UMAP Y"];

  // Sort: non-outliers first (grouped by cluster), then outliers
  const sorted = [...companies].sort((a, b) => {
    const aOut = a.clusterId === "outliers" ? 1 : 0;
    const bOut = b.clusterId === "outliers" ? 1 : 0;
    if (aOut !== bOut) return aOut - bOut;
    return (a.clusterId ?? "").localeCompare(b.clusterId ?? "");
  });

  // Track row indices per cluster (1-based, after header)
  const clusterRowMap: Record<string, number[]> = {};
  const assignRows = sorted.map((c, i) => {
    const rowNum = i + 2; // 1-based row; row 1 is header
    const clusterId = c.clusterId ?? "outliers";
    if (!clusterRowMap[clusterId]) clusterRowMap[clusterId] = [];
    clusterRowMap[clusterId].push(rowNum);

    return [
      c.name,
      clusterById[clusterId]?.name ?? "Outliers",
      c.umapX ?? "",
      c.umapY ?? "",
    ];
  });

  await setValues(token, spreadsheetId, "Cluster Assignments!A1", [assignHeader, ...assignRows]);
  await batchUpdate(token, spreadsheetId, [
    ...boldFreezeRequests(assignmentsSheetId, assignHeader.length),
    setColumnWidth(assignmentsSheetId, 0, 220),
  ]);

  // UMAP scatter chart (non-outlier clusters only)
  const nonOutlierClusters = clusters.filter((c) => !c.isOutliers);
  if (nonOutlierClusters.length > 0) {
    const chartSeries = nonOutlierClusters
      .map((c) => ({
        name: c.name,
        color: c.color,
        rowIndices: clusterRowMap[c.id] ?? [],
      }))
      .filter((s) => s.rowIndices.length > 0);

    if (chartSeries.length > 0) {
      await addScatterChart(
        token,
        spreadsheetId,
        assignmentsSheetId,
        chartSeries,
        sorted.length + 1
      ).catch(() => {}); // chart failure is non-fatal
    }
  }

  // ── Cluster Summary tab ──────────────────────────────────────────────────
  const summarySheetId = await addSheet(token, spreadsheetId, "Cluster Summary");
  const summaryHeader = ["Cluster", "Description", "Company Count"];
  const summaryRows = clusters
    .filter((c) => !c.isOutliers)
    .map((c) => [c.name, c.description, c.companyCount]);

  await setValues(token, spreadsheetId, "Cluster Summary!A1", [summaryHeader, ...summaryRows]);
  await batchUpdate(token, spreadsheetId, [
    ...boldFreezeRequests(summarySheetId, summaryHeader.length),
    setColumnWidth(summarySheetId, 0, 220),
    setColumnWidth(summarySheetId, 1, 320),
  ]);
}

// ── syncReviewToSheet ────────────────────────────────────────────────────────

/**
 * Called after Review → Continue to Analytics.
 * Clears and rewrites the "Cluster Assignments" tab with current (possibly edited) assignments.
 */
export async function syncReviewToSheet(
  token: string,
  spreadsheetId: string,
  companies: CompanyDoc[],
  clusters: ClusterDoc[]
): Promise<void> {
  // Get the sheetId of "Cluster Assignments"
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!metaRes.ok) throw new Error(`Sheets metadata ${metaRes.status}`);
  const meta = await metaRes.json();
  const sheet = (meta.sheets as { properties: { title: string; sheetId: number } }[]).find(
    (s) => s.properties.title === "Cluster Assignments"
  );
  if (!sheet) throw new Error("Cluster Assignments tab not found");
  const sheetId = sheet.properties.sheetId;

  // Clear existing content
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Cluster Assignments!A1:Z10000:clear`,
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
  );

  const clusterById = Object.fromEntries(clusters.map((c) => [c.id, c]));
  const sorted = [...companies].sort((a, b) => {
    const aOut = a.clusterId === "outliers" ? 1 : 0;
    const bOut = b.clusterId === "outliers" ? 1 : 0;
    if (aOut !== bOut) return aOut - bOut;
    return (a.clusterId ?? "").localeCompare(b.clusterId ?? "");
  });

  const header = [`Company — Last updated after review: ${todayLabel()}`, "Cluster", "UMAP X", "UMAP Y"];
  const rows = sorted.map((c) => {
    const clusterId = c.clusterId ?? "outliers";
    return [
      c.name,
      clusterById[clusterId]?.name ?? "Outliers",
      c.umapX ?? "",
      c.umapY ?? "",
    ];
  });

  await setValues(token, spreadsheetId, "Cluster Assignments!A1", [header, ...rows]);
  await batchUpdate(token, spreadsheetId, [
    ...boldFreezeRequests(sheetId, header.length),
    setColumnWidth(sheetId, 0, 220),
  ]);
}

// ── syncAnalyticsToSheet ─────────────────────────────────────────────────────

function fmtAnalyticsValue(key: keyof ClusterMetricsRow, value: ClusterMetricsRow[keyof ClusterMetricsRow]): string | number {
  if (value == null) return "";
  if (typeof value !== "number") return String(value);
  if (key === "avgFunding" || key === "totalFunding" || key === "totalInvested4yr" || key === "capitalMean" || key === "capitalMedian") {
    return Math.round(value);
  }
  if (key === "avgSeriesScore" || key === "avgPatentFamilies" || key === "meanMedianRatio" || key === "marktreife") {
    return Number(value.toFixed(2));
  }
  return value;
}

export async function syncAnalyticsToSheet(
  token: string,
  spreadsheetId: string,
  rows: ClusterMetricsRow[]
): Promise<void> {
  const title = "Cluster Analytics";
  const sheetId = await getOrCreateSheet(token, spreadsheetId, title);
  await clearSheet(token, spreadsheetId, title);

  const header: Array<keyof ClusterMetricsRow | "Last Updated"> = [
    "clusterName",
    "companyCount",
    "uniqueCompanies",
    "avgEmployees",
    "avgYearFounded",
    "pctRecentlyFounded",
    "dealCount",
    "dealMomentum",
    "avgFunding",
    "totalFunding",
    "totalInvested4yr",
    "fundingMomentum",
    "capitalMean",
    "capitalMedian",
    "meanMedianRatio",
    "vcGraduationRate",
    "mortalityRate",
    "hhi",
    "marktreife",
    "avgSeriesScore",
    "avgPatentFamilies",
    "Last Updated",
  ];

  const values = [
    header.map((key) => String(key)),
    ...rows.map((row) =>
      header.map((key) =>
        key === "Last Updated"
          ? todayLabel()
          : fmtAnalyticsValue(key, row[key])
      )
    ),
  ];

  await setValues(token, spreadsheetId, `${title}!A1`, values);
  await batchUpdate(token, spreadsheetId, [
    ...boldFreezeRequests(sheetId, header.length),
    setColumnWidth(sheetId, 0, 220),
  ]);
}
