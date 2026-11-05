// Figma URL parsing (spec 32.3): the file list is JAgentDesk's own, so every entry comes from a
// URL the user pastes — `figma.com/design/<key>/…`, `…/file/…`, `…/proto/…` — or a bare key. Teams
// have no list API, so the team URL (`figma.com/files/team/<id>/…`) is the only way in. The OAuth
// sign-in always keeps a paste path (32.2): the user pastes the final URL the browser landed on.

const FILE_KEY = /^[A-Za-z0-9]{10,}$/;
const TEAM_ID = /^[0-9]+$/;

function firstParam(params: URLSearchParams, key: string): string | null {
  const value = params.get(key);
  return value && value.length > 0 ? value : null;
}

function figmaHost(url: URL): boolean {
  return url.hostname === "figma.com" || url.hostname === "www.figma.com";
}

export interface ParsedFigmaFileUrl {
  fileKey: string;
  /** `node-id` decoded to the API form (`1-23` → `1:23`), when the URL carries one. */
  nodeId: string | null;
}

/** The file a design/file/proto URL points at, or a bare file key. Null when it is neither. */
export function parseFigmaFileUrl(input: string): ParsedFigmaFileUrl | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (FILE_KEY.test(trimmed)) return { fileKey: trimmed, nodeId: null };
  let url: URL;
  try {
    url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (!figmaHost(url)) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const kind = segments[0];
  if (kind !== "design" && kind !== "file" && kind !== "proto") return null;
  const fileKey = segments[1] ?? "";
  if (!FILE_KEY.test(fileKey)) return null;
  const nodeId = firstParam(url.searchParams, "node-id");
  return { fileKey, nodeId: nodeId ? nodeId.replace(/-/g, ":") : null };
}

/** The team id from a `figma.com/files/team/<id>` URL, or a bare team id. */
export function parseFigmaTeamUrl(input: string): { teamId: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (TEAM_ID.test(trimmed)) return { teamId: trimmed };
  let url: URL;
  try {
    url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (!figmaHost(url)) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const teamIndex = segments.indexOf("team");
  if (teamIndex < 0) return null;
  const teamId = segments[teamIndex + 1] ?? "";
  if (!TEAM_ID.test(teamId)) return null;
  return { teamId };
}

export type ParsedFigmaCallback =
  | { kind: "code"; code: string; state: string }
  | { kind: "error"; message: string };

/** The final URL the browser landed on after Figma's sign-in page (32.2 paste path). */
export function parseFigmaCallbackUrl(input: string): ParsedFigmaCallback {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "error", message: "Paste the URL the browser landed on." };
  let url: URL;
  try {
    url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
  } catch {
    return { kind: "error", message: "That is not a URL. Paste the full address." };
  }
  const error = firstParam(url.searchParams, "error");
  if (error) {
    return {
      kind: "error",
      message: firstParam(url.searchParams, "error_description") ?? `Figma said: ${error}`,
    };
  }
  const code = firstParam(url.searchParams, "code");
  const state = firstParam(url.searchParams, "state");
  if (!code || !state) return { kind: "error", message: "The URL carries no code or state." };
  return { kind: "code", code, state };
}
