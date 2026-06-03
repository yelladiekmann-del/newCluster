/**
 * Google Slides generation — pure REST API calls using the user's OAuth token.
 * No Python, no Cloud Run. Same pattern as lib/sheets/api.ts.
 *
 * Flow per generation:
 *  1. createChartDataSheet()  → new Sheets file with Import/Pivot/Results tabs + chart
 *  2. copyTemplate()          → Drive copy of the hy Slides template
 *  3. replacePlaceholders()   → replaceAllText for every {{placeholder}}
 *  4. embedChart()            → delete old chart, embed the Sheets chart
 */

import type { DealRow, SlidesData } from "./types";

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const SLIDES_BASE = "https://slides.googleapis.com/v1/presentations";
const DRIVE_BASE  = "https://www.googleapis.com/drive/v3/files";

function authHeaders(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function checkOk(res: Response, label: string): Promise<void> {
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`${label} ${res.status}: ${body}`);
  }
}

// ─── 1. Create Chart Data Sheet ───────────────────────────────────────────────

/**
 * Creates a new Google Sheet with Import / Pivot / Results tabs.
 * Writes deal data into Import, adds QUERY formulas for Pivot and Results,
 * creates the combo chart (Bars = Volumen, Line = Deals per year).
 * Returns { spreadsheetId, chartId }.
 */
export async function createChartDataSheet(
  token: string,
  title: string,
  deals: DealRow[]
): Promise<{ spreadsheetId: string; chartId: number }> {
  // ── Create spreadsheet with Import tab ──────────────────────────────────────
  const createRes = await fetch(SHEETS_BASE, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      properties: { title, locale: "de_DE" },
      sheets: [
        { properties: { sheetId: 0, title: "Import",  index: 0 } },
        { properties: { sheetId: 1, title: "Pivot",   index: 1 } },
        { properties: { sheetId: 2, title: "Results", index: 2 } },
      ],
    }),
  });
  await checkOk(createRes, "Sheets create");
  const { spreadsheetId } = await createRes.json() as { spreadsheetId: string };

  // ── Write deal rows into Import tab ─────────────────────────────────────────
  const header = ["Deal ID", "Companies", "Company ID", "Deal Date", "Deal Size", "Deal Year"];
  const rows = deals
    .filter((d) => d.deal_date)
    .map((d) => {
      const year = d.deal_date.slice(0, 4);
      return [d.deal_id, d.company, d.company_id, d.deal_date, d.deal_size, year];
    });

  await fetch(
    `${SHEETS_BASE}/${spreadsheetId}/values/Import!A1?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({ values: [header, ...rows] }),
    }
  ).then((r) => checkOk(r, "Sheets write Import"));

  // ── Write Pivot formulas (QUERY aggregation by year) ────────────────────────
  const pivotHeader = [["Jahr", "Investitionsvolumen (Mio. €)", "Anzahl Deals"]];
  const pivotFormula = [
    [
      `=IFERROR(QUERY(Import!A:F,"SELECT F, SUM(E), COUNT(A) WHERE F IS NOT NULL GROUP BY F ORDER BY F LABEL F 'Jahr', SUM(E) 'Investitionsvolumen (Mio. €)', COUNT(A) 'Anzahl Deals'",0),"")`,
    ],
  ];

  await fetch(
    `${SHEETS_BASE}/${spreadsheetId}/values/Pivot!A1?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({ values: [...pivotHeader, ...pivotFormula] }),
    }
  ).then((r) => checkOk(r, "Sheets write Pivot"));

  // ── Write Results formulas (pass-through from Pivot for chart source) ────────
  await fetch(
    `${SHEETS_BASE}/${spreadsheetId}/values/Results!A1?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({
        values: [
          ["=Pivot!A2", "=Pivot!B2", "=Pivot!C2"],
          ["=Pivot!A3", "=Pivot!B3", "=Pivot!C3"],
          ["=Pivot!A4", "=Pivot!B4", "=Pivot!C4"],
          ["=Pivot!A5", "=Pivot!B5", "=Pivot!C5"],
          ["=Pivot!A6", "=Pivot!B6", "=Pivot!C6"],
          ["=Pivot!A7", "=Pivot!B7", "=Pivot!C7"],
          ["=Pivot!A8", "=Pivot!B8", "=Pivot!C8"],
          ["=Pivot!A9", "=Pivot!B9", "=Pivot!C9"],
          ["=Pivot!A10", "=Pivot!B10", "=Pivot!C10"],
          ["=Pivot!A11", "=Pivot!B11", "=Pivot!C11"],
        ],
      }),
    }
  ).then((r) => checkOk(r, "Sheets write Results"));

  // ── Add combo chart in Results tab (Bars = Volumen, Line = Deals) ───────────
  const chartRes = await fetch(`${SHEETS_BASE}/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      requests: [
        {
          addChart: {
            chart: {
              spec: {
                title: "Investitionsvolumen & Finanzierungsrunden",
                basicChart: {
                  chartType: "COMBO",
                  legendPosition: "BOTTOM_LEGEND",
                  axis: [
                    { position: "BOTTOM_AXIS", title: "Jahr" },
                    { position: "LEFT_AXIS",   title: "Investitionsvolumen in Millionen Euro" },
                    { position: "RIGHT_AXIS",  title: "Anzahl der Finanzierungsrunden" },
                  ],
                  domains: [
                    {
                      domain: {
                        sourceRange: {
                          sources: [{ sheetId: 2, startRowIndex: 0, endRowIndex: 10, startColumnIndex: 0, endColumnIndex: 1 }],
                        },
                      },
                    },
                  ],
                  series: [
                    {
                      series: {
                        sourceRange: {
                          sources: [{ sheetId: 2, startRowIndex: 0, endRowIndex: 10, startColumnIndex: 1, endColumnIndex: 2 }],
                        },
                      },
                      targetAxis: "LEFT_AXIS",
                      type: "COLUMN",
                      color: { red: 0.071, green: 0.157, blue: 0.239 }, // hy dunkelblau
                    },
                    {
                      series: {
                        sourceRange: {
                          sources: [{ sheetId: 2, startRowIndex: 0, endRowIndex: 10, startColumnIndex: 2, endColumnIndex: 3 }],
                        },
                      },
                      targetAxis: "RIGHT_AXIS",
                      type: "LINE",
                      color: { red: 0.024, green: 0.651, blue: 0.639 }, // hy teal
                    },
                  ],
                },
              },
              position: {
                overlayPosition: {
                  anchorCell: { sheetId: 2, rowIndex: 0, columnIndex: 4 },
                  widthPixels: 600,
                  heightPixels: 371,
                },
              },
            },
          },
        },
      ],
    }),
  });
  await checkOk(chartRes, "Sheets addChart");
  const chartData = await chartRes.json() as { replies: Array<{ addChart?: { chart?: { chartId?: number } } }> };
  const chartId = chartData.replies?.[0]?.addChart?.chart?.chartId;
  if (chartId == null) throw new Error("Chart creation returned no chartId");

  return { spreadsheetId, chartId };
}

