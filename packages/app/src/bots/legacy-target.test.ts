import { describe, expect, it, vi } from "vitest";

vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
import { legacyBotTarget } from "./navigation";

describe("round-1 bot links", () => {
  it("open the panel the old tab moved to", () => {
    expect(legacyBotTarget({ tab: "items" })).toEqual({ tab: "home" });
    expect(legacyBotTarget({ tab: "schedules" })).toEqual({ tab: "home" });
    expect(legacyBotTarget({ tab: "soulMemory" })).toEqual({ settings: "soul" });
    expect(legacyBotTarget({ tab: "settings" })).toEqual({ settings: "root" });
    expect(legacyBotTarget({ tab: "items", itemId: "i1" })).toEqual({ itemId: "i1" });
    expect(legacyBotTarget({})).toBeUndefined();
  });
});
