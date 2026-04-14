"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import Papa from "papaparse";
import { saveAs } from "file-saver";
import { Download, CheckCircle2 } from "lucide-react";
import { useSession } from "@/lib/store/session";
import { loadCompanies, loadClusters } from "@/lib/firebase/hooks";
import { computeAnalytics } from "@/lib/analytics/compute";
import { Button } from "@/components/ui/button";
import { FileUploadZone } from "@/components/ui/file-upload-zone";
import { AnalyticsTable } from "./AnalyticsTable";
import { AnalyticsCharts } from "./AnalyticsCharts";
import { getBytes, ref } from "firebase/storage";
import { getFirebaseStorage } from "@/lib/firebase/client";
import type { AnalyticsColMap } from "@/types";

/**
 * Auto-detect standard column names from the CSV headers.
 * Supports common CBI/Pitchbook-style naming variants.
 */
function detectColMap(
  companyCols: string[],
  dealsCols: string[]
): AnalyticsColMap {
  const find = (cols: string[], patterns: RegExp[]) =>
    cols.find((c) => patterns.some((p) => p.test(c))) ?? undefined;

  return {
    co_id: find(companyCols, [/company.?id/i, /co.?id/i, /org.?id/i, /organization.?id/i, /^id$/i]),
    employees: find(companyCols, [/employee/i, /staff/i, /headcount/i]),
    year_founded: find(companyCols, [/year.?founded/i, /founded.?year/i, /founding/i, /^founded$/i]),
    total_raised: find(companyCols, [/total.?raised/i, /total.?funding/i, /funds.?raised/i, /total.?capital/i]),
    business_status: find(companyCols, [/business.?status/i, /company.?status/i, /^status$/i]),
    ownership_status: find(companyCols, [/ownership.?status/i, /ownership/i]),
    financing_status: find(companyCols, [/financing.?status/i, /company.?financing/i, /financing$/i]),
    patent_families: find(companyCols, [/patent.?famil/i, /total.?patent/i, /patentiert/i]),
    de_co_id: find(dealsCols, [/company.?id/i, /co.?id/i, /org.?id/i, /^id$/i]),
    de_co_name: find(dealsCols, [/company.?name/i, /org.?name/i, /^name$/i]),
    deal_date: find(dealsCols, [/deal.?date/i, /date$/i, /closed/i]),
    deal_size: find(dealsCols, [/deal.?size/i, /amount/i, /size/i]),
    series: find(dealsCols, [/series/i, /stage/i, /round/i]),
    deal_id: find(dealsCols, [/deal.?id/i, /^id$/i]),
  };
}

export function AnalyticsPageClient() {
  const { uid, companies, clusters, setCompanies, setClusters, dealsStoragePath, companyCol } = useSession();

  const [dealsData, setDealsData] = useState<Record<string, unknown>[] | null>(null);
  const [dealsColumns, setDealsColumns] = useState<string[]>([]);
  const [dealsAutoLoaded, setDealsAutoLoaded] = useState(false);

  // Load companies/clusters from Storage when store is empty (e.g. hard reload)
  useEffect(() => {
    if (!uid) return;
    if (companies.length === 0) {
      loadCompanies(uid, companyCol ?? "name").then(setCompanies).catch(() => {});
    }
    if (clusters.length === 0) {
      loadClusters(uid).then(setClusters).catch(() => {});
    }
  }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-fetch deals from Firebase Storage when available
  useEffect(() => {
    if (!uid || !dealsStoragePath || dealsData) return;
    getBytes(ref(getFirebaseStorage(), dealsStoragePath))
      .then((bytes) => {
        const text = new TextDecoder().decode(bytes);
        Papa.parse<Record<string, unknown>>(text, {
          header: true,
          skipEmptyLines: true,
          complete: (r) => {
            setDealsData(r.data);
            setDealsColumns(Object.keys(r.data[0] ?? {}));
            setDealsAutoLoaded(true);
          },
        });
      })
      .catch(() => {});
  }, [uid, dealsStoragePath]); // eslint-disable-line react-hooks/exhaustive-deps

  const companyColumns = useMemo(() => {
    if (companies.length === 0) return [];
    return Object.keys(companies[0].originalData ?? {});
  }, [companies]);

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

  const colMap = useMemo(
    () => detectColMap(companyColumns, dealsColumns),
    [companyColumns, dealsColumns]
  );

  const currentYear = useMemo(() => new Date().getFullYear(), []);
  const analyticsRows = useMemo(
    () =>
      computeAnalytics(
        clusters.filter((c) => !c.isOutliers),
        companies,
        dealsData,
        colMap,
        currentYear
      ),
    [clusters, companies, dealsData, colMap, currentYear]
  );

  const handleDownload = () => {
    const csv = Papa.unparse(analyticsRows);
    saveAs(new Blob([csv], { type: "text/csv" }), "cluster_analytics.csv");
  };

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
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">Deals Data</span>
          <span className="text-xs text-muted-foreground font-normal">(optional)</span>
        </div>
        {dealsData ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 text-primary shrink-0" />
            <span>
              {dealsData.length.toLocaleString()} deals loaded
              {dealsAutoLoaded ? " (from setup)" : ""}
            </span>
            <button
              onClick={() => { setDealsData(null); setDealsColumns([]); setDealsAutoLoaded(false); }}
              className="underline hover:text-foreground ml-1 transition-colors"
            >
              Replace
            </button>
          </div>
        ) : (
          <FileUploadZone
            accept=".csv,.xlsx,.xls"
            onFile={handleDealsFile}
            loaded={false}
            idleLabel="Upload deals CSV for funding & deal metrics"
            hint=".csv, .xlsx, .xls"
          />
        )}
      </div>

      {/* Analytics table */}
      {analyticsRows.length > 0 ? (
        <>
          <AnalyticsTable rows={analyticsRows} hasDeals={!!dealsData} />
          <AnalyticsCharts rows={analyticsRows} />
        </>
      ) : (
        <div className="text-center py-16 text-muted-foreground text-sm">
          No cluster data available. Complete the clustering pipeline first.
        </div>
      )}
    </div>
  );
}
