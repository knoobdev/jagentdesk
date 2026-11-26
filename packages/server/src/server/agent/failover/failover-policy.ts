import { z } from "zod";

export const ProviderModelRefSchema = z.object({
  provider: z.string(),
  model: z.string().nullable(),
});

export const FailoverConfigSchema = z.object({
  enabled: z.boolean(),
  order: z.array(ProviderModelRefSchema),
});

export const CrossProviderChildrenConfigSchema = z.object({
  enabled: z.boolean(),
  allowed: z.array(ProviderModelRefSchema),
});

export type ProviderModelRef = z.infer<typeof ProviderModelRefSchema>;
export type FailoverConfig = z.infer<typeof FailoverConfigSchema>;
export type CrossProviderChildrenConfig = z.infer<typeof CrossProviderChildrenConfigSchema>;

/** Per-agent overrides; an absent key falls back to the host setting. */
export const AgentContinuityOverridesSchema = z.object({
  failover: FailoverConfigSchema.nullable().optional(),
  crossProviderChildren: CrossProviderChildrenConfigSchema.nullable().optional(),
});
export type AgentContinuityOverrides = z.infer<typeof AgentContinuityOverridesSchema>;

export const FAILOVER_DISABLED: FailoverConfig = { enabled: false, order: [] };
export const CROSS_PROVIDER_CHILDREN_DISABLED: CrossProviderChildrenConfig = {
  enabled: false,
  allowed: [],
};

export const FAILOVERS_PER_HOUR = 3;
const HOUR_MS = 60 * 60 * 1000;

/** At most {@link FAILOVERS_PER_HOUR} automatic failovers per agent in any rolling hour. */
export class FailoverRateLimiter {
  private readonly history = new Map<string, number[]>();

  constructor(private readonly limit = FAILOVERS_PER_HOUR) {}

  canFailover(agentId: string, now: number): boolean {
    return this.recent(agentId, now).length < this.limit;
  }

  record(agentId: string, now: number): void {
    this.history.set(agentId, [...this.recent(agentId, now), now]);
  }

  private recent(agentId: string, now: number): number[] {
    return (this.history.get(agentId) ?? []).filter((at) => now - at < HOUR_MS);
  }
}

/**
 * The first entry in `order` that is not the provider that just hit its limit, is enabled on
 * this host, and is not itself out of quota according to Usage.
 */
export function pickFailoverTarget(input: {
  order: readonly ProviderModelRef[];
  currentProvider: string;
  isAvailable: (provider: string) => boolean;
  isExhausted: (provider: string) => boolean;
}): ProviderModelRef | null {
  return (
    input.order.find(
      (entry) =>
        entry.provider !== input.currentProvider &&
        input.isAvailable(entry.provider) &&
        !input.isExhausted(entry.provider),
    ) ?? null
  );
}
