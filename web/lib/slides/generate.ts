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

import type { ClusterSlideData, DealRow, SlidesData } from "./types";

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
      properties: { title },
      sheets: [
        { properties: { sheetId: 0, title: "Import",  index: 0 } },
        { properties: { sheetId: 1, title: "Pivot",   index: 1 } },
        { properties: { sheetId: 2, title: "Results", index: 2 } },
      ],
    }),
  });
  await checkOk(createRes, "Sheets create");
  const { spreadsheetId } = await createRes.json() as { spreadsheetId: string };

  // Move the new sheet into the user's own My Drive root (Sheets API creates in root
  // by default, but if the request context inherits a shared drive this makes it explicit).
  // We read the current parents first so we can remove them when re-parenting.
  const metaRes = await fetch(
    `${DRIVE_BASE}/${spreadsheetId}?fields=parents`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (metaRes.ok) {
    const { parents } = await metaRes.json() as { parents?: string[] };
    const removeParents = parents?.join(",") ?? "";
    await fetch(
      `${DRIVE_BASE}/${spreadsheetId}?addParents=root&removeParents=${removeParents}&fields=id`,
      { method: "PATCH", headers: authHeaders(token), body: JSON.stringify({}) }
    );
    // Non-fatal: if this fails the sheet was already in the user's Drive
  }

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

  // ── Write Pivot formula (QUERY aggregation by year) ─────────────────────────
  // Note: NO LABEL clause — special chars (€, parentheses) in LABEL strings cause
  // a formula parse error (#ERROR!) that IFERROR cannot catch.
  // headers=1 tells QUERY that Import row 1 is a header row (not data).
  // QUERY will output its own auto-header in Pivot!A2; actual year data starts at A3.
  const pivotFormula = [
    [
      `=IFERROR(QUERY(Import!A:F,"SELECT F, SUM(E), COUNT(A) WHERE F IS NOT NULL GROUP BY F ORDER BY F",1),"")`,
    ],
  ];

  await fetch(
    `${SHEETS_BASE}/${spreadsheetId}/values/Pivot!A2?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({ values: pivotFormula }),
    }
  ).then((r) => checkOk(r, "Sheets write Pivot"));

  // ── Write Results formulas (pass-through from Pivot for chart source) ────────
  // QUERY auto-header lands in Pivot!A2 — actual data starts at Pivot!A3.
  // Results row 1 therefore maps to Pivot!A3 (first year value, e.g. 2020).
  await fetch(
    `${SHEETS_BASE}/${spreadsheetId}/values/Results!A1?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({
        values: [
          ["=Pivot!A3",  "=Pivot!B3",  "=Pivot!C3"],
          ["=Pivot!A4",  "=Pivot!B4",  "=Pivot!C4"],
          ["=Pivot!A5",  "=Pivot!B5",  "=Pivot!C5"],
          ["=Pivot!A6",  "=Pivot!B6",  "=Pivot!C6"],
          ["=Pivot!A7",  "=Pivot!B7",  "=Pivot!C7"],
          ["=Pivot!A8",  "=Pivot!B8",  "=Pivot!C8"],
          ["=Pivot!A9",  "=Pivot!B9",  "=Pivot!C9"],
          ["=Pivot!A10", "=Pivot!B10", "=Pivot!C10"],
          ["=Pivot!A11", "=Pivot!B11", "=Pivot!C11"],
          ["=Pivot!A12", "=Pivot!B12", "=Pivot!C12"],
        ],
      }),
    }
  ).then((r) => checkOk(r, "Sheets write Results"));

  // ── Format year columns as plain integers (prevent date auto-formatting in chart) ──
  const formatRes = await fetch(`${SHEETS_BASE}/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      requests: [
        // Import!F2:F — Jahr-Spalte als Plain-Integer formatieren
        {
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 1, startColumnIndex: 5, endColumnIndex: 6 },
            cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "0" } } },
            fields: "userEnteredFormat.numberFormat",
          },
        },
        // Results!A1:A10 — Domain-Spalte als Plain-Integer formatieren
        {
          repeatCell: {
            range: { sheetId: 2, startRowIndex: 0, endRowIndex: 10, startColumnIndex: 0, endColumnIndex: 1 },
            cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "0" } } },
            fields: "userEnteredFormat.numberFormat",
          },
        },
      ],
    }),
  });
  await checkOk(formatRes, "Sheets format year columns");

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
                      dataLabel: { type: "DATA" },
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
                      dataLabel: { type: "DATA" },
                      lineStyle: { width: 2, type: "SOLID" },
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
  // parents: ["root"] ensures the copy lands in the user's own My Drive,
  // not in the shared folder where the template lives.
  const res = await fetch(`${DRIVE_BASE}/${templateId}/copy`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ name, parents: ["root"] }),
  });
  await checkOk(res, "Drive copy");
  const data = await res.json() as { id: string };
  return data.id;
}

// ─── 3. Replace placeholders ──────────────────────────────────────────────────

/**
 * Expands `clusterSlides` array into flat `{{cluster_num1}}` … `{{sowhat_3}}` keys.
 * Called by replacePlaceholders before building the requests array.
 */
function expandClusterPlaceholders(
  slides: ClusterSlideData[]
): Record<string, string> {
  const out: Record<string, string> = {};
  slides.slice(0, 3).forEach((s, i) => {
    const n = i + 1;
    out[`cluster_num${n}`]  = s.num;
    out[`cluster_name${n}`] = s.name;
    out[`hq_${n}`]          = s.hq;
    out[`funding_${n}`]     = s.funding;
    out[`description_${n}`] = s.description;
    out[`sowhat_${n}`]      = s.sowhat;
  });
  return out;
}

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

  // Expand cluster slide placeholders and omit non-string / non-text fields
  const { clusterSlides, umapImageUrl, ...rest } = data as SlidesData & { clusterSlides?: ClusterSlideData[]; umapImageUrl?: string };
  const clusterFields = clusterSlides?.length ? expandClusterPlaceholders(clusterSlides) : {};
  void umapImageUrl; // used separately in embedScatterImage

  // Build a flat string map — skip array/object values (dealRows etc.)
  const flatRest: Record<string, string> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (typeof v === "string") flatRest[k] = v;
  }

  const allFields: Record<string, string> = {
    ...flatRest,
    ...clusterFields,
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

// ── EMU helpers ───────────────────────────────────────────────────────────────
// 1 cm = 360 000 EMU    1 pt = 12 700 EMU
//
// Fallback chart position for the hy VC-analysis slide (Folie 2).
// Tunable via env vars so we never have to redeploy just to nudge the chart.
// Env vars are in cm; defaults match the standard hy 16:9 template layout.
function envEmu(key: string, defaultCm: number): number {
  const raw = process.env[key];
  const cm = raw ? parseFloat(raw) : defaultCm;
  return Math.round(cm * 360_000);
}

const CHART_X      = () => envEmu("SLIDES_CHART_X_CM",  1.0);   // 1.0 cm from left
const CHART_Y      = () => envEmu("SLIDES_CHART_Y_CM",  4.2);   // 4.2 cm from top
const CHART_W      = () => envEmu("SLIDES_CHART_W_CM", 15.0);   // 15 cm wide
const CHART_H      = () => envEmu("SLIDES_CHART_H_CM", 10.0);   // 10 cm tall

type ElemPos = { translateX: number; translateY: number; scaleX: number; scaleY: number };
type ElemSize = { width: number; height: number };

/**
 * Scans the copied presentation for a chart placeholder, deletes it, and
 * embeds the newly created Sheets chart at the same position.
 *
 * Detection order (first match wins):
 *   1. sheetsChart element (live linked chart from original template)
 *   2. image element on slide 2 with area > 5 cm × 3 cm (rasterised placeholder)
 *   3. env-var / hardcoded fallback position
 */
export async function embedChart(
  token: string,
  presentationId: string,
  spreadsheetId: string,
  chartId: number
): Promise<void> {
  // ── Fetch presentation ───────────────────────────────────────────────────────
  const presRes = await fetch(`${SLIDES_BASE}/${presentationId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await checkOk(presRes, "Slides get");
  // Use a broad type — we inspect arbitrary keys at runtime
  const pres = await presRes.json() as {
    slides: Array<{ objectId: string; pageElements?: Array<Record<string, unknown>> }>;
  };

  // ── Scan all slides for a placeholder to replace ─────────────────────────────
  let placeholderObjId: string | null = null;
  let foundPos: ElemPos | null = null;
  let foundSize: ElemSize | null = null;

  for (const slide of pres.slides ?? []) {
    for (const el of slide.pageElements ?? []) {
      const hasSheetsChart = el.sheetsChart != null;

      // Also match large image elements (chart baked into template as image)
      const imgData = el.image as Record<string, unknown> | null | undefined;
      const transform = el.transform as { translateX: number; translateY: number; scaleX: number; scaleY: number } | undefined;
      const size = el.size as { width: { magnitude: number }; height: { magnitude: number } } | undefined;

      const isLargeImage = !!imgData &&
        (size?.width?.magnitude ?? 0) > 1_800_000 &&   // > 5 cm
        (size?.height?.magnitude ?? 0) > 1_080_000;    // > 3 cm

      if (hasSheetsChart || isLargeImage) {
        if (transform) {
          foundPos = {
            translateX: transform.translateX,
            translateY: transform.translateY,
            scaleX:     transform.scaleX,
            scaleY:     transform.scaleY,
          };
        }
        if (size) {
          foundSize = {
            width:  size.width.magnitude,
            height: size.height.magnitude,
          };
        }
        placeholderObjId = String(el.objectId);
        console.log(
          `[embedChart] Found placeholder on slide type=${hasSheetsChart ? "sheetsChart" : "image"} ` +
          `objectId=${placeholderObjId} size=${foundSize?.width}×${foundSize?.height} EMU`
        );
        break;
      }
    }
    if (placeholderObjId) break;
  }

  if (!placeholderObjId) {
    console.warn(
      "[embedChart] No chart/image placeholder found in template — using fallback position. " +
      "Tune with SLIDES_CHART_X_CM / _Y_CM / _W_CM / _H_CM env vars."
    );
  }

  // ── Delete placeholder ───────────────────────────────────────────────────────
  if (placeholderObjId) {
    await fetch(`${SLIDES_BASE}/${presentationId}:batchUpdate`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ requests: [{ deleteObject: { objectId: placeholderObjId } }] }),
    }).then((r) => checkOk(r, "Slides deleteObject"));
  }

  // ── Re-fetch to get current slide objectIds after deletion ───────────────────
  const afterRes = await fetch(`${SLIDES_BASE}/${presentationId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await checkOk(afterRes, "Slides get after delete");
  const afterPres = await afterRes.json() as { slides: Array<{ objectId: string }> };
  const slideObjectId = afterPres.slides?.[1]?.objectId;   // Folie 2 (0-indexed)
  if (!slideObjectId) throw new Error("Could not find slide 2 objectId");

  // ── Embed new Sheets chart ────────────────────────────────────────────────────
  const translateX = foundPos?.translateX ?? CHART_X();
  const translateY = foundPos?.translateY ?? CHART_Y();
  const width      = foundSize?.width     ?? CHART_W();
  const height     = foundSize?.height    ?? CHART_H();

  console.log(`[embedChart] Inserting chart at (${translateX}, ${translateY}) size ${width}×${height} EMU on slide ${slideObjectId}`);

  const embedRes = await fetch(`${SLIDES_BASE}/${presentationId}:batchUpdate`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      requests: [{
        createSheetsChart: {
          spreadsheetId,
          chartId,
          linkingMode: "LINKED",
          elementProperties: {
            pageObjectId: slideObjectId,
            transform: {
              scaleX: foundPos?.scaleX ?? 1,
              scaleY: foundPos?.scaleY ?? 1,
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
      }],
    }),
  });
  await checkOk(embedRes, "Slides createSheetsChart");
  console.log("[embedChart] Chart embedded successfully.");
}

// ─── 5. Embed UMAP Scatter Image ─────────────────────────────────────────────

/**
 * Finds the UMAP scatter placeholder on slides 3+ (i.e., index ≥ 2),
 * deletes it, and inserts the PNG from `imageUrl` at the same position.
 *
 * Detection: first image element with area > 5 cm × 3 cm on a slide
 * with index ≥ 2 (skip slide 1 = title, slide 2 = Sheets chart).
 */
export async function embedScatterImage(
  token: string,
  presentationId: string,
  imageUrl: string
): Promise<void> {
  const presRes = await fetch(`${SLIDES_BASE}/${presentationId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await checkOk(presRes, "Slides get (scatter)");
  const pres = await presRes.json() as {
    slides: Array<{ objectId: string; pageElements?: Array<Record<string, unknown>> }>;
  };

  let placeholderObjId: string | null = null;
  let targetSlideObjId: string | null = null;
  let foundPos: ElemPos | null = null;
  let foundSize: ElemSize | null = null;

  for (let idx = 2; idx < (pres.slides?.length ?? 0); idx++) {
    const slide = pres.slides[idx];
    for (const el of slide.pageElements ?? []) {
      const imgData = el.image as Record<string, unknown> | null | undefined;
      const transform = el.transform as { translateX: number; translateY: number; scaleX: number; scaleY: number } | undefined;
      const size = el.size as { width: { magnitude: number }; height: { magnitude: number } } | undefined;

      const isLargeImage = !!imgData &&
        (size?.width?.magnitude ?? 0) > 1_800_000 &&
        (size?.height?.magnitude ?? 0) > 1_080_000;

      // Also match shape/text-box with alt text "cluster_scatter" (cleaner if template is updated)
      const altText = (el.description as string | undefined) ?? "";
      const isScatterPlaceholder = altText.toLowerCase().includes("cluster_scatter");

      if (isLargeImage || isScatterPlaceholder) {
        if (transform) {
          foundPos = { translateX: transform.translateX, translateY: transform.translateY, scaleX: transform.scaleX, scaleY: transform.scaleY };
        }
        if (size) {
          foundSize = { width: size.width.magnitude, height: size.height.magnitude };
        }
        placeholderObjId = String(el.objectId);
        targetSlideObjId = slide.objectId;
        console.log(`[embedScatterImage] Found placeholder on slide index ${idx} objectId=${placeholderObjId}`);
        break;
      }
    }
    if (placeholderObjId) break;
  }

  if (!placeholderObjId || !targetSlideObjId) {
    console.warn("[embedScatterImage] No scatter placeholder found — skipping scatter embed.");
    return;
  }

  // Delete placeholder
  await fetch(`${SLIDES_BASE}/${presentationId}:batchUpdate`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ requests: [{ deleteObject: { objectId: placeholderObjId } }] }),
  }).then((r) => checkOk(r, "Slides deleteObject (scatter)"));

  // Insert PNG image
  const translateX = foundPos?.translateX ?? 0;
  const translateY = foundPos?.translateY ?? 0;
  const width      = foundSize?.width  ?? envEmu("SLIDES_SCATTER_W_CM", 21.0);
  const height     = foundSize?.height ?? envEmu("SLIDES_SCATTER_H_CM", 12.0);

  const insertRes = await fetch(`${SLIDES_BASE}/${presentationId}:batchUpdate`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      requests: [{
        createImage: {
          url: imageUrl,
          elementProperties: {
            pageObjectId: targetSlideObjId,
            transform: {
              scaleX: foundPos?.scaleX ?? 1,
              scaleY: foundPos?.scaleY ?? 1,
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
      }],
    }),
  });
  await checkOk(insertRes, "Slides createImage (scatter)");
  console.log("[embedScatterImage] Scatter PNG embedded successfully.");
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Full generation pipeline:
 * 1. Create Chart Data Sheet with deal data + chart
 * 2. Copy template
 * 3. Replace all text placeholders (incl. cluster company placeholders)
 * 4. Embed the Sheets combo chart
 * 5. Embed UMAP scatter PNG (if umapImageUrl provided)
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

  // Step 5 — Embed UMAP scatter PNG (optional)
  if (data.umapImageUrl) {
    await embedScatterImage(token, presentationId, data.umapImageUrl);
  }

  return `https://docs.google.com/presentation/d/${presentationId}`;
}
