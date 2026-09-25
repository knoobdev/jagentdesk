// These entries are supplied by the host and remain external in author bundles.
export const PLUGIN_CLIENT_ONLY_SDK_SPECIFIERS = [
  "@jagentdesk/plugin/client",
  "@jagentdesk/plugin/client/ui",
  "@jagentdesk/plugin/client/react-native",
] as const;

const PLUGIN_SERVER_ONLY_SDK_SPECIFIERS = [
  "@jagentdesk/plugin/server",
  "@jagentdesk/plugin/server/provider",
  "@jagentdesk/plugin/server/acp",
] as const;

export const PLUGIN_SDK_SPECIFIERS = [
  "@jagentdesk/plugin",
  ...PLUGIN_SERVER_ONLY_SDK_SPECIFIERS,
  ...PLUGIN_CLIENT_ONLY_SDK_SPECIFIERS,
] as const;

export function isPluginClientOnlySdkSpecifier(name: string): boolean {
  return (PLUGIN_CLIENT_ONLY_SDK_SPECIFIERS as readonly string[]).includes(name);
}

export function isPluginServerOnlySdkSpecifier(name: string): boolean {
  return (PLUGIN_SERVER_ONLY_SDK_SPECIFIERS as readonly string[]).includes(name);
}
