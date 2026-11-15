import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";

// Spec 34.6 hot reload: after a custom provider save/delete, bootstrap re-extracts
// the persisted overrides and applies them as base overrides, dropping removed
// providers so they cannot reappear through the mutable daemon config either.
describe("ProviderSnapshotManager.applyMutableProviderConfig — baseOverrides", () => {
  test("replaces the startup-derived base overrides and emits change on publish", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        "prov-a": { extends: "claude", label: "A", enabled: true },
      },
    });
    try {
      // Create the global snapshot so publish() has a cwd to emit for.
      manager.getSnapshot();
      const onChange = vi.fn();
      manager.on("change", onChange);

      manager.applyMutableProviderConfig(undefined, {
        baseOverrides: {
          "prov-b": { extends: "opencode", label: "B", enabled: true },
        },
        removeProviders: ["prov-a"],
      });

      expect(manager.hasProvider("prov-a")).toBe(false);
      expect(manager.hasProvider("prov-b")).toBe(true);
      expect(manager.getProviderLabel("prov-b")).toBe("B");
      expect(onChange).toHaveBeenCalled();
    } finally {
      manager.destroy();
    }
  });

  test("a removed provider does not come back through the mutable toggles", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        "prov-a": { extends: "claude", label: "A", enabled: true },
      },
    });
    try {
      manager.getSnapshot();
      manager.applyMutableProviderConfig(
        { "prov-a": { enabled: true } },
        { baseOverrides: {}, removeProviders: ["prov-a"] },
      );
      expect(manager.hasProvider("prov-a")).toBe(false);
    } finally {
      manager.destroy();
    }
  });
});
