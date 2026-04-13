"use client";

import { useState } from "react";
import { useSession } from "@/lib/store/session";
import { CompanyListDialog } from "./CompanyListDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Users } from "lucide-react";

export function ClusterOverviewGrid() {
  const { clusters } = useSession();
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);

  const nonOutliers = clusters.filter((c) => !c.isOutliers);
  const outliers = clusters.find((c) => c.isOutliers);

  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {nonOutliers.map((cluster) => (
          <div
            key={cluster.id}
            className="rounded-lg border border-border bg-card p-3.5 flex flex-col gap-2"
            style={{ borderLeftColor: cluster.color, borderLeftWidth: 3 }}
          >
            <div className="flex items-start justify-between gap-2">
              <span className="text-sm font-semibold text-foreground leading-tight">
                {cluster.name}
              </span>
              <Badge variant="secondary" className="text-xs shrink-0">
                {cluster.companyCount}
              </Badge>
            </div>
            {cluster.description && (
              <p className="text-xs text-muted-foreground line-clamp-2">
                {cluster.description}
              </p>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="self-start -ml-1 h-7 text-xs gap-1 text-muted-foreground hover:text-primary"
              onClick={() => setSelectedClusterId(cluster.id)}
            >
              <Users className="h-3 w-3" />
              View companies →
            </Button>
          </div>
        ))}

        {outliers && outliers.companyCount > 0 && (
          <div className="rounded-lg border border-border bg-card p-3.5 flex flex-col gap-2 opacity-60">
            <div className="flex items-start justify-between gap-2">
              <span className="text-sm font-semibold text-muted-foreground">Outliers</span>
              <Badge variant="secondary" className="text-xs shrink-0">
                {outliers.companyCount}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Companies that did not fit into any cluster.
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="self-start -ml-1 h-7 text-xs gap-1 text-muted-foreground"
              onClick={() => setSelectedClusterId("outliers")}
            >
              <Users className="h-3 w-3" />
              View companies →
            </Button>
          </div>
        )}
      </div>

      <CompanyListDialog
        clusterId={selectedClusterId}
        onClose={() => setSelectedClusterId(null)}
      />
    </>
  );
}
