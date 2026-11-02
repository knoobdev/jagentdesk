import { describe, expect, it } from "vitest";
import { SshTerminalAppearanceSchema } from "@jagentdesk/protocol/ssh/snippets-schemas";
import { resolveTerminalAppearance } from "./appearance.js";

describe("resolveTerminalAppearance", () => {
  const groups = [
    { id: "grp_root", theme: "midnight", fontSize: 12 },
    { id: "grp_prod", parentId: "grp_root", fontSize: 15 },
    { id: "grp_loop_a", parentId: "grp_loop_b" },
    { id: "grp_loop_b", parentId: "grp_loop_a" },
  ];

  it("takes each field from the nearest server or ancestor group that sets it", () => {
    expect(resolveTerminalAppearance({ groupId: "grp_prod" }, groups)).toEqual({
      theme: "midnight",
      fontSize: 15,
      themeSource: { kind: "group", groupId: "grp_root" },
      fontSizeSource: { kind: "group", groupId: "grp_prod" },
    });
    expect(
      resolveTerminalAppearance({ groupId: "grp_prod", theme: "light" }, groups),
    ).toMatchObject({ theme: "light", themeSource: { kind: "server" } });
  });

  it("falls back to the client default and survives a parent loop", () => {
    expect(resolveTerminalAppearance({ groupId: "grp_loop_a" }, groups)).toEqual({
      theme: null,
      fontSize: null,
      themeSource: { kind: "default" },
      fontSizeSource: { kind: "default" },
    });
  });

  it("bounds the font size on the wire", () => {
    expect(SshTerminalAppearanceSchema.safeParse({ fontSize: 7 }).success).toBe(false);
    expect(SshTerminalAppearanceSchema.safeParse({ fontSize: 32, theme: "ghostty" }).success).toBe(
      true,
    );
  });
});
