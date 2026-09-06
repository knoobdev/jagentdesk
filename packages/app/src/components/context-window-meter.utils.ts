// Compact token count that KEEPS one significant fraction below 10× a unit, so
// distinct large totals stay distinguishable. Rounding to whole millions collapsed
// everything from 1.0m to 1.49m onto a bare "1m" (and 1.5m–2.49m onto "2m"), which
// made the Usage & Cost headline look like it defaulted to "1m". 1_234_567 → "1.2m",
// 12_300_000 → "12m", 1_234 → "1.2k", 12_345 → "12k", 999 → "999".
export function formatTokenCount(value: number): string {
  const unit = (n: number, suffix: string): string =>
    `${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10}${suffix}`;
  if (value >= 1_000_000) {
    return unit(value / 1_000_000, "m");
  }
  if (value >= 1_000) {
    return unit(value / 1_000, "k");
  }
  return Math.round(value).toString();
}
