import { Suspense } from "react";
import { AnalyticsPageClient } from "@/components/analytics/AnalyticsPageClient";

export default function AnalyticsPage() {
  return (
    <Suspense>
      <AnalyticsPageClient />
    </Suspense>
  );
}
