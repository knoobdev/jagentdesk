import { describe, expect, it } from "vitest";

import { fileSubtitle } from "./file-subtitle";
import type { FigmaFile } from "@jagentdesk/protocol/figma/rpc-schemas";

const now = new Date("2026-11-05T12:00:00.000Z");

const file = (over: Partial<FigmaFile>): FigmaFile => ({
  fileKey: "Kx7QmP2vTnYhW3cLdRf5Ba",
  connectionId: "fgc_1",
  name: "Storefront App",
  pinned: false,
  linked: false,
  ...over,
});

describe("fileSubtitle", () => {
  it("shows the project and last-modified time instead of the raw key", () => {
    expect(
      fileSubtitle(
        file({ projectName: "Web Store", lastModified_ms: now.getTime() - 2 * 60 * 60 * 1000 }),
        now,
      ),
    ).toBe("Web Store · edited 2h ago");
  });

  it("shows the relative edit time when that is all the record has", () => {
    expect(
      fileSubtitle(file({ lastModified_ms: now.getTime() - 3 * 24 * 60 * 60 * 1000 }), now),
    ).toBe("edited 3d ago");
  });

  it("keeps the opened time and pinned flag", () => {
    expect(
      fileSubtitle(file({ lastOpenedAt_ms: now.getTime() - 30 * 60 * 1000, pinned: true }), now),
    ).toBe("opened 30m ago · pinned");
  });

  it("never falls back to the raw file key — null when the record has nothing", () => {
    const bare = fileSubtitle(file({}), now);
    expect(bare).toBeNull();
  });
});
