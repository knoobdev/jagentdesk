import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  ORCHESTRATION_BRIEF_LABEL,
  ORCHESTRATION_PROFILE_LABEL,
  ORCHESTRATION_ROLE_LABEL,
  ORCHESTRATION_ROUTE_LABEL,
  ORCHESTRATION_WORKSPACE_LABEL,
  defaultRoleInstructions,
  defaultRouteInstructions,
  OrchestrationDissentOutcomeSchema,
  OrchestrationHandbackSchema,
  OrchestrationRoleLabelSchema,
  type OrchestrationConfig,
  type OrchestrationDissentOutcome,
  type OrchestrationHandback,
  type OrchestrationProfile,
  type OrchestrationRole,
  type OrchestrationRouteCategory,
  type OrchestrationRouteTarget,
} from "@jagentdesk/protocol/orchestration";
import { getParentAgentIdFromLabels } from "@jagentdesk/protocol/agent-labels";
import type { Logger } from "pino";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import { createAgentCommand } from "../agent/create-agent/create.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import { resolveConfiguredRouteCandidates } from "./task-brief.js";

const OrchestrationAssignmentStateSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  parentAgentId: z.string().min(1),
  routeCategory: z.string().min(1).optional(),
  profileId: z.string().min(1).optional(),
  status: z.enum(["active", "handed_back", "accepted", "failed"]),
  createdAtMs: z.number().int().nonnegative(),
});

const OrchestrationHandbackRecordSchema = OrchestrationHandbackSchema.extend({
  id: z.string().min(1),
  agentId: z.string().min(1),
  leadAgentId: z.string().min(1),
  createdAtMs: z.number().int().nonnegative(),
});

const OrchestrationDissentRecordSchema = z.object({
  id: z.string().min(1),
  peerAgentId: z.string().min(1),
  leadAgentId: z.string().min(1),
  outcome: OrchestrationDissentOutcomeSchema,
  rationale: z.string().trim().min(1).max(12000),
  nextAction: z.string().trim().min(1).max(12000),
  verificationRound: z.number().int().min(0),
  createdAtMs: z.number().int().nonnegative(),
});

const OrchestrationAcceptedResultSchema = z.object({
  leadAgentId: z.string().min(1),
  summary: z.string().trim().min(1).max(12000),
  evidence: z.string().trim().min(1).max(12000),
  remainingUncertainty: z.string().trim().min(1).max(12000),
  createdAtMs: z.number().int().nonnegative(),
});

const OrchestrationRunStateSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  supervisorAgentId: z.string().min(1),
  leadAgentId: z.string().min(1).optional(),
  assignments: z.array(OrchestrationAssignmentStateSchema),
  handbacks: z.array(OrchestrationHandbackRecordSchema),
  dissents: z.array(OrchestrationDissentRecordSchema),
  acceptedResult: OrchestrationAcceptedResultSchema.optional(),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
});

const OrchestrationRuntimeStateSchema = z.object({
  version: z.literal(1),
  runs: z.record(z.string(), OrchestrationRunStateSchema),
});

type OrchestrationRuntimeState = z.infer<typeof OrchestrationRuntimeStateSchema>;
type OrchestrationRunState = z.infer<typeof OrchestrationRunStateSchema>;

export interface OrchestrationAgentContext {
  agent: ManagedAgent;
  role: OrchestrationRole;
  workspaceId: string;
  briefId: string;
}

export interface OrchestrationCallerContext {
  lockedCwd?: string;
  allowCustomCwd?: boolean;
  childAgentDefaultLabels?: Record<string, string>;
}

export interface OrchestrationLeadResult {
  agentId: string;
  provider: string;
  model: string;
  thinkingOptionId: string;
  reused: boolean;
}

export interface OrchestrationPeerResult {
  agentId: string;
  assignmentId: string;
  routeCategory: OrchestrationRouteCategory;
  profileId: string;
  provider: string;
  model: string;
  thinkingOptionId: string;
}

const EMPTY_STATE: OrchestrationRuntimeState = { version: 1, runs: {} };

