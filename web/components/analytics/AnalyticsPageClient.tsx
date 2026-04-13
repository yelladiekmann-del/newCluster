"use client";

import { useState, useMemo, useCallback } from "react";
import Papa from "papaparse";
import { saveAs } from "file-saver";
import { Download, UploadCloud } from "lucide-react";
import { useSession } from "@/lib/store/session";
import { persistSession } from "@/lib/firebase/hooks";
import { computeAnalytics, rankRows } from "@/lib/analytics/compute";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AnalyticsTable } from "./AnalyticsTable";
import { AnalyticsCharts } from "./AnalyticsCharts";
import type { AnalyticsColMap } from "@/types";

export function AnalyticsPageClient() {
  const { uid, companies, clusters, analyticsColMap, setAnalyticsColMap } =
    useSession();

  const [dealsData, setDealsData] = useState<Record<string, unknown>[] | null>(null);
  const [dealsColumns, setDealsColumns] = useState<string[]>([]);

  const companyColumns = useMemo(() => {
    if (companies.length === 0) return [];
    return Object.keys(companies[0].originalData ?? {});
  }, [companies]);

  const allColumns = useMemo(
    () => Array.from(new Set([...companyColumns, ...dealsColumns])),
    [companyColumns, dealsColumns]
  );

  const handleDealsFile = useCallback((file: File) => {
    Papa.parse<Record<string, unknown>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        setDealsData(results.data);
        setDealsColumns(Object.keys(results.data[0] ?? {}));
      },
    });
  }, []);

  const updateColMap = useCallback(
    async (key: keyof AnalyticsColMap, value: string) => {
      const updated = { ...analyticsColMap, [key]: value };
      setAnalyticsColMap(updated);
      if (uid) await persistSession(uid, { analyticsColMap: updated });
    },
    [uid, analyticsColMap, setAnalyticsColMap]
  );

  const currentYear = useMemo(() => new Date().getFullYear(), []);
  const analyticsRows = useMemo(
    () =>
      computeAnalytics(
        clusters.filter((c) => !c.isOutliers),
        companies,
        dealsData,
        analyticsColMap,
        currentYear
      ),
    [clusters, companies, dealsData, analyticsColMap, currentYear]
  );

  const handleDownload = () => {
    const csv = Papa.unparse(analyticsRows);
    saveAs(new Blob([csv], { type: "text/csv" }), "cluster_analytics.csv");
  };

  const colPicker = (
    key: keyof AnalyticsColMap,
    label: string,
    columns = allColumns
  ) => (
    <div className="flex flex-col gap-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select
        value={analyticsColMap[key] ?? ""}
        onValueChange={(v) => updateColMap(key, v || "")}
      >
        <SelectTrigger className="h-8 text-xs">
          <SelectValue placeholder="Select…" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">— none —</SelectItem>
          {columns.map((c) => (
            <SelectItem key={c} value={c}>
              {c}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 flex flex-col gap-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Analytics</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Per-cluster metrics and rankings.
          </p>
        </div>
        {analyticsRows.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleDownload}
            className="gap-1.5"
          >
            <Download className="h-3.5 w-3.5" />
            Download CSV
          </Button>
        )}
      </div>

      {/* Deals upload */}
      <div className="flex flex-col gap-2">
        <Label className="text-sm font-semibold">
          Deals Data{" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <label className="flex items-center gap-3 border border-dashed border-border rounded-lg p-4 cursor-pointer hover:border-primary/60 hover:bg-muted/30 transition-colors w-fit">
          <UploadCloud className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            {dealsData
              ? `${dealsData.length.toLocaleString()} deals loaded`
              : "Upload deals CSV for funding & deal metrics"}
          </span>
          <input
            type="file"
            accept=".csv,.xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleDealsFile(file);
            }}
          />
        </label>
      </div>

      {/* Column mapping */}
      <div className="flex flex-col gap-3">
        <Label className="text-sm font-semibold">Column Mapping</Label>
        <div className="grid grid-cols-3 gap-3">
          {colPicker("employees", "Employee count", companyColumns)}
          {colPicker("year_founded", "Year founded", companyColumns)}
          {colPicker("total_raised", "Total raised", companyColumns)}
          {colPicker("business_status", "Business status", companyColumns)}
          {colPicker("ownership_status", "Ownership status", companyColumns)}
          {colPicker("financing_status", "Financing status", companyColumns)}
          {dealsData && (
            <>
              {colPicker("de_co_id", "Deal company ID", dealsColumns)}
              {colPicker("deal_date", "Deal date", dealsColumns)}
              {colPicker("deal_size", "Deal size", dealsColumns)}
            </>
          )}
        </div>
      </div>

      {/* Analytics table */}
      {analyticsRows.length > 0 && (
        <>
          <AnalyticsTable rows={analyticsRows} hasDeals={!!dealsData} />
          <AnalyticsCharts rows={analyticsRows} />
        </>
      )}

      {analyticsRows.length === 0 && (
        <div className="text-center py-16 text-muted-foreground text-sm">
          No cluster data available. Complete the clustering pipeline first.
        </div>
      )}
    </div>
  );
}
