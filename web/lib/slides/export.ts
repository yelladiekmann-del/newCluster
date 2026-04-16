/**
 * exportClusterSlide
 *
 * Captures the Plotly UMAP chart as a PNG, uploads it to Firebase Storage for a
 * publicly-accessible URL, then copies the hy.co Slides template and adds a
 * new slide containing the chart image + cluster colour legend.
 */

import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { getFirebaseStorage } from "@/lib/firebase/client";
import type { ClusterDoc } from "@/types";
import { copyDriveFile, getPresentation, slidesBatchUpdate } from "./api";

/** Google Drive file ID of the shared hy.co Slides template. */
export const HY_SLIDES_TEMPLATE_ID =
  process.env.NEXT_PUBLIC_HY_SLIDES_TEMPLATE_ID ??
  "1_Beur14zLzdtcRc70Yb6loa-S_n7vA6_cT-LjOesVSs";

// ── Slide layout constants (all values in EMU) ────────────────────────────────
// Standard widescreen slide: 9 144 000 × 5 143 500 EMU
const SLIDE_W = 9_144_000;
const SLIDE_H = 5_143_500;
const PAD = 350_000; // outer padding

function uid(label: string) {
  return `hycluster_${label}_${Math.random().toString(36).slice(2, 9)}`;
}

function hexToRgb(hex: string): { red: number; green: number; blue: number } {
  const h = hex.replace("#", "");
  return {
    red: parseInt(h.slice(0, 2), 16) / 255,
    green: parseInt(h.slice(2, 4), 16) / 255,
    blue: parseInt(h.slice(4, 6), 16) / 255,
  };
}

function emu(n: number) {
  return { magnitude: n, unit: "EMU" };
}

function pt(n: number) {
  return { magnitude: n, unit: "PT" };
}

function transform(x: number, y: number) {
  return { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: "EMU" };
}

function size(w: number, h: number) {
  return { width: emu(w), height: emu(h) };
}

/**
 * Exports the cluster UMAP scatter as a Google Slides presentation.
 *
 * @param token        Google OAuth access token (must have `presentations` + `drive.file` scopes)
 * @param uid          Firebase UID — used as the Storage path prefix
 * @param plotDivRef   The raw DOM element that Plotly rendered into (graphDiv ref.current)
 * @param clusters     All ClusterDocs for this session
 * @param sessionName  Used as the presentation and slide title
 * @returns URL to the newly created presentation
 */
