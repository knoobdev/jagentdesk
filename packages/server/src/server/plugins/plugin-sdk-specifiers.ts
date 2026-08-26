// Specifiers a plugin author can import to reach the SDK. The daemon never resolves these
// from disk: the compiler marks them external and the plugin subprocess hands back its own
// runtime, so a plugin typechecks against generated declarations without installing anything.
export const PLUGIN_SDK_SPECIFIERS = ["@jagentdesk/plugin", "@jagentdesk/plugin/server"] as const;

export function isPluginSdkSpecifier(name: string): boolean {
  return (PLUGIN_SDK_SPECIFIERS as readonly string[]).includes(name);
}
