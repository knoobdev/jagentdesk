import { describe, expect, it } from "vitest";
import { reconcileRenameSession, type RenameSession } from "./use-sidebar-workspace-rename";

describe("inline workspace rename", () => {
  it("keeps an untouched edit stable across another client's rename", () => {
    const editing: RenameSession = { kind: "inline", phase: "editing", initialValue: "Original" };
    expect(reconcileRenameSession(editing, "Other client")).toBe(editing);
  });
  it("tracks title updates before the response while retaining the submitted field", () => {
    const saving: RenameSession = {
      kind: "inline",
      phase: "saving",
      initialValue: "Original",
      titleSeen: "Original",
    };
    expect(reconcileRenameSession(saving, "Other client")).toEqual({
      ...saving,
      titleSeen: "Other client",
    });
  });
  it("holds the field after acceptance until the pushed title arrives", () => {
    const saved: RenameSession = {
      kind: "inline",
      phase: "saved",
      initialValue: "Original",
      titleSeen: "Original",
      acceptedTitle: "Renamed",
    };
    expect(reconcileRenameSession(saved, "Original")).toBe(saved);
    expect(reconcileRenameSession(saved, "Renamed")).toEqual({ kind: "closed" });
    expect(reconcileRenameSession(saved, "Superseding rename")).toEqual({ kind: "closed" });
  });
});
