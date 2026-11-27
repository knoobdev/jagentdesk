/** "45s", "2m", "1h 5m" — the sidebar line has room for one unit, two at most. */
export function formatBackgroundElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * A folder cut in the middle at a segment boundary so its root and its last folders stay
 * readable: "~/…/plat/bgdetail-workspace". The last segment is kept whole even when it alone is
 * longer than `maxChars`; the line's own ellipsis handles that.
 */
export function truncatePathMiddle(path: string, maxChars: number): string {
  if (path.length <= maxChars) return path;
  const segments = path.split("/");
  const head = segments[0] === "" ? `/${segments[1] ?? ""}` : (segments[0] ?? "");
  const tail = segments.slice(segments[0] === "" ? 2 : 1);
  let kept: string[] = [];
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const next = [tail[index] ?? "", ...kept];
    if (kept.length > 0 && `${head}/…/${next.join("/")}`.length > maxChars) break;
    kept = next;
  }
  if (kept.length >= tail.length) return path;
  return `${head}/…/${kept.join("/")}`;
}
