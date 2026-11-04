import http from "node:http";
import { shell } from "electron";

// Jira OAuth 2.0 (3LO) browser step on the desktop (spec 29.1.1 step 2, ADR-0034 §3): listen on the
// loopback callback the user registered (http://127.0.0.1:8765/jira/callback), open the system
// browser on the authorize URL, hand `code` + `state` back to the renderer, and close. The code is
// useless without the client secret, which only the daemon holds; the renderer forwards it there.

export const JIRA_LOOPBACK_TIMEOUT_MS = 5 * 60_000;

export type JiraLoopbackResult =
  | { kind: "code"; code: string; state: string }
  | { kind: "error"; message: string };

interface LoopbackArgs {
  authorizeUrl: string;
  redirectUri: string;
  timeoutMs?: number;
}

function parseArgs(args: Record<string, unknown> | undefined): LoopbackArgs {
  const authorizeUrl = typeof args?.authorizeUrl === "string" ? args.authorizeUrl : "";
  const redirectUri = typeof args?.redirectUri === "string" ? args.redirectUri : "";
  const timeoutMs = typeof args?.timeoutMs === "number" ? args.timeoutMs : undefined;
  return { authorizeUrl, redirectUri, timeoutMs };
}

const PAGE = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>JAgentDesk</title><body style="font-family:system-ui;padding:32px"><h3>${message}</h3><p>You can close this window and return to JAgentDesk.</p></body>`;

export function runJiraOAuthLoopback(input: LoopbackArgs): Promise<JiraLoopbackResult> {
  let redirect: URL;
  let authorize: URL;
  try {
    redirect = new URL(input.redirectUri);
    authorize = new URL(input.authorizeUrl);
  } catch {
    return Promise.resolve({ kind: "error", message: "Invalid sign-in URL." });
  }
  const loopbackHost = redirect.hostname === "127.0.0.1" || redirect.hostname === "localhost";
  if (redirect.protocol !== "http:" || !loopbackHost) {
    return Promise.resolve({
      kind: "error",
      message: "The callback URL is not a local address; paste the URL instead.",
    });
  }
  return new Promise((resolve) => {
    // The first outcome wins; later callbacks (timeout after success, a second request) are ignored.
    let pending: ((result: JiraLoopbackResult) => void) | null = resolve;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", redirect.origin);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (error || !code || !state) {
        res
          .writeHead(400, { "Content-Type": "text/html" })
          .end(PAGE("Jira sign-in was not completed."));
        finish({
          kind: "error",
          message: url.searchParams.get("error_description") ?? error ?? "No code returned.",
        });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" }).end(PAGE("Signed in to Jira."));
      finish({ kind: "code", code, state });
    });
    const timer = setTimeout(
      () => finish({ kind: "error", message: "Timed out waiting for the browser." }),
      input.timeoutMs ?? JIRA_LOOPBACK_TIMEOUT_MS,
    );
    function finish(result: JiraLoopbackResult): void {
      const deliver = pending;
      if (!deliver) return;
      pending = null;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      deliver(result);
    }
    server.on("error", (error: NodeJS.ErrnoException) => {
      const message =
        error.code === "EADDRINUSE"
          ? `Port ${redirect.port} is in use. Close the other sign-in or paste the URL instead.`
          : error.message;
      finish({ kind: "error", message });
    });
    server.listen(Number(redirect.port || 80), redirect.hostname, () => {
      void shell.openExternal(authorize.toString()).catch((error: unknown) => {
        finish({ kind: "error", message: `Could not open the browser: ${String(error)}` });
      });
    });
  });
}

export function createJiraCommandHandlers(): Record<
  string,
  (args?: Record<string, unknown>) => Promise<unknown>
> {
  return {
    jira_oauth_loopback: (args) => runJiraOAuthLoopback(parseArgs(args)),
  };
}
