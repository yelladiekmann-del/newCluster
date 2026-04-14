/**
 * Thin wrappers over the Google Sheets REST API v4.
 * All functions throw on non-2xx responses so callers can catch silently.
 */

const BASE = "https://sheets.googleapis.com/v4/spreadsheets";

function authHeaders(token: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function checkOk(res: Response): Promise<void> {
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`Sheets API ${res.status}: ${body}`);
  }
}

/** Create a new spreadsheet with one initial sheet tab. Returns { spreadsheetId, spreadsheetUrl }. */
export async function createSpreadsheet(
  token: string,
  title: string,
  firstSheetTitle: string
): Promise<{ spreadsheetId: string; spreadsheetUrl: string }> {
  const res = await fetch(BASE, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      properties: { title },
      sheets: [{ properties: { title: firstSheetTitle, sheetId: 0, index: 0 } }],
    }),
  });
  await checkOk(res);
  const data = await res.json();
  return {
    spreadsheetId: data.spreadsheetId,
    spreadsheetUrl: data.spreadsheetUrl,
  };
}

/** Write values to a range (valueInputOption: RAW). */
export async function setValues(
  token: string,
  spreadsheetId: string,
  range: string,
  values: unknown[][]
): Promise<void> {
  const res = await fetch(
    `${BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({ range, majorDimension: "ROWS", values }),
    }
  );
  await checkOk(res);
}

/** Add a new tab to an existing spreadsheet. Returns the new sheetId (number). */
export async function addSheet(
  token: string,
  spreadsheetId: string,
  title: string
): Promise<number> {
  const res = await fetch(`${BASE}/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title } } }],
    }),
  });
  await checkOk(res);
  const data = await res.json();
  return data.replies?.[0]?.addSheet?.properties?.sheetId as number;
}

/** Send arbitrary batchUpdate requests (formatting, freeze, etc.). */
export async function batchUpdate(
  token: string,
  spreadsheetId: string,
  requests: object[]
): Promise<void> {
  const res = await fetch(`${BASE}/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ requests }),
  });
  await checkOk(res);
}

function hexToSheetsColor(hex: string): { red: number; green: number; blue: number } {
  const clean = hex.replace("#", "");
  return {
    red: parseInt(clean.slice(0, 2), 16) / 255,
    green: parseInt(clean.slice(2, 4), 16) / 255,
    blue: parseInt(clean.slice(4, 6), 16) / 255,
  };
}

interface ClusterSeries {
  name: string;
  color: string;
  /** 1-based row indices in the sheet that belong to this cluster */
  rowIndices: number[];
}

/**
 * Embed a UMAP scatter chart in the given sheet.
 * Companies must already be written to the sheet before calling this.
 * Columns (1-based): 1=Company, 2=Cluster, 3=OutlierScore, 4=UmapX, 5=UmapY
 */
export async function addScatterChart(
  token: string,
  spreadsheetId: string,
  sheetId: number,
  series: ClusterSeries[],
  anchorRow: number // first row below the data
): Promise<void> {
  // Build one BasicChartSeries per cluster using individual data point overrides
  // Google Sheets scatter charts work best with one series per group sharing a domain.
  // We'll create a single series and rely on color by row using a workaround:
  // one BasicChartSeries per cluster, each referencing the relevant row range for X and Y.

  const chartSeries = series.flatMap((cluster) => {
    if (cluster.rowIndices.length === 0) return [];
    // Build a non-contiguous range using individual row indices isn't supported
    // in Sheets API directly — instead we build one series referencing a custom domain.
    // Simplest approach: one series per cluster, use row ranges (may not be contiguous).
    // For the API we need contiguous blocks; group consecutive rows.
    const blocks = getContiguousBlocks(cluster.rowIndices);
    return blocks.map((block) => ({
      series: {
        sourceRange: {
          sources: [
            {
              sheetId,
              startRowIndex: block.start - 1, // 0-based
              endRowIndex: block.end,
              startColumnIndex: 4, // col E = UmapY (0-based)
              endColumnIndex: 5,
            },
          ],
        },
      },
      targetAxis: "LEFT_AXIS",
      color: hexToSheetsColor(cluster.color),
      seriesLabel: { sourceRange: { sources: [{ sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 }] } },
    }));
  });

  if (chartSeries.length === 0) return;

  // Build domain from col D (UmapX) covering all data rows
  const totalRows = series.flatMap((s) => s.rowIndices).length;

  const requests = [
    {
      addChart: {
        chart: {
          spec: {
            title: "UMAP Cluster Visualization",
            basicChart: {
              chartType: "SCATTER",
              legendPosition: "RIGHT_LEGEND",
              domains: [
                {
                  domain: {
                    sourceRange: {
                      sources: [
                        {
                          sheetId,
                          startRowIndex: 1, // skip header
                          endRowIndex: 1 + totalRows,
                          startColumnIndex: 3, // col D = UmapX
                          endColumnIndex: 4,
                        },
                      ],
                    },
                  },
                },
              ],
              series: chartSeries,
            },
          },
          position: {
            overlayPosition: {
              anchorCell: {
                sheetId,
                rowIndex: anchorRow + 2,
                columnIndex: 0,
              },
              widthPixels: 600,
              heightPixels: 400,
            },
          },
        },
      },
    },
  ];

  const res = await fetch(`${BASE}/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ requests }),
  });
  await checkOk(res);
}

function getContiguousBlocks(indices: number[]): { start: number; end: number }[] {
  if (indices.length === 0) return [];
  const sorted = [...indices].sort((a, b) => a - b);
  const blocks: { start: number; end: number }[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== prev + 1) {
      blocks.push({ start, end: prev + 1 });
      start = sorted[i];
    }
    prev = sorted[i];
  }
  blocks.push({ start, end: prev + 1 });
  return blocks;
}
