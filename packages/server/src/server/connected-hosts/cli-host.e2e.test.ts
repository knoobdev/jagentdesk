import { afterAll, beforeAll, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createTestJAgentDeskDaemon,
  type TestJAgentDeskDaemon,
} from "../test-utils/jagentdesk-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
let a: TestJAgentDeskDaemon, b: TestJAgentDeskDaemon, app: DaemonClient, origin: DaemonClient;
beforeAll(async () => {
  a = await createTestJAgentDeskDaemon();
  b = await createTestJAgentDeskDaemon();
  app = new DaemonClient({ url: `ws://127.0.0.1:${b.port}/ws`, reconnect: { enabled: false } });
  origin = new DaemonClient({ url: `ws://127.0.0.1:${a.port}/ws`, reconnect: { enabled: false } });
  await app.connect();
  await origin.connect();
}, 60000);
afterAll(async () => {
  await app?.close();
  await origin?.close();
  await a?.close();
  await b?.close();
}, 30000);
test("CLI compares the SAS and saves a host after y and app confirmation", async () => {
  const offer = await app.beginSasPairing();
  let sas: string | undefined;
  const stop = app.subscribeRawMessages((message) => {
    if (message.type === "pairing.sas.changed" && message.payload.code) sas = message.payload.code;
  });
  const confirmCode = async (code: string) => {
    await expect.poll(() => sas).toBe(code);
    await app.confirmSasPairing(offer.pk, true);
  };
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("CLAUDE")),
    );
    const entry = fileURLToPath(new URL("../../../../cli/dist/index.js", import.meta.url));
    const child = spawn(
      process.execPath,
      [entry, "host", "add", offer.link, "--host", `127.0.0.1:${a.port}`, "--json"],
      {
        env: {
          ...env,
          JAGENTDESK_HOME: a.jagentdeskHome,
          JAGENTDESK_TAILSCALE_ENABLED: "0",
          JAGENTDESK_RELAY_ENABLED: "0",
        },
        stdio: ["pipe", "ignore", "pipe"],
      },
    );
    let stderr = "",
      answered = false;
    child.stderr.on("data", (data) => {
      stderr += String(data);
      const match = stderr.match(/Verification code:\s*(\d{3})\s+(\d{3})/);
      if (!match || answered) return;
      answered = true;
      void (async () => {
        await confirmCode(match[1]! + match[2]!);
        child.stdin.end("y\n");
      })().catch((error) => {
        child.kill();
        reject(error);
      });
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr }));
  });
  stop();
  expect(result.code, result.stderr).toBe(0);
  await expect.poll(async () => (await origin.listHosts()).hosts[0]?.status).toBe("connected");
}, 30000);
