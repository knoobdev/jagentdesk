import type { Logger } from "pino";
import type { AgentPromptInput, UsageLimitNotice } from "../agent-sdk-types.js";
import {
  FailoverRateLimiter,
  pickFailoverTarget,
  type FailoverConfig,
  type ProviderModelRef,
} from "./failover-policy.js";
import { classifyTurnFailure, type TurnFailureInput } from "./turn-failure-classification.js";

export interface FailoverCoordinatorDeps {
  /** The agent's override, else the host setting. */
  resolveConfig: (agentId: string) => Promise<FailoverConfig>;
  /** Providers enabled on this host, in host order. */
  listEnabledProviders: () => string[];
  /** True when Usage reports the provider out of quota. */
  isExhausted: (provider: string) => boolean;
  /** Spec 40 §3 switch with reason "failover"; a running turn is interrupted. */
  switchProvider: (agentId: string, target: ProviderModelRef) => Promise<void>;
  /** Starts a turn with the failed turn's message on the agent's current provider. */
  resend: (agentId: string, prompt: AgentPromptInput) => Promise<void>;
  /** The last user message of the agent, used when the daemon restarted since the turn. */
  readLastUserMessage: (agentId: string) => Promise<string | null>;
  appendUsageLimitNotice: (agentId: string, notice: UsageLimitNotice) => Promise<void>;
  logger: Logger;
  now?: () => number;
}

export interface TurnFailureEvent extends TurnFailureInput {
  agentId: string;
  provider: string;
}

/**
 * Spec 40 §4. A usage-limit failure moves the agent in place to the next usable entry of its
 * failover order and resends the failed turn's message, at most once per turn and three times an
 * hour per agent. When failover is off or used up, the daemon appends a usage-limit row the app
 * renders with "Continue with …".
 */
export class FailoverCoordinator {
  private readonly limiter = new FailoverRateLimiter();
  private readonly lastPrompts = new Map<string, AgentPromptInput>();
  /** Agents whose current turn is a failover resend; a second limit in it does not fail over. */
  private readonly resending = new Set<string>();

  constructor(private readonly deps: FailoverCoordinatorDeps) {}

  rememberPrompt(agentId: string, prompt: AgentPromptInput): void {
    this.lastPrompts.set(agentId, prompt);
  }

  /** A turn of the agent ended without failing; it is no longer a resend. */
  settleTurn(agentId: string): void {
    this.resending.delete(agentId);
  }

  forget(agentId: string): void {
    this.lastPrompts.delete(agentId);
    this.resending.delete(agentId);
  }

  async handleTurnFailure(event: TurnFailureEvent): Promise<"failover" | "notice" | "ignored"> {
    const wasResend = this.resending.delete(event.agentId);
    if (classifyTurnFailure(event) !== "usage_limit") return "ignored";
    const config = await this.deps.resolveConfig(event.agentId);
    const enabled = new Set(this.deps.listEnabledProviders());
    const target = pickFailoverTarget({
      order: config.order,
      currentProvider: event.provider,
      isAvailable: (provider) => enabled.has(provider),
      isExhausted: this.deps.isExhausted,
    });
    const now = (this.deps.now ?? Date.now)();
    if (config.enabled && target && !wasResend && this.limiter.canFailover(event.agentId, now)) {
      this.limiter.record(event.agentId, now);
      await this.failoverTo(event.agentId, target);
      return "failover";
    }
    await this.deps.appendUsageLimitNotice(event.agentId, {
      provider: event.provider,
      failover: this.noticeReason({ config, target, wasResend }),
      suggestion: target ?? this.suggestOtherProvider(event.provider, enabled),
    });
    return "notice";
  }

  /** "Continue with …": the user picked the provider, so the caps do not apply. */
  async continueWith(agentId: string, target: ProviderModelRef): Promise<void> {
    await this.failoverTo(agentId, target);
  }

  private async failoverTo(agentId: string, target: ProviderModelRef): Promise<void> {
    const prompt = this.lastPrompts.get(agentId) ?? (await this.deps.readLastUserMessage(agentId));
    await this.deps.switchProvider(agentId, target);
    if (!prompt) {
      this.deps.logger.warn(
        { agentId },
        "Failover switched provider but found no message to resend",
      );
      return;
    }
    this.resending.add(agentId);
    try {
      await this.deps.resend(agentId, prompt);
    } catch (error) {
      this.resending.delete(agentId);
      throw error;
    }
  }

  private noticeReason(input: {
    config: FailoverConfig;
    target: ProviderModelRef | null;
    wasResend: boolean;
  }): string {
    if (!input.config.enabled) return "off";
    if (input.wasResend) return "repeat";
    if (!input.target) return "exhausted";
    return "capped";
  }

  private suggestOtherProvider(current: string, enabled: Set<string>): ProviderModelRef | null {
    for (const provider of enabled) {
      if (provider !== current && !this.deps.isExhausted(provider))
        return { provider, model: null };
    }
    return null;
  }
}