function activeAgent(agent: ManagedAgent): boolean {
  return agent.lifecycle !== "closed" && agent.lifecycle !== "error";
}

function profileProviderModel(profile: OrchestrationProfile): string {
  return `${profile.provider}/${profile.model}`;
}

function profileThinking(
  target: OrchestrationRouteTarget | undefined,
  profile: OrchestrationProfile,
) {
  return target?.thinkingOptionId ?? profile.thinkingOptionId;
}

function compactTitle(value: string, fallback: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return fallback;
  return normalized.slice(0, 60);
}

function isPeerLikeRole(role: string): boolean {
  return role !== "supervisor" && role !== "lead";
}

function formatLeadRelay(input: {
  assignment: string;
  briefId: string;
  workspaceId: string;
  roleInstructions?: string;
}): string {
  const instructions = (input.roleInstructions ?? "").trim() || defaultRoleInstructions("lead");
  return [
    "<jagentdesk-orchestration>",
    "Role: Lead.",
    "You are the single engineering owner for this workspace and orchestration run.",
    "The Supervisor has relayed the human objective below. Preserve it faithfully; do not invent product decisions.",
    `Workspace: ${input.workspaceId}`,
    `Brief: ${input.briefId}`,
    "",
    "Human relay:",
    input.assignment,
    ...(instructions ? ["", "Instructions:", instructions] : []),
    "</jagentdesk-orchestration>",
  ].join("\n");
}

function formatPeerAssignment(input: {
  assignment: string;
  ownershipBoundary: string;
  expectedHandback: string;
  routeCategory: OrchestrationRouteCategory;
  profile: OrchestrationProfile;
  profileThinkingOptionId: string;
  roleId: string;
  roleInstructions?: string;
  routeInstructions?: string;
}): string {
  const roleInstr = (input.roleInstructions ?? "").trim() || defaultRoleInstructions(input.roleId);
  const routeInstr =
    (input.routeInstructions ?? "").trim() || defaultRouteInstructions(input.routeCategory);
  return [
    "<jagentdesk-orchestration>",
    `Role: ${input.roleId}.`,
    `Route: ${input.routeCategory}`,
    `Execution profile: ${input.profile.provider}/${input.profile.model} (thinking ${input.profileThinkingOptionId})`,
    ...(roleInstr ? ["", "Role instructions:", roleInstr] : []),
    ...(routeInstr ? ["", "Route instructions:", routeInstr] : []),
    "",
    "Assignment:",
    input.assignment,
    "",
    "Ownership boundary:",
    input.ownershipBoundary,
    "",
    "Expected handback:",
    input.expectedHandback,
    "Return a structured handback with: What changed/inspected; Evidence; Remaining uncertainty; Counterevidence; Requested resolution.",
    "</jagentdesk-orchestration>",
  ].join("\n");
}

