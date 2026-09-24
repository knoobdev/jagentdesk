import { execCommand } from "../../utils/spawn.js";
import type { SimSlimState } from "@jagentdesk/protocol/simulator/rpc-schemas";

// SimFleet density engine. A booted iOS simulator runs ~250 processes (~4 GB); most are
// background launchd daemons a dev/CI simulator never needs (Siri, Spotlight, Photos analysis,
// iCloud, News…). Disabling them via `simctl spawn <udid> launchctl` frees enough RAM to fit
// far more simulators on one Mac — the point of running many agents in parallel. This is our own
// curated label set (Apple daemon names are OS facts, not third-party code); it deliberately
// leaves the deadlock-prone core daemons (launchd, notifyd, cfprefsd, backboardd, SpringBoard,
// the graphics/HID stack) untouched so input, screenshots and the UI keep working.
const SLIMMABLE_LABELS: readonly string[] = [
  // Siri / assistant
  "com.apple.assistantd",
  "com.apple.siriknowledged",
  "com.apple.assistant_service",
  // Spotlight / search
  "com.apple.spotlightknowledged",
  "com.apple.search.searchd",
  "com.apple.corespotlightd",
  // Photos analysis
  "com.apple.photoanalysisd",
  "com.apple.mediaanalysisd",
  "com.apple.photolibraryd",
  // iCloud / accounts / sync
  "com.apple.cloudd",
  "com.apple.cloudphotod",
  "com.apple.protectedcloudstorage.protectedcloudkeysyncing",
  "com.apple.itunescloudd",
  "com.apple.followupd",
  // Store / app updates
  "com.apple.storekitd",
  "com.apple.appstored",
  "com.apple.storedownloadd",
  "com.apple.storeuid",
  // News / weather / stocks / tips
  "com.apple.newsd",
  "com.apple.weatherd",
  "com.apple.stocksd",
  "com.apple.tipsd",
  // Health / fitness
  "com.apple.healthd",
  // Family / screen time
  "com.apple.familycircled",
  "com.apple.ScreenTimeAgent",
  // Telemetry / analytics
  "com.apple.analyticsd",
  "com.apple.osanalytics.osanalyticshelper",
  "com.apple.diagnosticextensionsd",
];

function stderrMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { stderr?: unknown; message?: unknown };
    const s = typeof e.stderr === "string" ? e.stderr.trim() : "";
    if (s) return s;
    if (typeof e.message === "string") return e.message;
  }
  return String(error);
}

// `launchctl print-disabled system` prints lines like `"com.apple.foo" => true` where the
// boolean is whether a disable override is set. Collect the labels that are disabled.
function parseDisabled(stdout: string): Set<string> {
  const disabled = new Set<string>();
  for (const line of stdout.split("\n")) {
    const m = /"([^"]+)"\s*=>\s*(true|disabled|1)\b/i.exec(line);
    if (m) disabled.add(m[1]);
  }
  return disabled;
}

async function spawnLaunchctl(udid: string, args: string[]): Promise<string> {
  const result = await execCommand("xcrun", ["simctl", "spawn", udid, "launchctl", ...args], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout ?? "";
}

// Only meaningful for a booted device; a Shutdown sim can't be probed → "unknown".
export async function readSlimState(udid: string, isBooted: boolean): Promise<SimSlimState> {
  if (!isBooted) return "unknown";
  try {
    const disabled = parseDisabled(await spawnLaunchctl(udid, ["print-disabled", "system"]));
    const count = SLIMMABLE_LABELS.filter((label) => disabled.has(label)).length;
    if (count === 0) return "stock";
    if (count >= SLIMMABLE_LABELS.length) return "slim";
    return "partial";
  } catch {
    return "unknown";
  }
}

// Disable (and bootout so they stop this session) every managed daemon. Per-label failures are
// tolerated — a label absent on this runtime is not an error. `reboot` restarts the sim so the
// slimming is applied from a clean boot.
export async function slim(
  udid: string,
  reboot: boolean,
  bootAndWait: (udid: string) => Promise<void>,
): Promise<SimSlimState> {
  for (const label of SLIMMABLE_LABELS) {
    await spawnLaunchctl(udid, ["disable", `system/${label}`]).catch(() => {});
    await spawnLaunchctl(udid, ["bootout", `system/${label}`]).catch(() => {});
  }
  if (reboot) {
    await execCommand("xcrun", ["simctl", "shutdown", udid], { timeout: 60_000 }).catch(() => {});
    await bootAndWait(udid);
  }
  return readSlimState(udid, true);
}

export async function unslim(udid: string): Promise<SimSlimState> {
  for (const label of SLIMMABLE_LABELS) {
    await spawnLaunchctl(udid, ["enable", `system/${label}`]).catch(() => {});
  }
  return readSlimState(udid, true);
}

export function slimError(error: unknown): string {
  return stderrMessage(error);
}
