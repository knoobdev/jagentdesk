import { randomBytes } from "node:crypto";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { asDict, asNumber, asString, parsePlistDict } from "../plist.js";
import { runProcess } from "../process.js";
import { NativeMacAnisette, newAnisetteIdentity } from "./anisette.js";
import { GSA_ENDPOINTS, GsaClient } from "./gsa.js";
import { createAppleHttp, type AppleHttp, type AppleHttpResponse } from "./http.js";

// Opt-in probe of Apple's real sign-in service with this Mac's native anisette and NO real
// account: one SRP `init` for a made-up Apple ID. A machine Apple rejects gets HTTP 503; an
// accepted one gets a normal GrandSlam answer (SRP parameters or an account error).
//   JAD_GSA_PROBE=1 npx vitest run gsa-probe.local.e2e
// Nothing secret is printed: only the HTTP status and GrandSlam's status code/message.

const ENABLED = process.env.JAD_GSA_PROBE === "1" && process.platform === "darwin";

class ProbeStop extends Error {}

describe("GrandSlam probe (native anisette, fake Apple ID)", () => {
  it.runIf(ENABLED)(
    "Apple answers SRP init instead of refusing the machine (no 503)",
    async () => {
      const run = (command: string, args: string[]) =>
        runProcess(command, args, { timeoutMs: 20_000 });
      const native = new NativeMacAnisette(run);
      const appleHttp = createAppleHttp(pino({ level: "silent" }));
      let first: AppleHttpResponse | null = null;
      // Only the init request may leave this machine: anything after it is stopped.
      const http: AppleHttp = async (input) => {
        if (first || input.url !== GSA_ENDPOINTS.gsa) throw new ProbeStop("probe stops after init");
        first = await appleHttp(input);
        return first;
      };
      const appleId = `jad-anisette-probe-${randomBytes(6).toString("hex")}@icloud.com`;
      const client = new GsaClient({ http, anisette: () => native.fetch(newAnisetteIdentity()) });
      await client
        .login({
          appleId,
          // Never a real password; SRP never sends it anyway, and the probe stops after init.
          password: randomBytes(12).toString("hex"),
          twoFactor: async () => ({ action: "cancel" }),
        })
        .catch(() => undefined);
      expect(first).not.toBeNull();
      const response = first as unknown as AppleHttpResponse;
      let ec: number | null = null;
      let em: string | null = null;
      let srp = false;
      try {
        const inner = asDict(parsePlistDict(response.body).Response);
        const status = asDict(inner?.Status);
        ec = asNumber(status?.ec);
        em = asString(status?.em);
        srp = inner?.B !== undefined && inner?.s !== undefined;
      } catch {
        // not a plist (a 503 page)
      }
      // eslint-disable-next-line no-console
      console.log(
        `GSA probe: HTTP ${response.status}; ec=${ec ?? "none"}; em=${em ?? "none"}; srp_params=${srp}`,
      );
      expect(response.status).not.toBe(503);
      expect(ec !== null || srp).toBe(true);
    },
    60_000,
  );
});
