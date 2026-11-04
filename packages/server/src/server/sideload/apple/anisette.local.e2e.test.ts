import pino from "pino";
import { describe, expect, it } from "vitest";
import { runProcess } from "../process.js";
import { NativeMacAnisette, RemoteAnisette, newAnisetteIdentity } from "./anisette.js";
import { createAnisetteServerHttp, createAppleHttp } from "./http.js";

// Real anisette, no Apple ID involved. Native: this Mac's AOSKit. Remote: a self-hosted
// anisette-v3 server, which provisions a new machine against Apple's real MID service, e.g.
//   docker run -d --name jad-anisette -p 127.0.0.1:16969:6969 dadoum/anisette-v3-server
//   JAD_ANISETTE_URL=http://127.0.0.1:16969 npx vitest run anisette.local.e2e
// Header values are secrets: the tests check their shape, never print them.

const REMOTE_URL = process.env.JAD_ANISETTE_URL ?? "";
const logger = pino({ level: "silent" });

describe("anisette sources", () => {
  it.runIf(process.platform === "darwin")(
    "native macOS returns one-time and machine headers",
    async () => {
      const run = (command: string, args: string[]) =>
        runProcess(command, args, { timeoutMs: 20_000 });
      const native = new NativeMacAnisette(run, async () => ({
        model: (await run("sysctl", ["-n", "hw.model"])).stdout.trim(),
        osVersion: (await run("sw_vers", ["-productVersion"])).stdout.trim(),
        osBuild: (await run("sw_vers", ["-buildVersion"])).stdout.trim(),
      }));
      const result = await native.fetch(newAnisetteIdentity());
      expect(result.data["X-Apple-I-MD"]).toMatch(/^[A-Za-z0-9+/=]{20,}$/);
      expect(result.data["X-Apple-I-MD-M"]).toMatch(/^[A-Za-z0-9+/=]{40,}$/);
      expect(result.data["X-Mme-Client-Info"]).toMatch(
        /^<.+> <Mac OS X;[\d.]+;\w+> <com\.apple\.AuthKit/,
      );
    },
  );

  it.runIf(REMOTE_URL !== "")(
    "remote v3 provisions once, then reuses the machine",
    async () => {
      const remote = new RemoteAnisette(
        REMOTE_URL,
        createAnisetteServerHttp(logger),
        createAppleHttp(logger),
      );
      const first = await remote.fetch(newAnisetteIdentity());
      expect(first.identity.remoteIdentifier).not.toBeNull();
      expect(first.identity.remoteAdiPb).not.toBeNull();
      expect(first.data["X-Apple-I-MD"].length).toBeGreaterThan(20);
      const second = await remote.fetch(first.identity);
      expect(second.identity).toEqual(first.identity);
      expect(second.data["X-Apple-I-MD-M"]).toBe(first.data["X-Apple-I-MD-M"]);
    },
    60_000,
  );
});
