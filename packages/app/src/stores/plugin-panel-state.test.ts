import { expect, it, vi } from "vitest";
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
import { createWorkspaceLayoutStore } from "./workspace-layout-store";

it("restores plugin tab state after reload and advances the revision on repeated opens", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: async (key: string) => {
      values.delete(key);
    },
  };
  const first = createWorkspaceLayoutStore(undefined, storage);
  await first.persist.rehydrate();
  const target = {
    kind: "plugin",
    pluginId: "notes",
    panelId: "notes",
    context: "workspace",
  } as const;
  const tabId = first.getState().openTabFocused("host:workspace", target)!;
  first.getState().setTabState("host:workspace", tabId, { draft: "unsaved panel content" });
  const stateOnlyReload = createWorkspaceLayoutStore(undefined, storage);
  await stateOnlyReload.persist.rehydrate();
  expect(stateOnlyReload.getState().panelStateByWorkspace["host:workspace"]![tabId]).toEqual({
    draft: "unsaved panel content",
  });
  const revision = first.getState().panelRevisionByWorkspace["host:workspace"]![tabId]!;
  expect(first.getState().openTabFocused("host:workspace", target)).toBe(tabId);
  expect(first.getState().panelRevisionByWorkspace["host:workspace"]![tabId]).toBe(revision + 1);
  const restored = createWorkspaceLayoutStore(undefined, storage);
  await restored.persist.rehydrate();
  expect(restored.getState().panelStateByWorkspace["host:workspace"]![tabId]).toEqual({
    draft: "unsaved panel content",
  });
  restored.getState().closeTab("host:workspace", tabId);
  const closed = createWorkspaceLayoutStore(undefined, storage);
  await closed.persist.rehydrate();
  expect(closed.getState().panelStateByWorkspace["host:workspace"]).toEqual({});
});
