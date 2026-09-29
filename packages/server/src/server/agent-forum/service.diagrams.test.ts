import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import pino from "pino";
import type { ArchifyRenderer } from "./archify-renderer.js";
import { AgentForumService } from "./service.js";

// Spec 23 / ADR-0021: diagram versions (Mermaid and archify), the HTML stored beside the topic,
// and the rule that a rejected archify document adds no version.

const AUTHOR = { byAgentId: "agent_lead", byLabel: "Lead", role: "lead" as const };

describe("AgentForumService diagrams", () => {
  let dir: string;
  let render: ReturnType<typeof vi.fn<ArchifyRenderer>>;
  let service: AgentForumService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jad-forum-diagram-"));
    render = vi.fn<ArchifyRenderer>(async () => ({
      ok: true,
      diagramType: "architecture",
      html: "<!DOCTYPE html><html><body>rendered</body></html>",
    }));
    service = new AgentForumService({
      dir,
      logger: pino({ level: "silent" }),
      renderArchify: render,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("Mermaid stays the default format and never renders", async () => {
    const topic = await service.createTopic({ prompt: "Build a todo app" });
    const result = await service.setDiagram(topic.id, { ...AUTHOR, source: "graph TD; A-->B" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.version).toBe(1);
    const diagram = result.topic.diagrams[0]!;
    expect(diagram.format).toBe("mermaid");
    expect(diagram.diagramType).toBeUndefined();
    expect(diagram.renderStatus).toBeUndefined();
    expect(render).not.toHaveBeenCalled();
    expect(await service.getDiagramHtml(topic.id, diagram.id)).toBeNull();
  });

  test("archify versions store JSON in the topic and HTML beside it", async () => {
    const topic = await service.createTopic({ prompt: "Build a todo app" });
    await service.setDiagram(topic.id, { ...AUTHOR, source: "graph TD; A-->B" });
    const source = '{"diagram_type":"architecture"}';
    const result = await service.setDiagram(topic.id, {
      ...AUTHOR,
      format: "archify",
      source,
      title: "Todo",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.version).toBe(2);
    expect(render).toHaveBeenCalledWith({ source, diagramType: undefined });
    const diagram = result.topic.diagrams[1]!;
    expect(diagram).toMatchObject({
      format: "archify",
      diagramType: "architecture",
      renderStatus: "ok",
      source,
      title: "Todo",
    });

    const file = join(dir, topic.id, "diagrams", `${diagram.id}.html`);
    expect(await readFile(file, "utf8")).toContain("rendered");
    const persisted = await readFile(join(dir, `${topic.id}.json`), "utf8");
    expect(persisted).not.toContain("<!DOCTYPE html>");
    expect(await service.getDiagramHtml(topic.id, diagram.id)).toContain("rendered");
    expect(await service.getDiagramHtml(topic.id, "diagram_missing")).toBeNull();

    // The list API skips the per-topic diagram directory and still returns the topic.
    expect((await service.listSummaries()).map((s) => s.id)).toEqual([topic.id]);

    // Deleting the topic removes its rendered diagrams too.
    await service.deleteTopic(topic.id);
    await expect(stat(join(dir, topic.id))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a rejected archify document returns its errors and adds no version", async () => {
    const topic = await service.createTopic({ prompt: "Build a todo app" });
    render.mockResolvedValueOnce({
      ok: false,
      errors: [
        { path: "/components/0/type", message: "must be equal to one of the allowed values" },
      ],
    });
    const result = await service.setDiagram(topic.id, {
      ...AUTHOR,
      format: "archify",
      source: "{}",
    });
    expect(result).toEqual({
      ok: false,
      error: "invalid_diagram",
      errors: [
        { path: "/components/0/type", message: "must be equal to one of the allowed values" },
      ],
    });
    expect((await service.getTopic(topic.id))!.diagrams).toHaveLength(0);
    await expect(stat(join(dir, topic.id))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("unknown or unsafe topics are not rendered", async () => {
    const missing = await service.setDiagram("forum_missing", {
      ...AUTHOR,
      format: "archify",
      source: "{}",
    });
    expect(missing).toEqual({ ok: false, error: "topic_not_found" });
    const unsafe = await service.setDiagram("../forum_x", {
      ...AUTHOR,
      format: "archify",
      source: "{}",
    });
    expect(unsafe).toEqual({ ok: false, error: "topic_not_found" });
    expect(render).not.toHaveBeenCalled();
    expect(await service.getDiagramHtml("../forum_x", "../x")).toBeNull();
  });
});
