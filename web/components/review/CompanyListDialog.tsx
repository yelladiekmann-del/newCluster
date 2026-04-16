"use client";

import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useSession } from "@/lib/store/session";
import { toast } from "sonner";
import { Plus, Search } from "lucide-react";
import { sortClustersOutliersLast } from "@/lib/cluster-order";

interface Props {
  clusterId: string | null;
  onClose: () => void;
}

const PAGE_SIZE = 30;

export function CompanyListDialog({ clusterId, onClose }: Props) {
  const { uid, companies, clusters, updateCompany, setClusters, descCol } = useSession();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [mode, setMode] = useState<"members" | "add">("members");
  const [moveConfirm, setMoveConfirm] = useState<{
    companyId: string;
    companyName: string;
    targetId: string;
    targetName: string;
  } | null>(null);

  const cluster = clusters.find((c) => c.id === clusterId);

  const members = useMemo(() => {
    if (!clusterId) return [];
    return companies
      .filter(
        (c) =>
          c.clusterId === clusterId &&
          c.name.toLowerCase().includes(search.toLowerCase())
      )
      .sort((a, b) => a.rowIndex - b.rowIndex);
  }, [companies, clusterId, search]);

  const addCandidates = useMemo(() => {
    if (!clusterId) return [];
    const q = search.toLowerCase();
    return companies
      .filter((c) => c.clusterId !== clusterId)
      .filter((company) => {
        const name = company.name.toLowerCase();
        const desc = descCol ? String(company.originalData?.[descCol] ?? "").toLowerCase() : "";
        return !q || name.includes(q) || desc.includes(q);
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [clusterId, companies, descCol, search]);

  const filtered = mode === "members" ? members : addCandidates;
  const page_items = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  const handleMove = async (companyId: string, newClusterId: string) => {
    if (!uid) return;

    updateCompany(companyId, { clusterId: newClusterId });

    setClusters(
      clusters.map((c) => {
        if (c.id === clusterId) return { ...c, companyCount: c.companyCount - 1 };
        if (c.id === newClusterId) return { ...c, companyCount: c.companyCount + 1 };
        return c;
      })
    );

    // Persist updated companies to Storage CSV
    try {
      const { saveCompaniesToStorage } = await import("@/lib/firebase/companies-storage");
      await saveCompaniesToStorage(uid, useSession.getState().companies);
    } catch (err) {
      toast.error("Failed to save move: " + String(err));
    }

    toast.success("Company moved");
  };

  // nonTargetClusters already includes the Outliers cluster doc (isOutliers: true)
  // so we do NOT add a hardcoded Outliers item — that would duplicate it.
  const nonTargetClusters = sortClustersOutliersLast(
    clusters.filter((c) => c.id !== clusterId)
  );

  const showDesc = !!descCol;

  return (
    <Dialog open={!!clusterId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[min(90vw,72rem)] sm:max-w-[min(90vw,72rem)] max-h-[85vh] flex flex-col gap-4">
        <DialogHeader>
          <div className="flex items-center gap-3">
            {cluster?.color && (
              <div
                className="h-3 w-3 rounded-full shrink-0 mt-0.5"
                style={{ backgroundColor: cluster.color }}
              />
            )}
            <DialogTitle className="text-base">
              {cluster?.name ?? "Companies"}
            </DialogTitle>
            <Badge variant="secondary" className="text-xs font-mono">
              {mode === "members" ? members.length : addCandidates.length}
            </Badge>
          </div>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant={mode === "members" ? "default" : "outline"}
            size="sm"
            className="h-8 text-xs"
            onClick={() => {
              setMode("members");
              setSearch("");
              setPage(0);
            }}
          >
            In cluster
          </Button>
          <Button
            type="button"
            variant={mode === "add" ? "default" : "outline"}
            size="sm"
            className="h-8 text-xs gap-1.5"
            onClick={() => {
              setMode("add");
              setSearch("");
              setPage(0);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            Add companies
          </Button>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder={mode === "members" ? "Search companies in this cluster…" : "Search all other companies…"}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            className="pl-9 text-sm h-9"
          />
        </div>

        {/* Table */}
        <div className="flex-1 overflow-y-auto min-h-0 rounded-lg border border-border">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm z-10">
              <tr>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground border-b border-border w-48">
                  Company
                </th>
                {mode === "add" && (
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground border-b border-border w-40">
                    Current Cluster
                  </th>
                )}
                {showDesc && (
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground border-b border-border">
                    Description
                  </th>
                )}
                <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground border-b border-border w-52">
                  {mode === "members" ? "Move to" : "Add"}
                </th>
              </tr>
            </thead>
            <tbody>
              {page_items.map((company, i) => (
                <tr
                  key={company.id}
                  className={`border-b border-border/40 last:border-0 hover:bg-muted/30 transition-colors ${
                    i % 2 === 0 ? "" : "bg-muted/10"
                  }`}
                >
                  <td className="px-4 py-2.5 font-medium text-foreground">
                    {company.name}
                  </td>
                  {mode === "add" && (
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {nonTargetClusters.find((c) => c.id === company.clusterId)?.name ?? "Outliers"}
                    </td>
                  )}
                  {showDesc && (
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {(() => {
                        const full = String(company.originalData[descCol] ?? "");
                        return full ? (
                          <span className="line-clamp-2" title={full}>{full}</span>
                        ) : (
                          <span className="italic opacity-50">—</span>
                        );
                      })()}
                    </td>
                  )}
                  <td className="px-4 py-2.5 w-52">
                    {mode === "members" ? (
                      <Select
                        value=""
                        onValueChange={(v) => {
                          if (!v) return;
                          const target = nonTargetClusters.find((c) => c.id === v);
                          setMoveConfirm({
                            companyId: company.id,
                            companyName: company.name,
                            targetId: v,
                            targetName: target?.name ?? "Outliers",
                          });
                        }}
                      >
                        <SelectTrigger className="h-7 text-xs w-40 border-border/60">
                          <SelectValue placeholder="Move to…" />
                        </SelectTrigger>
                        <SelectContent>
                          {nonTargetClusters.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              <div className="flex items-center gap-2">
                                {!c.isOutliers && (
                                  <div
                                    className="h-2 w-2 rounded-full shrink-0"
                                    style={{ backgroundColor: c.color }}
                                  />
                                )}
                                {c.name}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1"
                        onClick={() =>
                          setMoveConfirm({
                            companyId: company.id,
                            companyName: company.name,
                            targetId: clusterId ?? "",
                            targetName: cluster?.name ?? "Cluster",
                          })
                        }
                      >
                        <Plus className="h-3 w-3" />
                        Add
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {page_items.length === 0 && (
                <tr>
                  <td colSpan={showDesc ? (mode === "add" ? 4 : 3) : (mode === "add" ? 3 : 2)} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    {search
                      ? "No companies match your search."
                      : mode === "members"
                      ? "No companies in this cluster."
                      : "No additional companies available."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {filtered.length > PAGE_SIZE && (
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
                className="h-7 text-xs"
              >
                Previous
              </Button>
              <span className="text-xs text-muted-foreground">
                {page + 1} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={(page + 1) * PAGE_SIZE >= filtered.length}
                onClick={() => setPage((p) => p + 1)}
                className="h-7 text-xs"
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </DialogContent>

      {/* Move confirmation dialog */}
      <AlertDialog open={!!moveConfirm} onOpenChange={(o) => !o && setMoveConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Move company?</AlertDialogTitle>
            <AlertDialogDescription>
              Move <strong>{moveConfirm?.companyName}</strong> to{" "}
              <strong>{moveConfirm?.targetName}</strong>?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (moveConfirm) {
                  handleMove(moveConfirm.companyId, moveConfirm.targetId);
                  setMoveConfirm(null);
                }
              }}
            >
              Move
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
