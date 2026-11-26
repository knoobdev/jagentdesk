// Spec 38 §4.1 (A38.4j): every Gumloop page has one description line under its title. Usage has
// its own; the other settings pages share the Settings one.
export const SETTINGS_DESCRIPTION = "App, host and plugin settings.";
export const USAGE_DESCRIPTION = "Plan limits and token use for each provider.";

/** The description line under a settings page's title. */
export function settingsPageDescription(view: { kind: string; section?: string }): string {
  return view.kind === "host" && view.section === "usage"
    ? USAGE_DESCRIPTION
    : SETTINGS_DESCRIPTION;
}
