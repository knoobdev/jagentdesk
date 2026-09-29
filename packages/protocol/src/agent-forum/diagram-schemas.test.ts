import { describe, expect, it } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "../messages.js";
import { validateWSOutboundMessage } from "../validation/ws-outbound.js";
import { ForumDiagramSchema, StoredForumTopicSchema } from "./types.js";

// Spec 23.1 / 23.3 (ADR-0021): archify diagram versions and the on-demand HTML RPC.

const LEGACY_MERMAID_VERSION = {
  id: "diagram_a1b2c3",
  version: 1,
  title: "Architecture",
  source: "graph TD; Client-->API",
  authorAgentId: "agent_a1b2c3",
  authorLabel: "Lead",
  createdAt_ms: 1_759_000_000_000,
};

describe("forum diagram schemas", () => {
  it("parses a persisted Mermaid version written before archify existed", () => {
    const parsed = ForumDiagramSchema.parse(LEGACY_MERMAID_VERSION);
    expect(parsed.format).toBe("mermaid");
    expect(parsed.diagramType).toBeUndefined();
    expect(parsed.renderStatus).toBeUndefined();
  });

  it("accepts an archify version with diagramType and renderStatus", () => {
    const parsed = ForumDiagramSchema.parse({
      ...LEGACY_MERMAID_VERSION,
      format: "archify",
      diagramType: "architecture",
      source: '{"schema_version":1}',
      renderStatus: "ok",
    });
    expect(parsed.format).toBe("archify");
    expect(parsed.diagramType).toBe("architecture");
    expect(parsed.renderStatus).toBe("ok");
  });

  it("rejects unknown formats, diagram types and render statuses", () => {
    expect(
      ForumDiagramSchema.safeParse({ ...LEGACY_MERMAID_VERSION, format: "plantuml" }).success,
    ).toBe(false);
    expect(
      ForumDiagramSchema.safeParse({
        ...LEGACY_MERMAID_VERSION,
        format: "archify",
        diagramType: "mindmap",
      }).success,
    ).toBe(false);
    expect(
      ForumDiagramSchema.safeParse({ ...LEGACY_MERMAID_VERSION, renderStatus: "pending" }).success,
    ).toBe(false);
  });

  it("keeps older topics without diagrams loadable", () => {
    const topic = StoredForumTopicSchema.parse({
      id: "forum_a1b2c3",
      title: "Topic",
      status: "discussion",
      createdAt_ms: 1,
      updatedAt_ms: 1,
    });
    expect(topic.diagrams).toEqual([]);
  });

  it("round-trips forum.diagram.html request and response through the session unions", () => {
    const request = SessionInboundMessageSchema.parse({
      type: "forum.diagram.html.request",
      requestId: "req-1",
      topicId: "forum_a1b2c3",
      diagramId: "diagram_a1b2c3",
    });
    expect(request.type).toBe("forum.diagram.html.request");

    const ok = {
      type: "forum.diagram.html.response",
      payload: {
        requestId: "req-1",
        topicId: "forum_a1b2c3",
        diagramId: "diagram_a1b2c3",
        html: "<!doctype html><html></html>",
        error: null,
      },
    };
    expect(SessionOutboundMessageSchema.parse(ok)).toEqual(ok);
    const notFound = {
      ...ok,
      payload: { ...ok.payload, html: null, error: "not_found" },
    };
    expect(SessionOutboundMessageSchema.parse(notFound)).toEqual(notFound);
  });

  it("is accepted by the generated outbound WebSocket validator", () => {
    const result = validateWSOutboundMessage({
      type: "session",
      message: {
        type: "forum.diagram.html.response",
        payload: {
          requestId: "req-1",
          topicId: "forum_a1b2c3",
          diagramId: "diagram_a1b2c3",
          html: null,
          error: "not_found",
        },
      },
    });
    expect(result.success).toBe(true);

    const stream = validateWSOutboundMessage({
      type: "session",
      message: {
        type: "forum.stream",
        payload: {
          topic: {
            id: "forum_a1b2c3",
            title: "Topic",
            status: "planning",
            createdAt_ms: 1,
            updatedAt_ms: 2,
            diagrams: [
              {
                ...LEGACY_MERMAID_VERSION,
                format: "archify",
                diagramType: "workflow",
                renderStatus: "ok",
              },
            ],
          },
        },
      },
    });
    expect(stream.success).toBe(true);
  });
});