// ─── 2. Copy template ─────────────────────────────────────────────────────────

export async function copyTemplate(
  token: string,
  templateId: string,
  name: string
): Promise<string> {
  const res = await fetch(`${DRIVE_BASE}/${templateId}/copy`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ name }),
  });
  await checkOk(res, "Drive copy");
  const data = await res.json() as { id: string };
  return data.id;
}

// ─── 3. Replace placeholders ──────────────────────────────────────────────────

export async function replacePlaceholders(
  token: string,
  presentationId: string,
  data: Omit<SlidesData, "dealRows">
): Promise<void> {
  const today = new Date().toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  const allFields: Record<string, string> = {
    ...data,
    date: today,
  };

  const requests = Object.entries(allFields).map(([key, value]) => ({
    replaceAllText: {
      containsText: { text: `{{${key}}}`, matchCase: true },
      replaceText: value,
    },
  }));

  const res = await fetch(`${SLIDES_BASE}/${presentationId}:batchUpdate`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ requests }),
  });
  await checkOk(res, "Slides replaceAllText");
}

// ─── 4. Embed chart ───────────────────────────────────────────────────────────

/**
 * Finds the existing linked chart in the presentation (if any), deletes it,
 * then embeds the newly created Sheets chart at the same position.
 * Falls back to a fixed position if no chart is found in the template.
 */
