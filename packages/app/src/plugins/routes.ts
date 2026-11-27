import type { PluginScreenParams } from "@jagentdesk/plugin/client";
import type { PluginSurfaceContributionIdentity } from "./surface-contribution";

type PluginSurfaceRoute<Kind extends PluginSurfaceContributionIdentity["kind"]> =
  `/h/${string}/plugin/${string}/${Kind}/${string}`;

export function buildPluginSurfaceRoute<Identity extends PluginSurfaceContributionIdentity>(
  serverId: string,
  pluginId: string,
  identity: Identity,
): PluginSurfaceRoute<Identity["kind"]> {
  return `/h/${encodeURIComponent(serverId)}/plugin/${encodeURIComponent(pluginId)}/${identity.kind}/${encodeURIComponent(identity.id)}` as PluginSurfaceRoute<
    Identity["kind"]
  >;
}

/** A plugin screen route; params ride in the query as `pluginParam.<key>`. */
export function buildPluginScreenRoute(
  serverId: string,
  pluginId: string,
  screenId: string,
  params: PluginScreenParams = {},
): string {
  const query = new URLSearchParams(
    Object.entries(params).map(([key, value]) => [`pluginParam.${key}`, value]),
  );
  const path = buildPluginSurfaceRoute(serverId, pluginId, { kind: "surface", id: screenId });
  return query.size ? `${path}?${query}` : path;
}

/** Checks screen params from outside the app (a notification payload): an object of strings. */
export function parsePluginScreenParams(value: unknown): PluginScreenParams {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Plugin screen params must be an object of strings");
  }
  const params: PluginScreenParams = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`Plugin screen param ${key} must be a string`);
    }
    params[key] = entry;
  }
  return params;
}

export function buildLegacyPluginSurfaceRedirectRoute(
  serverId: string,
  pluginId: string,
  sidebarContributionId: string,
): `/h/${string}/plugin/${string}/sidebar/${string}` {
  return buildPluginSurfaceRoute(serverId, pluginId, {
    kind: "sidebar",
    id: sidebarContributionId,
  });
}

export function hostIdFromPathname(pathname: string): string | null {
  const encoded = /^\/h\/([^/]+)/.exec(pathname)?.[1];
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}
