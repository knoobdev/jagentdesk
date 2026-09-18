import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { AgentForumService } from "../../agent-forum/service.js";

/**
 * Host-side Agent Forum / Team-mode RPC surface (docs/plans/active/agent-forum.md). Host↔daemon over
 * the main /ws. Thin translator over AgentForumService; live topic changes are pushed separately via
 * forum.stream.
 */
export interface AgentForumSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface AgentForumSessionOptions {
  host: AgentForumSessionHost;
  agentForumService: AgentForumService;
  logger: pino.Logger;
  // Bootstrap the orchestration lead for a freshly created topic (wired in Stage 3+). Optional/null so
  // the data layer works standalone.
  bootstrapTopic?:
    | ((input: { topicId: string; prompt: string; originAgentId?: string }) => void | Promise<void>)
    | null;
}

type ForumRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "forum/create"
      | "forum/list"
      | "forum/get"
      | "forum/archive"
      | "forum/delete"
      | "forum/post"
      | "forum/vote"
      | "forum/chat-post"
      | "forum/chat-react"
      | "forum/chat-room";
  }
>;

export class AgentForumSession {
  private readonly host: AgentForumSessionHost;
  private readonly service: AgentForumService;
  private readonly logger: pino.Logger;
  private readonly bootstrapTopic?: AgentForumSessionOptions["bootstrapTopic"];

  constructor(options: AgentForumSessionOptions) {
    this.host = options.host;
    this.service = options.agentForumService;
    this.logger = options.logger;
    this.bootstrapTopic = options.bootstrapTopic;
  }

  private emitRpcError(request: ForumRequest, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error({ err: error, requestType: request.type }, "Forum request failed");
    this.host.emit({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        error: message,
        code: "forum_request_failed",
      },
    });
  }

  async handleCreateRequest(
    request: Extract<SessionInboundMessage, { type: "forum/create" }>,
  ): Promise<void> {
    try {
      const topic = await this.service.createTopic({
        prompt: request.prompt,
        title: request.title,
        projectKey: request.projectKey,
        leadAgentId: request.originAgentId ?? null,
      });
      // Kick off the real orchestration run (best-effort; the topic exists regardless).
      if (request.bootstrapLead !== false && this.bootstrapTopic) {
        try {
          await this.bootstrapTopic({
            topicId: topic.id,
            prompt: request.prompt,
            originAgentId: request.originAgentId,
          });
        } catch (error) {
          this.logger.error({ err: error, topicId: topic.id }, "Forum topic bootstrap failed");
        }
      }
      this.host.emit({
        type: "forum/create/response",
        payload: { requestId: request.requestId, topic, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleListRequest(
    request: Extract<SessionInboundMessage, { type: "forum/list" }>,
  ): Promise<void> {
    try {
      const topics = await this.service.listSummaries();
      this.host.emit({
        type: "forum/list/response",
        payload: { requestId: request.requestId, topics, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleGetRequest(
    request: Extract<SessionInboundMessage, { type: "forum/get" }>,
  ): Promise<void> {
    try {
      const topic = await this.service.getTopic(request.topicId);
      this.host.emit({
        type: "forum/get/response",
        payload: { requestId: request.requestId, topic, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleArchiveRequest(
    request: Extract<SessionInboundMessage, { type: "forum/archive" }>,
  ): Promise<void> {
    try {
      const topic = await this.service.archiveTopic(request.topicId);
      this.host.emit({
        type: "forum/archive/response",
        payload: { requestId: request.requestId, topic, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleDeleteRequest(
    request: Extract<SessionInboundMessage, { type: "forum/delete" }>,
  ): Promise<void> {
    try {
      const deleted = await this.service.deleteTopic(request.topicId);
      this.host.emit({
        type: "forum/delete/response",
        payload: { requestId: request.requestId, topicId: request.topicId, deleted, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handlePostRequest(
    request: Extract<SessionInboundMessage, { type: "forum/post" }>,
  ): Promise<void> {
    try {
      const topic = await this.service.postHumanMessage(request.topicId, {
        text: request.text,
        replyToId: request.replyToId ?? null,
      });
      this.host.emit({
        type: "forum/post/response",
        payload: { requestId: request.requestId, topic, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleVoteRequest(
    request: Extract<SessionInboundMessage, { type: "forum/vote" }>,
  ): Promise<void> {
    try {
      const topic = await this.service.voteMessage(
        request.topicId,
        request.messageId,
        "user",
        request.direction,
      );
      this.host.emit({
        type: "forum/vote/response",
        payload: { requestId: request.requestId, topic, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleChatPostRequest(
    request: Extract<SessionInboundMessage, { type: "forum/chat-post" }>,
  ): Promise<void> {
    try {
      const topic = await this.service.postChatMessage(request.topicId, {
        roomId: request.roomId ?? null,
        authorAgentId: "user",
        authorLabel: "You",
        role: "user",
        kind: request.kind ?? "text",
        text: request.text,
        stickerId: request.stickerId ?? null,
        replyToId: request.replyToId ?? null,
      });
      this.host.emit({
        type: "forum/chat-post/response",
        payload: { requestId: request.requestId, topic, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleChatReactRequest(
    request: Extract<SessionInboundMessage, { type: "forum/chat-react" }>,
  ): Promise<void> {
    try {
      const topic = await this.service.reactChatMessage(request.topicId, {
        messageId: request.messageId,
        emoji: request.emoji,
        by: "user",
      });
      this.host.emit({
        type: "forum/chat-react/response",
        payload: { requestId: request.requestId, topic, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleChatRoomRequest(
    request: Extract<SessionInboundMessage, { type: "forum/chat-room" }>,
  ): Promise<void> {
    try {
      const result = await this.service.createChatRoom(request.topicId, {
        name: request.name,
        topic: request.purpose,
        byAgentId: "user",
        byLabel: "You",
        role: "user",
      });
      this.host.emit({
        type: "forum/chat-room/response",
        payload: {
          requestId: request.requestId,
          topic: result?.topic ?? null,
          roomId: result?.roomId ?? null,
          error: null,
        },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }
}
