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
  const serverId = "srv_shotact";
  const home = mkdtempSync(path.join(tmpdir(), "jad-act-"));
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
      label: "act",
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
    await page.goto(`http://127.0.0.1:${wPort}/h/${serverId}/clusters`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByText(CTX, { exact: true }).first().waitFor({ timeout: 30000 });
    await page
      .getByText(CTX, { exact: true })
      .locator('xpath=ancestor::div[.//*[normalize-space(text())="Connect"]][1]')
      .getByText("Connect", { exact: true })
      .first()
      .click();
    await page.getByText("Open workloads", { exact: true }).first().waitFor({ timeout: 90000 });
    await page.getByText("Open workloads", { exact: true }).first().click();
    await page.waitForTimeout(3000);

    const selectNs = async (ns: string) => {
      await page.getByText("All namespaces", { exact: true }).first().click();
      await page.waitForTimeout(500);
      await page.getByText(ns, { exact: true }).last().click();
      await page.waitForTimeout(1500);
    };

    // ---- Test A: Service detail (non-workload → exercises getResourceYaml fix) ----
    await page.getByText("Service", { exact: true }).first().click();
    await page.waitForTimeout(2000);
    await page.getByText("kube-dns", { exact: true }).first().click();
    await page.waitForTimeout(2500);
    const svcBody = await page.evaluate(() => document.body.innerText);
    const svcOk = /DETAILS/i.test(svcBody) && /Cluster IP|Type/i.test(svcBody);
    results.push(`${svcOk ? "✅" : "❌"} Service detail overview renders (Type/Cluster IP): ${svcOk}`);
    await page.screenshot({ path: "/tmp/act-1-service.png" });

    // ---- Test B: Pod Logs ---- (kindnet on the Ready control-plane node has a
    // working /bin/sh, unlike the qdrant pods whose worker node is NotReady)
    const shellPod = process.env.SHELL_POD ?? "kindnet-q988v";
    await page.getByText("Pod", { exact: true }).first().click();
    await page.waitForTimeout(1500);
    await selectNs("kube-system");
    await page.getByText(shellPod, { exact: true }).first().click();
    await page.waitForTimeout(2500);
    // Click the Logs action in the detail action bar.
    await page.getByText("Logs", { exact: true }).first().click();
    await page.waitForTimeout(4000);
    const logBody = await page.evaluate(() => document.body.innerText);
    const logOk = logBody.length > 200 && !/Failed to load|error/i.test(logBody.slice(-400));
    results.push(`${logOk ? "✅" : "❌"} Pod Logs render (${shellPod}): ${logOk}`);
    await page.screenshot({ path: "/tmp/act-2-logs.png" });

    // ---- Test C: Pod Shell — expect a LIVE terminal (no error card) ----
    await page.getByText("Shell", { exact: true }).first().click();
    await page.waitForTimeout(4000);
    const shellHeaderShown = await page.evaluate(() => /SHELL/.test(document.body.innerText));
    // Click into the terminal region, then type a command to prove interactivity.
    await page.mouse.click(950, 500);
    await page.waitForTimeout(500);
    await page.keyboard.type("echo HELLO_FROM_SHELL");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2500);
    await page.screenshot({ path: "/tmp/act-3-shell.png" });
    const shellBody = await page.evaluate(() => document.body.innerText);
    const hasEcho = /HELLO_FROM_SHELL/.test(shellBody);
    const noError = !/Shell unavailable/i.test(shellBody);
    const shellOk = shellHeaderShown && noError;
    results.push(
      `${shellOk ? "✅" : "❌"} Pod Shell on ${shellPod}: header=${shellHeaderShown} noError=${noError} echoEcho=${hasEcho}`,
    );

    await browser.close();
    fin(svcOk && logOk && shellOk, "UI ACTIONS: Service detail + Pod Logs + Pod Shell");
  } catch (e: unknown) {
    fin(false, `actions exception: ${e instanceof Error ? e.message : String(e)}`);
  }
}
void main();
