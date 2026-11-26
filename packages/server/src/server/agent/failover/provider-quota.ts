import type { ProviderUsage } from "../../messages.js";

export interface ProviderQuota {
  /** Lowest remaining percent across the provider's usage windows; null when Usage has none. */
  remainingPercent: number | null;
  /** When the window with the lowest remaining percent resets. */
  resetsAt: string | null;
}

export interface ProviderUsageSource {
  listUsage: () => Promise<{ providers: ProviderUsage[] }>;
}

function windowRemaining(window: ProviderUsage["windows"][number]): number | null {
  if (typeof window.remainingPct === "number") return window.remainingPct;
  if (typeof window.usedPct === "number") return 100 - window.usedPct;
  return null;
}

export function quotaFromUsage(usage: ProviderUsage | undefined): ProviderQuota {
  let quota: ProviderQuota = { remainingPercent: null, resetsAt: null };
  for (const window of usage?.windows ?? []) {
    const remaining = windowRemaining(window);
    if (remaining === null) continue;
    if (quota.remainingPercent === null || remaining < quota.remainingPercent) {
      quota = { remainingPercent: remaining, resetsAt: window.resetsAt ?? null };
    }
  }
  return quota;
}

/**
 * Remaining quota per provider from the Usage service (ADR-0052). Reads are cached; a stale cache
 * refreshes in the background so failover never waits on a usage fetch.
 */
export class ProviderQuotaTracker {
  private latest = new Map<string, ProviderUsage>();
  private refreshing: Promise<void> | null = null;

  constructor(private readonly source: ProviderUsageSource) {}

  async refresh(): Promise<void> {
    this.refreshing ??= this.load();
    await this.refreshing;
  }

  private async load(): Promise<void> {
    try {
      const result = await this.source.listUsage();
      this.latest = new Map(result.providers.map((usage) => [usage.providerId, usage]));
    } finally {
      this.refreshing = null;
    }
  }

  quota(provider: string): ProviderQuota {
    return quotaFromUsage(this.latest.get(provider));
  }

  /** True when some usage window of the provider has nothing left. */
  isExhausted(provider: string): boolean {
    void this.refresh().catch(() => undefined);
    const remaining = this.quota(provider).remainingPercent;
    return remaining !== null && remaining <= 0;
  }
}
