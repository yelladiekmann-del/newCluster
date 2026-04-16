"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import Papa from "papaparse";
import { ArrowLeft, BarChart3, CheckCircle2, Download, FileUp, Loader2, Save, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/store/session";
import { loadCompanies, loadClusters, persistSession } from "@/lib/firebase/hooks";
import { computeAnalytics } from "@/lib/analytics/compute";
import { Button } from "@/components/ui/button";
import { FileUploadZone } from "@/components/ui/file-upload-zone";
import { AnalyticsTable } from "./AnalyticsTable";
import { AnalyticsCharts } from "./AnalyticsCharts";
import { ScoringPanel } from "./ScoringPanel";
import { getBytes, ref, uploadBytesResumable } from "firebase/storage";
import { getFirebaseStorage } from "@/lib/firebase/client";
import type { AnalyticsColMap } from "@/types";
import { parseTabularFile, rowsToCsv } from "@/lib/tabular-upload";
import { toast } from "sonner";
import { syncAnalyticsToSheet } from "@/lib/sheets/sync";
import { downloadCsvRows } from "@/lib/analytics/export";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

function detectColMap(companyCols: string[], dealsCols: string[]): AnalyticsColMap {
  // Pattern-first: try each pattern against all columns in order.
  // The first pattern that finds a match wins, so more specific patterns
  // listed first always beat broader fallbacks (e.g. "Deal Date" before
  // "Announced Date", "Series" before "VC Round").
  const find = (cols: string[], patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const match = cols.find((c) => pattern.test(c));
      if (match) return match;
    }
    return undefined;
  };

  return {
    co_id:            find(companyCols, [/company.?id/i, /co.?id/i, /org.?id/i, /^id$/i]),
    employees:        find(companyCols, [/^total\s+employees$/i, /^employees$/i, /employee/i, /staff/i, /headcount/i]),
    year_founded:     find(companyCols, [/year.?founded/i, /founded.?year/i, /founding/i, /^founded$/i]),
    total_raised:     find(companyCols, [/total.?raised/i, /total.?funding/i, /funds.?raised/i, /total.?capital/i]),
    business_status:  find(companyCols, [/business.?status/i, /company.?status/i, /^status$/i]),
    ownership_status: find(companyCols, [/ownership.?status/i, /ownership/i]),
    financing_status: find(companyCols, [/financing.?status/i, /company.?financing/i, /financing$/i]),
    patent_families:  find(companyCols, [/patent.?famil/i, /total.?patent/i, /patentiert/i]),
    de_co_id:         find(dealsCols,   [/company.?id/i, /co.?id/i, /org.?id/i, /^id$/i]),
    de_co_name:       find(dealsCols,   [/^companies$/i, /company.?name/i, /org.?name/i, /^name$/i]),
    deal_date:        find(dealsCols,   [/^deal\s+date$/i, /deal.?date/i, /close.?date/i, /closed/i]),
    deal_size:        find(dealsCols,   [/^deal\s+size$/i, /deal.?size/i, /amount/i, /size/i]),
    series:           find(dealsCols,   [/^series$/i, /series/i, /stage/i]),
    deal_id:          find(dealsCols,   [/deal.?id/i, /^id$/i]),
  };
}

function StatTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-4 shadow-sm">
      <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