export async function embedChart(
  token: string,
  presentationId: string,
  spreadsheetId: string,
  chartId: number
): Promise<void> {
  // ── Get current presentation state ──────────────────────────────────────────
  const getRes = await fetch(`${SLIDES_BASE}/${presentationId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await checkOk(getRes, "Slides get");
  const pres = await getRes.json() as {
    slides: Array<{
      pageElements?: Array<{
        objectId: string;
        transform?: { translateX: number; translateY: number; scaleX: number; scaleY: number; unit: string };
        size?: { width: { magnitude: number; unit: string }; height: { magnitude: number; unit: string } };
        sheetsChart?: unknown;
      }>;
    }>;
  };

  const requests: object[] = [];

  // Find existing chart element (on any slide)
  let chartPosition: { translateX: number; translateY: number; scaleX: number; scaleY: number } | null = null;
  let chartSize: { width: number; height: number } | null = null;
  let targetSlideId: string | null = null;

  for (const slide of pres.slides ?? []) {
    for (const el of slide.pageElements ?? []) {
      if ("sheetsChart" in el) {
        // Save position + size so we can place the new chart at the same spot
        if (el.transform) {
          chartPosition = {
            translateX: el.transform.translateX,
            translateY: el.transform.translateY,
            scaleX: el.transform.scaleX,
            scaleY: el.transform.scaleY,
          };
        }
        if (el.size) {
          chartSize = {
            width: el.size.width.magnitude,
            height: el.size.height.magnitude,
          };
        }
        targetSlideId = slide.pageElements?.[0]?.objectId ?? null;
        // Find the actual slide objectId
        requests.push({ deleteObject: { objectId: el.objectId } });
        break;
      }
    }
    if (requests.length > 0) {
      // Get the actual slide page objectId
      const slidePageRes = await fetch(`${SLIDES_BASE}/${presentationId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const slideData = await slidePageRes.json() as { slides: Array<{ objectId: string; pageElements?: unknown[] }> };
      // Find the slide that had the chart (index 1 = Folie 2)
      targetSlideId = slideData.slides?.[1]?.objectId ?? null;
      break;
    }
  }

  if (requests.length === 0) {
    console.warn("[embedChart] No existing chart found in template — inserting at default position");
  }

  // ── Delete old chart ─────────────────────────────────────────────────────────
  if (requests.length > 0) {
    await fetch(`${SLIDES_BASE}/${presentationId}:batchUpdate`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ requests }),
    }).then((r) => checkOk(r, "Slides deleteChart"));
  }

  // ── Embed new chart ───────────────────────────────────────────────────────────
  // Re-fetch to get current slide objectId (after deletion)
  const afterRes = await fetch(`${SLIDES_BASE}/${presentationId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await checkOk(afterRes, "Slides get after delete");
  const afterPres = await afterRes.json() as { slides: Array<{ objectId: string }> };
  const slideObjectId = afterPres.slides?.[1]?.objectId;

  if (!slideObjectId) throw new Error("Could not find slide 2 objectId");

  // EMU units: 1 pt = 12700 EMU, 1 cm = 360000 EMU
  // Chart position from template (approximate): left ~1.7cm, top ~3.3cm
  // Size: ~13.5cm wide, ~9.3cm tall
  const translateX = chartPosition?.translateX ?? 612000;   // ~1.7cm in EMU
  const translateY = chartPosition?.translateY ?? 1188000;  // ~3.3cm in EMU
  const width      = chartSize?.width           ?? 4860000; // ~13.5cm in EMU
  const height     = chartSize?.height          ?? 3348000; // ~9.3cm in EMU

  const embedRes = await fetch(`${SLIDES_BASE}/${presentationId}:batchUpdate`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      requests: [
        {
          createSheetsChart: {
            spreadsheetId,
            chartId,
            linkingMode: "LINKED",
            elementProperties: {
              pageObjectId: slideObjectId,
              transform: {
                scaleX: chartPosition?.scaleX ?? 1,
                scaleY: chartPosition?.scaleY ?? 1,
                translateX,
                translateY,
                unit: "EMU",
              },
              size: {
                width:  { magnitude: width,  unit: "EMU" },
                height: { magnitude: height, unit: "EMU" },
              },
            },
          },
        },
      ],
    }),
  });
  await checkOk(embedRes, "Slides createSheetsChart");
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Full generation pipeline:
 * 1. Create Chart Data Sheet with deal data + chart
 * 2. Copy template
 * 3. Replace all text placeholders
 * 4. Embed the new chart
 * Returns the URL of the generated presentation.
 */
export async function generateSlides(
  token: string,
  templateId: string,
  data: SlidesData
): Promise<string> {
  const today = new Date().toLocaleDateString("de-DE");
  const presentationName = `${today} – hy VC Analyse – ${data.client_company}`;

  const { dealRows, ...textData } = data;

  // Step 1 — Chart Data Sheet
  const { spreadsheetId, chartId } = await createChartDataSheet(
    token,
    `${presentationName} – Chart Data`,
    dealRows
  );

  // Step 2 — Copy template
  const presentationId = await copyTemplate(token, templateId, presentationName);

  // Step 3 — Replace placeholders
  await replacePlaceholders(token, presentationId, textData);

  // Step 4 — Embed chart
  await embedChart(token, presentationId, spreadsheetId, chartId);

  return `https://docs.google.com/presentation/d/${presentationId}`;
}
