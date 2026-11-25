import { describe, expect, it } from "vitest";
import type { SshServerInfo } from "@jagentdesk/client/internal/daemon-client";
import { collectTags, serverHasAllTags, serverMatchesQuery, toggleTagIn } from "./tag-filter";

function server(partial: Partial<SshServerInfo> & { id: string; label: string }): SshServerInfo {
  return { address: `${partial.id}.example.com`, state: "disconnected", ...partial };
}

describe("collectTags", () => {
  it("dedupes case-insensitively and sorts", () => {
    const tags = collectTags([
      server({ id: "a", label: "A", tags: ["Web", "prod"] }),
      server({ id: "b", label: "B", tags: ["web", " EU ", ""] }),
    ]);
    expect(tags).toEqual(["EU", "prod", "Web"]);
  });
});

describe("toggleTagIn", () => {
  it("adds and removes without mutating the input set", () => {
    const initial = new Set(["a"]);
    const added = toggleTagIn(initial, "b");
    expect([...added].sort()).toEqual(["a", "b"]);
    expect([...initial]).toEqual(["a"]);
    const removed = toggleTagIn(added, "a");
    expect([...removed]).toEqual(["b"]);
  });
});

describe("serverMatchesQuery", () => {
  const s = server({ id: "web1", label: "Web Front", tags: ["prod"] });

  it("matches every word (AND) across label, target and tags", () => {
    expect(serverMatchesQuery(s, "web front", "ubuntu@10.0.0.5:22")).toBe(true);
    expect(serverMatchesQuery(s, "web prod", "ubuntu@10.0.0.5:22")).toBe(true);
    expect(serverMatchesQuery(s, "web missing", "ubuntu@10.0.0.5:22")).toBe(false);
  });

  it("empty query matches everything", () => {
    expect(serverMatchesQuery(s, "   ", "x")).toBe(true);
  });

  it("searches the address via the target string", () => {
    expect(serverMatchesQuery(s, "10.0.0.5", "ubuntu@10.0.0.5:22")).toBe(true);
  });
});

describe("serverHasAllTags", () => {
  const s = server({ id: "a", label: "A", tags: ["Prod", "web "] });

  it("requires every selected tag (AND semantics)", () => {
    expect(serverHasAllTags(s, new Set())).toBe(true);
    expect(serverHasAllTags(s, new Set(["prod"]))).toBe(true);
    expect(serverHasAllTags(s, new Set(["WEB"]))).toBe(true);
    expect(serverHasAllTags(s, new Set(["prod", "web"]))).toBe(true);
    expect(serverHasAllTags(s, new Set(["prod", "eu"]))).toBe(false);
  });

  it("rejects tag-less servers when a filter is active", () => {
    expect(serverHasAllTags(server({ id: "b", label: "B" }), new Set(["prod"]))).toBe(false);
  });
});
