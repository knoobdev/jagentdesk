import { formatTimeAgo } from "@/utils/time";
import type { FigmaFile } from "@jagentdesk/protocol/figma/rpc-schemas";

/**
 * The secondary line under a file card title (spec 32.5 home, pinned/recent lists).
 *
 * The raw file key ("Kx7QmP2vTnYhW3cLdRf5Ba") told users nothing; show what the file
 * record actually carries: its project, when it was last modified, when it was last
 * opened, and the pinned flag. Returns null when the file has none of them — the card
 * then renders no secondary line at all rather than falling back to the raw key.
 */
export function fileSubtitle(file: FigmaFile, now: Date = new Date()): string | null {
  const parts = [
    file.projectName ?? null,
    file.lastModified_ms ? `edited ${formatTimeAgo(new Date(file.lastModified_ms), now)}` : null,
    file.lastOpenedAt_ms ? `opened ${formatTimeAgo(new Date(file.lastOpenedAt_ms), now)}` : null,
    file.pinned ? "pinned" : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}
