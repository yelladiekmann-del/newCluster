"use client";

import Papa from "papaparse";

export interface ParsedTabularFile {
  rows: Record<string, unknown>[];
  columns: string[];
  source: "csv" | "excel";
  sheetName?: string;
  headerRow?: number;
  searchCriteria?: string; // raw search string extracted from PitchBook metadata rows
}

export function summarizeSearchCriteria(raw: string): string {
  // Strip leading label like "Industry Query: "
  const cleaned = raw.replace(/^[^:]+:\s*/i, "").trim().replace(/;$/, "");

  // Split by AND groups; keep track of NOT groups separately
  const upperRaw = cleaned.toUpperCase();
  const parts = cleaned.split(/\)\s+AND\s+(?:NOT\s+)?\(/i);

  const positiveTerms: string[] = [];
  const excludeTerms: string[] = [];

  for (const part of parts) {
    const group = part.replace(/^\(+|\)+;?$/g, "").trim();
    const snippet = group.toUpperCase().slice(0, 30);
    const idx = upperRaw.indexOf(snippet);
    const before = upperRaw.slice(0, Math.max(0, idx));
    const isNot = /AND\s+NOT\s*\(?\s*$/.test(before);
    const quoted = (group.match(/"([^"]+)"/g) ?? []).map(t => t.slice(1, -1));
    if (isNot) {
      excludeTerms.push(...quoted.slice(0, 4));
    } else {
      positiveTerms.push(...quoted.slice(0, 3)); // 3 per positive group
    }
  }

  const displayTerms = positiveTerms.slice(0, 8).map(t => `„${t}"`).join(", ");
  const hasMore = positiveTerms.length > 8;

  const kwPart = `Suche basiert auf Keywords: ${displayTerms}${hasMore ? " u.a." : ""}`;
  const exPart = excludeTerms.length > 0
    ? `Ausgeschlossen: ${excludeTerms.slice(0, 4).map(t => `„${t}"`).join(", ")}.`
    : "Keine Ausschlüsse angewendet.";

  return `${kwPart} — ${exPart}`;
}

function isExcelFile(file: File): boolean {
  return /\.(xlsx|xls)$/i.test(file.name);
}

function normalizeHeader(value: unknown, index: number, seen: Map<string, number>): string {
  const base = String(value ?? "").replace(/\s+/g, " ").trim() || `Column ${index + 1}`;
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base} (${count + 1})`;
}

function scoreHeaderRow(row: unknown[]): number {
  const values = row
    .map((cell) => String(cell ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (values.length < 3) return -1;

  let score = values.length;
  const joined = values.join(" | ").toLowerCase();

  if (joined.includes("company id")) score += 10;
  if (joined.includes("deal id")) score += 10;
  if (joined.includes("companies")) score += 8;
  if (joined.includes("description")) score += 6;
  if (joined.includes("search criteria")) score -= 20;
  if (joined.includes("downloaded on")) score -= 20;
  if (joined.includes("created for")) score -= 20;
  if (joined.includes("search link")) score -= 20;

  for (const value of values) {
    if (value.length <= 60) score += 1;
    if (/^(company|deal|description|keywords|verticals|pbid|competitors)/i.test(value)) {
      score += 2;
    }
    if (/https?:\/\//i.test(value)) score -= 3;
  }

  return score;
}

function detectHeaderRow(grid: unknown[][]): number {
  let bestIndex = 0;
  let bestScore = -Infinity;

  for (let i = 0; i < Math.min(grid.length, 20); i += 1) {
    const score = scoreHeaderRow(grid[i] ?? []);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return bestIndex;
}

async function parseExcelFile(file: File): Promise<ParsedTabularFile> {
  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", cellDates: false });
  const preferredSheet =
    workbook.SheetNames.find((name) => /^data$/i.test(name)) ??
    workbook.SheetNames.find((name) => !/^hidden_styles_/i.test(name) && !/^disclaimer$/i.test(name)) ??
    workbook.SheetNames[0];

  if (!preferredSheet) {
    throw new Error("Workbook does not contain any readable sheets");
  }

  const sheet = workbook.Sheets[preferredSheet];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
  });

  // Scan the first 20 rows for PitchBook search criteria metadata
  let rawSearchCriteria: string | undefined;
  for (let i = 0; i < Math.min(grid.length, 20); i++) {
    const row = grid[i];
    const colA = String(row?.[0] ?? "").trim();
    if (/^search criteria/i.test(colA)) {
      const colB = String(row?.[1] ?? "").trim();
      if (colB) rawSearchCriteria = colB;
      break;
    }
  }

  const headerIndex = detectHeaderRow(grid);
  const headerRow = grid[headerIndex] ?? [];
  const seen = new Map<string, number>();
  const columns = headerRow.map((value, index) => normalizeHeader(value, index, seen));

  const rows = grid
    .slice(headerIndex + 1)
    .filter((row) => row.some((cell) => String(cell ?? "").trim() !== ""))
    .map((row) =>
      Object.fromEntries(columns.map((column, index) => [column, row[index] ?? ""]))
    );

  return {
    rows,
    columns,
    source: "excel",
    sheetName: preferredSheet,
    headerRow: headerIndex + 1,
    searchCriteria: rawSearchCriteria,
  };
}

function parseCsvFile(file: File): Promise<ParsedTabularFile> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, unknown>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const rows = results.data;
        resolve({
          rows,
          columns: Object.keys(rows[0] ?? {}),
          source: "csv",
        });
      },
      error: reject,
    });
  });
}

export async function parseTabularFile(file: File): Promise<ParsedTabularFile> {
  return isExcelFile(file) ? parseExcelFile(file) : parseCsvFile(file);
}

export function rowsToCsv(rows: Record<string, unknown>[]): string {
  return Papa.unparse(rows);
}
