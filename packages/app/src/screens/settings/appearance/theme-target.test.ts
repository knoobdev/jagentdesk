import { describe, expect, it } from "vitest";
import type { PluginThemeOption } from "@/plugins/themes";
import { darkTheme, lightTheme } from "@/styles/theme";
import { resolveThemeTarget } from "./theme-target";

const atom = {
  id: "atom/theme/dark",
  serverId: "s",
  name: "Atom",
  swatch: "#282c34",
  theme: darkTheme,
} as PluginThemeOption;
const paper = {
  id: "paper/theme/light",
  serverId: "s",
  name: "Paper",
  swatch: "#fff",
  theme: lightTheme,
} as PluginThemeOption;

describe("resolveThemeTarget", () => {
  it("keeps ClickUp light whatever the system appearance; ClickUp Dark is its own choice", () => {
    const base = { preference: "clickup" as const, pluginThemeId: null, pluginOptions: [] };
    for (const systemScheme of ["light", "dark", null] as const) {
      expect(resolveThemeTarget({ ...base, systemScheme })).toEqual({
        kind: "static",
        key: "clickupLight",
      });
    }
    expect(
      resolveThemeTarget({ ...base, preference: "clickupDark", systemScheme: "light" }),
    ).toEqual({ kind: "static", key: "clickupDark" });
  });

  it("keeps the built-in themes and System selectable", () => {
    const base = { pluginThemeId: null, pluginOptions: [], systemScheme: "dark" as const };
    expect(resolveThemeTarget({ ...base, preference: "auto" })).toEqual({ kind: "adaptive" });
    expect(resolveThemeTarget({ ...base, preference: "zinc" })).toEqual({
      kind: "static",
      key: "darkZinc",
    });
    expect(resolveThemeTarget({ ...base, preference: "light" })).toEqual({
      kind: "static",
      key: "light",
    });
  });

  it("writes a plugin theme into the slot for its color scheme", () => {
    const base = {
      preference: "plugin" as const,
      pluginOptions: [atom, paper],
      systemScheme: "dark" as const,
    };
    expect(resolveThemeTarget({ ...base, pluginThemeId: atom.id })).toMatchObject({
      kind: "plugin",
      key: "pluginDark",
    });
    expect(resolveThemeTarget({ ...base, pluginThemeId: paper.id })).toMatchObject({
      kind: "plugin",
      key: "pluginLight",
    });
  });

  it("falls back to the default theme when the selected plugin theme is gone", () => {
    expect(
      resolveThemeTarget({
        preference: "plugin",
        pluginThemeId: "removed",
        pluginOptions: [],
        systemScheme: "light",
      }),
    ).toEqual({ kind: "static", key: "clickupLight" });
  });
});
