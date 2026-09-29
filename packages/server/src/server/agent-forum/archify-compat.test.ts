import { describe, expect, test } from "vitest";
import { StoredForumTopicSchema } from "@jagentdesk/protocol/agent-forum/types";
import {
  ARCHIFY_LEGACY_PLACEHOLDER,
  downgradeArchifyDiagrams,
  presentForumTopic,
} from "./archify-compat.js";

// COMPAT(archifyDiagrams): clients without the capability get archify versions as a Mermaid note.

const topic = StoredForumTopicSchema.parse({
  id: "forum_a1b2c3",
  title: "Topic",
  status: "planning",
  createdAt_ms: 1,
  updatedAt_ms: 2,
  diagrams: [
    {
      id: "diagram_m1",
      version: 1,
      title: "First",
      format: "mermaid",
      source: "graph TD; A-->B",
      authorAgentId: "agent_lead",
      authorLabel: "Lead",
      createdAt_ms: 10,
    },
    {
      id: "diagram_a2",
      version: 2,
      title: "Second",
      format: "archify",
      diagramType: "architecture",
      renderStatus: "ok",
      source: '{"diagram_type":"architecture"}',
      authorAgentId: "agent_lead",
      authorLabel: "Lead",
      note: "revised",
      createdAt_ms: 20,
    },
  ],
});

// The schema an app released before archify diagrams used for ForumDiagram.format.
const LEGACY_FORMATS = new Set(["mermaid"]);

describe("archify diagram compat", () => {
  test("old clients get a Mermaid placeholder with identity fields kept", () => {
    const legacy = downgradeArchifyDiagrams(topic);
    expect(legacy.diagrams[0]).toEqual(topic.diagrams[0]);
    expect(legacy.diagrams[1]).toEqual({
      id: "diagram_a2",
      version: 2,
      title: "Second",
      format: "mermaid",
      source: ARCHIFY_LEGACY_PLACEHOLDER,
      authorAgentId: "agent_lead",
      authorLabel: "Lead",
      note: "revised",
      createdAt_ms: 20,
    });
    expect(legacy.diagrams.every((d) => LEGACY_FORMATS.has(d.format))).toBe(true);
    // The stored topic is not mutated.
    expect(topic.diagrams[1]!.format).toBe("archify");
  });

  test("capable clients get the topic unchanged; topics without archify are not copied", () => {
    expect(presentForumTopic(topic, true)).toBe(topic);
    const mermaidOnly = { ...topic, diagrams: [topic.diagrams[0]!] };
    expect(presentForumTopic(mermaidOnly, false)).toBe(mermaidOnly);
  });
});
