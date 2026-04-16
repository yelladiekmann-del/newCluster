export function sortClustersOutliersLast<T extends { isOutliers?: boolean; id?: string; name?: string }>(
  clusters: T[]
): T[] {
  return [...clusters].sort((a, b) => {
    const aOut = a.isOutliers || a.id === "outliers";
    const bOut = b.isOutliers || b.id === "outliers";
    if (aOut !== bOut) return aOut ? 1 : -1;
    return String(a.name ?? "").localeCompare(String(b.name ?? ""));
  });
}
