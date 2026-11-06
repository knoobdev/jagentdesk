import { getIsElectron } from "@/constants/platform";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { parseFigmaCallbackUrl } from "@/figma/url-parse";

// Desktop runs the browser step itself: the daemon composes the authorize URL, Electron serves
// the loopback callback on 127.0.0.1 and opens the system browser (spec 32.2). Everywhere else
// the user pastes back the URL the browser landed on.

export const FIGMA_APPS_URL = "https://www.figma.com/developers/apps";
export const FIGMA_CALLBACK_URL = "http://127.0.0.1:8766/figma/callback";
// Spec 32.2 — the scopes the private OAuth app must enable, listed verbatim in the connect guide.
export const FIGMA_OAUTH_SCOPES = [
  "current_user:read",
  "file_content:read",
  "file_metadata:read",
  "file_versions:read",
  "file_comments:read",
  "file_comments:write",
  "library_content:read",
  "file_dev_resources:read",
  "projects:read",
];

export function canUseLoopback(): boolean {
  return getIsElectron();
}

export type FigmaLoopbackResult =
  | { kind: "code"; code: string; state: string }
  | { kind: "error"; message: string };

export function beginFigmaOAuthLoopback(input: {
  authorizeUrl: string;
  redirectUri: string;
  timeoutMs?: number;
}): Promise<FigmaLoopbackResult> {
  return invokeDesktopCommand<FigmaLoopbackResult>("figma_oauth_loopback", input);
}

export type FigmaOAuthOutcome = { kind: "connected" } | { kind: "error"; message: string };

export type FigmaCompleteCall = (params: {
  attemptId: string;
  code?: string;
  state?: string;
  pastedUrl?: string;
}) => Promise<{ connection: unknown | null }>;

function fromComplete(response: { connection: unknown | null }): FigmaOAuthOutcome {
  return response.connection
    ? { kind: "connected" }
    : { kind: "error", message: "Figma rejected the sign-in." };
}

// The desktop loopback path: Electron serves the callback, opens the browser, and resolves with
// the code; the attempt is then completed against the daemon.
export async function finishWithLoopback(
  complete: FigmaCompleteCall,
  begin: { attemptId: string; authorizeUrl: string; redirectUri: string },
): Promise<FigmaOAuthOutcome> {
  const loopback = await beginFigmaOAuthLoopback({
    authorizeUrl: begin.authorizeUrl,
    redirectUri: begin.redirectUri,
  });
  if (loopback.kind === "error") return { kind: "error", message: loopback.message };
  return fromComplete(
    await complete({ attemptId: begin.attemptId, code: loopback.code, state: loopback.state }),
  );
}

// The paste path: the user copies the URL the browser landed on; code + state come from it.
export async function completeFigmaOAuthPasted(
  complete: FigmaCompleteCall,
  attemptId: string,
  callbackUrl: string,
): Promise<FigmaOAuthOutcome> {
  const parsed = parseFigmaCallbackUrl(callbackUrl);
  if (parsed.kind === "error") return { kind: "error", message: parsed.message };
  return fromComplete(await complete({ attemptId, code: parsed.code, state: parsed.state }));
}
