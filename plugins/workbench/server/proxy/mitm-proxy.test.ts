import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkbenchCA } from "./ca.js";
import { CaptureStore, toFull } from "./capture-store.js";
import { MitmProxy } from "./mitm-proxy.js";

// Proof for the P1 MITM core: a real request routed through the proxy to a real origin server is
// forwarded correctly AND captured (HTTP and, via the CA, HTTPS). Uses a throwaway JAGENTDESK_HOME
// so the generated CA never touches the developer's real home.

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "wb-mitm-"));
const env = { ...process.env, JAGENTDESK_HOME: tmpHome } as NodeJS.ProcessEnv;

let httpOrigin: http.Server;
let httpsOrigin: https.Server;
let httpOriginPort = 0;
let httpsOriginPort = 0;

beforeAll(async () => {
  httpOrigin = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`http-origin saw ${req.method} ${req.url} body=${body}`);
    });
  });
  await listen(httpOrigin, 0);
  httpOriginPort = addressPort(httpOrigin);

  // A self-signed origin cert — the proxy must reach it despite the bad cert (rejectUnauthorized:
  // false), which is exactly what a testing proxy needs.
  const ca = new WorkbenchCA(env);
  const originCert = ca.certForHost("localhost");
  httpsOrigin = https.createServer(
    { cert: originCert.certPem, key: originCert.keyPem },
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    },
  );
  await listen(httpsOrigin, 0);
  httpsOriginPort = addressPort(httpsOrigin);
});

afterAll(async () => {
  httpOrigin?.close();
  httpsOrigin?.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("MitmProxy", () => {
  it("forwards and captures a plain HTTP request", async () => {
    const ca = new WorkbenchCA(env);
    const store = new CaptureStore();
    const captured: string[] = [];
    const proxy = new MitmProxy({
      ca,
      sessionId: "s1",
      store,
      onTransaction: (tx) => captured.push(tx.id),
    });
    const port = await proxy.start();
    try {
      const res = await proxyGet(port, `http://127.0.0.1:${httpOriginPort}/hello?x=1`);
      expect(res.body).toContain("http-origin saw GET /hello?x=1");
      expect(captured.length).toBe(1);
      const full = toFull(store.get(captured[0]!)!);
      expect(full.host).toBe("127.0.0.1");
      expect(full.method).toBe("GET");
      expect(full.status).toBe(200);
      expect(full.secure).toBe(false);
      expect(full.paramCount).toBe(1);
      expect(Buffer.from(full.responseBodyB64, "base64").toString()).toContain("http-origin saw");
    } finally {
      await proxy.stop();
    }
  });

  it("terminates TLS with the CA and captures an HTTPS request", async () => {
    const ca = new WorkbenchCA(env);
    const store = new CaptureStore();
    const rows: string[] = [];
    const proxy = new MitmProxy({
      ca,
      sessionId: "s2",
      store,
      onTransaction: (tx) => rows.push(tx.id),
    });
    const port = await proxy.start();
    try {
      const res = await proxyConnectGet({
        proxyPort: port,
        targetHost: "localhost",
        targetPort: httpsOriginPort,
        pathName: "/secure",
        caPem: ca.exportPem(),
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('"ok":true');
      expect(rows.length).toBe(1);
      const full = toFull(store.get(rows[0]!)!);
      expect(full.secure).toBe(true);
      expect(full.host).toBe("localhost");
      expect(full.url).toBe("/secure");
      expect(full.status).toBe(200);
    } finally {
      await proxy.stop();
    }
  });
});

function listen(server: http.Server | https.Server, port: number): Promise<void> {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
}
function addressPort(server: http.Server | https.Server): number {
  const addr = server.address();
  return typeof addr === "object" && addr ? addr.port : 0;
}

// A plain HTTP proxy GET (absolute-form request URI).
function proxyGet(proxyPort: number, absoluteUrl: string): Promise<{ body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(absoluteUrl);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: absoluteUrl,
        headers: { host: u.host },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// A CONNECT tunnel through the proxy, then a TLS GET trusting the Workbench CA.
function proxyConnectGet(o: {
  proxyPort: number;
  targetHost: string;
  targetPort: number;
  pathName: string;
  caPem: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const conn = http.request({
      host: "127.0.0.1",
      port: o.proxyPort,
      method: "CONNECT",
      path: `${o.targetHost}:${o.targetPort}`,
    });
    conn.on("connect", (_res, socket: net.Socket) => {
      const tlsReq = https.request(
        {
          host: o.targetHost,
          port: o.targetPort,
          method: "GET",
          path: o.pathName,
          socket,
          agent: false,
          ca: o.caPem,
          servername: o.targetHost,
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      tlsReq.on("error", reject);
      tlsReq.end();
    });
    conn.on("error", reject);
    conn.end();
  });
}
