import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProxyService } from "./proxy-service.js";

// The shared ProxyService is what both the human UI (session dispatch) and the agent MCP tools call,
// so this proves the agent-facing surface: start a capture (get a listener), list it, run a Repeater
// request against a real origin, and export the CA. A throwaway JAGENTDESK_HOME isolates the CA.

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "wb-svc-"));
const env = { ...process.env, JAGENTDESK_HOME: tmpHome } as NodeJS.ProcessEnv;
let origin: http.Server;
let originPort = 0;

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", () => r()));
  originPort = (origin.address() as { port: number }).port;
});

afterAll(async () => {
  origin?.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("ProxyService", () => {
  it("starts a capture, lists it, and exports a CA", async () => {
    const svc = new ProxyService(env);
    try {
      const session = await svc.captureStart({ mode: "manual", label: "test" });
      expect(session.state).toBe("running");
      expect(session.listenerPort).toBeGreaterThan(0);
      const list = svc.sessionsList();
      expect(list.some((s) => s.id === session.id)).toBe(true);
      const pem = svc.caExportPem();
      expect(pem).toContain("BEGIN CERTIFICATE");
      // Regression: `simctl keychain add-root-cert` rejects CRLF PEMs — must be LF-only.
      expect(pem).not.toContain("\r");
    } finally {
      await svc.disposeAll();
    }
  });

  it("replays a request via Repeater and returns the response", async () => {
    const svc = new ProxyService(env);
    try {
      const tx = await svc.repeaterSend({
        secure: false,
        host: "127.0.0.1",
        port: originPort,
        method: "GET",
        path: "/agent/hello",
        headers: [{ name: "Accept", value: "application/json" }],
        body: Buffer.alloc(0),
      });
      expect(tx.status).toBe(200);
      expect(Buffer.from(tx.responseBodyB64, "base64").toString()).toContain("/agent/hello");
    } finally {
      await svc.disposeAll();
    }
  });

  it("runs a Sniper intruder attack over payloads", async () => {
    const svc = new ProxyService(env);
    try {
      const out = await svc.intruderRun({
        secure: false,
        host: "127.0.0.1",
        port: originPort,
        template: `GET /u/§X§ HTTP/1.1\nHost: 127.0.0.1:${originPort}\n\n`,
        payloads: ["a", "bb", "ccc"],
      });
      expect(out.results).toHaveLength(3);
      expect(out.results.every((r) => r.status === 200)).toBe(true);
      expect(out.throttled).toBe(true);
    } finally {
      await svc.disposeAll();
    }
  });
});