function formatHandbackMessage(input: {
  peerAgentId: string;
  handback: OrchestrationHandback;
}): string {
  return [
    "<jagentdesk-orchestration-handback>",
    `Peer: ${input.peerAgentId}`,
    `What changed / inspected: ${input.handback.whatChangedOrInspected}`,
    `Evidence: ${input.handback.evidence}`,
    `Remaining uncertainty: ${input.handback.remainingUncertainty}`,
    `Counterevidence: ${input.handback.counterevidence}`,
    input.handback.requestedResolution
      ? `Requested resolution: ${input.handback.requestedResolution}`
      : "Requested resolution: none",
    input.handback.currentDirection ? `Current direction: ${input.handback.currentDirection}` : "",
    input.handback.claim ? `Claim: ${input.handback.claim}` : "",
    input.handback.risk ? `Risk: ${input.handback.risk}` : "",
    "</jagentdesk-orchestration-handback>",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatDissentResolution(input: {
  peerAgentId: string;
  outcome: OrchestrationDissentOutcome;
  rationale: string;
  nextAction: string;
}): string {
  return [
    "<jagentdesk-orchestration-dissent-resolution>",
    `Peer: ${input.peerAgentId}`,
    `Outcome: ${input.outcome}`,
    `Lead rationale: ${input.rationale}`,
    `Next action: ${input.nextAction}`,
    "The Lead has closed this dissent. Do not reopen an unbounded debate.",
    "</jagentdesk-orchestration-dissent-resolution>",
  ].join("\n");
}

function formatAcceptedResult(input: {
  leadAgentId: string;
  summary: string;
  evidence: string;
  remainingUncertainty: string;
}): string {
  return [
    "<jagentdesk-orchestration-accepted-result>",
    `Lead: ${input.leadAgentId}`,
    `Summary: ${input.summary}`,
    `Evidence: ${input.evidence}`,
    `Remaining uncertainty: ${input.remainingUncertainty}`,
    "The Lead accepted the engineering result after validation. The Supervisor should report this to the Human without changing the technical decision.",
    "</jagentdesk-orchestration-accepted-result>",
  ].join("\n");
}

export class OrchestrationRuntime {
  private readonly statePath: string;
  private mutation: Promise<void> = Promise.resolve();

  constructor(
    private readonly dependencies: {
      jagentdeskHome: string;
      agentManager: AgentManager;
      agentStorage: AgentStorage;
      providerSnapshotManager: ProviderSnapshotManager;
      getConfig: () => OrchestrationConfig;
      logger: Logger;
    },
  ) {
    this.statePath = join(dependencies.jagentdeskHome, "orchestration", "runtime.json");
  }

  getAgentContext(agentId: string): OrchestrationAgentContext | null {
    const agent = this.dependencies.agentManager.getAgent(agentId);
    if (!agent) return null;
    const role = OrchestrationRoleLabelSchema.safeParse(agent.labels[ORCHESTRATION_ROLE_LABEL]);
    const workspaceId = agent.labels[ORCHESTRATION_WORKSPACE_LABEL]?.trim();
    const briefId = agent.labels[ORCHESTRATION_BRIEF_LABEL]?.trim();
    if (!role.success || !workspaceId || !briefId) return null;
    return { agent, role: role.data, workspaceId, briefId };
  }

  private requireContext(agentId: string, role: OrchestrationRole): OrchestrationAgentContext {
    const context = this.getAgentContext(agentId);
    if (!context) {
      throw new Error(`Agent ${agentId} is not part of an Orchestration run`);
    }
    if (context.role !== role) {
      throw new Error(`Orchestration role ${context.role} cannot perform the ${role} operation`);
    }
    return context;
  }

  private requirePeerLikeContext(agentId: string): OrchestrationAgentContext {
    const context = this.getAgentContext(agentId);
    if (!context) {
      throw new Error(`Agent ${agentId} is not part of an Orchestration run`);
    }
    if (!isPeerLikeRole(context.role)) {
      throw new Error(`Orchestration role ${context.role} cannot perform the peer operation`);
    }
    return context;
  }

  private async readState(): Promise<OrchestrationRuntimeState> {
    try {
      const content = await readFile(this.statePath, "utf8");
      return OrchestrationRuntimeStateSchema.parse(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_STATE, runs: {} };
      throw error;
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutation.then(operation);
    this.mutation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async mutate<T>(operation: (state: OrchestrationRuntimeState) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const state = await this.readState();
      const result = await operation(state);
      await writeJsonFileAtomic(this.statePath, state);
      return result;
    });
  }

  private ensureRun(
    state: OrchestrationRuntimeState,
    context: OrchestrationAgentContext,
  ): OrchestrationRunState {
    const existing = state.runs[context.briefId];
    if (existing) {
      if (
        existing.workspaceId !== context.workspaceId ||
        existing.supervisorAgentId !==
          (context.role === "supervisor" ? context.agent.id : existing.supervisorAgentId)
      ) {
        throw new Error(`Orchestration run ${context.briefId} has a conflicting workspace owner`);
      }
      return existing;
    }
    if (context.role !== "supervisor") {
      throw new Error(
        "Orchestration run is not registered by a Supervisor; Lead/Peer control operations cannot bootstrap it",
      );
    }
    const now = Date.now();
    const created: OrchestrationRunState = {
      id: context.briefId,
      workspaceId: context.workspaceId,
      supervisorAgentId: context.role === "supervisor" ? context.agent.id : "unknown",
      assignments: [],
      handbacks: [],
      dissents: [],
      createdAtMs: now,
      updatedAtMs: now,
    };
    state.runs[context.briefId] = created;
    return created;
  }

  private activeAgentsForWorkspace(context: OrchestrationAgentContext, role: OrchestrationRole) {
    return this.dependencies.agentManager
      .listAgents()
      .filter(
        (agent) =>
          activeAgent(agent) &&
          agent.workspaceId === context.workspaceId &&
          agent.labels[ORCHESTRATION_ROLE_LABEL] === role,
      );
  }

  private async createChild(input: {
    caller: OrchestrationAgentContext;
    profile: OrchestrationProfile;
    target?: OrchestrationRouteTarget;
    title: string;
    initialPrompt: string;
    labels: Record<string, string>;
    callerContext?: OrchestrationCallerContext | null;
  }): Promise<ManagedAgent> {
    const thinkingOptionId = profileThinking(input.target, input.profile);
    const result = await createAgentCommand(
      {
        agentManager: this.dependencies.agentManager,
        agentStorage: this.dependencies.agentStorage,
        providerSnapshotManager: this.dependencies.providerSnapshotManager,
        logger: this.dependencies.logger.child({ module: "orchestration-runtime" }),
        jagentdeskHome: this.dependencies.jagentdeskHome,
      },
      {
        kind: "mcp",
        provider: profileProviderModel(input.profile),
        title: compactTitle(input.title, `JAgentDesk ${input.caller.role}`),
        initialPrompt: input.initialPrompt,
        workspaceId: input.caller.workspaceId,
        thinking: thinkingOptionId,
        ...(input.profile.modeId ? { mode: input.profile.modeId } : {}),
        labels: input.labels,
        background: true,
        notifyOnFinish: true,
        callerAgentId: input.caller.agent.id,
        callerContext: input.callerContext ?? null,
      },
    );
    if (result.initialPromptError) {
      throw result.initialPromptError instanceof Error
        ? result.initialPromptError
        : new Error(String(result.initialPromptError));
    }
    return result.snapshot;
  }

  async bootstrapLead(input: {
    callerAgentId: string;
    assignment: string;
    title?: string;
    callerContext?: OrchestrationCallerContext | null;
  }): Promise<OrchestrationLeadResult> {
    const context = this.requireContext(input.callerAgentId, "supervisor");
    return this.mutate(async (state) => {
      const run = this.ensureRun(state, context);
      if (run.leadAgentId) {
        const existing = this.dependencies.agentManager.getAgent(run.leadAgentId);
        if (existing && activeAgent(existing)) {
          return {
            agentId: existing.id,
            provider: existing.provider,
            model: existing.config.model ?? "default",
            thinkingOptionId: existing.config.thinkingOptionId ?? "default",
            reused: true,
          };
        }
        throw new Error(
          "This orchestration run already has an unhealthy Lead. Replacement requires an explicit Human-authorized lifecycle operation.",
        );
      }

      // The topology has one active Lead per workspace, not one Lead per
      // natural-language request. A subsequent brief must reuse that owner
      // and move its active run label before relaying the new objective.
      const activeLeads = this.activeAgentsForWorkspace(context, "lead");
      if (activeLeads.length > 1) {
        throw new Error("Topology violation: more than one active Lead exists for this workspace");
      }
      if (activeLeads.length === 1) {
        const lead = activeLeads[0];
        await this.dependencies.agentManager.setLabels(lead.id, {
          [ORCHESTRATION_BRIEF_LABEL]: context.briefId,
        });
        await sendPromptToAgent({
          agentManager: this.dependencies.agentManager,
          agentStorage: this.dependencies.agentStorage,
          agentId: lead.id,
          prompt: formatLeadRelay({
            assignment: input.assignment,
            briefId: context.briefId,
            workspaceId: context.workspaceId,
            roleInstructions: this.dependencies.getConfig().roles.lead.instructions,
          }),
          unarchive: false,
          logger: this.dependencies.logger.child({ module: "orchestration-runtime" }),
        });
        run.leadAgentId = activeLeads[0].id;
        run.updatedAtMs = Date.now();
        return {
          agentId: lead.id,
          provider: lead.provider,
          model: lead.config.model ?? "default",
          thinkingOptionId: lead.config.thinkingOptionId ?? "default",
          reused: true,
        };
      }

      const roleConfig = this.dependencies.getConfig().roles.lead;
      if (!roleConfig.enabled) throw new Error("The Lead role is disabled");
      const profiles = [
        roleConfig.profiles.find((profile) => profile.id === roleConfig.defaultProfileId),
        ...roleConfig.profiles,
      ].filter((profile, index, all): profile is OrchestrationProfile => {
        return (
          Boolean(profile?.enabled) &&
          all.findIndex((candidate) => candidate?.id === profile?.id) === index
        );
      });
      if (profiles.length === 0) throw new Error("No enabled Lead profile is configured");

      const errors: string[] = [];
      for (const profile of profiles) {
        try {
          const agent = await this.createChild({
            caller: context,
            profile,
            title: input.title ?? "Orchestration Lead",
            initialPrompt: formatLeadRelay({
              assignment: input.assignment,
              briefId: context.briefId,
              workspaceId: context.workspaceId,
              roleInstructions: this.dependencies.getConfig().roles.lead.instructions,
            }),
            labels: {
              [ORCHESTRATION_ROLE_LABEL]: "lead",
              [ORCHESTRATION_WORKSPACE_LABEL]: context.workspaceId,
              [ORCHESTRATION_BRIEF_LABEL]: context.briefId,
              [ORCHESTRATION_PROFILE_LABEL]: profile.id,
            },
            callerContext: input.callerContext,
          });
          run.leadAgentId = agent.id;
          run.updatedAtMs = Date.now();
          return {
            agentId: agent.id,
            provider: agent.provider,
            model: agent.config.model ?? profile.model,
            thinkingOptionId: agent.config.thinkingOptionId ?? profile.thinkingOptionId,
            reused: false,
          };
        } catch (error) {
          errors.push(`${profile.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      throw new Error(`Unable to bootstrap a Lead: ${errors.join("; ")}`);
    });
  }

  async createPeer(input: {
    callerAgentId: string;
    routeCategory: OrchestrationRouteCategory;
    assignment: string;
    ownershipBoundary: string;
    expectedHandback: string;
    title?: string;
    callerContext?: OrchestrationCallerContext | null;
  }): Promise<OrchestrationPeerResult> {
    const context = this.requireContext(input.callerAgentId, "lead");
    return this.mutate(async (state) => {
      const run = this.ensureRun(state, context);
      if (run.leadAgentId !== context.agent.id) {
        throw new Error("Only the registered Lead may staff Peer assignments for this run");
      }
      const config = this.dependencies.getConfig();
      const maxPeers = config.limits.maxPeersPerLead;
      const peerAssignments = run.assignments.filter(
        (assignment) =>
          assignment.parentAgentId === context.agent.id && assignment.status !== "failed",
      );
      if (peerAssignments.length >= maxPeers) {
        throw new Error(`Peer fan-out limit reached (${maxPeers}) for this Lead's active brief`);
      }

      const candidates = resolveConfiguredRouteCandidates(config, input.routeCategory).filter(
        (candidate) => isPeerLikeRole(candidate.target.role),
      );
      if (candidates.length === 0) {
        throw new Error(
          `Route ${input.routeCategory} does not resolve to a configured Peer; keep this work with the Lead or choose a Peer route`,
        );
      }

      const errors: string[] = [];
      for (const candidate of candidates) {
        try {
          const assignmentId = randomUUID();
          const roleConfig = config.roles[candidate.target.role];
          if (!roleConfig || roleConfig.enabled === false) {
            throw new Error(`role ${candidate.target.role} is disabled or not configured`);
          }
          const thinkingOptionId = profileThinking(candidate.target, candidate.profile);
          const agent = await this.createChild({
            caller: context,
            profile: candidate.profile,
            target: candidate.target,
            title: input.title ?? `Peer · ${input.routeCategory}`,
            initialPrompt: formatPeerAssignment({
              assignment: input.assignment,
              ownershipBoundary: input.ownershipBoundary,
              expectedHandback: input.expectedHandback,
              routeCategory: input.routeCategory,
              profile: candidate.profile,
              profileThinkingOptionId: thinkingOptionId,
              roleId: candidate.target.role,
              roleInstructions: roleConfig.instructions,
              routeInstructions: config.routes[input.routeCategory].instructions,
            }),
            labels: {
              [ORCHESTRATION_ROLE_LABEL]: candidate.target.role,
              [ORCHESTRATION_WORKSPACE_LABEL]: context.workspaceId,
              [ORCHESTRATION_BRIEF_LABEL]: context.briefId,
              [ORCHESTRATION_ROUTE_LABEL]: input.routeCategory,
              [ORCHESTRATION_PROFILE_LABEL]: candidate.profile.id,
              "jagentdesk.orchestration.assignment-id": assignmentId,
            },
            callerContext: input.callerContext,
          });
          run.assignments.push({
            id: assignmentId,
            agentId: agent.id,
            parentAgentId: context.agent.id,
            routeCategory: input.routeCategory,
            profileId: candidate.profile.id,
            status: "active",
            createdAtMs: Date.now(),
          });
          run.updatedAtMs = Date.now();
          return {
            agentId: agent.id,
            assignmentId,
            routeCategory: input.routeCategory,
            profileId: candidate.profile.id,
            provider: agent.provider,
            model: agent.config.model ?? candidate.profile.model,
            thinkingOptionId: agent.config.thinkingOptionId ?? thinkingOptionId,
          };
        } catch (error) {
          errors.push(
            `${candidate.target.profileId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      throw new Error(`Unable to create a Peer for ${input.routeCategory}: ${errors.join("; ")}`);
    });
  }

  async recordHandback(input: {
    callerAgentId: string;
    handback: OrchestrationHandback;
  }): Promise<{ handbackId: string; leadAgentId: string }> {
    const context = this.requirePeerLikeContext(input.callerAgentId);
    return this.mutate(async (state) => {
      const run = this.ensureRun(state, context);
      const parentAgentId = getParentAgentIdFromLabels(context.agent.labels);
      if (!parentAgentId || run.leadAgentId !== parentAgentId) {
        throw new Error("Peer has no registered Lead parent for this orchestration run");
      }
      const lead = this.dependencies.agentManager.getAgent(parentAgentId);
      if (!lead) throw new Error(`Lead ${parentAgentId} is not available`);
      const handbackId = randomUUID();
      run.handbacks.push({
        id: handbackId,
        agentId: context.agent.id,
        leadAgentId: parentAgentId,
        ...input.handback,
        createdAtMs: Date.now(),
      });
      const assignmentId = context.agent.labels["jagentdesk.orchestration.assignment-id"];
      const assignment = run.assignments.find((candidate) => candidate.id === assignmentId);
      if (assignment) assignment.status = "handed_back";
      run.updatedAtMs = Date.now();
      await sendPromptToAgent({
        agentManager: this.dependencies.agentManager,
        agentStorage: this.dependencies.agentStorage,
        agentId: parentAgentId,
        prompt: formatHandbackMessage({ peerAgentId: context.agent.id, handback: input.handback }),
        unarchive: false,
        logger: this.dependencies.logger.child({ module: "orchestration-runtime" }),
      });
      return { handbackId, leadAgentId: parentAgentId };
    });
  }

  async resolveDissent(input: {
    callerAgentId: string;
    peerAgentId: string;
    outcome: OrchestrationDissentOutcome;
    rationale: string;
    nextAction: string;
  }): Promise<{ dissentId: string; verificationRound: number }> {
    const context = this.requireContext(input.callerAgentId, "lead");
    const outcome = OrchestrationDissentOutcomeSchema.parse(input.outcome);
    return this.mutate(async (state) => {
      const run = this.ensureRun(state, context);
      if (run.leadAgentId !== context.agent.id) {
        throw new Error("Only the registered Lead may resolve dissent");
      }
      const peer = this.dependencies.agentManager.getAgent(input.peerAgentId);
      if (
        !peer ||
        peer.labels[ORCHESTRATION_BRIEF_LABEL] !== context.briefId ||
        peer.labels[ORCHESTRATION_WORKSPACE_LABEL] !== context.workspaceId ||
        !isPeerLikeRole(peer.labels[ORCHESTRATION_ROLE_LABEL] ?? "") ||
        getParentAgentIdFromLabels(peer.labels) !== context.agent.id
      ) {
        throw new Error("Dissent target is not a Peer owned by this Lead");
      }
      const priorEvidenceRounds = run.dissents.filter(
        (dissent) =>
          dissent.peerAgentId === input.peerAgentId && dissent.outcome === "NEEDS_MORE_EVIDENCE",
      ).length;
      if (outcome === "NEEDS_MORE_EVIDENCE" && priorEvidenceRounds >= 1) {
        throw new Error("Only one bounded NEEDS_MORE_EVIDENCE round is allowed");
      }
      const verificationRound =
        outcome === "NEEDS_MORE_EVIDENCE" ? priorEvidenceRounds + 1 : priorEvidenceRounds;
      const dissentId = randomUUID();
      run.dissents.push({
        id: dissentId,
        peerAgentId: input.peerAgentId,
        leadAgentId: context.agent.id,
        outcome,
        rationale: input.rationale.trim(),
        nextAction: input.nextAction.trim(),
        verificationRound,
        createdAtMs: Date.now(),
      });
      run.updatedAtMs = Date.now();
      await sendPromptToAgent({
        agentManager: this.dependencies.agentManager,
        agentStorage: this.dependencies.agentStorage,
        agentId: input.peerAgentId,
        prompt: formatDissentResolution({
          peerAgentId: input.peerAgentId,
          outcome,
          rationale: input.rationale,
          nextAction: input.nextAction,
        }),
        unarchive: false,
        logger: this.dependencies.logger.child({ module: "orchestration-runtime" }),
      });
      return { dissentId, verificationRound };
    });
  }

  async acceptResult(input: {
    callerAgentId: string;
    summary: string;
    evidence: string;
    remainingUncertainty: string;
  }): Promise<{ supervisorAgentId: string }> {
    const context = this.requireContext(input.callerAgentId, "lead");
    return this.mutate(async (state) => {
      const run = this.ensureRun(state, context);
      if (run.leadAgentId !== context.agent.id) {
        throw new Error("Only the registered Lead may accept an engineering result");
      }
      run.acceptedResult = {
        leadAgentId: context.agent.id,
        summary: input.summary.trim(),
        evidence: input.evidence.trim(),
        remainingUncertainty: input.remainingUncertainty.trim(),
        createdAtMs: Date.now(),
      };
      for (const assignment of run.assignments) {
        if (assignment.status === "handed_back") assignment.status = "accepted";
      }
      run.updatedAtMs = Date.now();
      const supervisor = this.dependencies.agentManager.getAgent(run.supervisorAgentId);
      if (!supervisor) throw new Error(`Supervisor ${run.supervisorAgentId} is not available`);
      await sendPromptToAgent({
        agentManager: this.dependencies.agentManager,
        agentStorage: this.dependencies.agentStorage,
        agentId: run.supervisorAgentId,
        prompt: formatAcceptedResult({
          leadAgentId: context.agent.id,
          summary: input.summary,
          evidence: input.evidence,
          remainingUncertainty: input.remainingUncertainty,
        }),
        unarchive: false,
        logger: this.dependencies.logger.child({ module: "orchestration-runtime" }),
      });
      return { supervisorAgentId: run.supervisorAgentId };
    });
  }
}
