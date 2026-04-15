import type { ClusterAction } from "@/types";

interface RawAction {
  type?: unknown;
  clusterName?: unknown;
  cluster?: unknown;
  sources?: unknown;
  newName?: unknown;
  new_name?: unknown;
  name?: unknown;
  description?: unknown;
  companies?: unknown;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter(Boolean);
}

export function normalizeAndValidateActions(
  rawActions: unknown,
  validClusterNames: string[],
  validCompanyNames: string[]
): ClusterAction[] | null {
  if (!Array.isArray(rawActions)) return null;

  const clusterSet = new Set(validClusterNames);
  const companySet = new Set(validCompanyNames.map((name) => name.toLowerCase()));
  const normalized: ClusterAction[] = [];

  for (const raw of rawActions as RawAction[]) {
    const type = String(raw?.type ?? "");
    if (type === "delete") {
      const clusterName = String(raw.clusterName ?? raw.cluster ?? "").trim();
      if (clusterSet.has(clusterName)) {
        normalized.push({ type: "delete", clusterName });
      }
      continue;
    }

    if (type === "merge") {
      const sources = toStringArray(raw.sources).filter((name) => clusterSet.has(name));
      const newName = String(raw.newName ?? raw.new_name ?? "").trim();
      if (sources.length >= 2 && newName) {
        normalized.push({ type: "merge", sources, newName });
      }
      continue;
    }

    if (type === "add") {
      const name = String(raw.name ?? "").trim();
      const description = String(raw.description ?? "").trim();
      const companies = toStringArray(raw.companies).filter((company) => companySet.has(company.toLowerCase()));
      if (name && description && companies.length > 0) {
        normalized.push({ type: "add", name, description, companies });
      }
    }
  }

  return normalized.length > 0 ? normalized : null;
}
