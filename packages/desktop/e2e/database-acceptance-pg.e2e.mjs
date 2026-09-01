#!/usr/bin/env node
// Live acceptance against a REAL external PostgreSQL. Boots the real daemon + real
// Electron + CDP, then drives the actual Add-connection UI (engine + host/port/db/
// user/password → Save & connect) and browses the real schema. Credentials come
// from env (PG_HOST/PG_PORT/PG_DB/PG_USER/PG_PASS) — never hard-coded/committed.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "../../..");
const devRunner = path.join(scriptDir, "..", "scripts", "dev-runner.mjs");
const timeoutMs = 120_000;

const PG = {
  host: process.env.PG_HOST ?? "",
  port: process.env.PG_PORT ?? "5432",
  db: process.env.PG_DB ?? "",
  user: process.env.PG_USER ?? "",
  pass: process.env.PG_PASS ?? "",
  table: process.env.PG_TABLE ?? "companies",
};

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      server.close((e) => (e ? reject(e) : resolve(a.port)));
    });
  });
}
async function waitForPort(port, label, info) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (info && (info.child.exitCode !== null || info.child.signalCode !== null))
      throw new Error(`${label} exited before opening its port; see ${info.logPath}`);
    const ok = await new Promise((resolve) => {
      const s = net.createConnection({ host: "127.0.0.1", port });
      s.setTimeout(500);
      s.once("connect", () => (s.destroy(), resolve(true)));
      s.once("timeout", () => (s.destroy(), resolve(false)));
      s.once("error", () => resolve(false));
    });
    if (ok) return;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label} on ${port}`);
}
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
}
function seedHome(home, listen, workspaceRoot) {
  const ts = "2026-01-01T00:00:00.000Z";
  const cwd = path.join(workspaceRoot, "ws-1");
  fs.mkdirSync(cwd, { recursive: true });
  writeJson(path.join(home, "config.json"), {
    version: 1,
    daemon: {
      listen,
      mcp: { enabled: true, injectIntoAgents: false },
      cors: { allowedOrigins: ["*"] },
    },
  });
  writeJson(path.join(home, "projects", "projects.json"), [
    {
      projectId: "p-accept",
      rootPath: cwd,
      kind: "non_git",
      displayName: "Acceptance",
      customName: null,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
    },
  ]);
  writeJson(path.join(home, "projects", "workspaces.json"), [
    {
      workspaceId: "ws-accept",
      projectId: "p-accept",
      cwd,
      kind: "directory",
      displayName: "Acceptance",
      title: "Acceptance",
      branch: null,
      baseBranch: null,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
      pinnedAt: null,
    },
  ]);
}
function spawnLogged(name, cmd, args, opts, logDir) {
  const logPath = path.join(logDir, `${name}.log`);
  const log = fs.createWriteStream(logPath, { flags: "a" });
  const child = spawn(cmd, args, {
    ...opts,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  return { child, logPath };
}
function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {}
}
async function waitForAppPage(browser, expoPort) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const c of browser.contexts())
      for (const p of c.pages()) if (p.url().includes(`localhost:${expoPort}`)) return p;
    await delay(250);
  }
  throw new Error("Timed out waiting for app renderer");
}
async function waitForDesktopStatus(page) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const s = await page.evaluate(async () => {
        if (typeof window.jagentdeskDesktop?.invoke !== "function") return null;
        return await window.jagentdeskDesktop.invoke("desktop_daemon_status");
      });
      if (typeof s?.serverId === "string") return s;
    } catch {}
    await delay(250);
  }
  throw new Error("Timed out waiting for desktop bridge");
}
async function shot(page, dir, name) {
  const f = path.join(dir, `${name}.png`);
  await page.screenshot({ path: f, fullPage: false });
  return f;
}
async function seen(page, text, ms = 20_000) {
  try {
    await page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout: ms });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  for (const [k, v] of Object.entries({ host: PG.host, db: PG.db, user: PG.user, pass: PG.pass }))
    if (!v) throw new Error(`Missing PG_${k.toUpperCase()} env`);

  const artifactDir = process.env.ACCEPT_OUT ?? path.join(os.tmpdir(), "jad-db-acceptance-pg");
  fs.rmSync(artifactDir, { recursive: true, force: true });
  fs.mkdirSync(artifactDir, { recursive: true });
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jad-db-pg-"));
  const home = path.join(runtimeDir, "home");
  const userData = path.join(runtimeDir, "electron-user-data");
  fs.mkdirSync(home, { recursive: true });

  const [daemonPort, expoPort, cdpPort] = await Promise.all([
    reservePort(),
    reservePort(),
    reservePort(),
  ]);
  const listen = `127.0.0.1:${daemonPort}`;
  seedHome(home, listen, path.join(runtimeDir, "workspaces"));

  const children = [];
  let browser = null;
  const report = { steps: [], screenshots: [], checks: {} };
  try {
    const commonEnv = {
      ...process.env,
      JAGENTDESK_HOME: home,
      JAGENTDESK_LISTEN: listen,
      JAGENTDESK_DAEMON_ENDPOINT: `localhost:${daemonPort}`,
      JAGENTDESK_CORS_ORIGINS: "*",
      JAGENTDESK_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
      JAGENTDESK_DICTATION_ENABLED: "0",
      JAGENTDESK_VOICE_MODE_ENABLED: "0",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    };
    const daemon = spawnLogged(
      "daemon",
      process.execPath,
      ["--import", "tsx", path.join(rootDir, "packages/server/scripts/dev-runner.ts")],
      { cwd: rootDir, env: { ...commonEnv, JAGENTDESK_NODE_ENV: "development" } },
      artifactDir,
    );
    children.push(daemon.child);
    await waitForPort(daemonPort, "daemon", daemon);

    const desktop = spawnLogged(
      "desktop",
      process.execPath,
      [devRunner],
      {
        cwd: rootDir,
        env: {
          ...commonEnv,
          EXPO_PORT: String(expoPort),
          EXPO_DEV_URL: `http://localhost:${expoPort}`,
          EXPO_PUBLIC_LOCAL_DAEMON: `localhost:${daemonPort}`,
          JAGENTDESK_ELECTRON_REMOTE_DEBUGGING_PORT: String(cdpPort),
          JAGENTDESK_ELECTRON_USER_DATA_DIR: userData,
          JAGENTDESK_ELECTRON_FLAGS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${cdpPort}`,
        },
      },
      artifactDir,
    );
    children.push(desktop.child);
    await waitForPort(cdpPort, "Electron CDP", desktop);

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const page = await waitForAppPage(browser, expoPort);
    await waitForDesktopStatus(page);

    // Onboarding → Local → Direct connect to the loopback daemon.
    try {
      await page.getByTestId("connection-type-local").first().click({ timeout: 25_000 });
      await delay(400);
      await page.getByTestId("connection-local-continue").first().click({ timeout: 10_000 });
      await delay(1500);
      await page.getByTestId("welcome-direct-connection").first().click({ timeout: 20_000 });
      await delay(700);
      await page.getByTestId("direct-host-input").first().fill("127.0.0.1");
      await page.getByTestId("direct-port-input").first().fill(String(daemonPort));
      await page.getByTestId("direct-host-submit").first().click({ timeout: 10_000 });
      report.steps.push("connected to loopback daemon");
    } catch (e) {
      report.steps.push(`onboarding error: ${String(e).slice(0, 120)}`);
    }

    const dbNav = page.getByTestId("sidebar-databases-nav").first();
    await dbNav.waitFor({ state: "visible", timeout: timeoutMs });
    await dbNav.click();
    await delay(1500);

    // Add connection via the real UI form.
    await page.getByTestId("db-add-connection").first().click({ timeout: 15_000 });
    await delay(500);
    await page.getByTestId("db-engine-postgres").first().click({ timeout: 10_000 });
    await delay(300);
    await page.getByTestId("db-field-displayName").first().fill("Mosa (prod)");
    await page.getByTestId("db-field-host").first().fill(PG.host);
    await page.getByTestId("db-field-port").first().fill(PG.port);
    await page.getByTestId("db-field-database").first().fill(PG.db);
    await page.getByTestId("db-field-user").first().fill(PG.user);
    await page.getByTestId("db-field-password").first().fill(PG.pass);
    report.screenshots.push(await shot(page, artifactDir, "1-add-connection-form"));
    await page.getByTestId("db-save-connect").first().click({ timeout: 10_000 });
    await delay(5000);
    report.checks.connectionListed = await seen(page, "Mosa (prod)");
    report.checks.connectedState = await seen(page, "PostgreSQL 17");
    report.screenshots.push(await shot(page, artifactDir, "2-connected-list"));

    // Open → browse the real schema.
    try {
      await page.getByText("Open", { exact: true }).first().click({ timeout: 15_000 });
    } catch {}
    await delay(4000);
    report.checks.browseShowsRealTables =
      (await seen(page, "companies")) || (await seen(page, "agents"));
    report.screenshots.push(await shot(page, artifactDir, "3-browse-real-schema"));

    // Open a table → real data grid.
    try {
      await page.getByText(PG.table, { exact: true }).first().click({ timeout: 15_000 });
    } catch {}
    await delay(3000);
    report.screenshots.push(await shot(page, artifactDir, "4-data-grid"));

    // SQL console — run a portable introspection query against the real DB.
    try {
      await page.getByText("SQL console", { exact: true }).first().click({ timeout: 15_000 });
      await delay(1500);
      const box = page.getByPlaceholder(/SQL for/i).first();
      await box.click({ timeout: 10_000 });
      await box.fill(
        "select table_schema, count(*) as tables from information_schema.tables group by table_schema order by tables desc",
      );
      await page.getByText("Run", { exact: true }).first().click({ timeout: 10_000 });
      await delay(2500);
      report.checks.consoleRanPublic = await seen(page, "public");
    } catch (e) {
      report.checks.consoleError = String(e).slice(0, 160);
    }
    report.screenshots.push(await shot(page, artifactDir, "5-sql-console"));

    // ER diagram of the real schema (many tables + FK edges).
    try {
      await page.getByText("ER diagram", { exact: true }).first().click({ timeout: 15_000 });
      await delay(3000);
      report.checks.erRendered = await seen(page, "relationships");
    } catch (e) {
      report.checks.erError = String(e).slice(0, 160);
    }
    report.screenshots.push(await shot(page, artifactDir, "6-er-diagram"));

    writeJson(path.join(artifactDir, "report.json"), report);
    const bool = Object.entries(report.checks).filter(([k]) => !k.endsWith("Error"));
    const ok = bool.filter(([, v]) => v === true).length;
    console.log(`\nPG ACCEPTANCE checks: ${ok}/${bool.length} true`);
    console.log(JSON.stringify(report.checks, null, 2));
    console.log(`Artifacts: ${artifactDir}`);
  } catch (error) {
    writeJson(path.join(artifactDir, "report.json"), { ...report, fatal: String(error) });
    console.error(`PG acceptance failed. Artifacts: ${artifactDir}`);
    console.error(error);
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    for (const child of children.toReversed()) stopProcess(child);
    await delay(1000);
    try {
      fs.rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  }
}

await main();
