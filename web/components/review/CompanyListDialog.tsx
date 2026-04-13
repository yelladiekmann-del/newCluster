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
import { useSession } from "@/lib/store/session";
import { persistSession } from "@/lib/firebase/hooks";
import { doc, writeBatch } from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import { toast } from "sonner";

interface Props {
  clusterId: string | null;
  onClose: () => void;
}

const PAGE_SIZE = 25;

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

  const handleMove = async (companyId: string, newClusterId: string) => {
    if (!uid) return;
    const db = getFirebaseDb();
    await doc(db, "sessions", uid, "companies", companyId);
    const batch = writeBatch(db);
    batch.update(doc(db, "sessions", uid, "companies", companyId), {
      clusterId: newClusterId,
    });
    await batch.commit();

    updateCompany(companyId, { clusterId: newClusterId });

    // Update cluster company counts
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
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {cluster?.name ?? "Companies"}{" "}
            <span className="text-muted-foreground font-normal">
              ({filtered.length})
            </span>
          </DialogTitle>
        </DialogHeader>

        <Input
          placeholder="Search companies…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          className="text-sm"
        />

        <div className="flex-1 overflow-y-auto min-h-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left p-2 text-xs text-muted-foreground font-medium">
                  Company
                </th>
                <th className="text-left p-2 text-xs text-muted-foreground font-medium">
                  Outlier score
                </th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {page_items.map((company) => (
                <tr key={company.id} className="border-b border-border/50 hover:bg-muted/20">
                  <td className="p-2 font-medium">{company.name}</td>
                  <td className="p-2 font-mono text-xs text-muted-foreground">
                    {company.outlierScore?.toFixed(3) ?? "—"}
                  </td>
                  <td className="p-2">
                    <Select
                      value=""
                      onValueChange={(v) => v && handleMove(company.id, v)}
                    >
                      <SelectTrigger className="h-7 text-xs w-36">
                        <SelectValue placeholder="Move to…" />
                      </SelectTrigger>
                      <SelectContent>
                        {nonTargetClusters.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
                          </SelectItem>
                        ))}
                        <SelectItem value="outliers">Outliers</SelectItem>
                      </SelectContent>
                    </Select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {filtered.length > PAGE_SIZE && (
          <div className="flex items-center justify-between pt-2">
            <span className="text-xs text-muted-foreground">
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} of{" "}
              {filtered.length}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={(page + 1) * PAGE_SIZE >= filtered.length}
                onClick={() => setPage((p) => p + 1)}
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
