// ADR-0038 — the desktop file picker is the real Figma Files site in a sandboxed guest window.
// A normal Figma website session selects the file; only its navigation URL crosses the boundary.
// The host reads no cookies, no DOM content, no internal APIs, and injects no script, so the
// URL policy below is the only trust gate between the website and JAgentDesk.

export const FIGMA_PICKER_URL = "https://www.figma.com/files";
export const FIGMA_PICKER_PARTITION = "persist:jagentdesk-figma-picker";

/** The guest (and its popups) may navigate over HTTPS only — sign-in redirects included. */
export function isFigmaPickerNavigation(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

// The accepted selection is an exact selected-Figma-host file URL: HTTPS, no credentials, no
// port, and a design/file/proto path with a canonical file key. The key and node-id shapes
// match the paste flow's parser (packages/app/src/figma/url-parse.ts) — keep the two in sync;
// a URL the picker returns must parse there.
const SELECTABLE_HOSTS = new Set(["figma.com", "www.figma.com"]);
const FILE_KINDS = new Set(["design", "file", "proto"]);
const FILE_KEY = /^[A-Za-z0-9]{10,}$/;
const NODE_ID = /^[A-Za-z0-9:._-]{1,128}$/;

export function selectedFigmaFileUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password || url.port) return null;
  if (!SELECTABLE_HOSTS.has(url.hostname)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (!FILE_KINDS.has(parts[0] ?? "") || !FILE_KEY.test(parts[1] ?? "")) return null;
  // Drop session/tracking query parameters; preserve only the selected node.
  const selected = new URL(`https://www.figma.com/${parts[0]}/${parts[1]}`);
  const node = url.searchParams.get("node-id");
  if (node && NODE_ID.test(node)) selected.searchParams.set("node-id", node);
  return selected.href;
}