export async function exportClusterSlide(
  token: string,
  userId: string,
  plotDivRef: unknown,
  clusters: ClusterDoc[],
  sessionName: string | null
): Promise<string> {
  // ── 1. Capture Plotly chart as PNG ─────────────────────────────────────────
  const Plotly = (await import("plotly.js-dist-min")).default;
  const dataUrl: string = await (Plotly as unknown as {
    toImage: (el: unknown, opts: object) => Promise<string>;
  }).toImage(plotDivRef, {
    format: "png",
    scale: 2,
    width: 1600,
    height: 1000,
  });

  // ── 2. Upload PNG to Firebase Storage for a public HTTPS URL ───────────────
  const base64 = dataUrl.split(",")[1];
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const storageRef = ref(
    getFirebaseStorage(),
    `sessions/${userId}/slide-export.png`
  );
  await uploadBytes(storageRef, bytes, { contentType: "image/png" });
  const imageUrl = await getDownloadURL(storageRef);

  // ── 3. Copy the hy.co Slides template ──────────────────────────────────────
  const presentationTitle = sessionName
    ? `${sessionName} – Cluster Map`
    : "Cluster Map";

  const { id: presentationId, url: presentationUrl } = await copyDriveFile(
    token,
    HY_SLIDES_TEMPLATE_ID,
    presentationTitle
  );

  // ── 4. Inspect the copy ─────────────────────────────────────────────────────
  const pres = await getPresentation(token, presentationId);
  const firstSlide = pres.slides?.[0];
  const slideId = firstSlide?.objectId ?? uid("slide");

  // ── 5. Build batchUpdate requests ──────────────────────────────────────────
  const requests: object[] = [];

  // Clear existing page elements from the first slide (master/layout elements
  // are inherited and won't appear here, so the template branding is preserved).
  for (const el of firstSlide?.pageElements ?? []) {
    requests.push({ deleteObject: { objectId: el.objectId } });
  }

  // Add new slide if the template had none (shouldn't happen but be safe)
  if (!firstSlide) {
    requests.push({
      createSlide: {
        objectId: slideId,
        insertionIndex: 0,
        slideLayoutReference: { predefinedLayout: "BLANK" },
      },
    });
  }

  // Title text box
  const titleId = uid("title");
  const TITLE_H = 380_000;
  requests.push(
    {
      createShape: {
        objectId: titleId,
        shapeType: "TEXT_BOX",
        elementProperties: {
          pageObjectId: slideId,
          size: size(SLIDE_W - PAD * 2, TITLE_H),
          transform: transform(PAD, PAD),
        },
      },
    },
    { insertText: { objectId: titleId, text: presentationTitle } },
    {
      updateTextStyle: {
        objectId: titleId,
        style: { fontSize: pt(20), bold: true },
        fields: "fontSize,bold",
      },
    }
  );

  // Chart image area
  const nonOutliers = clusters.filter((c) => !c.isOutliers);
  const CONTENT_TOP = PAD + TITLE_H + 130_000;
  const CONTENT_H = SLIDE_H - CONTENT_TOP - PAD;
  const LEGEND_ITEM_H = nonOutliers.length > 0
    ? Math.min(300_000, Math.floor(CONTENT_H / nonOutliers.length))
    : 0;
  const LEGEND_W = nonOutliers.length > 0 ? 2_000_000 : 0;
  const CHART_W = SLIDE_W - PAD * 2 - (LEGEND_W > 0 ? LEGEND_W + 120_000 : 0);

  const chartId = uid("chart");
  requests.push({
    createImage: {
      objectId: chartId,
      url: imageUrl,
      elementProperties: {
        pageObjectId: slideId,
        size: size(CHART_W, CONTENT_H),
        transform: transform(PAD, CONTENT_TOP),
      },
    },
  });

  // Legend items — colour circle + label text box per cluster
  if (nonOutliers.length > 0) {
    const LEGEND_X = PAD + CHART_W + 120_000;
    const SWATCH = 180_000;

    for (let i = 0; i < nonOutliers.length; i++) {
      const cluster = nonOutliers[i];
      const itemY = CONTENT_TOP + i * LEGEND_ITEM_H;
      const swatchId = uid(`swatch_${i}`);
      const labelId = uid(`label_${i}`);
      const color = cluster.color ?? "#888888";

      // Colour circle
      requests.push(
        {
          createShape: {
            objectId: swatchId,
            shapeType: "ELLIPSE",
            elementProperties: {
              pageObjectId: slideId,
              size: size(SWATCH, SWATCH),
              transform: transform(
                LEGEND_X,
                itemY + Math.round((LEGEND_ITEM_H - SWATCH) / 2)
              ),
            },
          },
        },
        {
          updateShapeProperties: {
            objectId: swatchId,
            shapeProperties: {
              shapeBackgroundFill: {
                solidFill: { color: { rgbColor: hexToRgb(color) } },
              },
              outline: { outlineFill: { solidFill: { color: { rgbColor: hexToRgb(color) } } } },
            },
            fields: "shapeBackgroundFill.solidFill.color,outline.outlineFill.solidFill.color",
          },
        }
      );

      // Label
      requests.push(
        {
          createShape: {
            objectId: labelId,
            shapeType: "TEXT_BOX",
            elementProperties: {
              pageObjectId: slideId,
              size: size(LEGEND_W - SWATCH - 100_000, LEGEND_ITEM_H),
              transform: transform(LEGEND_X + SWATCH + 80_000, itemY),
            },
          },
        },
        { insertText: { objectId: labelId, text: cluster.name } },
        {
          updateTextStyle: {
            objectId: labelId,
            style: { fontSize: pt(9) },
            fields: "fontSize",
          },
        },
        {
          updateShapeProperties: {
            objectId: labelId,
            shapeProperties: { contentAlignment: "MIDDLE" },
            fields: "contentAlignment",
          },
        }
      );
    }
  }

  // Delete extra slides the template may have added (keep only slide 0)
  for (let i = 1; i < (pres.slides?.length ?? 0); i++) {
    requests.push({ deleteObject: { objectId: pres.slides[i].objectId } });
  }

  // ── 6. Apply all changes in one round-trip ─────────────────────────────────
  await slidesBatchUpdate(token, presentationId, requests);

  return presentationUrl;
}
