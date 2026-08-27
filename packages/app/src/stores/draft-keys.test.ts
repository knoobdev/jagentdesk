import { describe, expect, it } from "vitest";
import { buildDraftStoreKey, remapDraftKey, remapDraftKeys } from "./draft-keys";

describe("buildDraftStoreKey", () => {
  it("isolates agent drafts by server and agent ids", () => {
    const keyA = buildDraftStoreKey({
      serverId: "server-a",
      agentId: "agent-1",
    });
    const keyB = buildDraftStoreKey({
      serverId: "server-b",
      agentId: "agent-1",
    });
    const keyC = buildDraftStoreKey({
      serverId: "server-a",
      agentId: "agent-2",
    });

    expect(keyA).not.toBe(keyB);
    expect(keyA).not.toBe(keyC);
    expect(keyB).not.toBe(keyC);
  });

  it("uses draftId keyspace for create flow drafts", () => {
    const key = buildDraftStoreKey({
      serverId: "server-a",
      agentId: "__new_agent__",
      draftId: "draft-123",
    });

    expect(key).toBe("draft:server-a:draft-123");
  });
});

describe("remapDraftKey (migration rekey)", () => {
  const idMap = { "agent-1": "agent-9" };

  it("remaps agent-scoped keys onto the new host and new agent id", () => {
    expect(
      remapDraftKey({
        draftKey: "agent:server-a:agent-1",
        oldServerId: "server-a",
        newServerId: "server-b",
        idMap,
      }),
    ).toBe("agent:server-b:agent-9");
  });

  it("remaps draft-id keys onto the new host but keeps the draft id", () => {
    expect(
      remapDraftKey({
        draftKey: "draft:server-a:draft-123",
        oldServerId: "server-a",
        newServerId: "server-b",
        idMap,
      }),
    ).toBe("draft:server-b:draft-123");
  });

  it("leaves keys from other hosts and host-agnostic keys untouched", () => {
    expect(
      remapDraftKey({
        draftKey: "agent:server-x:agent-1",
        oldServerId: "server-a",
        newServerId: "server-b",
        idMap,
      }),
    ).toBeNull();
    expect(
      remapDraftKey({
        draftKey: "new-workspace",
        oldServerId: "server-a",
        newServerId: "server-b",
        idMap,
      }),
    ).toBeNull();
  });
});

describe("remapDraftKeys (bulk)", () => {
  it("rewrites only the source host's keys and preserves others", () => {
    const drafts = {
      "agent:server-a:agent-1": "A",
      "agent:server-a:agent-2": "B",
      "agent:server-x:agent-1": "X",
      "new-workspace": "N",
    };
    const remapped = remapDraftKeys({
      drafts,
      oldServerId: "server-a",
      newServerId: "server-b",
      idMap: { "agent-1": "agent-9" },
    });
    expect(remapped["agent:server-b:agent-9"]).toBe("A");
    // agent-2 has no idMap entry -> keeps its id but moves to the new host.
    expect(remapped["agent:server-b:agent-2"]).toBe("B");
    expect(remapped["agent:server-x:agent-1"]).toBe("X");
    expect(remapped["new-workspace"]).toBe("N");
    expect(remapped["agent:server-a:agent-1"]).toBeUndefined();
  });

  it("returns the same reference when nothing matches", () => {
    const drafts = { "agent:server-x:agent-1": "X" };
    const remapped = remapDraftKeys({
      drafts,
      oldServerId: "server-a",
      newServerId: "server-b",
      idMap: {},
    });
    expect(remapped).toBe(drafts);
  });
});
