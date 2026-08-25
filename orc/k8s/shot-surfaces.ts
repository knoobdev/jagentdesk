import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import { mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSeededHost } from "../../packages/app/e2e/support/helpers/daemon-registry";
import { chromium } from "../../node_modules/playwright-core/index.js";

const CTX = "docker-desktop";
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
  const serverId = "srv_shotsurf";
  const home = mkdtempSync(path.join(tmpdir(), "jad-surf-"));
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
      const buf = readFileSync(fp);
      res.writeHead(200, { "content-type": MIME[path.extname(fp)] ?? "application/octet-stream" });
      res.end(buf);
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
    const host = buildSeededHost({
      serverId,
      endpoint: `127.0.0.1:${dPort}`,
      label: "surf",
      nowIso: "2026-08-25T00:00:00.000Z",
    });
    const browser = await chromium.launch();
    const page = await browser.newPage({
      viewport: { width: 1512, height: 950 },
      deviceScaleFactor: 2,
    });
    page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 140)));
    await page.addInitScript((h: unknown) => {
      localStorage.setItem("@jagentdesk:daemon-registry", JSON.stringify([h]));
    }, host);
    const openCluster = async () => {
      await page.goto(`http://127.0.0.1:${wPort}/h/${serverId}/clusters`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(CTX, { exact: true }).first().waitFor({ timeout: 30000 });
      const connect = page
        .getByText(CTX, { exact: true })
        .locator('xpath=ancestor::div[.//*[normalize-space(text())="Connect"]][1]')
        .getByText("Connect", { exact: true })
        .first();
      if (await connect.count()) await connect.click();
      await page.getByText("Open workloads", { exact: true }).first().waitFor({ timeout: 90000 });
      await page.getByText("Open workloads", { exact: true }).first().click();
      await page.waitForTimeout(3000);
    };
    const selectNs = async (ns: string) => {
      await page.getByText("All namespaces", { exact: true }).first().click();
      await page.waitForTimeout(500);
      await page.getByText(ns, { exact: true }).last().click();
      await page.waitForTimeout(1500);
    };
    const kind = async (k: string) => {
      await page.getByText(k, { exact: true }).first().click();
      await page.waitForTimeout(2000);
    };
    const row = async (name: string) => {
      await page.getByText(name, { exact: true }).first().click();
      await page.waitForTimeout(2500);
    };

    await openCluster();

    // Node detail (cordon path + node overview)
    await kind("Node");
    await row("desktop-control-plane");
    const nodeBody = await page.evaluate(() => document.body.innerText);
    const nodeOk = /Cordon|Uncordon/i.test(nodeBody) && /Kubelet|OS|Architecture/i.test(nodeBody);
    results.push(`${nodeOk ? "✅" : "❌"} Node detail (cordon + node info): ${nodeOk}`);
    await page.screenshot({ path: "/tmp/surf-1-node.png" });

    // StatefulSet detail (exercises getResourceYaml generic fix)
    await kind("StatefulSet");
    await selectNs("qdrant");
    await row("qdrant-database");
    const stsBody = await page.evaluate(() => document.body.innerText);
    const stsOk = /DETAILS/i.test(stsBody) && /Replicas/i.test(stsBody);
    results.push(`${stsOk ? "✅" : "❌"} StatefulSet detail overview: ${stsOk}`);
    await page.screenshot({ path: "/tmp/surf-2-statefulset.png" });

    // Secret detail
    await kind("Secret");
    const secBody0 = await page.evaluate(() => document.body.innerText);
    results.push(`Secret list has qdrant-database-apikey: ${secBody0.includes("qdrant-database-apikey")}`);
    await page.screenshot({ path: "/tmp/surf-3-secret-list.png" });

    // Helm releases (1 exists)
    await page.getByText("Releases", { exact: true }).first().click();
    await page.waitForTimeout(3500);
    const helmBody = await page.evaluate(() => document.body.innerText);
    const helmOk = !/not installed|error/i.test(helmBody.slice(0, 200));
    results.push(`${helmOk ? "✅" : "❌"} Helm releases view renders: ${helmOk}`);
    await page.screenshot({ path: "/tmp/surf-4-helm.png" });

    // ---- MOBILE viewport: cluster workloads on a phone-sized screen ----
    const mpage = await browser.newPage({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 3 });
    await mpage.addInitScript((h: unknown) => {
      localStorage.setItem("@jagentdesk:daemon-registry", JSON.stringify([h]));
    }, host);
    await mpage.goto(`http://127.0.0.1:${wPort}/h/${serverId}/clusters`, {
      waitUntil: "domcontentloaded",
    });
    await mpage.waitForTimeout(3000);
    await mpage.screenshot({ path: "/tmp/surf-5-mobile-clusters.png" });
    const mBody = await mpage.evaluate(() => document.body.innerText);
    const mobileOk = new RegExp(CTX).test(mBody) || /cluster/i.test(mBody);
    results.push(`${mobileOk ? "✅" : "❌"} Mobile viewport renders clusters: ${mobileOk}`);

    await browser.close();
    fin(nodeOk && stsOk && helmOk && mobileOk, "SURFACES: node/statefulset/secret/helm + mobile");
  } catch (e: unknown) {
    fin(false, `surfaces exception: ${e instanceof Error ? e.message : String(e)}`);
  }
}
void main();
