import { describe, expect, it } from "vitest";
import {
  figmaDeepLink,
  figmaDesignUrl,
  figmaNodeIdFromParam,
  figmaNodeParam,
  nodeParamToFocusId,
} from "./node-url";

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

describe("URL-driven focus decision (32.5)", () => {
  it("focuses a deep-linked or comment-linked node", () => {
    expect(nodeParamToFocusId("1-39", null, null)).toBe("1:39");
    expect(nodeParamToFocusId(["1-39"], null, null)).toBe("1:39");
  });

  it("skips the echo of a canvas click — skip guard and param must match in one form", () => {
    // The canvas click stored the decoded id "1:39"; the URL echo arrives as "1-39".
    // Comparing decoded-to-decoded (not url-form-to-decoded) is what stops the re-centre.
    expect(nodeParamToFocusId("1-39", "1:39", null)).toBeNull();
    // Regression guard for the old bug: a skip entry holding the URL form must NOT match.
    expect(nodeParamToFocusId("1-39", "1-39", null)).toBe("1:39");
  });

  it("skips a node that was already auto-focused", () => {
    expect(nodeParamToFocusId("1-39", null, "1:39")).toBeNull();
  });

  it("focuses a different node than the one skipped or focused", () => {
    expect(nodeParamToFocusId("2-40", "1:39", "1:39")).toBe("2:40");
  });

  it("returns null for no param or junk", () => {
    expect(nodeParamToFocusId(undefined, null, null)).toBeNull();
    expect(nodeParamToFocusId("", null, null)).toBeNull();
    expect(nodeParamToFocusId("not a node", null, null)).toBeNull();
  });
});
