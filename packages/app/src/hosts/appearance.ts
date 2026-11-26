import { IDENTITY_COLOR_NAMES, type IdentityColorName } from "@/styles/identity-colors";
import type { HostProfile } from "@/types/host-connection";

export type HostColor = "none" | IdentityColorName;

export const HOST_COLORS: readonly HostColor[] = ["none", ...IDENTITY_COLOR_NAMES];

export const HOST_ICONS = [
  "server",
  "laptop",
  "desktop",
  "mini",
  "workstation",
  "cloud",
  "container",
  "board",
  "terminal",
] as const;

export type HostIcon = (typeof HOST_ICONS)[number];

export const DEFAULT_HOST_ICON: HostIcon = "server";

const HOST_ICON_SET = new Set<string>(HOST_ICONS);

export function normalizeDetectedHostIcon(value: string | null | undefined): HostIcon | null {
  const trimmed = value?.trim();
  if (trimmed && HOST_ICON_SET.has(trimmed)) {
    return trimmed as HostIcon;
  }
  return null;
}

export type HostBadgeDisplay = "name" | "icon" | "hidden";

export const HOST_BADGE_DISPLAYS: readonly HostBadgeDisplay[] = ["name", "icon", "hidden"];

/**
 * Per-device host presentation.
 * - `icon` is omitted while untouched ("Auto") so existing records stay byte-for-byte compatible
 *   with older builds whose stored appearance schema is strict. An unknown icon string written by
 *   a newer build is preserved on disk and falls back at render time via `resolveHostIcon`.
 * - `badgeDisplay` is null while untouched so runtime defaults apply (hidden for local / name for
 *   remote) without baking runtime facts at parse time.
 */
export interface HostAppearance {
  color: HostColor;
  icon?: string;
  badgeDisplay: HostBadgeDisplay | null;
}

export function defaultHostAppearance(): HostAppearance {
  return { color: "none", badgeDisplay: null };
}

function isHostColor(value: unknown): value is HostColor {
  return HOST_COLORS.some((color) => color === value);
}

function isHostBadgeDisplay(value: unknown): value is HostBadgeDisplay {
  return HOST_BADGE_DISPLAYS.some((display) => display === value);
}

export function normalizeStoredHostAppearance(value: unknown): HostAppearance {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultHostAppearance();
  }
  const record = value as Record<string, unknown>;
  // A loose icon string survives read/write so an icon added by a newer build is not dropped;
  // `resolveHostIcon` falls back at render time.
  const icon = typeof record.icon === "string" ? record.icon.trim() : "";
  return {
    color: isHostColor(record.color) ? record.color : "none",
    ...(icon ? { icon } : {}),
    badgeDisplay: isHostBadgeDisplay(record.badgeDisplay) ? record.badgeDisplay : null,
  };
}

export function resolveHostIcon(input: {
  appearance: HostAppearance;
  detectedMachineKind?: string | null;
}): HostIcon {
  return (
    normalizeDetectedHostIcon(input.appearance.icon) ??
    normalizeDetectedHostIcon(input.detectedMachineKind) ??
    DEFAULT_HOST_ICON
  );
}

export function resolveHostBadgeDisplay(input: {
  appearance: HostAppearance;
  isLocalHost: boolean;
  localHostResolutionPending?: boolean;
}): HostBadgeDisplay | null {
  if (input.appearance.badgeDisplay) {
    return input.appearance.badgeDisplay;
  }
  if (input.localHostResolutionPending) {
    return null;
  }
  return input.isLocalHost ? "hidden" : "name";
}

export interface HostBadgeModel {
  serverId: string;
  label: string;
  color: HostColor;
  icon: HostIcon;
  showLabel: boolean;
}

export type HostAppearanceSource = Pick<HostProfile, "serverId" | "label" | "appearance">;

/**
 * The sidebar's whole host-badge decision, resolved once per host list. Rows look their
 * badge up by serverId and render whatever they find; a host that should show no badge is
 * simply absent from the map.
 */
export function selectHostBadges(input: {
  hosts: readonly HostAppearanceSource[];
  localServerId: string | null;
  localHostResolutionPending?: boolean;
  detectedMachineKindByServerId?: ReadonlyMap<string, string | null>;
  enabled: boolean;
}): ReadonlyMap<string, HostBadgeModel> {
  const badges = new Map<string, HostBadgeModel>();
  if (!input.enabled) {
    return badges;
  }
  for (const host of input.hosts) {
    const display = resolveHostBadgeDisplay({
      appearance: host.appearance,
      isLocalHost: host.serverId === input.localServerId,
      localHostResolutionPending: input.localHostResolutionPending,
    });
    if (display === null || display === "hidden") {
      continue;
    }
    badges.set(host.serverId, {
      serverId: host.serverId,
      label: host.label.trim() || host.serverId,
      color: host.appearance.color,
      icon: resolveHostIcon({
        appearance: host.appearance,
        detectedMachineKind: input.detectedMachineKindByServerId?.get(host.serverId) ?? null,
      }),
      showLabel: display === "name",
    });
  }
  return badges;
}
