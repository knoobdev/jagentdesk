import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@jagentdesk/protocol/messages";
import type { BrowserFingerprintProfile } from "@jagentdesk/protocol/browser-automation/fingerprint-profile";

/**
 * Pure helpers for the agentic browser's fingerprint profiles, which live in the
 * daemon config under `browserTools.{profiles, activeProfileId}` and are managed
 * through the existing daemon-config get/patch flow (deepMerge replaces the whole
 * `profiles` array, so a patch always sends the full list). The active profile is
 * resolved here and pushed to the desktop main process to apply. See
 * docs/plans/active/agentic-browser-custom-and-anti-detect.md.
 */

export function listFingerprintProfiles(
  config: MutableDaemonConfig | null,
): BrowserFingerprintProfile[] {
  return config?.browserTools.profiles ?? [];
}

export function activeFingerprintProfileId(config: MutableDaemonConfig | null): string | null {
  return config?.browserTools.activeProfileId ?? null;
}

export function resolveActiveFingerprintProfile(
  config: MutableDaemonConfig | null,
): BrowserFingerprintProfile | null {
  const id = activeFingerprintProfileId(config);
  if (!id) {
    return null;
  }
  return listFingerprintProfiles(config).find((profile) => profile.id === id) ?? null;
}

/** Patch that adds or replaces a profile by id (keeps the rest of the list). */
export function upsertProfilePatch(
  existing: BrowserFingerprintProfile[],
  profile: BrowserFingerprintProfile,
): MutableDaemonConfigPatch {
  const others = existing.filter((candidate) => candidate.id !== profile.id);
  return { browserTools: { profiles: [...others, profile] } };
}

/** Patch that removes a profile; clears the active id if it was the one removed. */
export function deleteProfilePatch(
  existing: BrowserFingerprintProfile[],
  id: string,
  activeId: string | null,
): MutableDaemonConfigPatch {
  return {
    browserTools: {
      profiles: existing.filter((candidate) => candidate.id !== id),
      activeProfileId: activeId === id ? null : activeId,
    },
  };
}

/** Patch that sets (or clears with `null`) the active profile. */
export function selectProfilePatch(id: string | null): MutableDaemonConfigPatch {
  return { browserTools: { activeProfileId: id } };
}

/** A collision-resistant profile id. Client-side (not a workflow), so RNG is fine. */
export function newFingerprintProfileId(): string {
  return `bfp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
