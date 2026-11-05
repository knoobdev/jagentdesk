import { describe, expect, it } from "vitest";
import { formatRelativeTime, versionTitle } from "./versions-model";
import type { FigmaVersion } from "@jagentdesk/protocol/figma/rpc-schemas";

const NOW = 1_700_000_000_000;

function version(overrides: Partial<FigmaVersion>): FigmaVersion {
  return {
    id: "v1",
    label: null,
    description: null,
    createdAt_ms: NOW - 60_000,
    user: { handle: "someone" },
    ...overrides,
  };
}

describe("versionTitle", () => {
  it("prefers the saved label", () => {
    expect(versionTitle(version({ label: "Release 2.1" }), NOW)).toBe("Release 2.1");
  });

  it("titles unlabeled versions by their save time", () => {
    expect(versionTitle(version({ createdAt_ms: NOW - 7_200_000 }), NOW)).toBe("2h ago");
  });
});

describe("formatRelativeTime", () => {
  it("steps through minutes, hours and days", () => {
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe("just now");
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(formatRelativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(formatRelativeTime(NOW - 2 * 86_400_000, NOW)).toBe("2d ago");
  });

  it("falls back to the ISO date after a week and never goes negative", () => {
    expect(formatRelativeTime(NOW - 9 * 86_400_000, NOW)).toBe(
      new Date(NOW - 9 * 86_400_000).toISOString().slice(0, 10),
    );
    expect(formatRelativeTime(NOW + 10_000, NOW)).toBe("just now");
  });
});
