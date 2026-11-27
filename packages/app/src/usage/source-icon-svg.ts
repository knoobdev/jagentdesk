import { BUNDLED_USAGE_SOURCE_ICONS } from "./bundled-source-icons.generated";
import type { UsageReportEntry } from "./types";

/**
 * The SVG a report's source is drawn with: the one the host sent, else the bundled source's own
 * icon for that source ID, else null for the generic gauge. A host can list a bundled source with
 * no `icon` (hosts from before usage-source icons send none), and the summary's gauge then reads
 * as a cut-off icon, so a bundled source always gets its own.
 */
export function usageSourceIconSvg(
  entry: Pick<UsageReportEntry, "icon" | "sourceId">,
): string | null {
  return entry.icon || BUNDLED_USAGE_SOURCE_ICONS[entry.sourceId] || null;
}
