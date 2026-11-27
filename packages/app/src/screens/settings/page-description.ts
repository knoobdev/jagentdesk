// Spec 38 §4.1 (A38.4j) and §4.4c (A38.4n): every settings page has one description line under its
// title. The root Settings page keeps the shared line; every sub-page says what it is for, and a
// plugin page uses the plugin manifest's `description`.
export const SETTINGS_DESCRIPTION = "App, host and plugin settings.";
export const USAGE_DESCRIPTION = "Plan limits and token use for each provider.";

const SECTION_DESCRIPTIONS: Record<string, string> = {
  sidebar: "What the sidebar shows and in which order.",
  general: "App behaviour on this device.",
  appearance: "Theme, text size and layout.",
  editor: "How files open and edit.",
  shortcuts: "Keyboard shortcuts in this app.",
  integrations: "The command-line tool and agent skills on this computer.",
  permissions: "Notifications and microphone access for this app.",
  diagnostics: "Logs and checks for troubleshooting.",
};

const HOST_SECTION_DESCRIPTIONS: Record<string, string> = {
  host: "This host's name, connection and daemon.",
  projects: "Projects this host knows about.",
  connections: "How your devices reach this host.",
  "pair-device": "Add a phone or computer to this host.",
  agents: "Defaults for new agents on this host.",
  "agent-profiles": "Saved model, mode and option presets for new agents.",
  orchestration: "How agents hand work to other agents.",
  voice: "Dictation and voice mode.",
  workspaces: "Where new workspaces and worktrees are created.",
  providers: "Agent CLIs on this host: install, turn on and pick their models.",
  usage: USAGE_DESCRIPTION,
  terminals: "Shells and terminal behaviour on this host.",
  plugins: "Turn built-in features on or off for this host.",
  tools: "Command-line tools this host can run, and installing missing ones.",
};

export const PROJECT_DESCRIPTION = "Scripts and setup for this project.";
export const PLUGIN_FALLBACK_DESCRIPTION = "Settings for this plugin.";

export type SettingsDescriptionView =
  | { kind: "root" }
  | { kind: "section"; section: string }
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
