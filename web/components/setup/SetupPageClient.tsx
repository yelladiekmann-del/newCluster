"use client";

import { useState, useCallback } from "react";
import { toast } from "sonner";
import { useSession } from "@/lib/store/session";
import { ApiKeyStep } from "./ApiKeyStep";
import { CompanyDataStep } from "./CompanyDataStep";
import { DimensionExtractionStep } from "./DimensionExtractionStep";
import { DealsDataStep } from "./DealsDataStep";
import { EmbeddingsUploadStep } from "./EmbeddingsUploadStep";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { persistSession } from "@/lib/firebase/hooks";

export function SetupPageClient() {
  const router = useRouter();
  const {
    uid,
    apiKey,
    pipelineStep,
    companies,
    descCol,
    npzPreloaded,
    setPipelineStep,
  } = useSession();

  const hasDimensions =
    companies.length > 0 &&
    !!companies[0]?.dimensions &&
    Object.keys(companies[0].dimensions).length > 0;

  const canContinue =
    companies.length > 0 &&
    (pipelineStep >= 1 || npzPreloaded || hasDimensions);

  const handleContinue = useCallback(async () => {
    if (!uid) return;
    const nextStep = Math.max(pipelineStep, 1) as 1;
    setPipelineStep(nextStep);
    await persistSession(uid, { pipelineStep: nextStep });
    router.push("/embed");
  }, [uid, pipelineStep, setPipelineStep, router]);

  return (
    <div className="max-w-2xl mx-auto px-6 py-8 flex flex-col gap-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Setup</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure your API key, upload company data, and extract AI dimensions.
        </p>
      </div>

      {/* Steps */}
      <div className="flex flex-col gap-6">
        <ApiKeyStep />
        <CompanyDataStep />
        {companies.length > 0 && descCol && <DimensionExtractionStep />}
        <DealsDataStep />
        <EmbeddingsUploadStep />
      </div>

      {/* Continue CTA */}
      <div className="flex justify-end pt-2">
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
