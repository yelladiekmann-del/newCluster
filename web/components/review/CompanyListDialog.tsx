"use client";

import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { persistSession } from "@/lib/firebase/hooks";
import { doc, writeBatch } from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import { toast } from "sonner";
import { Search } from "lucide-react";

interface Props {
  clusterId: string | null;
  onClose: () => void;
}

const PAGE_SIZE = 30;

export function CompanyListDialog({ clusterId, onClose }: Props) {
  const { uid, companies, clusters, updateCompany, setClusters } = useSession();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);

  const cluster = clusters.find((c) => c.id === clusterId);

  const filtered = useMemo(() => {
    if (!clusterId) return [];
    return companies
      .filter(
        (c) =>
          c.clusterId === clusterId &&
          c.name.toLowerCase().includes(search.toLowerCase())
      )
      .sort((a, b) => a.rowIndex - b.rowIndex);
  }, [companies, clusterId, search]);

  const page_items = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  const handleMove = async (companyId: string, newClusterId: string) => {
    if (!uid) return;
    const db = getFirebaseDb();
    const batch = writeBatch(db);
    batch.update(doc(db, "sessions", uid, "companies", companyId), {
      clusterId: newClusterId,
    });
    await batch.commit();

    updateCompany(companyId, { clusterId: newClusterId });

    setClusters(
      clusters.map((c) => {
        if (c.id === clusterId) return { ...c, companyCount: c.companyCount - 1 };
        if (c.id === newClusterId) return { ...c, companyCount: c.companyCount + 1 };
        return c;
      })
    );
    toast.success("Company moved");
  };

  const nonTargetClusters = clusters.filter((c) => c.id !== clusterId);

  return (
    <Dialog open={!!clusterId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col gap-4">
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
              {filtered.length}
            </Badge>
          </div>
        </DialogHeader>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search companies…"
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
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground border-b border-border">
                  Company
                </th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground border-b border-border w-44" />
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
                  <td className="px-4 py-2.5">
                    <Select
                      value=""
                      onValueChange={(v) => v && handleMove(company.id, v)}
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
                        <SelectItem value="outliers">Outliers</SelectItem>
                      </SelectContent>
                    </Select>
                  </td>
                </tr>
              ))}
              {page_items.length === 0 && (
                <tr>
                  <td colSpan={2} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    {search ? "No companies match your search." : "No companies in this cluster."}
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
    </Dialog>
  );
}
