#!/usr/bin/env node
// Final acceptance for the multi-database feature: boots the REAL daemon (tsx
// source) + the REAL Electron desktop + CDP, seeds a real SQLite connection, and
// drives the actual UI — databases list → browse → data grid → SQL console → ER
// diagram — capturing a screenshot at each step. Adapted from browser-tabs.e2e.mjs.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { chromium } from "playwright";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const rootDir = path.resolve(desktopDir, "../..");
const devRunner = path.join(desktopDir, "scripts", "dev-runner.mjs");
const timeoutMs = 120_000;
const DB_ID = "db_accept01";

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) return reject(error);
        resolve(address.port);
      });
    });
  });
}

async function waitForPort(port, label, processInfo) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      processInfo &&
      (processInfo.child.exitCode !== null || processInfo.child.signalCode !== null)
    ) {
      throw new Error(`${label} exited before opening its port; see ${processInfo.logPath}`);
    }
    const ok = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(500);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(false));
    });
    if (ok) return;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label} on port ${port}`);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function seedSqliteFile(file) {
  const db = new Database(file);
  db.exec(
    "create table customers (id integer primary key, name text not null);" +
      "create table orders (id integer primary key, customer_id integer references customers(id), status text not null, total real);",
  );
  db.prepare("insert into customers (id, name) values (?,?)").run(1, "Acme Corp");
  db.prepare("insert into customers (id, name) values (?,?)").run(2, "Globex");
  const ins = db.prepare("insert into orders (customer_id, status, total) values (?,?,?)");
  for (let i = 1; i <= 8; i++) ins.run((i % 2) + 1, i % 3 === 0 ? "shipped" : "paid", i * 12.5);
  db.close();
}

function seedHome(jagentdeskHome, listen, workspaceRoot, sqliteFile) {
  const ts = "2026-01-01T00:00:00.000Z";
  const cwd = path.join(workspaceRoot, "workspace-1");
  fs.mkdirSync(cwd, { recursive: true });
  writeJson(path.join(jagentdeskHome, "config.json"), {
    version: 1,
    daemon: {
      listen,
      mcp: { enabled: true, injectIntoAgents: false },
      cors: { allowedOrigins: ["*"] },
    },
  });
  writeJson(path.join(jagentdeskHome, "projects", "projects.json"), [
    {
      projectId: "project-accept",
      rootPath: cwd,
      kind: "non_git",
      displayName: "Acceptance project",
      customName: null,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
    },
  ]);
  writeJson(path.join(jagentdeskHome, "projects", "workspaces.json"), [
    {
      workspaceId: "workspace-accept",
      projectId: "project-accept",
      cwd,
      kind: "directory",
      displayName: "Acceptance workspace",
      title: "Acceptance workspace",
      branch: null,
      baseBranch: null,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
      pinnedAt: null,
    },
  ]);
  // Pre-seed the database connection so it appears in the UI immediately (SQLite
  // needs no secret). This is the exact shape DatabaseRegistry persists.
  writeJson(path.join(jagentdeskHome, "databases", "databases.json"), [
    { id: DB_ID, engine: "sqlite", displayName: "Acceptance shop", file: sqliteFile },
  ]);
}

function spawnLogged(name, command, args, options, logDir) {
  const logPath = path.join(logDir, `${name}.log`);
  const log = fs.createWriteStream(logPath, { flags: "a" });
  const child = spawn(command, args, {
    ...options,
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
  } catch {
    /* already gone */
  }
}

async function waitForAppPage(browser, expoPort) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().includes(`localhost:${expoPort}`)) return page;
      }
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the Electron app renderer");
}

async function waitForDesktopStatus(page) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await page.evaluate(async () => {
        if (typeof window.jagentdeskDesktop?.invoke !== "function") return null;
        return await window.jagentdeskDesktop.invoke("desktop_daemon_status");
      });
      if (typeof status?.serverId === "string") return status;
    } catch {
      /* Metro may swap the execution context during load */
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the Electron desktop bridge");
}

async function goto(page, route, serverId) {
  await page.evaluate(
    ({ r, id }) => {
      window.location.href = `/h/${id}${r}`;
    },
    { r: route, id: serverId },
  );
  await delay(1500);
}

async function shot(page, dir, name) {
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
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
  const artifactDir = process.env.ACCEPT_OUT ?? path.join(os.tmpdir(), "jad-db-acceptance");
  fs.rmSync(artifactDir, { recursive: true, force: true });
  fs.mkdirSync(artifactDir, { recursive: true });
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jad-db-accept-"));
  const jagentdeskHome = path.join(runtimeDir, "home");
  const userData = path.join(runtimeDir, "electron-user-data");
  const workspaceRoot = path.join(runtimeDir, "workspaces");
  const sqliteFile = path.join(runtimeDir, "shop.sqlite");
  fs.mkdirSync(jagentdeskHome, { recursive: true });

  seedSqliteFile(sqliteFile);

  const [daemonPort, expoPort, cdpPort] = await Promise.all([
    reservePort(),
    reservePort(),
    reservePort(),
  ]);
  const listen = `127.0.0.1:${daemonPort}`;
  seedHome(jagentdeskHome, listen, workspaceRoot, sqliteFile);

  const children = [];
  let browser = null;
  const report = { steps: [], screenshots: [], checks: {} };

  try {
    const commonEnv = {
      ...process.env,
      JAGENTDESK_HOME: jagentdeskHome,
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
    report.steps.push("daemon up");

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
          // Auto-connect the app to our loopback daemon (no Tailscale/pairing),
          // the same override dev-app.sh uses. Must point at our actual port.
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
    report.steps.push("electron+CDP up");

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const page = await waitForAppPage(browser, expoPort);
    const status = await waitForDesktopStatus(page);
    const serverId = status.serverId;
    report.steps.push(`connected serverId=${serverId}`);

    // Onboarding: (1) Connect type → Local → Continue, (2) welcome → Direct
    // connection, (3) fill host/port of our loopback daemon → submit. This is
    // the real "add a host by direct connection" user path — no Tailscale.
    try {
      const localType = page.getByTestId("connection-type-local").first();
      await localType.waitFor({ state: "visible", timeout: 25_000 });
      await localType.click();
      await delay(400);
      await page.getByTestId("connection-local-continue").first().click({ timeout: 10_000 });
      report.steps.push("selected Local connect");
      await delay(2000);
    } catch {
      report.steps.push("no connect-type chooser");
    }
    try {
      await page.getByTestId("welcome-direct-connection").first().click({ timeout: 20_000 });
      await delay(800);
      const host = page.getByTestId("direct-host-input").first();
      await host.waitFor({ state: "visible", timeout: 15_000 });
      await host.fill("127.0.0.1");
      await page.getByTestId("direct-port-input").first().fill(String(daemonPort));
      await page.getByTestId("direct-host-submit").first().click({ timeout: 10_000 });
      report.steps.push(`direct-connect 127.0.0.1:${daemonPort}`);
      await delay(3000);
    } catch (error) {
      report.steps.push(`direct-connect step error: ${String(error).slice(0, 120)}`);
    }

    // Wait for the app to connect to the loopback daemon and render the sidebar
    // (the "Databases" entry we added). Non-fatal: capture state either way.
    const dbNav = page.getByTestId("sidebar-databases-nav").first();
    try {
      await dbNav.waitFor({ state: "visible", timeout: 60_000 });
      report.steps.push("sidebar Databases entry visible");
      report.checks.connectedSidebar = true;
      await dbNav.click();
      await delay(2000);
    } catch {
      report.checks.connectedSidebar = false;
      report.steps.push("sidebar not visible — capturing onboarding state");
      report.screenshots.push(await shot(page, artifactDir, "0-onboarding-state"));
      // Try deep-linking straight to databases anyway.
      await goto(page, "/databases", serverId);
      await delay(2000);
    }

    // 1. Databases list — the seeded connection must appear.
    report.checks.listShowsConnection = await seen(page, "Acceptance shop");
    report.checks.listShowsEngine = await seen(page, "sqlite");
    report.screenshots.push(await shot(page, artifactDir, "1-databases-list"));

    // 1b. The connect-DB form (Add connection → PostgreSQL shows the full field set).
    try {
      await page.getByTestId("db-add-connection").first().click({ timeout: 10_000 });
      await delay(500);
      await page.getByTestId("db-engine-postgres").first().click({ timeout: 8_000 });
      await delay(400);
      report.checks.connectFormFields = await seen(page, "Password");
      report.screenshots.push(await shot(page, artifactDir, "1b-connect-db-form"));
      await page.getByText("Cancel", { exact: true }).first().click({ timeout: 8_000 });
      await delay(600);
    } catch (e) {
      report.steps.push(`connect-form error: ${String(e).slice(0, 100)}`);
    }

    // 2. Connect + Open the seeded connection (the real button flow).
    try {
      await page.getByText("Connect", { exact: true }).first().click({ timeout: 15_000 });
      await delay(2500);
      await page.getByText("Open", { exact: true }).first().click({ timeout: 15_000 });
    } catch {
      // Fallback: deep-link into the browse route (host is connected now).
      await goto(page, `/database/${DB_ID}`, serverId);
    }
    await delay(3500);
    report.checks.browseShowsTables =
      (await seen(page, "orders")) && (await seen(page, "customers"));
    report.checks.browseShowsOverviewOrEngine = await seen(page, "sqlite");
    report.screenshots.push(await shot(page, artifactDir, "2-browse-overview"));

    // 3. Open the orders table → data grid with real rows.
    try {
      await page.getByText("orders", { exact: true }).first().click({ timeout: 15_000 });
    } catch {
      /* fall through; screenshot still captures state */
    }
    await delay(2500);
    report.checks.gridShowsStatusColumn = await seen(page, "status");
    report.checks.gridShowsShipped = await seen(page, "shipped");
    report.screenshots.push(await shot(page, artifactDir, "3-data-grid"));

    // 3b. Structure view (DataGrip-like columns grid: Name/Type/Nullable/Key/Default).
    try {
      await page.getByText("Structure", { exact: true }).first().click({ timeout: 10_000 });
      await delay(1500);
      report.checks.structureShowsGrid = await seen(page, "Nullable");
      report.screenshots.push(await shot(page, artifactDir, "3b-structure"));
    } catch (e) {
      report.steps.push(`structure error: ${String(e).slice(0, 100)}`);
    }

    // 4. SQL console → run a query.
    try {
      await page.getByText("SQL console", { exact: true }).first().click({ timeout: 15_000 });
      await delay(1500);
      const box = page.getByPlaceholder(/SQL for/i).first();
      await box.click({ timeout: 10_000 });
      await box.fill("select status, count(*) as n from orders group by status");
      await page.getByText("Run", { exact: true }).first().click({ timeout: 10_000 });
      await delay(2500);
    } catch (error) {
      report.checks.consoleError = String(error);
    }
    report.checks.consoleRan = await seen(page, "row");
    report.screenshots.push(await shot(page, artifactDir, "4-sql-console"));

    // 5. ER diagram — boxes + FK edge (orders → customers).
    try {
      await page.getByText("ER diagram", { exact: true }).first().click({ timeout: 15_000 });
      await delay(2500);
    } catch (error) {
      report.checks.erError = String(error);
    }
    report.checks.erShowsRelationships = await seen(page, "relationships");
    report.screenshots.push(await shot(page, artifactDir, "5-er-diagram"));

    writeJson(path.join(artifactDir, "report.json"), report);
    const passed = Object.entries(report.checks).filter(([k]) => !k.endsWith("Error"));
    const ok = passed.filter(([, v]) => v === true).length;
    console.log(`\nACCEPTANCE checks: ${ok}/${passed.length} true`);
    console.log(JSON.stringify(report.checks, null, 2));
    console.log(`Artifacts (screenshots + logs + report.json): ${artifactDir}`);
  } catch (error) {
    console.error(`Acceptance failed. Artifacts: ${artifactDir}`);
    console.error(error);
    writeJson(path.join(artifactDir, "report.json"), { ...report, fatal: String(error) });
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    for (const child of children.toReversed()) stopProcess(child);
    await delay(1000);
    try {
      fs.rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* best effort */
    }
  }
}

await main();
