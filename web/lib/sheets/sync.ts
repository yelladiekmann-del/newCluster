/**
 * High-level sync functions called from pipeline pages.
 * All functions are fire-and-forget safe — they throw on error so callers can .catch(() => {}).
 */

import type { CompanyDoc, ClusterDoc } from "@/types";
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

// ── syncSetupToSheet ─────────────────────────────────────────────────────────

/**
 * Called after Setup → Continue.
 * Creates the spreadsheet and writes the "Companies" tab.
 */
export async function syncSetupToSheet(
  token: string,
  companies: CompanyDoc[],
  sessionName?: string | null
): Promise<{ spreadsheetId: string; spreadsheetUrl: string }> {
  const n = companies.length;
  const prefix = sessionName ? `${sessionName} – ` : "";
  const title = `${prefix}${n} companies – ${todayLabel()}`;

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
