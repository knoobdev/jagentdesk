import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import { mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSeededHost } from "../../packages/app/e2e/support/helpers/daemon-registry";
import { chromium } from "../../node_modules/playwright-core/index.js";

const CTX = process.env.SHOT_CTX ?? "docker-desktop";
const KIND = process.env.SHOT_KIND ?? "Deployment";

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
  const serverId = "srv_verifyns";
  const home = mkdtempSync(path.join(tmpdir(), "jad-shot-"));
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
      if (existsSync(fp + ".html")) fp = fp + ".html";
      else fp = path.join(distDir, "index.html");
    }
    try {
      const buf = readFileSync(fp);
      const ext = path.extname(fp);
      const ct =
        ext === ".js"
          ? "application/javascript"
          : ext === ".css"
            ? "text/css"
            : ext === ".html"
              ? "text/html"
              : ext === ".json"
                ? "application/json"
                : "application/octet-stream";
      res.writeHead(200, { "content-type": ct });
      res.end(buf);
    } catch {
      res.writeHead(404);
      res.end("nf");
    }
  });
  await new Promise<void>((r) => srv.listen(wPort, "127.0.0.1", () => r()));
  const fin = (ok: boolean, msg: string) => {
    console.log(ok ? `\n✅ ${msg}` : `\n❌ ${msg}\n${derr}`);
    try {
      daemon.kill("SIGKILL");
    } catch {}
    srv.close();
    process.exit(ok ? 0 : 1);
  };
  try {
    await waitListen(dPort);
    console.log("[shot] daemon up");
    const host = buildSeededHost({
      serverId,
      endpoint: `127.0.0.1:${dPort}`,
      label: "shot",
      nowIso: "2026-08-25T00:00:00.000Z",
    });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1512, height: 950 }, deviceScaleFactor: 2 });
    page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 160)));
    await page.addInitScript((h: unknown) => {
      localStorage.setItem("@jagentdesk:daemon-registry", JSON.stringify([h]));
    }, host);
    await page.goto(`http://127.0.0.1:${wPort}/h/${serverId}/clusters`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByText(CTX, { exact: true }).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "/tmp/ns-1.png" });
    console.log("[shot] 1 clusters list");

    // Connect the specific context row (docker-desktop), not just the first Connect.
    const connectBtn = page
      .getByText(CTX, { exact: true })
      .locator('xpath=ancestor::div[.//*[normalize-space(text())="Connect"]][1]')
      .getByText("Connect", { exact: true })
      .first();
    await connectBtn.click();
    console.log("[shot] clicked Connect for", CTX);
    await page.getByText("Open workloads", { exact: true }).first().waitFor({ timeout: 90000 });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: "/tmp/deploy-2-connected.png" });
    console.log("[shot] 2 connected");

    await page.getByText("Open workloads", { exact: true }).first().click();
    await page.waitForTimeout(3500);

    // Open Pod list (pods exist across several namespaces on docker-desktop).
    await page.getByText("Pod", { exact: true }).first().click();
    await page.waitForTimeout(2500);

    // Collect the namespaces shown while "All namespaces" is selected.
    const scrapeNamespaces = () =>
      page.evaluate(() => {
        const known = [
          "kube-system",
          "default",
          "kube-node-lease",
          "kube-public",
          "local-path-storage",
        ];
        const text = document.body.innerText;
        return known.filter((ns) => text.includes(ns));
      });
    const allNs = await scrapeNamespaces();
    const allCount = await page.evaluate(() => {
      const m = document.body.innerText.match(/Pod\s+(\d+)/);
      return m ? Number(m[1]) : -1;
    });
    console.log("[ns] All namespaces -> namespaces seen:", allNs, "count:", allCount);
    await page.screenshot({ path: "/tmp/ns-2-all.png" });

    // Open the namespace selector (the trigger in the left nav) and pick kube-system.
    await page.getByText("All namespaces", { exact: true }).first().click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: "/tmp/ns-3-sheet.png" });
    // The modal sheet renders last in the DOM; target its kube-system row.
    await page.getByText("kube-system", { exact: true }).last().click();
    await page.waitForTimeout(2500);

    const filteredNs = await scrapeNamespaces();
    const filteredCount = await page.evaluate(() => {
      const m = document.body.innerText.match(/Pod\s+(\d+)/);
      return m ? Number(m[1]) : -1;
    });
    const triggerLabel = await page.evaluate(() => {
      // the selector trigger text after selection
      return document.body.innerText.includes("kube-system");
    });
    await page.screenshot({ path: "/tmp/ns-4-filtered.png" });
    console.log("[ns] After select kube-system -> namespaces seen:", filteredNs, "count:", filteredCount);

    const onlyKubeSystem = filteredNs.length === 1 && filteredNs[0] === "kube-system";
    const narrowed = allCount === -1 || filteredCount === -1 || filteredCount <= allCount;
    await browser.close();
    fin(
      onlyKubeSystem && narrowed && triggerLabel,
      `NAMESPACE FILTER ${onlyKubeSystem && narrowed ? "WORKS" : "FAILED"}: all=${allNs.join(",")}(${allCount}) -> kube-system(${filteredCount}); onlyKubeSystem=${onlyKubeSystem}`,
    );
  } catch (e: unknown) {
    fin(false, `shot exception: ${e instanceof Error ? e.message : String(e)}`);
  }
}
void main();
