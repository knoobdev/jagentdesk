import { MAX_EXPLICIT_AGENT_TITLE_CHARS } from "@jagentdesk/protocol/agent-title-limits";

const MAX_MESSAGE_PART_CHARS = 60;

function firstContentLine(message: string): string | null {
  const line = message
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  const normalized = line.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Title for a database chat agent: the user's first message prefixed with the
 * database it belongs to, so the same question against two databases is
 * distinguishable in the agents list. Undefined when the message has no content.
 */
export function databaseChatTitle(databaseName: string, message: string): string | undefined {
  const body = firstContentLine(message);
  if (!body) return undefined;
  const name = databaseName.trim() || "database";
  const combined = `${name}: ${body.slice(0, MAX_MESSAGE_PART_CHARS).trim()}`;
  return combined.slice(0, MAX_EXPLICIT_AGENT_TITLE_CHARS);
}
