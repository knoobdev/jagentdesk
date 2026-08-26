/**
 * Make a title unique against a set of already-used titles by appending a
 * counter suffix. So a second "Orchestration" / "Cluster chat" / "K8s Doctor"
 * agent becomes "Orchestration 2", "K8s Doctor 3", … instead of a confusing
 * duplicate. Comparison is case-insensitive and trims whitespace.
 */
export function uniqueTitle(base: string, existing: Iterable<string | null | undefined>): string {
  const wanted = base.trim() || "Untitled";
  const taken = new Set<string>();
  for (const t of existing) {
    const v = t?.trim().toLowerCase();
    if (v) taken.add(v);
  }
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${wanted} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  // Pathological fallback: never collide.
  return `${wanted} ${Math.abs(Date.now() % 100000)}`;
}
