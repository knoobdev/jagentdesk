import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type {
  ActivityGraphPush,
  ActivityGraphService,
} from "../../agent/activity-graph/service.js";

/**
 * Agent activity graph RPC surface (spec 31.5, ADR-0031). Thin translator over the daemon-wide
 * ActivityGraphService; one instance per client session owns that session's subscriptions.
 * Clients that did not advertise the `activity_graph` capability get `unsupported` and the daemon
 * renders nothing for them.
 */
export interface ActivityGraphSessionHost {
  emit(msg: SessionOutboundMessage): void;
  supportsActivityGraph(): boolean;
  // Loads an archived/unloaded agent into the manager before its timeline is read.
  ensureAgentLoaded?(agentId: string): Promise<void>;
}

export interface ActivityGraphSessionOptions {
  host: ActivityGraphSessionHost;
  service: ActivityGraphService;
  logger: pino.Logger;
}

type GetRequest = Extract<SessionInboundMessage, { type: "agent.activity_graph.get.request" }>;
type SubscribeRequest = Extract<
  SessionInboundMessage,
  { type: "agent.activity_graph.subscribe.request" }
>;
type UnsubscribeRequest = Extract<
  SessionInboundMessage,
  { type: "agent.activity_graph.unsubscribe.request" }
>;

export class ActivityGraphSession {
  private readonly host: ActivityGraphSessionHost;
  private readonly service: ActivityGraphService;
  private readonly logger: pino.Logger;
  private readonly subscriptions = new Set<string>();

  constructor(options: ActivityGraphSessionOptions) {
    this.host = options.host;
    this.service = options.service;
    this.logger = options.logger;
  }

  dispatch(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "agent.activity_graph.get.request":
        return this.handleGet(msg);
      case "agent.activity_graph.subscribe.request":
        return this.handleSubscribe(msg);
      case "agent.activity_graph.unsubscribe.request":
        return this.handleUnsubscribe(msg);
      default:
        return undefined;
    }
  }

  dispose(): void {
    for (const subscriptionId of this.subscriptions) this.service.unsubscribe(subscriptionId);
    this.subscriptions.clear();
  }

  private emptyGet(
    msg: GetRequest,
    error: "no_activity" | "not_found" | "unsupported" | "render_failed",
  ) {
    this.host.emit({
      type: "agent.activity_graph.get.response",
      payload: {
        requestId: msg.requestId,
        agentId: msg.agentId,
        view: msg.view,
        graphVersion: 0,
        html: "",
        nodeIndex: {},
        nodes: [],
        turnIndex: 0,
        live: false,
        turns: [],
        error,
      },
    });
  }

  private async handleGet(msg: GetRequest): Promise<void> {
    if (!this.host.supportsActivityGraph()) {
      this.emptyGet(msg, "unsupported");
      return;
    }
    try {
      await this.host.ensureAgentLoaded?.(msg.agentId);
      const result = await this.service.get(msg.agentId, msg.view, msg.turnIndex);
      if (!result.ok) {
        this.emptyGet(msg, result.error);
        return;
      }
      const { snapshot } = result;
      this.host.emit({
        type: "agent.activity_graph.get.response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
          view: msg.view,
          graphVersion: snapshot.graphVersion,
          html: snapshot.html,
          nodeIndex: snapshot.nodeIndex,
          nodes: snapshot.nodes,
          turnIndex: snapshot.turnIndex,
          live: snapshot.live,
          turns: snapshot.turns,
          error: null,
        },
      });
    } catch (error) {
      this.logger.warn({ err: error, agentId: msg.agentId }, "activity graph get failed");
      this.emptyGet(msg, "render_failed");
    }
  }

  private async handleSubscribe(msg: SubscribeRequest): Promise<void> {
    if (!this.host.supportsActivityGraph()) {
      this.host.emit({
        type: "agent.activity_graph.subscribe.response",
        payload: { requestId: msg.requestId, subscriptionId: null, error: "unsupported" },
      });
      return;
    }
    const subscriptionId = this.service.subscribe(msg.agentId, msg.view, (push) =>
      this.forward(push),
    );
    this.subscriptions.add(subscriptionId);
    this.host.emit({
      type: "agent.activity_graph.subscribe.response",
      payload: { requestId: msg.requestId, subscriptionId, error: null },
    });
  }

  private async handleUnsubscribe(msg: UnsubscribeRequest): Promise<void> {
    if (this.subscriptions.delete(msg.subscriptionId)) {
      this.service.unsubscribe(msg.subscriptionId);
    }
    this.host.emit({
      type: "agent.activity_graph.unsubscribe.response",
      payload: { requestId: msg.requestId },
    });
  }

  private forward(push: ActivityGraphPush): void {
    if (push.type === "changed") {
      this.host.emit({
        type: "agent.activity_graph.changed",
        payload: { agentId: push.agentId, view: push.view, graphVersion: push.graphVersion },
      });
      return;
    }
    this.host.emit({
      type: "agent.activity_graph.status",
      payload: {
        agentId: push.agentId,
        view: push.view,
        graphVersion: push.graphVersion,
        nodes: push.nodes,
      },
    });
  }
}
