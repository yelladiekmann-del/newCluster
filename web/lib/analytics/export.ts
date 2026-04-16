import Papa from "papaparse";
import { saveAs } from "file-saver";

export function downloadCsvRows(
  filename: string,
  rows: Array<Record<string, unknown>>
) {
  const csv = Papa.unparse(rows);
  saveAs(new Blob([csv], { type: "text/csv" }), filename);
}
