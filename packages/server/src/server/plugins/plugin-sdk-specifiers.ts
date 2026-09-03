// Specifiers a plugin author can import to reach the SDK. The daemon never resolves these
// from disk: the compiler marks them external and the plugin subprocess hands back its own
// runtime, so a plugin typechecks against generated declarations without installing anything.
//
// COMPAT(plugin-sdk-scope): @jagentdesk/plugin was the SDK name through 0.5.0-beta.1 and was never
// published — that scope is not ours. Plugins scaffolded against that name still import it, so
// both spellings resolve. Remove the @jagentdesk/* entries after 2026-11-19.
export const PLUGIN_CLIENT_ONLY_SDK_SPECIFIERS = [
  "@jagentdesk/plugin/react-native",
  "@jagentdesk/plugin/react-native",
] as const;

export const PLUGIN_SDK_SPECIFIERS = [
  "@jagentdesk/plugin",
  "@jagentdesk/plugin/server",
  "@jagentdesk/plugin",
  "@jagentdesk/plugin/server",
  ...PLUGIN_CLIENT_ONLY_SDK_SPECIFIERS,
] as const;

export function isPluginSdkSpecifier(name: string): boolean {
  return (PLUGIN_SDK_SPECIFIERS as readonly string[]).includes(name);
}

export function isPluginClientOnlySdkSpecifier(name: string): boolean {
  return (PLUGIN_CLIENT_ONLY_SDK_SPECIFIERS as readonly string[]).includes(name);
}
