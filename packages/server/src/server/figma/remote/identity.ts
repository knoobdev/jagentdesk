// whoami can return a JSON document containing plan/seat information and instructions.
// Only account identity belongs in Connections; never send the raw tool document as a label.
export function figmaIdentityLabel(text: string | undefined): string | undefined {
  if (!text?.trim()) return undefined;
  const value = text.trim();
  if (!value.startsWith("{") && !value.startsWith("[")) return value.slice(0, 200);
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return undefined;
    const identity = isRecord(parsed.whoami) ? parsed.whoami : parsed;
    const name = labelPart(identity.handle) ?? labelPart(identity.name);
    const email = labelPart(identity.email);
    return [name, email].filter(Boolean).join(" · ") || undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function labelPart(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().slice(0, 200) || undefined : undefined;
}
