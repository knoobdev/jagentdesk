import equal from "fast-deep-equal";
import type { AgentMetric, AgentUsage, AgentUsageTotals } from "@jagentdesk/protocol/agent-types";

interface AgentUpdateValue {
  updatedAt: Date | string;
  lastUsage?: AgentUsage;
  usageTotals?: AgentUsageTotals;
  title?: string | null;
  sessionMetrics?: AgentMetric[];
}

// The daemon reports these without bumping `updatedAt`, so a stale upsert can still carry the
// newest value.
const FIELDS_UPDATED_IN_PLACE = ["lastUsage", "sessionMetrics"] as const;

function timestamp(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

export function acceptAgentDirectoryUpdate<T extends AgentUpdateValue>(
  current: T | undefined,
  incoming: T,
): T {
  if (!current || timestamp(incoming.updatedAt) >= timestamp(current.updatedAt)) {
    // A fresher payload wins wholesale, but never let a payload that omits the
    // cumulative usage totals blank out totals we already have, and never let a
    // null/absent title wipe a good title we already have (k8s idle agents keep a
    // fixed updatedAt, so this equal-timestamp path is their common case).
    let result = incoming;
    if (current && incoming.usageTotals === undefined && current.usageTotals !== undefined) {
      result = { ...result, usageTotals: current.usageTotals };
    }
    if (current && (result.title === undefined || result.title === null) && current.title) {
      result = { ...result, title: current.title };
    }
    return result;
  }
  const newer = FIELDS_UPDATED_IN_PLACE.filter(
    (field) => incoming[field] !== undefined && !equal(incoming[field], current[field]),
  );
  if (newer.length === 0) return current;
  return { ...current, ...Object.fromEntries(newer.map((field) => [field, incoming[field]])) };
}
