import { describe, expect, it } from "vitest";
import {
  PLUGIN_FALLBACK_DESCRIPTION,
  PROJECT_DESCRIPTION,
  SETTINGS_DESCRIPTION,
  USAGE_DESCRIPTION,
  settingsPageDescription,
} from "./page-description";

const SECTIONS = [
  "sidebar",
  "general",
  "appearance",
  "editor",
  "shortcuts",
  "integrations",
  "permissions",
  "diagnostics",
];
const HOST_SECTIONS = [
  "host",
  "projects",
  "connections",
  "pair-device",
  "agents",
  "orchestration",
  "voice",
  "workspaces",
  "providers",
  "usage",
  "terminals",
  "plugins",
  "tools",
];

describe("settingsPageDescription", () => {
  it("keeps the shared line for the root Settings page only", () => {
    expect(settingsPageDescription({ kind: "root" })).toBe(SETTINGS_DESCRIPTION);
    expect(SETTINGS_DESCRIPTION).toBe("App, host and plugin settings.");
  });

  it("uses the spec 38 §4.4c lines for the named pages", () => {
    expect(settingsPageDescription({ kind: "host", section: "providers" })).toBe(
      "Agent CLIs on this host: install, turn on and pick their models.",
    );
    expect(settingsPageDescription({ kind: "host", section: "connections" })).toBe(
      "How your devices reach this host.",
    );
    expect(settingsPageDescription({ kind: "host", section: "pair-device" })).toBe(
      "Add a phone or computer to this host.",
    );
    expect(settingsPageDescription({ kind: "host", section: "plugins" })).toBe(
      "Turn built-in features on or off for this host.",
    );
    expect(settingsPageDescription({ kind: "section", section: "general" })).toBe(
      "App behaviour on this device.",
    );
    expect(settingsPageDescription({ kind: "host", section: "usage" })).toBe(USAGE_DESCRIPTION);
  });

  it("gives every sub-page a line of its own", () => {
    const lines = [
      ...SECTIONS.map((section) => settingsPageDescription({ kind: "section", section })),
      ...HOST_SECTIONS.map((section) => settingsPageDescription({ kind: "host", section })),
      settingsPageDescription({ kind: "project" }),
    ];
    for (const line of lines) expect(line).not.toBe(SETTINGS_DESCRIPTION);
    expect(new Set(lines).size).toBe(lines.length);
    expect(settingsPageDescription({ kind: "project" })).toBe(PROJECT_DESCRIPTION);
  });

  it("uses the plugin manifest description on a plugin page", () => {
    expect(settingsPageDescription({ kind: "plugin" }, "Containers, images and volumes.")).toBe(
      "Containers, images and volumes.",
    );
    expect(settingsPageDescription({ kind: "plugin" }, null)).toBe(PLUGIN_FALLBACK_DESCRIPTION);
  });
});
