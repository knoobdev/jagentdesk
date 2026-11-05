import { describe, expect, it } from "vitest";
import { parseFigmaLocation } from "./nav";

// The route params are the single source of the surface location (spec 32.5): parsing arrays,
// blanks and the view default must not depend on expo-router being mounted.

describe("parseFigmaLocation", () => {
  it("reads file, page, node and version params", () => {
    expect(
      parseFigmaLocation({
        c: "fgc_1",
        fileKey: "abcdefghij1234567890",
        page: "0:1",
        node: "1:2",
        version: "138",
      }),
    ).toEqual({
      connectionId: "fgc_1",
      fileKey: "abcdefghij1234567890",
      pageId: "0:1",
      nodeId: "1:2",
      version: "138",
      view: "files",
    });
  });

  it("takes the first value of repeated params and drops empties", () => {
    const location = parseFigmaLocation({ fileKey: ["", undefined], node: ["1:2", "3:4"] });
    expect(location.fileKey).toBeNull();
    expect(location.nodeId).toBe("1:2");
  });

  it("keeps the view within the known values", () => {
    expect(parseFigmaLocation({ view: "connect" }).view).toBe("connect");
    expect(parseFigmaLocation({ view: "link" }).view).toBe("link");
    expect(parseFigmaLocation({ view: "nonsense" }).view).toBe("files");
  });
});
