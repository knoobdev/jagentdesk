import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFigmaCommandHandlers,
  FIGMA_LOOPBACK_CALLBACK_PATH,
  FIGMA_LOOPBACK_PORT,
  runFigmaOAuthLoopback,
} from "./figma-oauth-loopback";

// Spec 32.2: the desktop serves the registered callback http://127.0.0.1:8766/figma/callback
// and hands code + state back for the daemon's figma.oauth.complete. The state check itself is
// the daemon's (it owns the attempt), so the loopback only forwards what the browser brings.

const AUTH_URL = "https://www.figma.com/oauth?client_id=x&state=st_1";

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

function redirectUri(port: number): string {
  return `http://127.0.0.1:${port}${FIGMA_LOOPBACK_CALLBACK_PATH}`;
}

const blockers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    blockers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("runFigmaOAuthLoopback", () => {
  it("serves the registered callback URL on port 8766", () => {
    expect(FIGMA_LOOPBACK_PORT).toBe(8766);
    expect(FIGMA_LOOPBACK_CALLBACK_PATH).toBe("/figma/callback");
    expect(`http://127.0.0.1:${FIGMA_LOOPBACK_PORT}${FIGMA_LOOPBACK_CALLBACK_PATH}`).toBe(
      "http://127.0.0.1:8766/figma/callback",
    );
  });

  it("opens the system browser on the authorize URL and returns code + state", async () => {
    const port = await freePort();
    const opened: string[] = [];
    const pending = runFigmaOAuthLoopback({
      authorizeUrl: AUTH_URL,
      redirectUri: redirectUri(port),
      timeoutMs: 5_000,
      openExternal: async (url) => {
        opened.push(url);
        const response = await fetch(`${redirectUri(port)}?code=code_1&state=state_1`);
        expect(response.status).toBe(200);
      },
    });

    expect(await pending).toEqual({ kind: "code", code: "code_1", state: "state_1" });
    expect(opened).toEqual([AUTH_URL]);
  });

  it("relays the browser error callback", async () => {
    const port = await freePort();
    const result = await runFigmaOAuthLoopback({
      authorizeUrl: AUTH_URL,
      redirectUri: redirectUri(port),
      timeoutMs: 5_000,
      openExternal: async () => {
        await fetch(`${redirectUri(port)}?error=access_denied&error_description=User%20refused`);
      },
    });

    expect(result).toEqual({ kind: "error", message: "User refused" });
  });

  it("rejects a callback with no code", async () => {
    const port = await freePort();
    const result = await runFigmaOAuthLoopback({
      authorizeUrl: AUTH_URL,
      redirectUri: redirectUri(port),
      timeoutMs: 5_000,
      openExternal: async () => {
        await fetch(`${redirectUri(port)}?state=state_1`);
      },
    });

    expect(result).toEqual({ kind: "error", message: "No code returned." });
  });

  it("answers 404 on a path other than the callback without ending the run", async () => {
    const port = await freePort();
    const pending = runFigmaOAuthLoopback({
      authorizeUrl: AUTH_URL,
      redirectUri: redirectUri(port),
      timeoutMs: 5_000,
      openExternal: async () => {
        const stray = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
        expect(stray.status).toBe(404);
        await fetch(`${redirectUri(port)}?code=code_2&state=state_2`);
      },
    });

    expect(await pending).toEqual({ kind: "code", code: "code_2", state: "state_2" });
  });

  it("times out when the browser never calls back", async () => {
    const port = await freePort();
    const result = await runFigmaOAuthLoopback({
      authorizeUrl: AUTH_URL,
      redirectUri: redirectUri(port),
      timeoutMs: 200,
      openExternal: async () => {},
    });

    expect(result).toEqual({ kind: "error", message: "Timed out waiting for the browser." });
  });

  it("fails when the callback URL is not a local address", async () => {
    const result = await runFigmaOAuthLoopback({
      authorizeUrl: AUTH_URL,
      redirectUri: "https://example.com/figma/callback",
      timeoutMs: 5_000,
      openExternal: async () => {},
    });

    expect(result.kind).toBe("error");
  });

  it("fails with a port-in-use message when 8766 is already taken", async () => {
    const port = await freePort();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
    blockers.push(blocker);
    const opened: string[] = [];

    const result = await runFigmaOAuthLoopback({
      authorizeUrl: AUTH_URL,
      redirectUri: redirectUri(port),
      timeoutMs: 5_000,
      openExternal: async (url) => {
        opened.push(url);
      },
    });

    expect(result).toEqual({
      kind: "error",
      message: `Port ${port} is in use. Close the other sign-in or paste the URL instead.`,
    });
    expect(opened).toEqual([]);
  });

  it("rejects a malformed authorize URL without opening the browser", async () => {
    const port = await freePort();
    const opened: string[] = [];
    const result = await runFigmaOAuthLoopback({
      authorizeUrl: "not a url",
      redirectUri: redirectUri(port),
      timeoutMs: 5_000,
      openExternal: async (url) => {
        opened.push(url);
      },
    });

    expect(result).toEqual({ kind: "error", message: "Invalid sign-in URL." });
    expect(opened).toEqual([]);
  });
});

describe("createFigmaCommandHandlers", () => {
  it("registers the figma_oauth_loopback command the preload invokes", async () => {
    const handlers = createFigmaCommandHandlers({ openExternal: async () => {} });
    expect(Object.keys(handlers)).toEqual(["figma_oauth_loopback"]);
    const port = await freePort();
    const result = await handlers.figma_oauth_loopback!({
      authorizeUrl: AUTH_URL,
      redirectUri: redirectUri(port),
      timeoutMs: 200,
    });
    // The command carries no injectable browser, so with nothing hitting the listener the
    // run ends by timeout.
    expect(result).toEqual({ kind: "error", message: "Timed out waiting for the browser." });
  });
});
