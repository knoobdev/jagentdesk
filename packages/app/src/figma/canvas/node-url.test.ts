import { describe, expect, it } from "vitest";
import { figmaDeepLink, figmaDesignUrl, figmaNodeIdFromParam, figmaNodeParam } from "./node-url";

describe("node id ↔ url param (32.5.5)", () => {
  it("dash-encodes node ids the way Figma urls do", () => {
    expect(figmaNodeParam("123:45")).toBe("123-45");
    expect(figmaNodeParam("I567:12;3:45")).toBe("I567-12;3-45");
    expect(figmaNodeParam(null)).toBeUndefined();
    expect(figmaNodeParam(undefined)).toBeUndefined();
    expect(figmaNodeParam("")).toBeUndefined();
  });

  it("decodes url params back to node ids and rejects junk", () => {
    expect(figmaNodeIdFromParam("123-45")).toBe("123:45");
    expect(figmaNodeIdFromParam("I567-12;3-45")).toBe("I567:12;3:45");
    expect(figmaNodeIdFromParam(null)).toBeNull();
    expect(figmaNodeIdFromParam("")).toBeNull();
    expect(figmaNodeIdFromParam("not a node")).toBeNull();
    expect(figmaNodeIdFromParam("../..")).toBeNull();
  });
});

describe("Open in Figma links", () => {
  it("builds the web design url with the node param", () => {
    expect(figmaDesignUrl("AbC123")).toBe("https://www.figma.com/design/AbC123");
    expect(figmaDesignUrl("AbC123", "1:23")).toBe(
      "https://www.figma.com/design/AbC123?node-id=1-23",
    );
  });

  it("builds the desktop deep link", () => {
    expect(figmaDeepLink("AbC123")).toBe("figma://design/AbC123");
    expect(figmaDeepLink("AbC123", "1:23")).toBe("figma://design/AbC123?node-id=1-23");
    expect(figmaDeepLink("AbC123", null)).toBe("figma://design/AbC123");
  });
});
