import { describe, expect, it } from "vitest";
import {
  resolveExplorerSidebarDockSizes,
  resolveExplorerSidebarWidth,
} from "@/components/explorer-sidebar-layout";

// Adapted from Paseo v0.18.0 packages/app/src/components/explorer-sidebar-layout.test.ts.
describe("Explorer sidebar layout", () => {
  it("opens the inspector at 525 px until the client resizes it", () => {
    expect(resolveExplorerSidebarWidth({ requestedWidth: null, containerWidth: 1400 })).toBe(525);
    expect(resolveExplorerSidebarWidth({ containerWidth: 1400 })).toBe(525);
  });

  it("keeps the sidebar width fixed when the workspace body changes size", () => {
    const narrow = resolveExplorerSidebarDockSizes({ requestedWidth: 320, containerWidth: 1200 });
    const wide = resolveExplorerSidebarDockSizes({ requestedWidth: 320, containerWidth: 1520 });

    expect(narrow[1] * 1200).toBeCloseTo(320);
    expect(wide[1] * 1520).toBeCloseTo(320);
  });

  it("has no fixed maximum while preserving room for the workspace body", () => {
    expect(resolveExplorerSidebarWidth({ requestedWidth: 100, containerWidth: 1200 })).toBe(240);
    expect(resolveExplorerSidebarWidth({ requestedWidth: 900, containerWidth: 1600 })).toBe(900);
    expect(resolveExplorerSidebarWidth({ requestedWidth: 900, containerWidth: 1200 })).toBe(840);
    expect(resolveExplorerSidebarWidth({ requestedWidth: 600, containerWidth: 750 })).toBe(390);
  });

  it("keeps the requested width before the row is measured", () => {
    expect(resolveExplorerSidebarWidth({ requestedWidth: 700, containerWidth: 0 })).toBe(700);
    expect(resolveExplorerSidebarDockSizes({ requestedWidth: 700, containerWidth: 0 })).toEqual([
      1, 0,
    ]);
  });
});
