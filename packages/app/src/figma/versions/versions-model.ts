import type { FigmaVersion } from "@jagentdesk/protocol/figma/rpc-schemas";

// Naming and grouping for the version list (spec 32.5.4). Figma leaves unnamed versions blank;
// the panel titles them by save time, newest first, like Figma's own history.

export function versionTitle(version: FigmaVersion, now_ms: number): string {
  if (version.label) return version.label;
  return formatRelativeTime(version.createdAt_ms, now_ms);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function formatRelativeTime(at_ms: number, now_ms: number): string {
  const delta = Math.max(0, now_ms - at_ms);
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < WEEK) return `${Math.floor(delta / DAY)}d ago`;
  return new Date(at_ms).toISOString().slice(0, 10);
}
