import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import type { FigmaConnection, FigmaFile, FigmaTeam } from "@jagentdesk/protocol/figma/rpc-schemas";
import { JsonFigmaStore } from "./store.js";

function makeHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "jad-figma-store-"));
}

function connection(id: string, overrides: Partial<FigmaConnection> = {}): FigmaConnection {
  return {
    id,
    account: { figmaUserId: `u-${id}`, handle: `@${id}`, email: null },
    authState: "connected",
    createdAt_ms: 1_700_000_000_000,
    ...overrides,
  };
}

function file(
  fileKey: string,
  connectionId: string,
  overrides: Partial<FigmaFile> = {},
): FigmaFile {
  return {
    fileKey,
    connectionId,
    name: `${fileKey} design`,
    pinned: false,
    linked: false,
    ...overrides,
  };
}

function team(teamId: string, connectionId: string): FigmaTeam {
  return { teamId, connectionId, name: `${teamId} team` };
}

function createStore(jagentdeskHome: string): JsonFigmaStore {
  return new JsonFigmaStore({ jagentdeskHome, logger: pino({ level: "silent" }) });
}

describe("JsonFigmaStore", () => {
  it("round-trips connections, files and teams through a fresh instance", async () => {
    const home = await makeHome();
    const store = createStore(home);
    await store.saveConnection(connection("fgc_a"));
    await store.saveFile(file("KEY1", "fgc_a", { pinned: true, lastVersion: "v9" }));
    await store.saveTeam(team("111", "fgc_a"));

    const reopened = createStore(home);
    expect(await reopened.listConnections()).toEqual([connection("fgc_a")]);
    expect(await reopened.listFiles()).toEqual([
      file("KEY1", "fgc_a", { pinned: true, lastVersion: "v9" }),
    ]);
    expect(await reopened.listFiles("fgc_a")).toHaveLength(1);
    expect(await reopened.listFiles("fgc_other")).toHaveLength(0);
    expect(await reopened.listTeams("fgc_a")).toEqual([team("111", "fgc_a")]);
  });

  it("upserts by key and reports missing entities as null", async () => {
    const home = await makeHome();
    const store = createStore(home);
    await store.saveFile(file("KEY1", "fgc_a"));
    await store.saveFile(file("KEY1", "fgc_b", { name: "renamed" }));
    const files = await store.listFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ connectionId: "fgc_b", name: "renamed" });
    expect(await store.getFile("NOPE")).toBeNull();
    expect(await store.getConnection("fgc_missing")).toBeNull();
  });

  it("removes files and keeps the rest", async () => {
    const home = await makeHome();
    const store = createStore(home);
    await store.saveFile(file("KEY1", "fgc_a"));
    await store.saveFile(file("KEY2", "fgc_a"));
    await store.removeFile("KEY1");
    expect((await store.listFiles()).map((entry) => entry.fileKey)).toEqual(["KEY2"]);
  });

  it("removes a connection together with its files and teams", async () => {
    const home = await makeHome();
    const store = createStore(home);
    await store.saveConnection(connection("fgc_a"));
    await store.saveConnection(connection("fgc_b"));
    await store.saveFile(file("KEY1", "fgc_a"));
    await store.saveFile(file("KEY2", "fgc_b"));
    await store.saveTeam(team("111", "fgc_a"));

    await store.removeConnection("fgc_a");
    expect((await store.listConnections()).map((entry) => entry.id)).toEqual(["fgc_b"]);
    expect(await store.listFiles("fgc_a")).toEqual([]);
    expect(await store.listTeams("fgc_a")).toEqual([]);
    expect(await store.listFiles("fgc_b")).toHaveLength(1);
  });

  it("writes 0700 directories, 0600 files, and leaves no temp files behind", async () => {
    const home = await makeHome();
    const store = createStore(home);
    await store.saveConnection(connection("fgc_a"));
    await store.saveFile(file("KEY1", "fgc_a"));

    const dirMode = (await stat(store.dir)).mode & 0o777;
    expect(dirMode).toBe(0o700);
    const entries = await readdir(store.dir);
    expect(entries.filter((entry) => entry.endsWith(".json")).sort()).toEqual([
      "connections.json",
      "files.json",
    ]);
    for (const entry of entries) {
      expect((await stat(path.join(store.dir, entry))).mode & 0o777).toBe(0o600);
    }
    expect(entries.filter((entry) => !entry.endsWith(".json"))).toEqual([]);
  });

  it("serializes concurrent writes so no update is dropped", async () => {
    const home = await makeHome();
    const store = createStore(home);
    const ids = Array.from({ length: 10 }, (_, index) => `fgc_${index}`);
    await Promise.all(ids.map((id) => store.saveConnection(connection(id))));
    const saved = await store.listConnections();
    expect(saved.map((entry) => entry.id).sort()).toEqual([...ids].sort());
  });

  it("starts empty when the store files do not exist", async () => {
    const home = await makeHome();
    const store = createStore(home);
    expect(await store.listConnections()).toEqual([]);
    expect(await store.listFiles()).toEqual([]);
    expect(await store.listTeams("fgc_a")).toEqual([]);
  });
});
