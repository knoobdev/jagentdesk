import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { SkillEntry } from "@jagentdesk/protocol/native-skills";
import { makeSkillEntry } from "@/test/skill-entry";
import { migrateAttachmentRecord, useAgentSkillsStore } from "./agent-skills-store";
import {
  allKnownSkills,
  bindSkillsSync,
  loadSkillCatalog,
  unbindSkillsSync,
  useSkillsStore,
} from "./skills-store";

type StatusListener = (message: { payload: unknown }) => void;

function fakeClient(catalogs: Record<string, SkillEntry[]>) {
  const listeners: StatusListener[] = [];
  const listNativeSkills = vi.fn(async (options: { cwd?: string } = {}) => ({
    requestId: "r",
    skills: catalogs[options.cwd ?? ""] ?? [],
    written: { lockPath: "/jad/skills/lock.json", paths: [] },
  }));
  const client = {
    listNativeSkills,
    on: (event: string, listener: StatusListener) => {
      if (event === "status") listeners.push(listener);
      return () => {
        listeners.splice(listeners.indexOf(listener), 1);
      };
    },
  } as unknown as DaemonClient;
  const emitStatus = (payload: unknown) => listeners.forEach((listener) => listener({ payload }));
  return { client, listNativeSkills, emitStatus };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("skills-store (native catalog cache)", () => {
  beforeEach(() => {
    useAgentSkillsStore.setState({ attached: {}, injected: {}, autoLoad: true });
  });
  afterEach(() => {
    unbindSkillsSync();
  });

  it("loads the global catalog on bind and a project catalog on demand", async () => {
    const global = [makeSkillEntry({ name: "alpha" })];
    const project = [
      ...global,
      makeSkillEntry({ name: "beta", scope: "project", projectRoot: "/repo" }),
    ];
    const { client, listNativeSkills } = fakeClient({ "": global, "/repo": project });
    bindSkillsSync(client, "srv_1");
    await flush();
    expect(useSkillsStore.getState().catalogs[""]?.status).toBe("ready");
    expect(useSkillsStore.getState().catalogs[""]?.written?.lockPath).toBe("/jad/skills/lock.json");

    loadSkillCatalog("/repo");
    loadSkillCatalog("/repo");
    await flush();
    expect(listNativeSkills).toHaveBeenCalledTimes(2);
    expect(listNativeSkills).toHaveBeenLastCalledWith({ cwd: "/repo" });
    expect(allKnownSkills().map((entry) => entry.name)).toEqual(["alpha", "beta"]);
  });

  it("refetches every loaded catalog on status:skills_changed", async () => {
    const catalogs: Record<string, SkillEntry[]> = { "": [makeSkillEntry({ name: "alpha" })] };
    const { client, listNativeSkills, emitStatus } = fakeClient(catalogs);
    bindSkillsSync(client, "srv_1");
    await flush();
    catalogs[""] = [...catalogs[""]!, makeSkillEntry({ name: "gamma" })];
    emitStatus({ status: "skills_changed", skills: [], catalogChanged: true });
    await flush();
    expect(listNativeSkills).toHaveBeenCalledTimes(2);
    expect(useSkillsStore.getState().catalogs[""]?.skills.map((s) => s.name)).toEqual([
      "alpha",
      "gamma",
    ]);
    emitStatus({ status: "agents_changed" });
    await flush();
    expect(listNativeSkills).toHaveBeenCalledTimes(2);
  });

  it("records an error state when the daemon rejects the list", async () => {
    const { client, listNativeSkills } = fakeClient({});
    listNativeSkills.mockRejectedValueOnce(new Error("unknown request"));
    bindSkillsSync(client, "srv_1");
    await flush();
    expect(useSkillsStore.getState().catalogs[""]).toMatchObject({
      status: "error",
      error: "unknown request",
    });
  });

  it("rewrites stored legacy attachment ids once the catalog reports legacyId", async () => {
    useAgentSkillsStore.setState({ attached: { agent_1: ["skl_legacy", "global:agents:other"] } });
    const { client } = fakeClient({
      "": [makeSkillEntry({ name: "release-captain", owned: true, legacyId: "skl_legacy" })],
    });
    bindSkillsSync(client, "srv_1");
    await flush();
    expect(useAgentSkillsStore.getState().attached.agent_1).toEqual([
      "global:agents:release-captain",
      "global:agents:other",
    ]);
  });

  it("clears the cache on unbind", async () => {
    const { client } = fakeClient({ "": [makeSkillEntry({ name: "alpha" })] });
    bindSkillsSync(client, "srv_1");
    await flush();
    unbindSkillsSync();
    expect(useSkillsStore.getState()).toMatchObject({ serverId: null, catalogs: {} });
  });
});

describe("agent-skills-store", () => {
  beforeEach(() => {
    useAgentSkillsStore.setState({ attached: {}, injected: {}, autoLoad: true });
  });

  it("returns the same record when no legacy id applies", () => {
    const record = { a: ["global:agents:x"] };
    expect(migrateAttachmentRecord(record, { skl_1: "global:agents:y" })).toBe(record);
    expect(
      migrateAttachmentRecord({ a: ["skl_1", "global:agents:y"] }, { skl_1: "global:agents:y" }),
    ).toEqual({
      a: ["global:agents:y"],
    });
  });

  it("swaps an attached skill for its fork, or adds the fork when not attached", () => {
    const store = useAgentSkillsStore.getState();
    store.setAttached("agent_1", ["global:claude:pdf", "global:agents:other"]);
    store.replaceAttached("agent_1", "global:claude:pdf", "global:agents:pdf-jagentdesk");
    expect(useAgentSkillsStore.getState().attached.agent_1).toEqual([
      "global:agents:pdf-jagentdesk",
      "global:agents:other",
    ]);
    store.replaceAttached("agent_2", "global:claude:pdf", "global:agents:pdf-jagentdesk");
    expect(useAgentSkillsStore.getState().attached.agent_2).toEqual([
      "global:agents:pdf-jagentdesk",
    ]);
  });

  it("migrates legacy ids in attached and injected lists", () => {
    useAgentSkillsStore.setState({
      attached: { agent_1: ["skl_1"] },
      injected: { agent_1: ["skl_1"] },
    });
    useAgentSkillsStore.getState().migrateLegacyIds({ skl_1: "global:agents:one" });
    const state = useAgentSkillsStore.getState();
    expect(state.attached.agent_1).toEqual(["global:agents:one"]);
    expect(state.injected.agent_1).toEqual(["global:agents:one"]);
  });
});
