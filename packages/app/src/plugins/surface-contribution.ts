import type { InstalledPlugin } from "./types";

export type PluginSurfaceContributionIdentity =
  | { kind: "sidebar"; id: string }
  | { kind: "surface"; id: string }
  | { kind: "settings"; id: string };

export function resolvePluginSurfaceContribution(
  plugin: InstalledPlugin | null,
  identity: PluginSurfaceContributionIdentity | null,
): {
  sidebarItem: InstalledPlugin["sidebarItems"][number] | null;
  surface: InstalledPlugin["surfaces"][number] | null;
  settingsScreen: InstalledPlugin["settingsScreens"][number] | null;
} {
  if (!identity) return { sidebarItem: null, surface: null, settingsScreen: null };
  if (identity.kind === "settings") {
    const settingsScreen =
      plugin?.settingsScreens.find((contribution) => contribution.id === identity.id) ?? null;
    return { sidebarItem: null, surface: null, settingsScreen };
  }
  const sidebarItem =
    identity.kind === "sidebar"
      ? (plugin?.sidebarItems.find((contribution) => contribution.id === identity.id) ?? null)
      : null;
  const surfaceId = identity.kind === "sidebar" ? sidebarItem?.surface : identity.id;
  const surface = surfaceId
    ? (plugin?.surfaces.find((contribution) => contribution.id === surfaceId) ?? null)
    : null;
  return { sidebarItem, surface, settingsScreen: null };
}

export function getPluginSurfaceContributionServerIds(
  installations: readonly InstalledPlugin[],
  pluginId: string,
  identity: PluginSurfaceContributionIdentity,
): string[] {
  return installations
    .filter((installation) => {
      if (installation.id !== pluginId) return false;
      if (identity.kind === "sidebar") {
        return installation.sidebarItems.some((contribution) => contribution.id === identity.id);
      }
      if (identity.kind === "settings") {
        return installation.settingsScreens.some((contribution) => contribution.id === identity.id);
      }
      return installation.surfaces.some((contribution) => contribution.id === identity.id);
    })
    .map((installation) => installation.serverId);
}
