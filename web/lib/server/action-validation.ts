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

  // Case-insensitive lookup maps — model output often differs in casing/punctuation
  const clusterMap = new Map(validClusterNames.map((n) => [n.toLowerCase().trim(), n]));
  const companyMap = new Map(validCompanyNames.map((n) => [n.toLowerCase().trim(), n]));

  function resolveCluster(raw: string): string | null {
    return clusterMap.get(raw.toLowerCase().trim()) ?? null;
  }
  function resolveCompany(raw: string): string | null {
    return companyMap.get(raw.toLowerCase().trim()) ?? null;
  }

  const normalized: ClusterAction[] = [];

  for (const raw of rawActions as RawAction[]) {
    const type = String(raw?.type ?? "");

    if (type === "delete") {
      const clusterName = resolveCluster(String(raw.clusterName ?? raw.cluster ?? "").trim());
      if (clusterName) {
        normalized.push({ type: "delete", clusterName });
      }
      continue;
    }

    if (type === "merge") {
      const sources = toStringArray(raw.sources)
        .map((n) => resolveCluster(n))
        .filter((n): n is string => n !== null);
      const newName = String(raw.newName ?? raw.new_name ?? "").trim();
      const description = String(raw.description ?? "").trim() || undefined;
      if (sources.length >= 2 && newName) {
        normalized.push({ type: "merge", sources, newName, description });
      }
      continue;
    }

    if (type === "add") {
      const name = String(raw.name ?? "").trim();
      const description = String(raw.description ?? "").trim();
      // Resolve company names case-insensitively; fall back to the raw name if not found
      // so the action is not silently dropped due to minor spelling differences.
      const companies = toStringArray(raw.companies).map(
        (n) => resolveCompany(n) ?? n.trim()
      ).filter(Boolean);
      if (name && description && companies.length > 0) {
        normalized.push({ type: "add", name, description, companies });
      }
    }
  }

  return normalized.length > 0 ? normalized : null;
}
