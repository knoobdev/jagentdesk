import { useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { useSessionStore } from "@/stores/session-store";
import type { Agent } from "@/stores/session-store";

/**
 * Usage & Cost Insights are aggregated entirely from the per-agent snapshots the
 * daemon already streams to the client (`agent.lastUsage`) — the same numbers the
 * composer's context-window meter renders. No extra RPC, no persisted history.
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

function agentTokens(agent: Agent): { input: number; cached: number; output: number; total: number } {
  const usage = agent.lastUsage;
  const input = usage?.inputTokens ?? 0;
  const cached = usage?.cachedInputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  return { input, cached, output, total: input + cached + output };
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
    const cost = agent.lastUsage?.totalCostUsd ?? 0;
    const ctxUsed = agent.lastUsage?.contextWindowUsedTokens ?? null;
    const ctxMax = agent.lastUsage?.contextWindowMaxTokens ?? null;

    if (total > 0 || cost > 0) {
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

  const totalTokens = totalInput + totalCached + totalOutput;
  const agentCount = rows.length;

  const modelRows = Array.from(byModel.values()).sort((a, b) => b.totalTokens - a.totalTokens);
  const topAgents = rows
    .filter((row) => row.totalTokens > 0 || row.costUsd > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 8);
  activeContext.sort(
    (a, b) => (b.contextUsedTokens ?? 0) / (b.contextMaxTokens ?? 1) -
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
