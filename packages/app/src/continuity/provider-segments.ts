import type { StreamItem } from "@/types/stream";

export interface ItemProvider {
  provider: string;
  /** Null when the model of that stretch is not known (before the first switch row). */
  model: string | null;
}

/**
 * The provider that wrote each item before the latest provider switch (spec 40 §3). Items after
 * the latest switch are left out: they belong to the agent's current provider.
 */
export function buildProviderSegments(items: readonly StreamItem[]): Map<string, ItemProvider> {
  const segments = new Map<string, ItemProvider>();
  let current: ItemProvider | null = null;
  let pending: string[] = [];
  for (const item of items) {
    const notice = item.kind === "activity_log" ? item.providerSwitch : undefined;
    if (!notice) {
      pending.push(item.id);
      continue;
    }
    const owner = current ?? { provider: notice.fromProvider, model: null };
    for (const id of pending) segments.set(id, owner);
    pending = [];
    current = { provider: notice.toProvider, model: notice.model };
  }
  return segments;
}
