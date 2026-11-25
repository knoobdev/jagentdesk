import type { AccountRecord, AppIdUsage, AppRecord } from "./storage.js";

/**
 * Free-account limits (26.5), checked from local records before any Apple call: at most 3
 * sideloaded apps per device and 10 new App IDs per 7 days. Refresh windows (26.6) too.
 */

export const FREE_APPS_PER_DEVICE = 3;
export const FREE_APP_IDS_PER_WINDOW = 10;
export const APP_ID_WINDOW_MS = 7 * 24 * 3600_000;
export const FREE_PROFILE_LIFETIME_MS = 7 * 24 * 3600_000;
/** Refresh when ≤ 2 days remain; warn every client when ≤ 12 hours remain. */
export const REFRESH_WINDOW_MS = 2 * 24 * 3600_000;
export const EXPIRY_WARNING_MS = 12 * 3600_000;
export const REFRESH_CHECK_INTERVAL_MS = 3600_000;

export type LimitCheck =
  | { ok: true; newAppIds: string[] }
  | {
      ok: false;
      code: "free_app_limit" | "app_id_limit";
      message: string;
      nextAvailableAt_ms: number | null;
    };

export function appIdsInWindow(
  usage: readonly AppIdUsage[],
  accountId: string,
  now: number,
): AppIdUsage[] {
  return usage
    .filter((entry) => entry.accountId === accountId && entry.createdAt_ms > now - APP_ID_WINDOW_MS)
    .sort((a, b) => a.createdAt_ms - b.createdAt_ms);
}

/** When the n-th oldest App ID of the window ages out (n = how many slots are missing). */
function nextSlotAt(window: readonly AppIdUsage[], missing: number): number | null {
  const entry = window[missing - 1];
  return entry ? entry.createdAt_ms + APP_ID_WINDOW_MS : null;
}

export function checkFreeLimits(input: {
  account: AccountRecord;
  accounts: readonly AccountRecord[];
  deviceUdid: string;
  mainBundleId: string;
  /** Main + extension bundle ids that need an App ID. */
  bundleIds: readonly string[];
  apps: readonly AppRecord[];
  usage: readonly AppIdUsage[];
  now: number;
}): LimitCheck {
  const window = appIdsInWindow(input.usage, input.account.id, input.now);
  const registered = new Set(window.map((entry) => entry.bundleId));
  const newAppIds = input.bundleIds.filter((bundleId) => !registered.has(bundleId));
  if (input.account.kind !== "free") return { ok: true, newAppIds };

  const freeAccounts = new Set(
    input.accounts.filter((account) => account.kind === "free").map((account) => account.id),
  );
  const onDevice = input.apps.filter(
    (app) =>
      app.deviceUdid === input.deviceUdid &&
      freeAccounts.has(app.accountId) &&
      app.bundleId !== input.mainBundleId &&
      app.expiresAt_ms > input.now,
  );
  if (onDevice.length >= FREE_APPS_PER_DEVICE) {
    return {
      ok: false,
      code: "free_app_limit",
      message: `A free Apple ID can keep ${FREE_APPS_PER_DEVICE} sideloaded apps on a device. Remove one first (${onDevice.map((app) => app.name).join(", ")}).`,
      nextAvailableAt_ms: null,
    };
  }
  const over = window.length + newAppIds.length - FREE_APP_IDS_PER_WINDOW;
  if (over > 0) {
    const nextAvailableAt_ms = nextSlotAt(window, over);
    const when = nextAvailableAt_ms ? new Date(nextAvailableAt_ms).toISOString() : "later";
    return {
      ok: false,
      code: "app_id_limit",
      message: `This needs ${newAppIds.length} new App ID(s) but the free Apple ID has ${FREE_APP_IDS_PER_WINDOW - window.length} of ${FREE_APP_IDS_PER_WINDOW} left this week. The next App ID can be created at ${when}.`,
      nextAvailableAt_ms,
    };
  }
  return { ok: true, newAppIds };
}

export type RefreshDecision = "not_due" | "refresh" | "warn_unreachable" | "wait_unreachable";

/** One app at one hourly check (26.6). */
export function refreshDecision(input: {
  app: AppRecord;
  now: number;
  deviceVisible: boolean;
}): RefreshDecision {
  if (!input.app.autoRefresh) return "not_due";
  const remaining = input.app.expiresAt_ms - input.now;
  if (remaining > REFRESH_WINDOW_MS) return "not_due";
  if (input.deviceVisible) return "refresh";
  return remaining <= EXPIRY_WARNING_MS ? "warn_unreachable" : "wait_unreachable";
}
