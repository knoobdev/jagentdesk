import { describe, expect, it } from "vitest";
import { computePosition } from "./menu-anchor";

// A chat pane that starts 320 px into the window, with a pill near its left edge.
const chatArea = { x: 320, y: 100, width: 700, height: 600 };
const pill = { x: 330, y: 650, width: 120, height: 32 };

describe("computePosition", () => {
  it("keeps the default 8 px gap to the window edge", () => {
    const result = computePosition({
      triggerRect: { x: 2, y: 650, width: 120, height: 32 },
      contentSize: { width: 300, height: 200 },
      displayArea: { x: 0, y: 0, width: 1440, height: 900 },
      placement: "top",
      alignment: "start",
      offset: 12,
    });
    expect(result.x).toBe(8);
  });

  it("holds a panel inside a boundary at the boundary's own inset", () => {
    const result = computePosition({
      triggerRect: pill,
      contentSize: { width: 560, height: 400 },
      displayArea: chatArea,
      placement: "top",
      alignment: "start",
      offset: 12,
      edgePadding: 16,
    });
    expect(result.x).toBe(chatArea.x + 16);
    expect(result.y).toBe(pill.y - 400 - 12);
    expect(result.actualPlacement).toBe("top");
  });

  it("pulls a panel that would overrun the boundary's trailing edge back inside it", () => {
    const result = computePosition({
      triggerRect: { x: 900, y: 650, width: 100, height: 32 },
      contentSize: { width: 560, height: 300 },
      displayArea: chatArea,
      placement: "top",
      alignment: "start",
      offset: 12,
      edgePadding: 16,
    });
    expect(result.x + 560).toBe(chatArea.x + chatArea.width - 16);
  });
});
