// Share route against `wrangler dev --local` with its simulated R2 bucket (spec 37.13.2):
// share_create over an owned control socket, PUT, GET, the 21st link, stop -> 410.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import { encodeRelayAuth, relayChallengeMessage } from "./ownership.js";
import { MAX_SHARES_PER_SERVER, SHARE_SERVER_HEADER } from "./shares.js";

const nodeMajor = Number((process.versions.node ?? "0").split(".")[0] ?? "0");
const run = process.env.FORCE_RELAY_E2E === "1" || nodeMajor < 25;
const wranglerCliPath = createRequire(import.meta.url).resolve("wrangler/bin/wrangler.js");
const relayRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function signBytes(text: string): Uint8Array {
  const HostUint8Array = Object.getPrototypeOf(nacl.sign.keyPair().publicKey)
    .constructor as unknown as Uint8ArrayConstructor;
  return new HostUint8Array(new TextEncoder().encode(text));
}

/** An owned daemon control socket; `request` sends a frame and waits for the reply with its id. */
async function controlSocket(port: number, serverId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?serverId=${serverId}&role=server&v=2`);
  const keys = nacl.sign.keyPair();
  const waiters = new Map<string, (frame: Record<string, unknown>) => void>();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ownership timed out")), 15_000);
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (frame.type === "relay_challenge" && typeof frame.nonce === "string") {
        const signature = nacl.sign.detached(
          signBytes(relayChallengeMessage(serverId, frame.nonce)),
          keys.secretKey,
        );
        ws.send(JSON.stringify(encodeRelayAuth(keys.publicKey, signature)));
      } else if (frame.type === "relay_auth_ok") {
        clearTimeout(timer);
        resolve();
      } else if (typeof frame.requestId === "string") {
        waiters.get(frame.requestId)?.(frame);
      }
    });
    ws.once("error", reject);
  });
  let next = 0;
  return {
    close: () => ws.close(),
    request: (frame: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const requestId = `r${++next}`;
        waiters.set(requestId, resolve);
        ws.send(JSON.stringify({ ...frame, v: 1, requestId }));
      }),
  };
}

(run ? describe : describe.skip)("relay share route on wrangler dev", () => {
  let port = 0;
  let relay: ChildProcess | null = null;
  let persist = "";
  let logs = "";
  const base = () => `http://127.0.0.1:${port}`;

  beforeAll(async () => {
    port = await freePort();
    persist = mkdtempSync(join(tmpdir(), "jad-share-r2-"));
    relay = spawn(
      process.execPath,
      [
        wranglerCliPath,
        "dev",
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--persist-to",
        persist,
        "--live-reload=false",
        "--show-interactive-dev-session=false",
      ],
      {
        cwd: relayRoot,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    relay.stdout?.on("data", (data: Buffer) => (logs += data.toString()));
    relay.stderr?.on("data", (data: Buffer) => (logs += data.toString()));
    const deadline = Date.now() + 80_000;
    while (Date.now() < deadline) {
      if (relay.exitCode !== null) throw new Error(`wrangler exited: ${logs}`);
      const ok = await fetch(`${base()}/health`)
        .then((response) => response.ok)
        .catch(() => false);
      if (ok) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`wrangler dev did not start: ${logs}`);
  }, 90_000);

  afterAll(async () => {
    relay?.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (relay && relay.exitCode === null) relay.kill("SIGKILL");
    rmSync(persist, { recursive: true, force: true });
  });

  it("creates, uploads, serves, limits and stops a link", { timeout: 60_000 }, async () => {
    const serverId = `share-e2e-${Date.now().toString(36)}`;
    const control = await controlSocket(port, serverId);
    try {
      const created = (await control.request({ type: "share_create" })) as {
        type: string;
        shareId: string;
        writeToken: string;
      };
      expect(created.type).toBe("share_created");
      const url = `${base()}/s/${created.shareId}`;
      expect((await fetch(url)).status).toBe(404);

      const sealed = new Uint8Array(4096).map((_, index) => (index * 31) % 251);
      const put = await fetch(url, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${created.writeToken}`,
          [SHARE_SERVER_HEADER]: serverId,
        },
        body: sealed,
      });
      expect(put.status).toBe(200);
      const wrong = await fetch(url, {
        method: "PUT",
        headers: { authorization: `Bearer ${"A".repeat(43)}`, [SHARE_SERVER_HEADER]: serverId },
        body: sealed,
      });
      expect(wrong.status).toBe(404);

      const got = await fetch(`${url}#k=must-never-reach-the-worker`);
      expect(got.status).toBe(200);
      expect(new Uint8Array(await got.arrayBuffer())).toEqual(sealed);

      for (let index = 1; index < MAX_SHARES_PER_SERVER; index++)
        expect((await control.request({ type: "share_create" })).type).toBe("share_created");
      expect(await control.request({ type: "share_create" })).toMatchObject({
        type: "share_error",
        code: "limit",
      });

      expect(
        await control.request({ type: "share_delete", shareId: created.shareId }),
      ).toMatchObject({ type: "share_deleted" });
      expect((await fetch(url)).status).toBe(410);
      expect(logs).not.toContain("must-never-reach-the-worker");
    } finally {
      control.close();
    }
  });
});
