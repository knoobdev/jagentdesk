import http from "node:http";
import { ipcMain, shell } from "electron";

// Argo CD SSO on the desktop (spec 30.2.1 step 2, ADR-0034 §3): a temporary loopback listener on
// 127.0.0.1:8085 receives `code` + `state` at /auth/callback — the redirect URI the Argo CD CLI
// client is registered with — and hands them to the renderer, which relays them to the daemon.
// The PKCE verifier never leaves the daemon, so the code alone is useless to anyone else.

export const SSO_LOOPBACK_HOST = "127.0.0.1";
export const SSO_LOOPBACK_PORT = 8085;
export const SSO_CALLBACK_PATH = "/auth/callback";
export const SSO_DEFAULT_TIMEOUT_MS = 5 * 60_000;

export type SsoLoopbackResult =
  | { ok: true; code: string; state: string }
  | {
      ok: false;
      errorCode: "sso_port_in_use" | "sso_timeout" | "sso_idp_error" | "sso_state_mismatch";
      message: string;
      error?: string;
      errorDescription?: string;
    };

export interface SsoLoopbackInput {
  authUrl: string;
  state: string;
  timeoutMs: number;
  port?: number;
  openExternal: (url: string) => Promise<void>;
}

const PAGE_STYLE =
  "font-family:-apple-system,system-ui,sans-serif;background:#0b0b0c;color:#e6e6e6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0";

function page(title: string, detail: string): string {
  const escape = (text: string) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title></head><body style="${PAGE_STYLE}"><div><h2>${escape(title)}</h2><p>${escape(detail)}</p></div></body></html>`;
}

export function runSsoLoopback(input: SsoLoopbackInput): Promise<SsoLoopbackResult> {
  const port = input.port ?? SSO_LOOPBACK_PORT;
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (url.pathname !== SSO_CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");
      let result: SsoLoopbackResult;
      if (state !== input.state) {
        result = {
          ok: false,
          errorCode: "sso_state_mismatch",
          message: "The sign-in response does not match this request. Start SSO again.",
        };
      } else if (error || !code) {
        result = {
          ok: false,
          errorCode: "sso_idp_error",
          message: errorDescription ?? error ?? "The identity provider returned no code.",
          ...(error ? { error } : {}),
          ...(errorDescription ? { errorDescription } : {}),
        };
      } else {
        result = { ok: true, code, state };
      }
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        result.ok
          ? page("Signed in to Argo CD", "You can close this tab and return to JAgentDesk.")
          : page("Argo CD sign-in failed", result.message),
      );
      finish(result);
    });

    function finish(result: SsoLoopbackResult): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      // oxlint-disable-next-line promise/no-multiple-resolved -- `settled` makes this run once.
      resolve(result);
    }

    server.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        errorCode: error.code === "EADDRINUSE" ? "sso_port_in_use" : "sso_idp_error",
        message:
          error.code === "EADDRINUSE"
            ? `Port ${port} is in use, usually by a running \`argocd login --sso\`. Close that process (for example \`lsof -i :${port}\` to find it) and try again.`
            : error.message,
      });
    });

    server.listen(port, SSO_LOOPBACK_HOST, () => {
      timer = setTimeout(
        () =>
          finish({
            ok: false,
            errorCode: "sso_timeout",
            message: "No sign-in arrived within 5 minutes. Start SSO again.",
          }),
        input.timeoutMs,
      );
      input.openExternal(input.authUrl).catch((error: unknown) =>
        finish({
          ok: false,
          errorCode: "sso_idp_error",
          message: `Could not open the browser: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
    });
  });
}

function parseInput(raw: unknown): { authUrl: string; state: string; timeoutMs: number } {
  const value = (raw ?? {}) as { authUrl?: unknown; state?: unknown; timeoutMs?: unknown };
  if (typeof value.authUrl !== "string" || !/^https?:\/\//.test(value.authUrl)) {
    throw new Error("authUrl must be an http(s) URL");
  }
  if (typeof value.state !== "string" || value.state.length === 0) {
    throw new Error("state is required");
  }
  const timeoutMs =
    typeof value.timeoutMs === "number" && value.timeoutMs > 0
      ? Math.min(value.timeoutMs, SSO_DEFAULT_TIMEOUT_MS)
      : SSO_DEFAULT_TIMEOUT_MS;
  return { authUrl: value.authUrl, state: value.state, timeoutMs };
}

export function registerArgoCdSsoHandlers(): void {
  ipcMain.handle("jagentdesk:argocd:sso-loopback", (_event, raw: unknown) => {
    const input = parseInput(raw);
    return runSsoLoopback({ ...input, openExternal: (url) => shell.openExternal(url) });
  });
}
