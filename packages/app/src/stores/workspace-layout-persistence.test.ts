import { expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import { createWorkspaceLayoutStore } from "./workspace-layout-store";

it("keeps saved tabs when a layout changes before hydration settles", async () => {
  const values = new Map<string, string>();
  const storage: StateStorage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      values.set(name, value);
    },
    removeItem: (name) => {
      values.delete(name);
    },
  };
  const workspaceKey = "server:workspace";
  const saved = createWorkspaceLayoutStore(undefined, storage);
  await saved.persist.rehydrate();
  saved.getState().openTabFocused(workspaceKey, { kind: "file", path: "notes.md" });
  const loaded = createWorkspaceLayoutStore(undefined, storage);
  loaded.getState().openTabInBackground("other-workspace", { kind: "file", path: "other.md" });
  await new Promise<void>((resolve) => loaded.persist.onFinishHydration(() => resolve()));
  expect(loaded.getState().layoutByWorkspace[workspaceKey]).toEqual(
    saved.getState().layoutByWorkspace[workspaceKey],
  );
  const reloaded = createWorkspaceLayoutStore(undefined, storage);
  await reloaded.persist.rehydrate();
  expect(reloaded.getState().layoutByWorkspace[workspaceKey]).toEqual(
    saved.getState().layoutByWorkspace[workspaceKey],
  );
});

it("restores the agent pane after parked focus is rehydrated", async () => {
  const values = new Map<string, string>();
  const storage: StateStorage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      values.set(name, value);
    },
    removeItem: (name) => {
      values.delete(name);
    },
  };
  const key = "host:workspace";
  const source = createWorkspaceLayoutStore(undefined, storage);
  await source.persist.rehydrate();
  source.getState().openTabFocused(key, { kind: "agent", agentId: "agent-a" });
  source.getState().unfocusPane(key);
  expect(source.getState().layoutByWorkspace[key].focusedPaneId).toBeNull();
  const restored = createWorkspaceLayoutStore(undefined, storage);
  await restored.persist.rehydrate();
  const layout = restored.getState().layoutByWorkspace[key];
  expect(layout.focusedPaneId).toBe("main");
  expect(
    restored
      .getState()
      .getWorkspaceTabs(key)
      .map((tab) => tab.target),
  ).toEqual([{ kind: "agent", agentId: "agent-a" }]);
});

it("persists changed pin intents and layouts without duplicating focus or repeated pin writes", async () => {
  let writes = 0;
  const storage: StateStorage = {
    getItem: () => null,
    setItem: () => {
      writes += 1;
    },
    removeItem: () => undefined,
  };
  const key = "server:workspace";
  const store = createWorkspaceLayoutStore(undefined, storage);
  await store.persist.rehydrate();
  const tabId = store.getState().openTabFocused(key, { kind: "file", path: "notes.md" })!;
  await Promise.resolve();
  await Promise.resolve();
  const initialWrites = writes;
  store.getState().focusTab(key, tabId);
  store.getState().focusPane(key, "main");
  await Promise.resolve();
  await Promise.resolve();
  expect(writes).toBe(initialWrites);
  store.getState().pinAgent(key, "agent-a");
  await Promise.resolve();
  await Promise.resolve();
  expect(writes).toBe(initialWrites + 1);
  store.getState().pinAgent(key, "agent-a");
  store.getState().focusTab(key, tabId);
  await Promise.resolve();
  await Promise.resolve();
  expect(writes).toBe(initialWrites + 1);
  store.getState().openTabFocused(key, { kind: "file", path: "other.md" });
  await Promise.resolve();
  await Promise.resolve();
  expect(writes).toBe(initialWrites + 2);
});
