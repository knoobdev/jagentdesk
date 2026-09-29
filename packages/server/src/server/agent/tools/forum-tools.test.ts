import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AgentForumService } from "../../agent-forum/service.js";
import { registerForumTools } from "./forum-tools.js";
import type { JAgentDeskToolResult } from "./types.js";

// forum.set_diagram (spec 23.2): archify JSON is validated + rendered by the daemon in the lead's
// own turn; errors come back as the tool result and no version is added. Uses the real vendored
// archify renderer (child process, no network, no model).

type Handler = (input: unknown) => Promise<JAgentDeskToolResult>;

const VALID_ARCHITECTURE = JSON.stringify({
  schema_version: 1,
  diagram_type: "architecture",
  meta: { title: "Todo app", animation: "trace" },
  components: [
    { id: "web", type: "frontend", label: "Web app", pos: [40, 120], size: [140, 60] },
    { id: "api", type: "backend", label: "API", pos: [260, 120], size: [140, 60] },
  ],
  connections: [{ id: "web-api", from: "web", to: "api", label: "HTTPS" }],
});

describe("forum.set_diagram tool", () => {
  let dir: string;
  let service: AgentForumService;
  let setDiagram: Handler;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jad-forum-tool-"));
    service = new AgentForumService({ dir, logger: pino({ level: "silent" }) });
    const handlers = new Map<string, Handler>();
    registerForumTools({
      registerTool: (name, _config, handler) => handlers.set(name, handler as Handler),
      agentForumService: service,
      callerAgentId: "agent_lead",
    });
    setDiagram = handlers.get("forum.set_diagram")!;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("invalid archify JSON returns every error and adds no version", async () => {
    const topic = await service.createTopic({
      prompt: "Build a todo app",
      leadAgentId: "agent_lead",
    });
    const invalid = JSON.parse(VALID_ARCHITECTURE);
    invalid.components[0].type = "mainframe";
    invalid.components[1].brand = "vue";
    const result = await setDiagram({
      topicId: topic.id,
      format: "archify",
      source: JSON.stringify(invalid),
    });
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as {
      ok: boolean;
      error: string;
      errors: { path: string; message: string }[];
    };
    expect(structured.ok).toBe(false);
    expect(structured.error).toBe("invalid_diagram");
    expect(structured.errors.map((e) => e.path)).toContain("/components/0/type");
    expect(result.content[0]?.text).toContain("/components/0/type");
    expect((await service.getTopic(topic.id))!.diagrams).toHaveLength(0);
  }, 60_000);

  test("valid archify JSON publishes a version with rendered HTML", async () => {
    const topic = await service.createTopic({
      prompt: "Build a todo app",
      leadAgentId: "agent_lead",
    });
    const result = await setDiagram({
      topicId: topic.id,
      format: "archify",
      diagramType: "architecture",
      source: VALID_ARCHITECTURE,
    });
    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      ok: boolean;
      diagramId: string;
      version: number;
    };
    expect(structured).toMatchObject({ ok: true, version: 1 });
    const stored = (await service.getTopic(topic.id))!.diagrams[0]!;
    expect(stored).toMatchObject({
      format: "archify",
      diagramType: "architecture",
      renderStatus: "ok",
      authorLabel: "Lead",
    });
    expect(await service.getDiagramHtml(topic.id, structured.diagramId)).toContain(
      'data-animation="trace"',
    );
  }, 60_000);

  test("format defaults to Mermaid and unknown topics are reported", async () => {
    const topic = await service.createTopic({ prompt: "Build a todo app" });
    const ok = await setDiagram({ topicId: topic.id, source: "graph TD; A-->B" });
    expect(ok.structuredContent).toMatchObject({ ok: true, version: 1 });
    expect((await service.getTopic(topic.id))!.diagrams[0]!.format).toBe("mermaid");

    const missing = await setDiagram({
      topicId: "forum_missing",
      format: "archify",
      source: VALID_ARCHITECTURE,
    });
    expect(missing.structuredContent).toEqual({ ok: false, error: "topic_not_found" });
  });
});
