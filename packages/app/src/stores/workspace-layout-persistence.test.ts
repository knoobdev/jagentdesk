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
