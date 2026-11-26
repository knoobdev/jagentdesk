import { describe, expect, it } from "vitest";
import {
  SETTINGS_DESCRIPTION,
  USAGE_DESCRIPTION,
  settingsPageDescription,
} from "./page-description";

describe("settingsPageDescription", () => {
  it("gives the host Usage page its own line", () => {
    expect(settingsPageDescription({ kind: "host", section: "usage" })).toBe(USAGE_DESCRIPTION);
    expect(USAGE_DESCRIPTION).toBe("Plan limits and token use for each provider.");
  });

  it("gives every other settings page the Settings line", () => {
    for (const view of [
      { kind: "root" },
      { kind: "section", section: "general" },
      { kind: "section", section: "usage" },
      { kind: "host", section: "providers" },
      { kind: "project" },
      { kind: "plugin" },
    ]) {
      expect(settingsPageDescription(view)).toBe(SETTINGS_DESCRIPTION);
    }
    expect(SETTINGS_DESCRIPTION).toBe("App, host and plugin settings.");
  });
});
