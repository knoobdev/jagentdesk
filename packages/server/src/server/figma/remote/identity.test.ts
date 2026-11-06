import { describe, expect, it } from "vitest";
import { figmaIdentityLabel } from "./identity.js";

describe("Figma editing account identity", () => {
  it("formats the whoami account without plans, seats, IDs, or instructions", () => {
    const text = JSON.stringify({
      whoami: {
        handle: "<account-handle>",
        email: "<account-email>",
        user_id: "1",
        plans: [{ key: "team:1", seat: "Full" }],
      },
      instructions: "<instructions>",
    });
    expect(figmaIdentityLabel(text)).toBe("<account-handle> · <account-email>");
  });
  it("parses identity before truncating a large tool response", () => {
    expect(
      figmaIdentityLabel(
        JSON.stringify({ whoami: { handle: "<account-handle>" }, instructions: "x".repeat(1000) }),
      ),
    ).toBe("<account-handle>");
  });
  it("supports direct account objects and email-only identities", () => {
    expect(figmaIdentityLabel('{"email":"<account-email>"}')).toBe("<account-email>");
    expect(figmaIdentityLabel('{"handle":"<account-handle>"}')).toBe("<account-handle>");
  });
  it("never displays unrecognized or truncated JSON as an identity", () => {
    expect(figmaIdentityLabel('{"whoami":')).toBeUndefined();
    expect(figmaIdentityLabel('{"plans":[]}')).toBeUndefined();
    expect(figmaIdentityLabel('[{"handle":"<account-handle>"}]')).toBeUndefined();
    expect(figmaIdentityLabel('{"handle":{"value":"<account-handle>"}}')).toBeUndefined();
  });
  it("keeps a plain identity and omits missing text", () => {
    expect(figmaIdentityLabel("<account-handle>")).toBe("<account-handle>");
    expect(figmaIdentityLabel(undefined)).toBeUndefined();
    expect(figmaIdentityLabel("  ")).toBeUndefined();
  });
});
