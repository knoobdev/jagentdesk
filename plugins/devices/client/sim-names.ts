// "iPhone 15 Pro", then "iPhone 15 Pro 2", "iPhone 15 Pro 3"… skipping names already in the fleet.
export function uniqueNames(base: string, count: number, taken: readonly string[]): string[] {
  const used = new Set(taken);
  const out: string[] = [];
  for (let n = 1; out.length < count; n++) {
    const candidate = n === 1 ? base : `${base} ${n}`;
    if (used.has(candidate)) continue;
    used.add(candidate);
    out.push(candidate);
  }
  return out;
}
