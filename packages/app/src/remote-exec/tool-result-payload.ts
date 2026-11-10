/**
 * Shared unwrapping for a jagentdesk MCP tool result (spec 33.7) before the cards parse it.
 * Each provider wraps the same tool JSON differently:
 * - OpenCode delivers the JSON directly (object or string).
 * - Claude wraps command-input tools in `{type: "command", command, output}` and everything
 *   else in `{output}` (AgentMetadata fallback) — the payload sits under `output`, as a
 *   string or object, possibly nested once more.
 * - Codex delivers the MCP `CallToolResult`: `{content: [{type: "text", text}]}`.
 * - Generic ACP may deliver a bare content array, a single `{type: "text", text}` block, a
 *   "shell" detail whose `output` is the JSON text, or the payload object itself.
 *
 * The check runs at every level, so a payload that itself carries an `output` field (the
 * remote job result) is never over-unwrapped: unwrapping stops as soon as a level satisfies
 * `isValidPayload`, and is bounded so junk input terminates.
 */

const MAX_UNWRAP_DEPTH = 4;

export function unwrapToolResultPayload(
  raw: unknown,
  isValidPayload: (value: unknown) => boolean,
): Record<string, unknown> | null {
  let value = raw;
  for (let depth = 0; depth <= MAX_UNWRAP_DEPTH; depth += 1) {
    if (typeof value === "string") {
      value = parseJsonObjectText(value);
      if (value === null) return null;
      continue;
    }
    if (Array.isArray(value)) {
      value = firstContentText(value);
      if (value === null) return null;
      continue;
    }
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (isValidPayload(record)) return record;
    const unwrapped = unwrapWrapper(record);
    if (unwrapped === null) return null;
    value = unwrapped;
  }
  return null;
}

/** One wrapper peel: MCP content (array or single text block) or the `output` field. */
function unwrapWrapper(record: Record<string, unknown>): unknown | null {
  if (Array.isArray(record.content)) {
    return firstContentText(record.content);
  }
  if (record.type === "text" && typeof record.text === "string") {
    return record.text;
  }
  if ("output" in record && record.output !== undefined) {
    return record.output;
  }
  return null;
}

function firstContentText(content: unknown[]): string | null {
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") return record.text;
  }
  return null;
}

function parseJsonObjectText(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}
