import { spawn, execSync } from "node:child_process";
import net from "node:net";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
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
  const serverId = "srv_composer";
  const home = mkdtempSync(path.join(tmpdir(), "jad-comp-"));
  const projDir = path.join(tmpdir(), "jad-composer-proj");
  if (!existsSync(projDir)) mkdirSync(projDir, { recursive: true });
  writeFileSync(path.join(projDir, "README.md"), "# k8s chat project\n");
  try {
    execSync("git init -q && git add -A && git -c user.email=a@b.c -c user.name=x commit -qm init", {
      cwd: projDir,
    });
  } catch {}
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
  daemon.stderr?.on("data", (b: Buffer) => (derr = (derr + b).split("\n").slice(-30).join("\n")));
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
    // Seed a project + workspace + connected cluster over the real client stack.
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${dPort}/ws`,
      clientId: `comp-${Date.now()}`,
      clientType: "cli",
      appVersion: "1.0.18",
      webSocketFactory: createNodeWebSocketFactory(),
    }) as unknown as {
      connect: () => Promise<void>;
      addProject: (cwd: string) => Promise<{ error?: string }>;
      createWorkspace: (i: {
        source: { kind: string; path: string };
        title?: string;
      }) => Promise<{ error?: string; workspace?: { id?: string; workspaceDirectory?: string } }>;
      clusterContexts: () => Promise<{ error?: string; contexts?: Array<{ name: string; current?: boolean }> }>;
      clusterImport: (o: { contextName: string }) => Promise<{ error?: string; clusters: Array<{ id: string; contextName: string }> }>;
      clusterConnect: (o: { id: string }) => Promise<{ error?: string; cluster?: unknown }>;
      listProviders?: () => Promise<unknown>;
    };
    await client.connect();

    const addRes = await client.addProject(projDir);
    console.log("[comp] addProject err:", addRes.error ?? "none");
    const wsRes = await client.createWorkspace({
      source: { kind: "directory", path: projDir },
      title: "k8s-chat",
    });
    console.log("[comp] createWorkspace err:", wsRes.error ?? "none", "wsDir:", wsRes.workspace?.workspaceDirectory);

    const ctxRes = await client.clusterContexts();
    const target = (ctxRes.contexts ?? []).find((c) => c.name === "docker-desktop");
    if (!target) return fin(false, "no docker-desktop context");
    const imp = await client.clusterImport({ contextName: "docker-desktop" });
    if (imp.error) return fin(false, `import: ${imp.error}`);
    const cluId = imp.clusters[imp.clusters.length - 1].id;
    const con = await client.clusterConnect({ id: cluId });
    if (con.error) return fin(false, `connect: ${con.error}`);
    console.log("[comp] cluster connected id=", cluId);

    const host = buildSeededHost({
      serverId,
      endpoint: `127.0.0.1:${dPort}`,
      label: "comp",
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
    await page.goto(`http://127.0.0.1:${wPort}/h/${serverId}/cluster/${cluId}`, {
      waitUntil: "domcontentloaded",
    });
    // Give the dock time to see provider+workspace and eager-create the agent.
    await page.waitForTimeout(12000);
    await page.screenshot({ path: "/tmp/comp-1-dock.png" });
    const body = await page.evaluate(() => document.body.innerText);
    const hasComposer = !/Connect a host & add a project/i.test(body);
    const starting = /Starting chat/i.test(body);
    console.log("[comp] composer present:", hasComposer, "starting:", starting);
    console.log("[comp] body sample:", body.slice(0, 300).replace(/\n/g, " | "));
    await browser.close();
    fin(hasComposer, `COMPOSER dock: present=${hasComposer} (starting=${starting})`);
  } catch (e: unknown) {
    fin(false, `exception: ${e instanceof Error ? e.message : String(e)}`);
  }
}
void main();
