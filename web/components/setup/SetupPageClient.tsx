"use client";

import { useState, useCallback } from "react";
import { toast } from "sonner";
import { useSession } from "@/lib/store/session";
import { CompanyDataStep } from "./CompanyDataStep";
import { EmbeddingsUploadStep } from "./EmbeddingsUploadStep";
import { Button } from "@/components/ui/button";
import { ArrowRight, ChevronDown, ChevronUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { persistSession } from "@/lib/firebase/hooks";
import { syncSetupToSheet } from "@/lib/sheets/sync";

export function SetupPageClient() {
  const router = useRouter();
  const {
    uid,
    pipelineStep,
    companies,
    npzPreloaded,
    setPipelineStep,
  } = useSession();

  const [advancedOpen, setAdvancedOpen] = useState(false);

  const hasDimensions =
    companies.length > 0 &&
    !!companies[0]?.dimensions &&
    Object.keys(companies[0].dimensions).length > 0;

  const canContinue =
    !!uid &&
    companies.length > 0 &&
    (hasDimensions || npzPreloaded || pipelineStep >= 1);

  const handleContinue = useCallback(async () => {
    if (!uid) return;
    const nextStep = Math.max(pipelineStep, 1) as 1;
    setPipelineStep(nextStep);
    await persistSession(uid, { pipelineStep: nextStep });

    // Background Sheets sync — non-blocking
    const { googleAccessToken, sessionName } = useSession.getState();
    if (googleAccessToken) {
      syncSetupToSheet(googleAccessToken, companies, sessionName)
        .then(({ spreadsheetId, spreadsheetUrl }) => {
          useSession.getState().setSpreadsheetId(spreadsheetId);
          useSession.getState().setSpreadsheetUrl(spreadsheetUrl);
          persistSession(uid, { spreadsheetId, spreadsheetUrl });
          toast.success(
            <span>
              Synced to Google Sheets —{" "}
              <a href={spreadsheetUrl} target="_blank" rel="noopener noreferrer" className="underline">
                Open ↗
              </a>
            </span>
          );
        })
        .catch((err) => toast.error(`Sheets sync failed: ${err instanceof Error ? err.message : String(err)}`));
    } else {
      toast.warning("No Google token — sign out and sign back in to enable Sheets sync");
    }

    router.push("/embed");
  }, [uid, pipelineStep, setPipelineStep, router, companies]);

  return (
    <div className="max-w-2xl mx-auto px-6 py-8 pb-24 flex flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Setup</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Upload company data and extract AI dimensions.
        </p>
      </div>

      {/* Company Data + inline dimension extraction */}
      <CompanyDataStep />

      {/* Advanced Options — collapsible */}
      <div className="flex flex-col gap-0">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors w-fit py-1"
        >
          {advancedOpen ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
          Advanced Options
        </button>

        {advancedOpen && (
          <div className="mt-3 flex flex-col gap-4 border border-border rounded-xl p-4 bg-card">
            <EmbeddingsUploadStep />
          </div>
        )}
      </div>

      {/* Sticky bottom action bar */}
      <div className="fixed bottom-0 left-0 right-0 z-10 bg-background/95 backdrop-blur-sm border-t border-border px-6 py-3 flex items-center justify-end">
        <Button
          onClick={handleContinue}
          disabled={!canContinue}
          className="gap-2"
        >
          Continue to Embed & Cluster
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
