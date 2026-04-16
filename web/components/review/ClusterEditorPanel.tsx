"use client";

import { useState } from "react";
import { useSession } from "@/lib/store/session";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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
import { CompanyListDialog } from "./CompanyListDialog";
import { doc, writeBatch } from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import { toast } from "sonner";
import { Users, Trash2, Check } from "lucide-react";

export function ClusterEditorPanel() {
  const { uid, clusters, companies, setClusters, setCompanies, updateCluster } = useSession();
  const [companyDialogClusterId, setCompanyDialogClusterId] = useState<string | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  // Per-cluster draft state
  const [drafts, setDrafts] = useState<Record<string, { name: string; description: string }>>(
    {}
  );

  const getDraft = (id: string) =>
    drafts[id] ?? { name: clusters.find((c) => c.id === id)?.name ?? "", description: clusters.find((c) => c.id === id)?.description ?? "" };

  const setDraftName = (id: string, name: string) =>
    setDrafts((d) => ({ ...d, [id]: { ...getDraft(id), name } }));
  const setDraftDesc = (id: string, desc: string) =>
    setDrafts((d) => ({ ...d, [id]: { ...getDraft(id), description: desc } }));

  const handleConfirmEdit = async (id: string) => {
    if (!uid) return;
    const draft = getDraft(id);
    const cluster = clusters.find((c) => c.id === id);
    if (!cluster) return;

    if (!draft.name.trim()) {
      toast.error("Cluster name cannot be empty");
      return;
    }
    if (
      draft.name !== cluster.name &&
      clusters.some((c) => c.id !== id && c.name === draft.name.trim())
    ) {
      toast.error("Cluster name already exists");
      return;
    }

    const db = getFirebaseDb();
    await doc(db, "sessions", uid, "clusters", id);
    const batch = writeBatch(db);
    batch.update(doc(db, "sessions", uid, "clusters", id), {
      name: draft.name.trim(),
      description: draft.description,
    });
    await batch.commit();

    updateCluster(id, { name: draft.name.trim(), description: draft.description });
    setDrafts((d) => {
      const next = { ...d };
      delete next[id];
      return next;
    });
    toast.success("Cluster updated");
  };

  const handleDelete = async (id: string) => {
    if (!uid) return;
    const db = getFirebaseDb();
    const batch = writeBatch(db);

    // Move all companies to outliers
    const clusterCompanies = companies.filter((c) => c.clusterId === id);
    for (const company of clusterCompanies) {
      batch.update(doc(db, "sessions", uid, "companies", company.id), {
        clusterId: "outliers",
      });
    }

    // Delete cluster doc
    batch.delete(doc(db, "sessions", uid, "clusters", id));

    await batch.commit();

    // Update local state
    setCompanies(
      companies.map((c) =>
        c.clusterId === id ? { ...c, clusterId: "outliers" } : c
      )
    );
    setClusters(
      clusters
        .filter((c) => c.id !== id)
        .map((c) =>
          c.id === "outliers"
            ? { ...c, companyCount: c.companyCount + clusterCompanies.length }
            : c
        )
    );

    setDeleteTargetId(null);
    toast.success("Cluster deleted — companies moved to Outliers");
  };

  const nonOutliers = clusters.filter((c) => !c.isOutliers);

  return (
    <>
      <div className="flex flex-col gap-6">
        <h2 className="text-sm font-semibold">Cluster editor</h2>
        {nonOutliers.map((cluster) => {
          const draft = getDraft(cluster.id);
          const isDirty =
            draft.name !== cluster.name || draft.description !== cluster.description;

          return (
            <div key={cluster.id} className="flex flex-col gap-2 pb-5 border-b border-border/50 last:border-0">
              {/* Color swatch + name */}
              <div className="flex items-center gap-2">
                <div
                  className="h-3 w-3 rounded-full shrink-0"
                  style={{ backgroundColor: cluster.color }}
                />
                <Label className="text-xs text-muted-foreground font-medium">
                  {cluster.companyCount} companies
                </Label>
              </div>

              {/* Name input */}
              <Input
                value={draft.name}
                onChange={(e) => setDraftName(cluster.id, e.target.value)}
                className="text-sm font-semibold h-8"
              />

              {/* Description textarea */}
              <Textarea
                value={draft.description}
                onChange={(e) => setDraftDesc(cluster.id, e.target.value)}
                className="text-xs min-h-[60px] resize-none"
                placeholder="Cluster description…"
              />

              {/* Actions */}
              <div className="flex gap-2 flex-wrap">
                <Button
                  size="sm"
                  disabled={!isDirty}
                  onClick={() => handleConfirmEdit(cluster.id)}
                  className="gap-1 h-7 text-xs"
                >
                  <Check className="h-3 w-3" />
                  Save edits
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCompanyDialogClusterId(cluster.id)}
                  className="gap-1 h-7 text-xs text-muted-foreground"
                >
                  <Users className="h-3 w-3" />
                  Browse companies
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteTargetId(cluster.id)}
                  className="gap-1 h-7 text-xs text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-3 w-3" />
                  Delete
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Company list dialog */}
      <CompanyListDialog
        clusterId={companyDialogClusterId}
        onClose={() => setCompanyDialogClusterId(null)}
      />

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteTargetId}
        onOpenChange={(o) => !o && setDeleteTargetId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete cluster?</AlertDialogTitle>
            <AlertDialogDescription>
              All companies in this cluster will be moved to Outliers. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTargetId && handleDelete(deleteTargetId)}
              className="bg-destructive hover:bg-destructive/90"
            >
              Delete cluster
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
