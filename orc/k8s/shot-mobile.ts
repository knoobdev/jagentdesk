import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import { mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DaemonClient } from "../../packages/client/src/index";
import { createNodeWebSocketFactory } from "../../packages/app/e2e/support/helpers/node-ws-factory";
import { buildSeededHost } from "../../packages/app/e2e/support/helpers/daemon-registry";
import { chromium } from "../../node_modules/playwright-core/index.js";

const MIME: Record<string, string> = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".json": "application/json",
  ".png": "image/png",
};
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
    s.on("error", rej);
  });
const waitListen = (port: number, tries = 60): Promise<void> =>
  new Promise((res, rej) => {
    let n = 0;
    const tick = () => {
      const c = net.connect(port, "127.0.0.1", () => {
        c.destroy();
        res();
      });
      c.on("error", () => {
        c.destroy();
        if (++n > tries) rej(new Error("no listen"));
        else setTimeout(tick, 500);
      });
    };
    tick();
  });

async function main() {
  const dPort = await freePort();
  const wPort = await freePort();
  const serverId = "srv_mobshot";
  const home = mkdtempSync(path.join(tmpdir(), "jad-mob-"));
  const serverDir = path.resolve(__dirname, "../../packages/server");
  const tsxBin = path.resolve(__dirname, "../../node_modules/.bin/tsx");
  const distDir = path.resolve(__dirname, "../../packages/app/dist");
  const daemon = spawn(tsxBin, ["scripts/supervisor-entrypoint.ts", "--dev"], {
    cwd: serverDir,
    env: {
      ...process.env,
      JAGENTDESK_HOME: home,
      JAGENTDESK_LISTEN: `127.0.0.1:${dPort}`,
      JAGENTDESK_SERVER_ID: serverId,
      JAGENTDESK_CORS_ORIGINS: `http://127.0.0.1:${wPort}`,
      JAGENTDESK_NODE_ENV: "development",
      NODE_ENV: "development",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let derr = "";
  daemon.stderr?.on("data", (b: Buffer) => (derr = (derr + b).split("\n").slice(-25).join("\n")));
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent((req.url || "/").split("?")[0]);
    let fp = path.join(distDir, p);
    if (!existsSync(fp) || statSync(fp).isDirectory()) {
      fp = existsSync(fp + ".html") ? fp + ".html" : path.join(distDir, "index.html");
    }
    try {
      res.writeHead(200, { "content-type": MIME[path.extname(fp)] ?? "application/octet-stream" });
      res.end(readFileSync(fp));
    } catch {
      res.writeHead(404);
      res.end("nf");
    }
  });
  await new Promise<void>((r) => srv.listen(wPort, "127.0.0.1", () => r()));
  const results: string[] = [];
  const fin = (ok: boolean, msg: string) => {
    console.log(`\n${results.join("\n")}\n${ok ? "✅" : "❌"} ${msg}`);
    if (!ok) console.log(derr);
    try {
      daemon.kill("SIGKILL");
    } catch {}
    srv.close();
    process.exit(ok ? 0 : 1);
  };

  try {
    await waitListen(dPort);
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${dPort}/ws`,
      clientId: `mob-${Date.now()}`,
      clientType: "cli",
      appVersion: "1.0.18",
      webSocketFactory: createNodeWebSocketFactory(),
    }) as unknown as {
      connect: () => Promise<void>;
      clusterImport: (o: { contextName: string }) => Promise<{ clusters: Array<{ id: string }> }>;
      clusterConnect: (o: { id: string }) => Promise<{ error?: string }>;
    };
    await client.connect();
    const imp = await client.clusterImport({ contextName: "docker-desktop" });
    const cluId = imp.clusters[imp.clusters.length - 1].id;
    await client.clusterConnect({ id: cluId });

    const host = buildSeededHost({
      serverId,
      endpoint: `127.0.0.1:${dPort}`,
      label: "mob",
      nowIso: "2026-08-25T00:00:00.000Z",
    });
    const browser = await chromium.launch();

    // ---- Desktop: open cluster → bug 3 (no auto-Pod), should show "pick a resource"
    const dp = await browser.newPage({ viewport: { width: 1512, height: 950 }, deviceScaleFactor: 2 });
    await dp.addInitScript((h: unknown) => {
      localStorage.setItem("@jagentdesk:daemon-registry", JSON.stringify([h]));
    }, host);
    await dp.goto(`http://127.0.0.1:${wPort}/h/${serverId}/cluster/${cluId}`, {
      waitUntil: "domcontentloaded",
    });
    await dp.waitForTimeout(4000);
    const landing = await dp.evaluate(() => document.body.innerText);
    const noAutoPod = /Pick a resource/i.test(landing) && !/coredns-/i.test(landing);
    results.push(`${noAutoPod ? "✅" : "❌"} open cluster does NOT auto-jump to Pod list: ${noAutoPod}`);
    await dp.screenshot({ path: "/tmp/mob-1-landing.png" });

    // Select Pod (desktop nav visible), open a pod detail, screenshot the action bar.
    await dp.getByText("Pod", { exact: true }).first().click();
    await dp.waitForTimeout(2500);
    await dp.getByText("coredns-66bc5c9577-829dh", { exact: true }).first().click();
    await dp.waitForTimeout(2500);
    const detailBody = await dp.evaluate(() => document.body.innerText);
    // All action buttons should be present (scrollable), not dropped.
    const hasAllActions = ["Logs", "Shell", "Port-forward", "Delete"].every((b) =>
      detailBody.includes(b),
    );
    results.push(`${hasAllActions ? "✅" : "❌"} detail action bar keeps all buttons (Logs/Shell/Port-forward/Delete): ${hasAllActions}`);
    await dp.screenshot({ path: "/tmp/mob-2-detail-actions.png" });

    // ---- Mobile viewport: same cluster detail, narrow width
    const mp = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
    await mp.addInitScript((h: unknown) => {
      localStorage.setItem("@jagentdesk:daemon-registry", JSON.stringify([h]));
    }, host);
    await mp.goto(`http://127.0.0.1:${wPort}/h/${serverId}/cluster/${cluId}`, {
      waitUntil: "domcontentloaded",
    });
    await mp.waitForTimeout(4000);
    await mp.screenshot({ path: "/tmp/mob-3-mobile-cluster.png" });
    results.push("ℹ️ mobile cluster screenshot saved");

    await browser.close();
    fin(noAutoPod && hasAllActions, "mobile fixes: landing + action bar");
  } catch (e: unknown) {
    fin(false, `exception: ${e instanceof Error ? e.message : String(e)}`);
  }
}
void main();
