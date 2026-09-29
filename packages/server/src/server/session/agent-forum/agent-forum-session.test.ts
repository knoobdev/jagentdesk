import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SessionOutboundMessage } from "../../messages.js";
import { ARCHIFY_LEGACY_PLACEHOLDER } from "../../agent-forum/archify-compat.js";
import { AgentForumService } from "../../agent-forum/service.js";
import { AgentForumSession } from "./agent-forum-session.js";

// forum.diagram.html.request (spec 23.3): the rendered archify HTML, or error "not_found".

describe("AgentForumSession forum.diagram.html.request", () => {
  let dir: string;
  let service: AgentForumService;
  let emitted: SessionOutboundMessage[];
  let session: AgentForumSession;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jad-forum-session-"));
    service = new AgentForumService({
      dir,
      logger: pino({ level: "silent" }),
      renderArchify: async () => ({
        ok: true,
        diagramType: "architecture",
        html: "<!DOCTYPE html><html><body>diagram</body></html>",
      }),
    });
    emitted = [];
    session = new AgentForumSession({
      host: { emit: (msg) => emitted.push(msg) },
      agentForumService: service,
      logger: pino({ level: "silent" }),
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns the stored HTML for an archify version", async () => {
    const topic = await service.createTopic({ prompt: "Build a todo app" });
    const result = await service.setDiagram(topic.id, {
      format: "archify",
      source: "{}",
      byAgentId: "agent_lead",
      byLabel: "Lead",
      role: "lead",
    });
    if (!result.ok) throw new Error("setDiagram failed");
    await session.handleDiagramHtmlRequest({
      type: "forum.diagram.html.request",
      requestId: "req-1",
      topicId: topic.id,
      diagramId: result.diagramId,
    });
    expect(emitted).toEqual([
      {
        type: "forum.diagram.html.response",
        payload: {
          requestId: "req-1",
          topicId: topic.id,
          diagramId: result.diagramId,
          html: "<!DOCTYPE html><html><body>diagram</body></html>",
          error: null,
        },
      },
    ]);
  });

  test("answers not_found for unknown topics, versions and Mermaid versions", async () => {
    const topic = await service.createTopic({ prompt: "Build a todo app" });
    const mermaid = await service.setDiagram(topic.id, {
      source: "graph TD; A-->B",
      byAgentId: "agent_lead",
      byLabel: "Lead",
      role: "lead",
    });
    if (!mermaid.ok) throw new Error("setDiagram failed");
    const cases = [
      { topicId: "forum_missing", diagramId: "diagram_missing" },
      { topicId: topic.id, diagramId: "diagram_missing" },
      { topicId: topic.id, diagramId: mermaid.diagramId },
    ];
    for (const [index, ids] of cases.entries()) {
      await session.handleDiagramHtmlRequest({
        type: "forum.diagram.html.request",
        requestId: `req-${index}`,
        ...ids,
      });
    }
    expect(emitted.map((msg) => msg.type)).toEqual([
      "forum.diagram.html.response",
      "forum.diagram.html.response",
      "forum.diagram.html.response",
    ]);
    for (const msg of emitted) {
      if (msg.type !== "forum.diagram.html.response") continue;
      expect(msg.payload.html).toBeNull();
      expect(msg.payload.error).toBe("not_found");
    }
  });
});

describe("AgentForumSession archify compat (COMPAT(archifyDiagrams))", () => {
  let dir: string;
  let service: AgentForumService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jad-forum-compat-"));
    service = new AgentForumService({
      dir,
      logger: pino({ level: "silent" }),
      renderArchify: async () => ({ ok: true, diagramType: "architecture", html: "<html></html>" }),
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function getTopicAs(supportsArchifyDiagrams: boolean) {
    const topic = await service.createTopic({ prompt: "Build a todo app" });
    await service.setDiagram(topic.id, {
      format: "archify",
      source: "{}",
      byAgentId: "agent_lead",
      byLabel: "Lead",
      role: "lead",
    });
    const emitted: SessionOutboundMessage[] = [];
    const session = new AgentForumSession({
      host: {
        emit: (msg) => emitted.push(msg),
        supportsArchifyDiagrams: () => supportsArchifyDiagrams,
      },
      agentForumService: service,
      logger: pino({ level: "silent" }),
    });
    await session.handleGetRequest({ type: "forum/get", requestId: "req-1", topicId: topic.id });
    const response = emitted[0];
    if (response?.type !== "forum/get/response") throw new Error("no forum/get response");
    return response.payload.topic!;
  }

  test("an old client gets archify versions as a Mermaid placeholder", async () => {
    const topic = await getTopicAs(false);
    expect(topic.diagrams[0]).toMatchObject({
      format: "mermaid",
      source: ARCHIFY_LEGACY_PLACEHOLDER,
      version: 1,
    });
    expect(topic.diagrams[0]).not.toHaveProperty("diagramType");
    expect(topic.diagrams[0]).not.toHaveProperty("renderStatus");
  });

  test("a capable client gets the archify version", async () => {
    const topic = await getTopicAs(true);
    expect(topic.diagrams[0]).toMatchObject({
      format: "archify",
      diagramType: "architecture",
      renderStatus: "ok",
    });
  });
});
