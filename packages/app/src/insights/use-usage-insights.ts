import { useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { useSessionStore } from "@/stores/session-store";
import type { Agent } from "@/stores/session-store";

/**
 * Usage & Cost Insights aggregate the per-agent cumulative usage totals the
 * daemon accumulates across every completed turn (`agent.usageTotals`). These are
 * persisted server-side, so they survive reconnects and directory refreshes —
 * unlike the per-turn `agent.lastUsage` snapshot (which the composer's
 * context-window meter still renders and which we only read here for the live
 * context-window display). No extra RPC, no client-side history.
 *
 * Deliberately NOT included: tokens-over-time and per-tool cost. The daemon keeps
 * no usage history and does not attribute cost to individual tools, so those would
 * be fabricated. We surface only what real snapshots contain.
 */
export interface ModelUsageRow {
  model: string;
  agentCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface AgentUsageRow {
  id: string;
  title: string;
  model: string;
  status: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  contextUsedTokens: number | null;
  contextMaxTokens: number | null;
}

export interface UsageInsights {
  agentCount: number;
  agentsWithUsage: number;
  totalInputTokens: number;
  totalCachedInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  /** True when at least one agent reported a cost (subscription plans often report $0). */
  hasCost: boolean;
  avgTokensPerAgent: number;
  byModel: ModelUsageRow[];
  topAgents: AgentUsageRow[];
  activeContext: AgentUsageRow[];
}

const EMPTY_INSIGHTS: UsageInsights = {
  agentCount: 0,
  agentsWithUsage: 0,
  totalInputTokens: 0,
  totalCachedInputTokens: 0,
  totalOutputTokens: 0,
  totalTokens: 0,
  totalCostUsd: 0,
  hasCost: false,
  avgTokensPerAgent: 0,
  byModel: [],
  topAgents: [],
  activeContext: [],
};

function agentModel(agent: Agent): string {
  return agent.model ?? agent.runtimeInfo?.model ?? agent.provider ?? "unknown";
}

function agentTokens(agent: Agent): {
  input: number;
  cached: number;
  output: number;
  total: number;
} {
  // Cumulative, persisted totals — survive reconnect/directory refresh, unlike
  // the per-turn `lastUsage` snapshot which is overwritten each turn.
  const totals = agent.usageTotals;
  const input = totals?.inputTokens ?? 0;
  const cached = totals?.cachedInputTokens ?? 0;
  const output = totals?.outputTokens ?? 0;
  // `total` excludes cache-READ tokens (Claude re-reads the cached context every
  // turn); counting them made totals balloon into the tens of millions. Cache reads
  // stay available via `cached` for a separate breakdown.
  return { input, cached, output, total: input + output };
}

function upsertModel(
  byModel: Map<string, ModelUsageRow>,
  model: string,
  input: number,
  cached: number,
  output: number,
  total: number,
  cost: number,
): void {
  const bucket = byModel.get(model) ?? {
    model,
    agentCount: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
  bucket.agentCount += 1;
  bucket.inputTokens += input;
  bucket.cachedInputTokens += cached;
  bucket.outputTokens += output;
  bucket.totalTokens += total;
  bucket.costUsd += cost;
  byModel.set(model, bucket);
}

function agentHasUsage(agent: Agent): boolean {
  return Boolean(
    agent.usageTotals && (agent.usageTotals.turns > 0 || agent.usageTotals.totalCostUsd > 0),
  );
}

function buildInsights(agents: Map<string, Agent> | undefined): UsageInsights {
  if (!agents || agents.size === 0) {
    return EMPTY_INSIGHTS;
  }

  let totalInput = 0;
  let totalCached = 0;
  let totalOutput = 0;
  let totalCost = 0;
  let agentsWithUsage = 0;
  const byModel = new Map<string, ModelUsageRow>();
  const rows: AgentUsageRow[] = [];
  const activeContext: AgentUsageRow[] = [];

  for (const agent of agents.values()) {
    if (agent.archivedAt) {
      continue;
    }
    const model = agentModel(agent);
    const { input, cached, output, total } = agentTokens(agent);
    const cost = agent.usageTotals?.totalCostUsd ?? 0;
    // Context-window meter stays on the live per-turn snapshot.
    const ctxUsed = agent.lastUsage?.contextWindowUsedTokens ?? null;
    const ctxMax = agent.lastUsage?.contextWindowMaxTokens ?? null;

    if (agentHasUsage(agent)) {
      agentsWithUsage += 1;
    }

    totalInput += input;
    totalCached += cached;
    totalOutput += output;
    totalCost += cost;

    upsertModel(byModel, model, input, cached, output, total, cost);

    const row: AgentUsageRow = {
      id: agent.id,
      title: agent.title?.trim() || "Untitled agent",
      model,
      status: agent.status,
      inputTokens: input,
      cachedInputTokens: cached,
      outputTokens: output,
      totalTokens: total,
      costUsd: cost,
      contextUsedTokens: ctxUsed,
      contextMaxTokens: ctxMax,
    };
    rows.push(row);
    if (agent.status === "running" && ctxUsed !== null && ctxMax !== null && ctxMax > 0) {
      activeContext.push(row);
    }
  }

  // Excludes cache-READ tokens (see agentTokens) so the AVG/AGENT + totals stay
  // sane instead of ballooning with per-turn cache re-reads.
  const totalTokens = totalInput + totalOutput;
  const agentCount = rows.length;

  const modelRows = Array.from(byModel.values()).sort((a, b) => b.totalTokens - a.totalTokens);
  const topAgents = rows
    .filter((row) => row.totalTokens > 0 || row.costUsd > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 8);
  activeContext.sort(
    (a, b) =>
      (b.contextUsedTokens ?? 0) / (b.contextMaxTokens ?? 1) -
      (a.contextUsedTokens ?? 0) / (a.contextMaxTokens ?? 1),
  );

  return {
    agentCount,
    agentsWithUsage,
    totalInputTokens: totalInput,
    totalCachedInputTokens: totalCached,
    totalOutputTokens: totalOutput,
    totalTokens,
    totalCostUsd: totalCost,
    hasCost: totalCost > 0,
    avgTokensPerAgent: agentsWithUsage > 0 ? Math.round(totalTokens / agentsWithUsage) : 0,
    byModel: modelRows,
    topAgents,
    activeContext: activeContext.slice(0, 6),
  };
}

export function useUsageInsights(serverId: string): UsageInsights {
  const agents = useSessionStore(useShallow((state) => state.sessions[serverId]?.agents));
  return useMemo(() => buildInsights(agents), [agents]);
}
