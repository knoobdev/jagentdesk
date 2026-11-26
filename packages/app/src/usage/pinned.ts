import type { TFunction } from "i18next";
import { i18n } from "@/i18n/i18next";
import {
  formatPct,
  formatDisplayPct,
  formatProviderUsageLabel,
  formatUsageAccountName,
} from "./format";
import { displayPercent, resolveUsageSnapshot } from "./model";
import {
  arrangeUsageReports,
  defaultUsagePins,
  effectiveUsagePins,
  usageReportsOn,
  type UsagePin,
  type UsagePreferences,
} from "./preferences";
import { windowTone } from "./tone";
import type { UsageReportEntry, UsageTone } from "./types";

/** One summary window of one account, as the sidebar Usage item shows it. */
export interface PinnedUsageWindow {
  key: string;
  /** Accessible description, including the source, account, window and percent meaning. */
  label: string;
  /** The window's short name ("5h"), empty for none, or its label when the source sends none. */
  shortLabel: string;
  /** Bare period token ("5h", "wk", "mo") used when full short labels overflow the sidebar row. */
  compactLabel: string;
  /** The share shown, under the user's used/remaining preference. */
  percent: number;
  percentText: string;
  tone: UsageTone;
}

/** One account's summary windows, under its source's icon. */
export interface PinnedUsageSource {
  key: string;
  icon: string | null;
  /** The displayed values are retained from before a failed refresh. */
  hasError: boolean;
  windows: PinnedUsageWindow[];
}

/** How much of each window the one-line summary has room for. */
export type PinnedUsageLayout = "meters" | "labels" | "compact" | "percents";

// A meter narrower than this is a sliver that reads as noise rather than a share.
export const MIN_METER_WIDTH = 16;
/** The space between a meter and its text. */
export const METER_GAP = 4;

const DURATION_TOKEN_PATTERN = /^\d+[smhd]$/i;

function normalizePeriodToken(token: string): string | null {
  const lower = token.toLowerCase();
  if (lower === "wk" || lower === "weekly") return "wk";
  if (lower === "mo" || lower === "monthly") return "mo";
  if (DURATION_TOKEN_PATTERN.test(token)) return lower;
  return null;
}

/**
 * Extracts a bare period token ("5h", "wk", "mo") from a window's short label so tight sidebar
 * rows can keep shorthands visible instead of dropping every label when one window is scoped.
 */
function compactShortLabel(shortLabel: string): string {
  const trimmed = shortLabel.trim();
  if (trimmed === "") return "";
  const exact = normalizePeriodToken(trimmed);
  if (exact !== null) return exact;
  const parts = trimmed.split(/\s+/);
  if (parts.length > 1) {
    const first = normalizePeriodToken(parts[0]!);
    if (first !== null) return first;
    const last = normalizePeriodToken(parts[parts.length - 1]!);
    if (last !== null) return last;
  }
  return "";
}

/**
 * The richest layout that fits on one line: every window's meter, else its short label, else its
 * bare period shorthand, else its percent alone. Meters are all or none; a line never mixes them.
 * Until the widths are known it shows labels, which never flashes meters that turn out not to fit.
 */
export function choosePinnedUsageLayout(input: {
  available: number | null;
  labelsWidth: number | null;
  compactWidth: number | null;
  percentsWidth: number | null;
  windowCount: number;
}): PinnedUsageLayout {
  const { available, labelsWidth, compactWidth, percentsWidth, windowCount } = input;
  if (
    available === null ||
    labelsWidth === null ||
    compactWidth === null ||
    percentsWidth === null
  ) {
    return "labels";
  }
  if (labelsWidth + windowCount * (MIN_METER_WIDTH + METER_GAP) <= available) return "meters";
  if (labelsWidth <= available) return "labels";
  if (compactWidth <= available && compactWidth > percentsWidth) return "compact";
  return percentsWidth < labelsWidth ? "percents" : "labels";
}

function describe(entry: UsageReportEntry, windowLabel: string): string {
  return `${formatUsageAccountName(entry)} ${windowLabel}`;
}

function reportsWindow(
  reports: readonly UsageReportEntry[],
  pin: UsagePin,
  preferences: UsagePreferences,
): boolean {
  return reports.some((entry) => {
    if (entry.sourceId !== pin.sourceId) return false;
    const snapshot = resolveUsageSnapshot(entry);
    return (
      snapshot?.report.windows.some(
        (window) =>
          window.id === pin.windowId && displayPercent(window, preferences.displayAs) !== null,
      ) ?? false
    );
  });
}

/**
 * The windows the summary shows (spec 38 §4.2): the pins whose source still reports them with
 * data, or, when none does (a source dropped a pinned window, or nothing is pinned), the default
 * pins. The summary is empty only when no shown source has a window with data.
 */
export function summaryUsagePins(
  reports: readonly UsageReportEntry[],
  preferences: UsagePreferences,
): UsagePin[] {
  const live = effectiveUsagePins(preferences, reports).filter((pin) =>
    reportsWindow(reports, pin, preferences),
  );
  return live.length > 0 ? live : defaultUsagePins(preferences.displayAs, reports);
}

function hasData(entry: UsageReportEntry, preferences: UsagePreferences): boolean {
  const snapshot = resolveUsageSnapshot(entry);
  return (
    snapshot?.report.windows.some(
      (window) => displayPercent(window, preferences.displayAs) !== null,
    ) ?? false
  );
}

/**
 * The reports the summary reads: the cards that are on. When none of them has data, every report
 * the user has not turned off themselves, so the host's default-off hint (a source whose provider
 * the daemon did not find active) never empties the summary while a source reports numbers.
 */
function summaryReports(
  reports: readonly UsageReportEntry[],
  preferences: UsagePreferences,
): UsageReportEntry[] {
  const on = usageReportsOn(reports, preferences);
  if (on.some((entry) => hasData(entry, preferences))) return on;
  return arrangeUsageReports(reports, preferences).filter(
    (entry) => preferences.cardVisibility[entry.id] !== false,
  );
}

/**
 * The sidebar Usage item's summary: one group per account in card order, each with its windows in
 * its report's order. Accounts turned off or with nothing to show are left out.
 */
export function resolvePinnedUsage(
  reports: readonly UsageReportEntry[],
  preferences: UsagePreferences,
  t: TFunction = i18n.t,
): PinnedUsageSource[] {
  const shown = summaryReports(reports, preferences);
  const pins = summaryUsagePins(shown, preferences);
  return shown.flatMap((entry) => {
    const snapshot = resolveUsageSnapshot(entry);
    if (!snapshot) return [];
    const windows = snapshot.report.windows
      .filter(
        (window) =>
          displayPercent(window, preferences.displayAs) !== null &&
          pins.some((pin) => pin.sourceId === entry.sourceId && pin.windowId === window.id),
      )
      .map((window) => {
        const percent = displayPercent(window, preferences.displayAs) ?? 0;
        const percentText = formatPct(percent);
        const shortLabel =
          window.shortLabel ?? formatProviderUsageLabel(window.id, window.label, t);
        return {
          key: `${entry.id}/${window.id}`,
          label: `${describe(entry, formatProviderUsageLabel(window.id, window.label, t))} ${formatDisplayPct(percent, preferences.displayAs, undefined, t)}`,
          shortLabel,
          compactLabel: compactShortLabel(shortLabel),
          percent,
          percentText,
          tone: windowTone(window),
        };
      });
    if (windows.length === 0) return [];
    return [
      {
        key: entry.id,
        icon: entry.icon ?? null,
        hasError: entry.report.status === "error",
        windows,
      },
    ];
  });
}
