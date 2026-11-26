import type { CrossProviderChildrenConfig, ProviderModelRef } from "./failover-policy.js";
import type { ProviderQuota } from "./provider-quota.js";

export interface ChildProviderEntry extends ProviderModelRef, ProviderQuota {
  suggested: boolean;
}

/** Splits create_agent's `provider/model` (the model may itself contain slashes). */
export function parseProviderModel(value: string | undefined | null): ProviderModelRef | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  if (slash < 0) return { provider: trimmed, model: null };
  const model = trimmed.slice(slash + 1).trim();
  return { provider: trimmed.slice(0, slash).trim(), model: model || null };
}

function mentionsProvider(text: string, provider: string, label: string): boolean {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [provider, label].some((name) =>
    new RegExp(`(^|[^a-z0-9])${escape(name.toLowerCase())}([^a-z0-9]|$)`).test(text.toLowerCase()),
  );
}

export type ChildProviderDecision = { ok: true } | { ok: false; error: string };

/**
 * Spec 40 §5. A child may always run on its parent's provider. With cross-provider children on,
 * it may run on an entry of `allowed`; with it off, only on a provider the user named in their
 * latest message to the parent.
 */
export function checkChildProvider(input: {
  config: CrossProviderChildrenConfig;
  parentProvider: string;
  requested: ProviderModelRef | null;
  lastUserMessage: string | null;
  providerLabel: (provider: string) => string;
}): ChildProviderDecision {
  const { config, parentProvider, requested } = input;
  if (!requested || requested.provider === parentProvider) return { ok: true };
  if (config.enabled) {
    const allowed = config.allowed.some(
      (entry) =>
        entry.provider === requested.provider &&
        (entry.model === null || entry.model === requested.model),
    );
    if (allowed) return { ok: true };
    const list = config.allowed
      .map((entry) => (entry.model ? `${entry.provider}/${entry.model}` : entry.provider))
      .join(", ");
    return {
      ok: false,
      error:
        `${requested.provider}${requested.model ? `/${requested.model}` : ""} is not an allowed ` +
        `child provider on this host. Allowed: ${list || "none"}, or your own provider ` +
        `(${parentProvider}). Call list_child_providers to see them.`,
    };
  }
  const named =
    input.lastUserMessage !== null &&
    mentionsProvider(
      input.lastUserMessage,
      requested.provider,
      input.providerLabel(requested.provider),
    );
  if (named) return { ok: true };
  return {
    ok: false,
    error:
      `Child agents run on your own provider (${parentProvider}) unless the user names another ` +
      "provider or cross-provider children are enabled for this host. Omit provider or use " +
      `${parentProvider}/<model>.`,
  };
}

/** Allowed entries with their remaining quota; the one with the most left is suggested. */
export function rankChildProviders(input: {
  allowed: readonly ProviderModelRef[];
  quota: (provider: string) => ProviderQuota;
}): ChildProviderEntry[] {
  const entries = input.allowed.map((entry) => ({
    ...entry,
    ...input.quota(entry.provider),
    suggested: false,
  }));
  let best: ChildProviderEntry | null = null;
  for (const entry of entries) {
    const remaining = entry.remainingPercent ?? -1;
    if (!best || remaining > (best.remainingPercent ?? -1)) best = entry;
  }
  if (best) best.suggested = true;
  return entries;
}
