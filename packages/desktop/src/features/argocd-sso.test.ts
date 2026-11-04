import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { runSsoLoopback } from "./argocd-sso";

// Spec 30.2.1 step 4 / criterion 30.6.3: the loopback is a real listener on 127.0.0.1.

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

const blockers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    blockers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("runSsoLoopback", () => {
  it("fails with sso_port_in_use when the port is already taken", async () => {
    const port = await freePort();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
    blockers.push(blocker);
    const opened: string[] = [];

    const result = await runSsoLoopback({
      authUrl: "https://argocd.invalid/api/dex/auth",
      state: "st_1",
      timeoutMs: 5_000,
      port,
      openExternal: async (url) => {
        opened.push(url);
      },
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errorCode).toBe("sso_port_in_use");
    expect(opened).toEqual([]);
  });

  it("returns the code once the browser hits /auth/callback with the right state", async () => {
    const port = await freePort();
    const pending = runSsoLoopback({
      authUrl: "https://argocd.invalid/api/dex/auth",
      state: "st_2",
      timeoutMs: 5_000,
      port,
      openExternal: async () => {
        const response = await fetch(`http://127.0.0.1:${port}/auth/callback?code=c_1&state=st_2`);
        expect(response.status).toBe(200);
      },
    });

    expect(await pending).toEqual({ ok: true, code: "c_1", state: "st_2" });
  });

  it("rejects a callback whose state does not match", async () => {
    const port = await freePort();
    const result = await runSsoLoopback({
      authUrl: "https://argocd.invalid/api/dex/auth",
      state: "st_3",
      timeoutMs: 5_000,
      port,
      openExternal: async () => {
        await fetch(`http://127.0.0.1:${port}/auth/callback?code=c_1&state=other`);
      },
    });

    expect(result.ok === false && result.errorCode).toBe("sso_state_mismatch");
  });

  it("relays the identity provider's error", async () => {
    const port = await freePort();
    const result = await runSsoLoopback({
      authUrl: "https://argocd.invalid/api/dex/auth",
      state: "st_4",
      timeoutMs: 5_000,
      port,
      openExternal: async () => {
        await fetch(
          `http://127.0.0.1:${port}/auth/callback?state=st_4&error=invalid_request&error_description=Unregistered%20redirect_uri`,
        );
      },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: "sso_idp_error",
      message: "Unregistered redirect_uri",
      error: "invalid_request",
      errorDescription: "Unregistered redirect_uri",
    });
  });

  it("times out with sso_timeout when no callback arrives", async () => {
    const port = await freePort();
    const result = await runSsoLoopback({
      authUrl: "https://argocd.invalid/api/dex/auth",
      state: "st_5",
      timeoutMs: 200,
      port,
      openExternal: async () => {},
    });

    expect(result.ok === false && result.errorCode).toBe("sso_timeout");
  });
});
