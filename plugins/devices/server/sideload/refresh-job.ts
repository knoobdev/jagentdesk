import type pino from "pino";
import type { SideloadNotice } from "@jagentdesk/protocol/sideload/rpc-schemas";
import type { SideloadAccounts } from "./accounts.js";
import { REFRESH_CHECK_INTERVAL_MS, refreshDecision } from "./limits.js";
import type { SideloadPipeline } from "./pipeline.js";
import type { AppRecord, SideloadStorage } from "./storage.js";

/**
 * Background auto refresh (26.6): a daemon timer, no agent and no model call. Every check
 * re-signs, with the same App ID, each app that has ≤ 2 days left on a device the daemon
 * can see; it warns every client when an unreachable app has ≤ 12 hours, and asks for a new
 * sign-in when an account without a kept password has an expired session.
 */

const NOTICE_REPEAT_MS = 6 * 3600_000;

export interface RefreshJobDependencies {
  storage: SideloadStorage;
  accounts: SideloadAccounts;
  pipeline: SideloadPipeline;
  logger: pino.Logger;
  /** The job's clock (offsettable for tests and the 26.12.4 acceptance run). */
  now: () => number;
  visibleDevices: () => Promise<Set<string>>;
  notify: (notice: Omit<SideloadNotice, "type" | "at_ms">) => void;
  intervalMs?: number;
}

export class SideloadRefreshJob {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private readonly lastNotice = new Map<string, number>();

  constructor(private readonly deps: RefreshJobDependencies) {}

  start(): void {
    if (this.timer) return;
    const interval = this.deps.intervalMs ?? REFRESH_CHECK_INTERVAL_MS;
    this.timer = setInterval(() => void this.checkNow(), interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One check; concurrent callers share it. */
  checkNow(): Promise<void> {
    if (!this.running) {
      this.running = this.check()
        .catch((error: unknown) => {
          this.deps.logger.warn({ err: error }, "sideload refresh check failed");
        })
        .finally(() => {
          this.running = null;
        });
    }
    return this.running;
  }

  private shouldNotify(key: string, now: number): boolean {
    const last = this.lastNotice.get(key);
    if (last !== undefined && now - last < NOTICE_REPEAT_MS) return false;
    this.lastNotice.set(key, now);
    return true;
  }

  private async check(): Promise<void> {
    const apps = this.deps.storage.listApps().filter((app) => app.autoRefresh);
    if (apps.length === 0) return;
    const visible = await this.deps.visibleDevices().catch(() => new Set<string>());
    const now = this.deps.now();
    const blocked = new Map<string, AppRecord[]>();
    for (const app of apps) {
      const decision = refreshDecision({ app, now, deviceVisible: visible.has(app.deviceUdid) });
      if (decision === "not_due" || decision === "wait_unreachable") continue;
      const account = this.deps.storage.getAccount(app.accountId);
      if (!account) continue;
      if (!(await this.deps.accounts.isSignedIn(account))) {
        blocked.set(account.id, [...(blocked.get(account.id) ?? []), app]);
        continue;
      }
      if (decision === "warn_unreachable") {
        if (this.shouldNotify(`expiring:${app.id}`, now)) {
          this.deps.notify({
            kind: "expiring",
            title: `${app.name} expires soon`,
            body: `Connect the device by cable or Wi-Fi so JAgentDesk can refresh ${app.name}.`,
            accountId: account.id,
            appId: app.id,
          });
        }
        continue;
      }
      await this.refresh(app);
    }
    for (const [accountId, pending] of blocked) {
      if (!this.shouldNotify(`sign_in:${accountId}`, now)) continue;
      const account = this.deps.storage.getAccount(accountId);
      this.deps.notify({
        kind: "sign_in_again",
        title: "Sign in again",
        body: `Sign in again to refresh ${pending.length} app${pending.length === 1 ? "" : "s"} (${account?.appleId ?? accountId}).`,
        accountId,
        appId: null,
      });
    }
  }

  private async refresh(app: AppRecord): Promise<void> {
    const jobId = this.deps.pipeline.start({
      ipaPath: `${this.deps.storage.ipaDir}/${app.ipaSha256}.ipa`,
      mode: "sign_install",
      accountId: app.accountId,
      deviceUdid: app.deviceUdid,
      options: app.options,
      autoRefresh: app.autoRefresh,
      interactive: false,
    });
    try {
      await this.deps.pipeline.wait(jobId);
      this.deps.logger.info({ appId: app.id }, "sideload app refreshed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.deps.storage.getApp(app.id);
      if (current) this.deps.storage.upsertApp({ ...current, lastError: message });
      this.deps.notify({
        kind: "refresh_failed",
        title: `Could not refresh ${app.name}`,
        body: message,
        accountId: app.accountId,
        appId: app.id,
      });
    }
  }
}
