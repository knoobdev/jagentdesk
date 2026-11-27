// Spec 38 §4.1 (A38.4j) and §4.4c (A38.4n): every settings page has one description line under its
// title. The root Settings page keeps the shared line; every sub-page says what it is for, and a
// plugin page uses the plugin manifest's `description`.
export const SETTINGS_DESCRIPTION = "App, host and plugin settings.";
export const USAGE_DESCRIPTION = "Plan limits and token use for each provider.";

// "This device" sections: stored on this device only.
const SECTION_DESCRIPTIONS: Record<string, string> = {
  general: "App behaviour on this device.",
  hosts: "Hosts this device connects to.",
  appearance: "Theme, text size and layout.",
  sidebar: "What the sidebar shows and in which order.",
  chat: "Sending, files, terminals, the browser and Bots on this device.",
  shortcuts: "Keyboard shortcuts in this app.",
  notifications: "Which alerts this device gets, and notification and microphone access.",
  diagnostics: "Logs and checks for troubleshooting.",
};

// Host sections: the daemon's own settings, shared by every device that reaches it.
const HOST_SECTION_DESCRIPTIONS: Record<string, string> = {
  providers: "Agent CLIs on this host: install, turn on and pick their models.",
  "agent-profiles": "Saved model, mode and option presets for new agents.",
  tools: "Instructions and tools agents get, and the command-line tools this host can run.",
  agents: "Defaults for new agents on this host.",
  orchestration: "How agents hand work to other agents.",
  projects: "Projects this host knows about.",
  workspaces: "Where new workspaces and worktrees are created.",
  voice: "Dictation and voice mode.",
  usage: USAGE_DESCRIPTION,
  terminals: "Shells and terminal behaviour on this host.",
  plugins: "Turn built-in features on or off for this host.",
  "pair-device": "Add a phone or computer to this host.",
  daemon: "This host's daemon: status, updates, agent runtime and restart.",
};

/** This device's page for one saved host. */
export const CLIENT_HOST_DESCRIPTION = "How your devices reach this host.";

export const PROJECT_DESCRIPTION = "Scripts and setup for this project.";
export const PLUGIN_FALLBACK_DESCRIPTION = "Settings for this plugin.";

export type SettingsDescriptionView =
  | { kind: "root" }
  | { kind: "section"; section: string }
  | { kind: "clientHost" }
  | { kind: "host"; section: string }
  | { kind: "project" }
  | { kind: "plugin" };

/** The description line under a settings page's title. */
export function settingsPageDescription(
  view: SettingsDescriptionView,
  pluginDescription?: string | null,
): string {
  switch (view.kind) {
    case "section":
      return SECTION_DESCRIPTIONS[view.section] ?? SETTINGS_DESCRIPTION;
    case "clientHost":
      return CLIENT_HOST_DESCRIPTION;
    case "host":
      return HOST_SECTION_DESCRIPTIONS[view.section] ?? SETTINGS_DESCRIPTION;
    case "project":
      return PROJECT_DESCRIPTION;
    case "plugin":
      return pluginDescription?.trim() || PLUGIN_FALLBACK_DESCRIPTION;
    case "root":
      return SETTINGS_DESCRIPTION;
  }
}
