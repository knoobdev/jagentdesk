import { describe, expect, it } from "vitest";
import type { FigmaFile } from "@jagentdesk/protocol/figma/rpc-schemas";
import { filterSavedFigmaFiles, openFigmaFiles } from "./file-browser-model";

describe("native Figma file browsing", () => {
  it("leaves the canvas and reads the selected account's files in the app", async () => {
    const calls: unknown[] = [];
    await openFigmaFiles(
      {
        go: (patch) => {
          calls.push(patch);
        },
        refresh: async (connectionId) => {
          calls.push({ refresh: connectionId });
        },
      },
      "fgc_a1b2c3",
    );
    expect(calls).toEqual([
      {
        connectionId: "fgc_a1b2c3",
        view: "files",
        fileKey: null,
        pageId: null,
        nodeId: null,
        version: null,
      },
      { refresh: "fgc_a1b2c3" },
    ]);
  });

  it("keeps a failed refresh as a failure, with the files view available for retry", async () => {
    let navigations = 0;
    await expect(
      openFigmaFiles(
        {
          go: () => {
            navigations++;
          },
          refresh: async () => {
            throw new Error("Host disconnected.");
          },
        },
        "fgc_a1b2c3",
      ),
    ).rejects.toThrow("Host disconnected.");
    expect(navigations).toBe(1);
  });

  it("finds names without case or surrounding-space differences and does not cap the saved index", () => {
    const files: FigmaFile[] = Array.from({ length: 20 }, (_, index) => ({
      fileKey: `file_${index}`,
      connectionId: "fgc_a1b2c3",
      name: `<file-${index}>`,
      pinned: false,
      linked: false,
    }));
    files[19] = { ...files[19]!, name: "Thiết kế" };
    expect(filterSavedFigmaFiles(files, "")).toEqual(files);
    expect(filterSavedFigmaFiles(files, " THIẾT KẾ ")).toEqual([files[19]]);
    expect(filterSavedFigmaFiles(files, "<no-match>")).toEqual([]);
  });
});
