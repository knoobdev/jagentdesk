// Add Apple ID (26.3, 26.4): Apple ID + password + keep signed in up front, anisette under a
// collapsed Advanced section. Pure logic so the sheet stays layout only.

export type AnisetteChoice = "native" | "remote";

export interface AnisetteFormState {
  source: AnisetteChoice;
  url: string;
  /** The user changed the source or URL in Advanced. */
  touched: boolean;
}

export interface AnisetteRequestFields {
  anisetteSource?: AnisetteChoice;
  anisetteUrl?: string;
}

/**
 * Untouched Advanced sends nothing, so the daemon keeps the account's source when signing
 * in again and otherwise applies the host default (native on macOS and Windows, remote on
 * Linux). A choice the user made is sent as is.
 */
export function anisetteRequestFields(state: AnisetteFormState): AnisetteRequestFields {
  if (!state.touched) return {};
  return state.source === "remote"
    ? { anisetteSource: "remote", anisetteUrl: state.url.trim() }
    : { anisetteSource: "native" };
}

/** Advanced starts open when the account already uses a remote server. */
export function advancedOpenInitially(source: AnisetteChoice): boolean {
  return source === "remote";
}

/**
 * After a failed sign-in: anisette failures open Advanced; a host without native anisette
 * (Linux answers anisette_url_required) also switches the choice to Remote server.
 */
export function advancedAfterFailure(
  code: string | null,
): { open: true; source: AnisetteChoice | null } | null {
  if (code === "anisette_url_required") return { open: true, source: "remote" };
  if (code === "anisette_failed") return { open: true, source: null };
  return null;
}

export function canSubmitAppleId(input: {
  appleId: string;
  password: string;
  anisette: AnisetteFormState;
}): boolean {
  if (!input.appleId.trim() || input.password.length === 0) return false;
  return !(input.anisette.source === "remote" && !input.anisette.url.trim());
}

export const PASSWORD_HELP =
  "Apple requires your Apple ID password to sign apps, just like Sideloadly. It goes only to this host and to Apple.";
