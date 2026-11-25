// Narrowing helpers for Jira response JSON. Jira payloads are large and loosely typed; the daemon
// reads only the fields it maps (the wire allowlist of ADR-0034 §1) and ignores the rest.

export type Json = Record<string, unknown>;

export function obj(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function objs(value: unknown): Json[] {
  return arr(value)
    .map(obj)
    .filter((item): item is Json => item !== null);
}

export function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

export function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export function bool(value: unknown): boolean {
  return value === true || value === "true";
}

/** Jira timestamps look like `2026-11-04T10:00:00.000+0700`; returns Unix ms or null. */
export function jiraTime(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

/** Unix ms → the `yyyy-MM-dd'T'HH:mm:ss.SSSZ` form Jira accepts for worklog `started`. */
export function toJiraTime(ms: number): string {
  return new Date(ms).toISOString().replace("Z", "+0000");
}

export function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, "");
}
