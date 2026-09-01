#!/usr/bin/env node
// Acceptance against the PACKAGED production desktop app (electron-builder output,
// release/mac-arm64/JAgentDesk.app) — not dev/Metro. Launches the signed .app in
// isolation (random daemon port + temp home + temp user-data so it never touches
// the installed app on 6768), then drives the real UI over CDP + screenshots.

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
const appBinary = path.join(
  desktopDir,
  "release",
  "mac-arm64",
  "JAgentDesk.app",
  "Contents",
  "MacOS",
  "JAgentDesk",
);
const timeoutMs = 150_000;
const DB_ID = "db_accept01";

function reservePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close((e) => (e ? reject(e) : resolve(a.port)));
    });
  });
}
async function waitForPort(port, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const s = net.createConnection({ host: "127.0.0.1", port });
      s.setTimeout(500);
      s.once("connect", () => (s.destroy(), resolve(true)));
      s.once("timeout", () => (s.destroy(), resolve(false)));
      s.once("error", () => resolve(false));
    });
    if (ok) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label} on ${port}`);
}
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
}
function seedSqlite(file) {
  const db = new Database(file);
  db.exec(
    "create table customers (id integer primary key, name text not null);" +
      "create table orders (id integer primary key, customer_id integer references customers(id), status text not null, total real);",
  );
  db.prepare("insert into customers (id, name) values (1,'Acme Corp'),(2,'Globex')").run();
  const ins = db.prepare("insert into orders (customer_id, status, total) values (?,?,?)");
  for (let i = 1; i <= 8; i++) ins.run((i % 2) + 1, i % 3 === 0 ? "shipped" : "paid", i * 12.5);
  db.close();
}
function seedHome(home, listen, sqliteFile) {
  writeJson(path.join(home, "config.json"), {
    version: 1,
    daemon: {
      listen,
      mcp: { enabled: true, injectIntoAgents: false },
      cors: { allowedOrigins: ["*"] },
    },
  });
  writeJson(path.join(home, "databases", "databases.json"), [
    { id: DB_ID, engine: "sqlite", displayName: "Acceptance shop", file: sqliteFile },
  ]);
}
async function findAppPage(browser) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const c of browser.contexts()) {
      for (const p of c.pages()) {
        try {
          const hasBridge = await p.evaluate(
            () => typeof window.jagentdeskDesktop?.invoke === "function",
          );
          if (hasBridge) return p;
        } catch {
          /* page still loading */
        }
      }
    }
    await delay(400);
  }
  throw new Error("Timed out finding the packaged app renderer with the desktop bridge");
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
  if (!fs.existsSync(appBinary)) throw new Error(`Packaged app not found: ${appBinary}`);
  const artifactDir = process.env.ACCEPT_OUT ?? path.join(os.tmpdir(), "jad-db-packaged");
  fs.rmSync(artifactDir, { recursive: true, force: true });
  fs.mkdirSync(artifactDir, { recursive: true });
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jad-pkg-"));
  const home = path.join(runtimeDir, "home");
  const userData = path.join(runtimeDir, "user-data");
  const sqliteFile = path.join(runtimeDir, "shop.sqlite");
  fs.mkdirSync(home, { recursive: true });
  const usePg = Boolean(process.env.PG_HOST);
  if (!usePg) seedSqlite(sqliteFile);

  const [daemonPort, cdpPort] = await Promise.all([reservePort(), reservePort()]);
  const listen = `127.0.0.1:${daemonPort}`;
  // For Postgres we add the connection through the real UI form (secret can't be
  // pre-seeded without the vault key); for SQLite we pre-seed (no secret).
  if (usePg) {
    writeJson(path.join(home, "config.json"), {
      version: 1,
      daemon: {
        listen,
        mcp: { enabled: true, injectIntoAgents: false },
        cors: { allowedOrigins: ["*"] },
      },
    });
  } else {
    seedHome(home, listen, sqliteFile);
  }

  const report = { steps: [], screenshots: [], checks: {}, packaged: true, daemonPort, listen };
  let child = null;
  let browser = null;
  const logPath = path.join(artifactDir, "app.log");
  const log = fs.createWriteStream(logPath, { flags: "a" });
  try {
    // The packaged app has a strict CLI parser (rejects unknown flags), so the
    // remote-debugging switches must come via JAGENTDESK_ELECTRON_FLAGS (applied
    // with appendSwitch before app.whenReady), not as argv.
    child = spawn(appBinary, [], {
      env: {
        ...process.env,
        JAGENTDESK_HOME: home,
        JAGENTDESK_LISTEN: listen,
        JAGENTDESK_ELECTRON_USER_DATA_DIR: userData,
        JAGENTDESK_ELECTRON_REMOTE_DEBUGGING_PORT: String(cdpPort),
        JAGENTDESK_ELECTRON_FLAGS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${cdpPort}`,
        JAGENTDESK_TAILNET_DISABLED: "1",
        JAGENTDESK_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
      },
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    report.steps.push(`launched packaged app pid=${child.pid}`);

    await waitForPort(cdpPort, "packaged Electron CDP");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const page = await findAppPage(browser);
    report.steps.push("found packaged renderer + desktop bridge");
    // Managed daemon (spawned by the packaged app) should come up on our port.
    await waitForPort(daemonPort, "packaged managed daemon").catch(() => {});

    // The packaged app auto-adopts its managed daemon. If onboarding shows,
    // drive Local → Direct connect to our managed daemon port.
    const dbNav = page.getByTestId("sidebar-databases-nav").first();
    try {
      await dbNav.waitFor({ state: "visible", timeout: 30_000 });
    } catch {
      report.steps.push("onboarding shown — connecting Local/direct");
      try {
        await page.getByTestId("connection-type-local").first().click({ timeout: 15_000 });
        await delay(400);
        await page.getByTestId("connection-local-continue").first().click({ timeout: 10_000 });
        await delay(1200);
        await page.getByTestId("welcome-direct-connection").first().click({ timeout: 15_000 });
        await delay(700);
        await page.getByTestId("direct-host-input").first().fill("127.0.0.1");
        await page.getByTestId("direct-port-input").first().fill(String(daemonPort));
        await page.getByTestId("direct-host-submit").first().click({ timeout: 10_000 });
      } catch (e) {
        report.steps.push(`onboarding error: ${String(e).slice(0, 120)}`);
      }
      await dbNav.waitFor({ state: "visible", timeout: 60_000 });
    }
    report.checks.connected = true;
    await dbNav.click();
    await delay(2000);

    if (usePg) {
      // Add a PostgreSQL connection through the real form.
      await page.getByTestId("db-add-connection").first().click({ timeout: 12_000 });
      await delay(500);
      await page.getByTestId("db-engine-postgres").first().click({ timeout: 8_000 });
      await delay(300);
      await page.getByTestId("db-field-displayName").first().fill("Shop (pg)");
      await page.getByTestId("db-field-host").first().fill(process.env.PG_HOST);
      await page
        .getByTestId("db-field-port")
        .first()
        .fill(process.env.PG_PORT ?? "5432");
      await page
        .getByTestId("db-field-database")
        .first()
        .fill(process.env.PG_DB ?? "shop");
      await page
        .getByTestId("db-field-user")
        .first()
        .fill(process.env.PG_USER ?? "postgres");
      await page
        .getByTestId("db-field-password")
        .first()
        .fill(process.env.PG_PASS ?? "");
      await page.getByTestId("db-save-connect").first().click({ timeout: 10_000 });
      await delay(4000);
      report.checks.listShowsConnection = await seen(page, "Shop (pg)");
      report.checks.pgConnected = await seen(page, "PostgreSQL");
    } else {
      report.checks.listShowsConnection = await seen(page, "Acceptance shop");
    }
    report.screenshots.push(await shot(page, artifactDir, "1-databases-list"));

    // Open the connection (it's already connected → the row shows "Open"; if not,
    // Connect first then Open).
    try {
      await page.getByText("Open", { exact: true }).first().click({ timeout: 12_000 });
    } catch {
      try {
        await page.getByText("Connect", { exact: true }).first().click({ timeout: 10_000 });
        await delay(2500);
        await page.getByText("Open", { exact: true }).first().click({ timeout: 10_000 });
      } catch {
        /* leave on list; screenshot captures state */
      }
    }
    await delay(3500);
    report.checks.browseShowsTables =
      (await seen(page, "orders")) && (await seen(page, "customers"));
    report.screenshots.push(await shot(page, artifactDir, "2-browse"));

    // Data grid.
    try {
      await page.getByText("orders", { exact: true }).first().click({ timeout: 12_000 });
    } catch {}
    await delay(2500);
    report.checks.gridShowsData = await seen(page, "shipped");
    report.screenshots.push(await shot(page, artifactDir, "3-data-grid"));

    // Inline cell edit (DataGrip-style): double-tap a status cell → type → blur →
    // Submit → the new value must appear. Only meaningful for the editable SQLite run.
    if (!usePg) {
      try {
        await page.getByText("shipped", { exact: true }).first().dblclick({ timeout: 10_000 });
        await delay(400);
        const input = page.locator("input:focus, textarea:focus").first();
        await input.fill("delivered");
        await page.getByText("Data", { exact: true }).first().click(); // blur → commit edit
        await delay(400);
        report.checks.cellMarkedDirty = await seen(page, "Preview (1)", 5000);
        await page.getByText("Submit", { exact: true }).first().click({ timeout: 8000 });
        await delay(2500);
        report.checks.inlineEditPersisted = await seen(page, "delivered", 8000);
      } catch (e) {
        report.checks.inlineEditError = String(e).slice(0, 120);
      }
      report.screenshots.push(await shot(page, artifactDir, "3b-inline-edit"));
    }

    // Structure grid.
    try {
      await page.getByText("Structure", { exact: true }).first().click({ timeout: 10_000 });
      await delay(1500);
      report.checks.structureGrid = await seen(page, "Nullable");
    } catch {}
    report.screenshots.push(await shot(page, artifactDir, "4-structure"));

    // ER diagram.
    try {
      await page.getByText("ER diagram", { exact: true }).first().click({ timeout: 12_000 });
      await delay(2500);
      report.checks.erRendered = await seen(page, "relationships");
    } catch {}
    report.screenshots.push(await shot(page, artifactDir, "5-er-diagram"));

    writeJson(path.join(artifactDir, "report.json"), report);
    const bool = Object.entries(report.checks);
    const ok = bool.filter(([, v]) => v === true).length;
    console.log(`\nPACKAGED ACCEPTANCE checks: ${ok}/${bool.length} true`);
    console.log(JSON.stringify(report.checks, null, 2));
    console.log(`Artifacts: ${artifactDir}`);
  } catch (error) {
    writeJson(path.join(artifactDir, "report.json"), { ...report, fatal: String(error) });
    console.error(`Packaged acceptance failed. Artifacts: ${artifactDir}`);
    console.error(error);
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    if (child?.pid) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
    await delay(1500);
    log.end();
    try {
      fs.rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  }
}

await main();