export function AnalyticsPageClient() {
  const router = useRouter();
  const { uid, companies, clusters, setCompanies, setClusters, dealsStoragePath, setDealsStoragePath, companyCol, setPipelineStep } = useSession();

  const [dealsData, setDealsData] = useState<Record<string, unknown>[] | null>(null);
  const [dealsColumns, setDealsColumns] = useState<string[]>([]);
  const [dealsAutoLoaded, setDealsAutoLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncedOnce, setSyncedOnce] = useState(false);
  const lastAnalyticsSyncRef = useRef<string | null>(null);

  useEffect(() => {
    if (!uid) return;
    if (companies.length === 0) {
      loadCompanies(uid, companyCol ?? "name").then(setCompanies).catch(() => {});
    }
    if (clusters.length === 0) {
      loadClusters(uid).then(setClusters).catch(() => {});
    }
  }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const handleDealsFile = useCallback(async (file: File) => {
    try {
      const parsed = await parseTabularFile(file);
      setDealsData(parsed.rows);
      setDealsColumns(parsed.columns);
      setDealsAutoLoaded(false);

      // Upload to Storage so the file persists across sessions/navigations
      if (uid) {
        const csv = rowsToCsv(parsed.rows);
        const blob = new Blob([csv], { type: "text/csv" });
        const storageRef = ref(getFirebaseStorage(), `sessions/${uid}/deals.csv`);
        await new Promise<void>((resolve, reject) => {
          uploadBytesResumable(storageRef, blob).on("state_changed", null, reject, resolve);
        });
        const path = `sessions/${uid}/deals.csv`;
        setDealsStoragePath(path);
        await persistSession(uid, { dealsStoragePath: path });
      }
    } catch (err) {
      toast.error(`Failed to read deals file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [uid, setDealsStoragePath]);

  const colMap = useMemo(() => detectColMap(companyColumns, dealsColumns), [companyColumns, dealsColumns]);
  const currentYear = useMemo(() => new Date().getFullYear(), []);

  const analyticsRows = useMemo(() => {
    const rows = computeAnalytics(
      clusters.filter((c) => !c.isOutliers),
      companies,
      dealsData,
      colMap,
      currentYear
    );
    const colorMap = Object.fromEntries(clusters.map((c) => [c.id, c.color]));
    return rows.map((r) => ({ ...r, color: colorMap[r.clusterId] ?? undefined }));
  }, [clusters, companies, dealsData, colMap, currentYear]);

  useEffect(() => {
    const { googleAccessToken, spreadsheetId } = useSession.getState();
    if (!googleAccessToken || !spreadsheetId || analyticsRows.length === 0) return;

    const signature = JSON.stringify({
      deals: !!dealsData,
      rows: analyticsRows.map((row) => ({
        clusterId: row.clusterId,
        companyCount: row.companyCount,
        dealCount: row.dealCount,
        totalFunding: row.totalFunding,
      })),
    });

    if (lastAnalyticsSyncRef.current === signature) return;
    lastAnalyticsSyncRef.current = signature;

    syncAnalyticsToSheet(googleAccessToken, spreadsheetId, analyticsRows).catch(() => {});
  }, [analyticsRows, dealsData]);

  const handleDownload = () => {
    downloadCsvRows(
      "cluster_analytics.csv",
      analyticsRows.map((row) => ({
        Cluster: row.clusterName,
        Companies: row.companyCount,
        "Unique Companies": row.uniqueCompanies,
        "Avg Employees": row.avgEmployees,
        "Avg Founded": row.avgYearFounded,
        "% Recent": row.pctRecentlyFounded,
        Deals: row.dealCount,
        "Deal Momentum": row.dealMomentum,
        "Avg Raised": row.avgFunding,
        "Total Raised": row.totalFunding,
        "Capital (4yr)": row.totalInvested4yr,
        "Funding Momentum": row.fundingMomentum,
        "Deal Mean": row.capitalMean,
        "Deal Median": row.capitalMedian,
        "Mean/Median": row.meanMedianRatio,
        "VC Grad Rate": row.vcGraduationRate,
        "Mortality Rate": row.mortalityRate,
        HHI: row.hhi,
        "Marktreife (%)": row.marktreife,
        "Avg. Stage": row.avgSeriesScore,
        "Avg Patents": row.avgPatentFamilies,
      }))
    );
  };

  const handleSaveSync = async () => {
    if (!uid || analyticsRows.length === 0) return;
    setSyncing(true);
    try {
      const { googleAccessToken, spreadsheetId } = useSession.getState();

      // 1. Persist pipelineStep = 4 so resuming this session lands on /analytics
      await persistSession(uid, { pipelineStep: 4 });
      setPipelineStep(4);

      // 2. Sync to Google Sheets if connected
      if (googleAccessToken && spreadsheetId) {
        await syncAnalyticsToSheet(googleAccessToken, spreadsheetId, analyticsRows);
        // Reset the auto-sync debounce so the next change re-triggers
        lastAnalyticsSyncRef.current = null;
        toast.success("Analytics saved and synced to Google Sheets.");
      } else {
        toast.success("Session saved. Connect Google Sheets to also sync the analytics table.");
      }

      setSyncedOnce(true);
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncing(false);
    }
  };

  const totalCompanies = companies.length.toLocaleString();
  const totalClusters = clusters.filter((cluster) => !cluster.isOutliers).length.toLocaleString();
  const totalDeals = dealsData ? dealsData.length.toLocaleString() : "—";
  const totalRaised = analyticsRows.reduce((sum, row) => sum + (row.totalFunding ?? 0), 0);
  const formattedTotalRaised =
    totalRaised >= 1e9
      ? `$${(totalRaised / 1e9).toFixed(1)}B`
      : totalRaised >= 1e6
        ? `$${(totalRaised / 1e6).toFixed(1)}M`
        : totalRaised > 0
          ? `$${Math.round(totalRaised).toLocaleString()}`
          : "—";

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-6">
      <div className="relative overflow-hidden rounded-[28px] border border-border/70 bg-gradient-to-br from-background via-background to-muted/40 shadow-sm">
        <div className="absolute inset-x-0 top-0 h-28 bg-[radial-gradient(circle_at_top_left,hsl(var(--foreground)/0.06),transparent_55%)]" />
        <div className="relative grid gap-4 px-6 py-6 lg:grid-cols-[1.2fr_0.8fr] lg:px-8">
          <div className="space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/80 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
              <BarChart3 className="h-3.5 w-3.5" />
              Analytics Workspace
            </div>
            <div>
              <h1 className="max-w-3xl text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                See how each cluster behaves as a market segment, not just a colored dot cloud.
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
                This page turns your clustering output into an investable market view: segment scale, deal velocity,
                funding quality, and a configurable ranking model you can tune to your thesis.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {analyticsRows.length > 0 && (
                <>
                  <Button
                    size="sm"
                    onClick={handleSaveSync}
                    disabled={syncing}
                    className="gap-2"
                  >
                    {syncing ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : syncedOnce ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    {syncing ? "Saving…" : syncedOnce ? "Saved & synced" : "Save & sync"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleDownload} className="gap-2">
                    <Download className="h-4 w-4" />
                    Export CSV
                  </Button>
                </>
              )}
              <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                <Sparkles className="h-3.5 w-3.5" />
                Saving marks the session complete and syncs the analytics tab in your Sheet.
              </div>
            </div>
          </div>

          <Card className="border-border/70 bg-background/85 shadow-sm">
            <CardHeader className="border-b border-border/60 pb-3">
              <div>
                <CardTitle>Deals coverage</CardTitle>
                <CardDescription>Upload optional deal history to unlock financing, momentum, and maturity metrics.</CardDescription>
              </div>
              <CardAction>
                {dealsData ? (
                  <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                    <CheckCircle2 className="h-3.5 w-3.5 text-foreground" />
                    Loaded
                  </div>
                ) : (
                  <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                    <FileUp className="h-3.5 w-3.5" />
                    Optional
                  </div>
                )}
              </CardAction>
            </CardHeader>
            <CardContent className="pt-1">
              {dealsData ? (
                <div className="grid gap-3">
                  <div className="rounded-xl border border-border/70 bg-muted/15 px-4 py-3">
                    <div className="text-sm font-medium text-foreground">
                      {dealsData.length.toLocaleString()} deals loaded
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {dealsAutoLoaded ? "Pulled automatically from setup." : "Loaded manually for analytics."}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setDealsData(null);
                      setDealsColumns([]);
                      setDealsAutoLoaded(false);
                    }}
                    className="w-fit"
                  >
                    Replace deals file
                  </Button>
                </div>
              ) : (
                <FileUploadZone
                  accept=".csv,.xlsx,.xls"
                  onFile={handleDealsFile}
                  loaded={false}
                  idleLabel="Upload deals data"
                  hint=".csv, .xlsx, .xls"
                />
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {analyticsRows.length > 0 ? (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <StatTile label="Tracked companies" value={totalCompanies} detail="Across the current active session" />
            <StatTile label="Named clusters" value={totalClusters} detail="Excluding outliers" />
            <StatTile label="Deals in model" value={totalDeals} detail={dealsData ? "Available for momentum and funding analysis" : "Upload deals data to populate"} />
            <StatTile label="Aggregate capital" value={formattedTotalRaised} detail="Summed from current cluster analytics" />
          </div>

          <AnalyticsCharts rows={analyticsRows} />

          <ScoringPanel rows={analyticsRows} hasDeals={!!dealsData} />

          <Card className="border-border/70 bg-background/80 shadow-sm">
            <CardHeader className="border-b border-border/60 pb-3">
              <div>
                <CardTitle>Detailed benchmark table</CardTitle>
                <CardDescription>
                  Full metric comparison across all active clusters, including rankings for directional metrics.
                </CardDescription>
              </div>
              <CardAction>
                <Button variant="outline" size="sm" onClick={handleDownload} className="gap-1.5">
                  <Download className="h-3.5 w-3.5" />
                  Export table CSV
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="pt-1">
              <AnalyticsTable rows={analyticsRows} hasDeals={!!dealsData} />
            </CardContent>
          </Card>
        </>
      ) : (
        <Card className="border-border/70 bg-background/80 shadow-sm">
          <CardHeader>
            <CardTitle>No analytics yet</CardTitle>
            <CardDescription>Complete clustering first, then this workspace will populate automatically.</CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* Sticky bottom bar */}
      <div className="sticky bottom-0 z-10 bg-background/95 backdrop-blur-sm border-t border-border px-6 py-3 flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => router.push("/review")} className="gap-1.5 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Back to Review
        </Button>
        {analyticsRows.length > 0 && (
          <Button size="sm" onClick={handleSaveSync} disabled={syncing} className="gap-2">
            {syncing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : syncedOnce ? (
              <CheckCircle2 className="h-3.5 w-3.5" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {syncing ? "Saving…" : syncedOnce ? "Saved & synced" : "Save & sync"}
          </Button>
        )}
      </div>
    </div>
  );
}
