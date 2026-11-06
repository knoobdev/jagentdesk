#!/usr/bin/env node
// W9 real E2E for Figma standalone browsing + playback (ADR-0037, ADR-0038, spec 32.11).
//
// FULL E2E, not a scaffold test: boots an isolated daemon and a real Electron app on reserved
// ports (the production daemon on 6767 is never restarted), drives the actual renderer through
// Playwright over CDP, and verifies the REST data flow through `figma.*` RPCs plus a recording
// pass-through proxy in front of api.figma.com. Every gate must be exercised with real data:
// there is no skip-to-green and no ALLOW_BLOCKED. A missing credential, a 403, or a missing
// website session is a RED with the unexercised gates listed.
//
// Inputs (environment):
//   JAGENTDESK_FIGMA_E2E_ACCESS_TOKEN    a valid, read-only Figma access token — THE only input
//                                        the parent supplies at run time. No refresh, no rotation
//                                        side effects: the harness never refreshes and never reads
//                                        the vault itself. Absence is a RED at the credentials gate
//                                        BEFORE any heavy boot.
//   JAGENTDESK_FIGMA_E2E_FILE_KEY        real file key or full figma.com URL; defaults to the
//                                        parent-verified file (2026-11-06: /me 200, meta 200,
//                                        depth-1/2 200, no 403 on this connection).
//   JAGENTDESK_FIGMA_E2E_FRAME_IDS       optional comma list of playback ids (default: from the outline)
//   JAGENTDESK_FIGMA_STANDALONE_E2E_ARTIFACT_DIR  evidence output directory
//
// Identity is populated ONLY from the real `GET /v1/me` answer — never a fabricated account row,
// no dummy client credentials. The `Browse files` control and the prototype player are driven
// through actual product UI clicks; the WS outline/playback checks are API-integration proof and
// are labelled as such. The real-website browse gate stays BLOCKED until an actual authenticated
// selection happens inside the guest — no injected location.assign, no DOM injection into Figma.
//
// The >=500-frame criterion counts FRAME nodes through the WHOLE document tree: this file nests
// screens inside SECTIONs (depth-2 yields 24 top FRAME + 209 SECTION), so a top-level count
// cannot prove it. That deep count is a pre-boot read-only data diagnostic against
// api.figma.com directly; the app's own REST trace must still show no full-document fetch.
import { spawn, execFileSync } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { chromium } from "playwright";
import { DaemonClient } from "@jagentdesk/client/internal/daemon-client";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const rootDir = path.resolve(desktopDir, "../..");
const devRunner = path.join(desktopDir, "scripts", "dev-runner.mjs");
const serverDevRunner = path.join(rootDir, "packages/server/scripts/dev-runner.ts");
const desktopMain = path.join(desktopDir, "dist", "main.js");

const bootTimeoutMs = 240_000;
const figmaTimeoutMs = 60_000;
const canvasDeadlineMs = 3_000; // spec 32.11 #2: canvas with viewport frames in <= 3 s
const appRamBudgetMb = 300; // spec 32.11 #2: app RAM growth < 300 MB
const minFps = 50; // spec 32.11 #2: pan/zoom >= 50 fps
const minFrames = 500; // spec 32.11 #2: a real file with >= 500 frames
const CONNECTION_ID = "fgc_w9_harness";
const WORKSPACE_ID = "figma-standalone-w9";
const FIGMA_API_ORIGIN = "https://api.figma.com";
const FIGMA_FILE_KINDS = new Set(["design", "file", "proto"]);
// Parent-verified 2026-11-06. A version that moved on is reported, not failed: playback pins the
// live version, and this file is a snapshot, not a frozen fixture.
const VERIFIED_FILE_KEY = "aGsoYCbRX1CH7o1yuaN7Hf";
const VERIFIED_FILE_VERSION = "2418589277144612492";

const GATE_NAMES = [
  "desktop-build",
  "credentials",
  "me-identity",
  "file-access",
  "file-size-500-frames",
  "boot-isolated-daemon",
  "boot-electron-renderer",
  "capability-advertisement",
  "ui-figma-section",
  "ui-browse-files",
  "ui-picker-selection",
  "ui-picker-cancel",
  "api-file-add",
  "api-outline",
  "api-playback-cold",
  "api-playback-warm-zero-rest",
  "net-url-trace",
  "ui-file-open",
  "ui-player-open",
  "perf-app-ram-tree",
  "perf-playback-fps",
];

const gates = new Map();
function passGate(name, measurements) {
  gates.set(name, { status: "PASS", measurements });
  console.log(`  PASS       ${name}${measurements ? ` ${JSON.stringify(measurements)}` : ""}`);
}
function failGate(name, detail) {
  gates.set(name, { status: "FAIL", detail });
  console.log(`  FAIL       ${name}: ${detail}`);
}
function blockedGate(name, detail) {
  gates.set(name, { status: "BLOCKED", detail });
  console.log(`  BLOCKED    ${name}: ${detail}`);
}
function unimplementedGate(name, detail) {
  gates.set(name, { status: "UNIMPLEMENTED", detail });
  console.log(`  UNIMPL     ${name}: ${detail}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) return reject(error);
        if (!address || typeof address === "string")
          return reject(new Error("Failed to reserve a local port"));
        resolve(address.port);
      });
    });
  });
}

async function portBusy(port) {
  return await new Promise((resolve) => {
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
}

async function waitForPort(port, label, processInfo) {
  const deadline = Date.now() + bootTimeoutMs;
  while (Date.now() < deadline) {
    if (processInfo && processInfo.child.exitCode !== null) {
      throw new Error(
        `${label} process exited (code ${processInfo.child.exitCode}) before opening its port; see ${processInfo.logPath}`,
      );
    }
    if (await portBusy(port)) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label} on port ${port}`);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
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
    // The process may exit between the liveness check and signal delivery.
  }
}

/** RSS of every descendant of rootPid: Electron main, renderer, GPU and helper processes. */
function treeRssKb(rootPid) {
  let out;
  try {
    out = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" });
  } catch {
    return { totalKb: 0, procs: 0 };
  }
  const rows = [];
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (match)
      rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]) });
  }
  const childrenOf = new Map();
  for (const row of rows) {
    const list = childrenOf.get(row.ppid) ?? [];
    list.push(row);
    childrenOf.set(row.ppid, list);
  }
  const tree = [];
  const walk = (pid) => {
    const self = rows.find((row) => row.pid === pid);
    if (!self) return;
    tree.push(self);
    for (const child of childrenOf.get(pid) ?? []) walk(child.pid);
  };
  walk(rootPid);
  return { totalKb: tree.reduce((sum, row) => sum + row.rssKb, 0), procs: tree.length };
}

const SEAL_KEY = randomBytes(32);

function sealSecret(plaintext) {
  // Mirrors FileSecretStore.set: AES-256-GCM {iv,tag,data} base64 under the 32-byte raw key.
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", SEAL_KEY, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function parseFileKeyInput(input) {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9]+(?::[A-Za-z0-9]+)?$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const parts = url.pathname.split("/").filter(Boolean);
    if (FIGMA_FILE_KINDS.has(parts[0]) && /^[A-Za-z0-9]+(?::[A-Za-z0-9]+)?$/.test(parts[1] ?? ""))
      return parts[1];
  } catch {
    /* not a url */
  }
  return null;
}

/** Real read-only GET against api.figma.com with the parent-provided token. Never refreshes. */
async function figmaApiGet(token, apiPath, query) {
  const url = new URL(`${FIGMA_API_ORIGIN}${apiPath}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  let body = null;
  try {
    body = JSON.parse(await response.text());
  } catch {
    /* non-JSON body: the status carries the verdict */
  }
  return { status: response.status, body };
}

/**
 * Count FRAME nodes through the whole document tree. The verified file nests screens inside
 * SECTIONs (depth-2 gives 24 top FRAME + 209 SECTION), so only the recursive total answers
 * spec 32.11 #2's >=500-frame criterion.
 */
function countFrameNodes(node) {
  if (!node || typeof node !== "object") return 0;
  let total = String(node.type).toUpperCase() === "FRAME" ? 1 : 0;
  for (const child of node.children ?? []) total += countFrameNodes(child);
  return total;
}

// ── recording pass-through proxy ─────────────────────────────────────────────
// The daemon is pointed at this proxy via JAGENTDESK_FIGMA_API_URL, so every REST call the app
// made is captured as a URL trace — Tier-1 budget counts alone cannot prove the absence of a
// full-document fetch.

function startFigmaProxy() {
  const log = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const url = new URL(req.url, FIGMA_API_ORIGIN);
      const entry = {
        method: req.method,
        pathname: url.pathname,
        search: Object.fromEntries(url.searchParams),
        at: Date.now(),
      };
      log.push(entry);
      try {
        const upstream = await fetch(url, {
          method: req.method,
          headers: {
            Authorization: req.headers.authorization ?? "",
            Accept: req.headers.accept ?? "application/json",
            ...(req.headers["content-type"] ? { "Content-Type": req.headers["content-type"] } : {}),
          },
          body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
          signal: AbortSignal.timeout(60_000),
        });
        const body = Buffer.from(await upstream.arrayBuffer());
        entry.status = upstream.status;
        res.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
        });
        res.end(body);
      } catch (error) {
        entry.status = 0;
        entry.error = String(error);
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ err: `e2e proxy: ${String(error)}` }));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("proxy has no port"));
      resolve({ server, port: address.port, log });
    });
  });
}

// ── isolated app boot helpers (same model as browser-tabs.e2e.mjs) ───────────

function seedJAgentDeskHome(jagentdeskHome, listen, workspaceRoot) {
  const timestamp = new Date().toISOString();
  const cwd = path.join(workspaceRoot, "workspace-1");
  fs.mkdirSync(cwd, { recursive: true });
  writeJson(path.join(jagentdeskHome, "config.json"), {
    version: 1,
    daemon: {
      listen,
      mcp: { enabled: false, injectIntoAgents: false },
      cors: { allowedOrigins: ["*"] },
    },
  });
  writeJson(path.join(jagentdeskHome, "projects", "projects.json"), [
    {
      projectId: "project-figma-w9",
      rootPath: cwd,
      kind: "non_git",
      displayName: "Figma E2E project",
      customName: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    },
  ]);
  writeJson(path.join(jagentdeskHome, "projects", "workspaces.json"), [
    {
      workspaceId: WORKSPACE_ID,
      projectId: "project-figma-w9",
      cwd,
      kind: "directory",
      displayName: "Figma E2E workspace",
      title: "Figma E2E workspace",
      branch: null,
      baseBranch: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
      pinnedAt: null,
    },
  ]);
}

/**
 * Seed a connection the way oauth.ts persists one. The account is the REAL `/v1/me` answer —
 * never a fabricated name — and the token expires far enough out that the daemon never triggers
 * a refresh during the run: no rotation side effects, no client credentials involved.
 */
function seedFigmaState(jagentdeskHome, { accessToken, account }) {
  const figmaDir = path.join(jagentdeskHome, "figma");
  fs.mkdirSync(figmaDir, { recursive: true });
  fs.writeFileSync(path.join(figmaDir, "secret.key"), SEAL_KEY.toString("base64"), {
    mode: 0o600,
  });
  const tokens = {
    accessToken,
    refreshToken: "",
    expiresAt_ms: Date.now() + 6 * 60 * 60 * 1000,
  };
  writeJson(path.join(figmaDir, "secrets.json"), {
    [`figma/${CONNECTION_ID}/tokens`]: sealSecret(JSON.stringify(tokens)),
  });
  writeJson(path.join(figmaDir, "connections.json"), {
    connections: [
      {
        id: CONNECTION_ID,
        account,
        authState: "connected",
        createdAt_ms: Date.now(),
      },
    ],
  });
  writeJson(path.join(figmaDir, "files.json"), { files: [] });
  writeJson(path.join(figmaDir, "teams.json"), { teams: [] });
}

async function waitForAppPage(browser, expoPort) {
  const deadline = Date.now() + bootTimeoutMs;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().includes(`localhost:${expoPort}`)) return page;
      }
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the real Electron app renderer");
}

async function waitForDesktopStatus(page) {
  const deadline = Date.now() + bootTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await page.evaluate(async () => {
        if (typeof window.jagentdeskDesktop?.invoke !== "function") return null;
        return await window.jagentdeskDesktop.invoke("desktop_daemon_status");
      });
      if (typeof status?.serverId === "string") return status;
    } catch {
      // Metro may replace the execution context during the initial load.
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the Electron desktop bridge");
}

async function connectDaemonClient(port) {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId: `clid_figma_w9_${randomBytes(3).toString("hex")}`,
    clientType: "cli",
    appVersion: "0.9.54",
    webSocketFactory: (u, o) => new WebSocket(u, o?.protocols, { headers: o?.headers }),
  });
  await client.connect();
  await delay(500);
  return client;
}

async function figmaRequest(client, type, params, options = {}) {
  const timeoutMs = options.timeoutMs ?? figmaTimeoutMs;
  try {
    const payload = await Promise.race([
      client.figmaRequest(type, params, { timeoutMs }),
      delay(timeoutMs + 2_000, { __harnessTimeout: true }),
    ]);
    if (payload?.__harnessTimeout)
      return {
        error: { code: "harness_timeout", message: `${type} got no answer in ${timeoutMs}ms` },
      };
    return payload;
  } catch (error) {
    // Inbound-validation rejections answer `rpc_error`; surface them as an error payload.
    if (error?.code && error?.requestType)
      return { error: { code: error.code, message: String(error.error ?? error.message) } };
    if (typeof error?.error === "string" && error?.requestId)
      return { error: { code: error.code ?? "daemon_rpc_error", message: error.error } };
    throw error;
  }
}

function classifyFigmaError(error) {
  const code = error?.code;
  if (code === "forbidden") return "BLOCKED_FIGMA_403";
  if (code === "needs_reauth" || code === "auth_failed") return "BLOCKED_FIGMA_AUTH";
  if (code === "network" || code === "rate_limited") return "BLOCKED_FIGMA_NETWORK";
  return "FAILED";
}

// ── main ─────────────────────────────────────────────────────────────────────

// eslint-disable-next-line eslint(complexity) -- harness gate flow: every gate records its own verdict.
async function main() {
  const artifactDir =
    process.env.JAGENTDESK_FIGMA_STANDALONE_E2E_ARTIFACT_DIR ??
    fs.mkdtempSync(path.join(os.tmpdir(), "jagentdesk-figma-standalone-e2e-"));
  fs.mkdirSync(artifactDir, { recursive: true });
  const evidence = { startedAt: new Date().toISOString(), gates: {}, artifactDir };

  const accessToken = process.env.JAGENTDESK_FIGMA_E2E_ACCESS_TOKEN ?? "";
  const fileKeyInput = process.env.JAGENTDESK_FIGMA_E2E_FILE_KEY || VERIFIED_FILE_KEY;
  const configuredFrames = (process.env.JAGENTDESK_FIGMA_E2E_FRAME_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const fileKey = fileKeyInput ? parseFileKeyInput(fileKeyInput) : null;

  // ── pre-boot gates: everything cheap is proven before ANY heavy process starts ──
  let exitCode = 0;
  let account = null;
  try {
    if (fs.existsSync(desktopMain)) {
      passGate("desktop-build", {
        path: desktopMain,
        note: "integrator-owned merged build; this harness never auto-builds",
      });
    } else {
      failGate(
        "desktop-build",
        `missing ${desktopMain} — the integrator must run the merged build:desktop before this run`,
      );
      finish(evidence, gates, artifactDir);
      process.exit(1);
    }

    if (!accessToken) {
      failGate(
        "credentials",
        "JAGENTDESK_FIGMA_E2E_ACCESS_TOKEN is missing — the parent supplies a valid access token at run time; RED without booting the app (the vault is not read by this harness)",
      );
      finish(evidence, gates, artifactDir);
      process.exit(1);
    }
    if (!fileKey) throw new Error(`unparseable file key input: ${fileKeyInput}`);
    passGate("credentials", { fileKey, tokenLength: accessToken.length });

    const me = await figmaApiGet(accessToken, "/v1/me");
    if (me.status !== 200 || !me.body?.id) {
      blockedGate(
        "me-identity",
        `GET /v1/me answered ${me.status} — no real account identity (no token refresh attempted)`,
      );
      finish(evidence, gates, artifactDir);
      process.exit(1);
    }
    account = {
      figmaUserId: String(me.body.id),
      handle: String(me.body.handle ?? ""),
      email: typeof me.body.email === "string" ? me.body.email : null,
    };
    evidence.account = account;
    passGate("me-identity", { figmaUserId: account.figmaUserId, handle: account.handle });

    const meta = await figmaApiGet(accessToken, `/v1/files/${encodeURIComponent(fileKey)}/meta`);
    if (meta.status === 403) {
      blockedGate(
        "file-access",
        `GET /v1/files/${fileKey}/meta answered 403 — the current account cannot read this file (spec 32.11 #16)`,
      );
      finish(evidence, gates, artifactDir);
      process.exit(1);
    }
    if (meta.status !== 200) {
      failGate("file-access", `GET /v1/files/${fileKey}/meta answered ${meta.status}`);
      finish(evidence, gates, artifactDir);
      process.exit(1);
    }
    const fileMeta = meta.body?.file ?? meta.body ?? {};
    if (!fileMeta.name) {
      failGate("file-access", "meta returned no file name");
      finish(evidence, gates, artifactDir);
      process.exit(1);
    }
    evidence.fileMeta = { name: fileMeta.name, version: fileMeta.version ?? null };
    passGate("file-access", { name: fileMeta.name });

    const fullDocument = await figmaApiGet(accessToken, `/v1/files/${encodeURIComponent(fileKey)}`);
    if (fullDocument.status !== 200) {
      failGate(
        "file-size-500-frames",
        `full-document data diagnostic answered ${fullDocument.status}`,
      );
    } else {
      const frames = countFrameNodes(fullDocument.body?.document);
      evidence.totalFrameNodes = frames;
      if (frames >= minFrames)
        passGate("file-size-500-frames", {
          frames,
          method: "recursive FRAME count of the full document (pre-boot read-only data diagnostic)",
        });
      else
        failGate(
          "file-size-500-frames",
          `real file has ${frames} FRAME nodes across the whole tree — spec 32.11 #2 demands >= ${minFrames}; pick a bigger file for green`,
        );
    }
    if (evidence.fileMeta.version && evidence.fileMeta.version !== VERIFIED_FILE_VERSION) {
      console.log(
        `  note       file version moved from ${VERIFIED_FILE_VERSION} to ${evidence.fileMeta.version} (playback pins the live version)`,
      );
    }
  } catch (error) {
    console.error(error);
    evidence.failedWith = String(error?.message ?? error);
    finish(evidence, gates, artifactDir);
    process.exit(2);
  }

  // ── heavy boot: isolated daemon + real Electron + recording proxy ────────────
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jagentdesk-figma-standalone-e2e-"));
  const jagentdeskHome = path.join(runtimeDir, "jagentdesk-home");
  const userData = path.join(runtimeDir, "electron-user-data");
  const workspaceRoot = path.join(runtimeDir, "workspaces");
  fs.mkdirSync(jagentdeskHome, { recursive: true });

  const productionDaemonBusy = await portBusy(6767);
  const [daemonPort, expoPort, cdpPort] = await Promise.all([
    reservePort(),
    reservePort(),
    reservePort(),
  ]);
  const listen = `127.0.0.1:${daemonPort}`;
  seedJAgentDeskHome(jagentdeskHome, listen, workspaceRoot);
  seedFigmaState(jagentdeskHome, { accessToken, account });

  const children = [];
  let browser = null;
  let client = null;
  let proxy = null;
  let ramSampler = null;

  try {
    proxy = await startFigmaProxy();
    const commonEnv = {
      ...process.env,
      JAGENTDESK_HOME: jagentdeskHome,
      JAGENTDESK_LISTEN: listen,
      JAGENTDESK_DAEMON_ENDPOINT: `localhost:${daemonPort}`,
      JAGENTDESK_CORS_ORIGINS: "*",
      JAGENTDESK_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
      JAGENTDESK_DICTATION_ENABLED: "0",
      JAGENTDESK_VOICE_MODE_ENABLED: "0",
      JAGENTDESK_FIGMA_API_URL: `http://127.0.0.1:${proxy.port}`,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    };

    const daemonBootStart = Date.now();
    const daemon = spawnLogged(
      "daemon",
      process.execPath,
      ["--import", "tsx", serverDevRunner],
      { cwd: rootDir, env: { ...commonEnv, JAGENTDESK_NODE_ENV: "development" } },
      artifactDir,
    );
    children.push(daemon.child);
    await waitForPort(daemonPort, "isolated daemon", daemon);
    assert(daemonPort !== 6767, "isolated daemon must not use the production port 6767");
    passGate("boot-isolated-daemon", {
      daemonPort,
      bootMs: Date.now() - daemonBootStart,
      productionDaemonBusy,
    });

    const appBootStart = Date.now();
    const desktop = spawnLogged(
      "desktop",
      process.execPath,
      [devRunner, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
      {
        cwd: rootDir,
        env: {
          ...commonEnv,
          EXPO_PORT: String(expoPort),
          EXPO_DEV_URL: `http://localhost:${expoPort}`,
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
    const status = await waitForDesktopStatus(page);
    passGate("boot-electron-renderer", {
      serverId: status.serverId,
      bootMs: Date.now() - appBootStart,
    });

    // Continuous app-tree RAM sampling for the whole session
    // (spec 32.11 #2: RAM before/peak/after close; daemon measured separately).
    const ram = { baselineKb: 0, peakKb: 0, afterCloseKb: null, samples: [] };
    ramSampler = setInterval(() => {
      const { totalKb } = treeRssKb(desktop.child.pid);
      if (totalKb > 0) {
        ram.samples.push({ at: Date.now(), totalKb });
        ram.peakKb = Math.max(ram.peakKb, totalKb);
      }
    }, 250);
    ram.baselineKb = treeRssKb(desktop.child.pid).totalKb;
    evidence.daemonRssKb = treeRssKb(daemon.child.pid).totalKb;

    client = await connectDaemonClient(daemonPort);
    const serverInfo = client.getLastServerInfoMessage();
    assert(serverInfo, "no server_info after connect");
    if (serverInfo.features?.figma === true && serverInfo.features?.figmaPlayback === true) {
      passGate("capability-advertisement", { figma: true, figmaPlayback: true });
    } else {
      failGate(
        "capability-advertisement",
        `server_info.features=${JSON.stringify(serverInfo.features)}`,
      );
    }

    // ── UI: open the Figma section through the real sidebar ────────────────────
    const openFigmaSection = async () => {
      await page
        .getByTestId(`sidebar-workspace-row-${status.serverId}:${WORKSPACE_ID}`)
        .click({ timeout: bootTimeoutMs });
      const figmaNav = page.getByTestId("sidebar-figma-nav");
      await figmaNav.waitFor({ state: "visible", timeout: 30_000 });
      await figmaNav.click();
      await page
        .getByTestId("figma-files-empty")
        .or(page.getByTestId("figma-files-home"))
        .waitFor({ state: "visible", timeout: 30_000 });
    };
    await openFigmaSection();
    passGate("ui-figma-section", { reached: "figma files home" });
    await page.screenshot({ path: path.join(artifactDir, "figma-section.png") });

    // ── UI: Browse files (W2 product control) ──────────────────────────────────
    const browseButton = page.getByTestId("figma-browse-files");
    if (await browseButton.isVisible().catch(() => false)) {
      passGate("ui-browse-files", { via: "real product control figma-browse-files" });
    } else {
      unimplementedGate(
        "ui-browse-files",
        "no Browse files control in the product UI yet — W2 owns the button that opens the picker",
      );
    }

    // ── UI: real selection through the picker guest (W1 seed bridge) ────────────
    await runPickerGate(page, browser, artifactDir, { fileKey });

    // ── API-integration proof (WS RPCs; NOT the player E2E) ────────────────────
    await runApiGates(client, jagentdeskHome, proxy, {
      fileKey,
      fileMetaName: evidence.fileMeta.name,
      configuredFrames,
      evidence,
    });

    // ── UI: open the file and the player through real clicks ───────────────────
    await runUiPlaybackGates(page, ram, canvasDeadlineMs, minFps, desktop.child.pid, fileKey, {
      artifactDir,
      refreshUi: async () => {
        // The file entered the daemon store over WS; reload and re-navigate the real product UI
        // so the files home shows it — a user-visible refresh, not DOM injection into Figma.
        await page.reload({ waitUntil: "domcontentloaded", timeout: bootTimeoutMs });
        await waitForDesktopStatus(page);
        await openFigmaSection();
      },
    });

    // ── app-tree RAM gate ──────────────────────────────────────────────────────
    if (ram.samples.length === 0) {
      failGate("perf-app-ram-tree", "the RAM sampler collected no process-tree samples");
    } else {
      const peakGrowthMb = (ram.peakKb - ram.baselineKb) / 1024;
      const closeGrowthMb =
        ram.afterCloseKb === null ? null : (ram.afterCloseKb - ram.baselineKb) / 1024;
      evidence.ram = {
        baselineMb: Math.round(ram.baselineKb / 1024),
        peakMb: Math.round(ram.peakKb / 1024),
        afterCloseMb: ram.afterCloseKb === null ? null : Math.round(ram.afterCloseKb / 1024),
        samples: ram.samples.length,
        daemonRssMb: Math.round(evidence.daemonRssKb / 1024),
      };
      if (
        peakGrowthMb < appRamBudgetMb &&
        (closeGrowthMb === null || closeGrowthMb < appRamBudgetMb)
      ) {
        passGate("perf-app-ram-tree", {
          peakGrowthMb: peakGrowthMb.toFixed(1),
          afterCloseGrowthMb: closeGrowthMb === null ? null : closeGrowthMb.toFixed(1),
        });
      } else {
        failGate(
          "perf-app-ram-tree",
          `app process tree grew ${peakGrowthMb.toFixed(0)}MB peak / ${
            closeGrowthMb === null ? "?" : closeGrowthMb.toFixed(0)
          }MB after close — budget ${appRamBudgetMb}MB`,
        );
      }
    }

    // ── URL trace gate: real proof of which REST shapes the app touched ─────────
    runUrlTraceGate(proxy.log, fileKey);
  } catch (error) {
    console.error(`Figma standalone E2E failed. Artifacts: ${artifactDir}`);
    console.error(error);
    evidence.failedWith = String(error?.message ?? error);
    exitCode = 2;
  } finally {
    if (ramSampler) clearInterval(ramSampler);
    await client?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    proxy?.server.close();
    for (const child of children.toReversed()) stopProcess(child);
    await delay(1_000);
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) stopProcess(child);
    }
    await delay(500);
    try {
      fs.rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      console.warn(`Failed to remove isolated E2E state ${runtimeDir}`);
    }
  }

  exitCode = finish(evidence, gates, artifactDir) || exitCode;
  process.exit(exitCode);
}

/** Opens the guest through the W1 preload bridge and clicks a REAL Files entry — no injected URL. */
async function runPickerGate(page, browser, artifactDir, { fileKey }) {
  const openGuest = async () => {
    const before = new Set(browser.contexts().flatMap((context) => context.pages()));
    await page.evaluate(() => {
      globalThis.__jagentdeskFigmaPicker =
        globalThis.window?.jagentdeskDesktop?.figma?.pickFile?.() ??
        Promise.resolve({ kind: "no-bridge" });
    });
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      for (const context of browser.contexts()) {
        for (const guest of context.pages()) {
          // The only new window the app may open is the Files guest; a login redirect can carry
          // it to the SSO host, so any new https target counts as the guest.
          if (!before.has(guest) && guest.url().startsWith("https://")) return guest;
        }
      }
      await delay(250);
    }
    return null;
  };

  let guest = null;
  try {
    guest = await openGuest();
  } catch (error) {
    failGate("ui-picker-selection", `the picker bridge threw: ${String(error)}`);
    return;
  }
  if (!guest) {
    failGate(
      "ui-picker-selection",
      "pickFile() opened no guest window — the desktop Files picker is not working",
    );
    return;
  }
  await guest.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
  await delay(3_000);
  await guest
    .screenshot({ path: path.join(artifactDir, "picker-guest.png") })
    .catch(() => undefined);
  const landedUrl = guest.url();
  if (
    /figma\.com\/(login|email|handle-auth|oauth)/.test(landedUrl) ||
    !/figma\.com/.test(landedUrl)
  ) {
    blockedGate(
      "ui-picker-selection",
      `guest landed on ${landedUrl} — the embedded Figma website session is not signed in (spec 32.11 #14: record the failure, do not substitute an image or a self-made list)`,
    );
    gates.set("ui-picker-cancel", {
      status: "UNEXERCISED",
      detail: "the website session gate stopped the picker lifecycle",
    });
    await guest.close().catch(() => undefined);
    return;
  }
  // Real user selection: click the anchor for the configured file in the Files list.
  const selector = `a[href*="/design/${fileKey}"], a[href*="/file/${fileKey}"], a[href*="/proto/${fileKey}"]`;
  const anchor = guest.locator(selector).first();
  const anchorVisible = await anchor.isVisible({ timeout: 20_000 }).catch(() => false);
  if (!anchorVisible) {
    blockedGate(
      "ui-picker-selection",
      `the signed-in Files page shows no entry for file ${fileKey} — provide a file the account actually has (no fake file URLs)`,
    );
    gates.set("ui-picker-cancel", {
      status: "UNEXERCISED",
      detail: "the signed-in Files list did not show the file",
    });
    await guest.close().catch(() => undefined);
    return;
  }
  const href = await anchor.getAttribute("href");
  const pickPromise = page.evaluate(() => globalThis.__jagentdeskFigmaPicker);
  const start = Date.now();
  await anchor.click();
  let picked = null;
  try {
    picked = await Promise.race([pickPromise, delay(20_000, { kind: "timeout" })]);
  } catch (error) {
    failGate("ui-picker-selection", `the pick promise rejected: ${String(error)}`);
    return;
  }
  const capturedOk =
    picked?.kind === "file" &&
    typeof picked.url === "string" &&
    /^https:\/\/(www\.)?figma\.com\//.test(picked.url) &&
    picked.url.includes(fileKey);
  if (capturedOk) {
    passGate("ui-picker-selection", {
      url: picked.url,
      clickedHref: href,
      ms: Date.now() - start,
      note: "captured URL derives from the anchor the click landed on — no injected URL",
    });
  } else {
    failGate(
      "ui-picker-selection",
      `clicking the real Files anchor resolved ${JSON.stringify(picked)} for href ${href}`,
    );
  }
  await guest.close().catch(() => undefined);

  // Cancel path: closing the guest from the user's side must resolve cancelled.
  const cancelGuest = await openGuest();
  if (!cancelGuest) {
    failGate("ui-picker-cancel", "second guest window never appeared");
    return;
  }
  const cancelPromise = page.evaluate(() => globalThis.__jagentdeskFigmaPicker);
  await cancelGuest.close();
  const cancelled = await Promise.race([cancelPromise, delay(20_000, { kind: "timeout" })]);
  if (cancelled?.kind === "cancelled") passGate("ui-picker-cancel", {});
  else failGate("ui-picker-cancel", `closing the guest resolved ${JSON.stringify(cancelled)}`);
}

/** WS outline/playback + warm cache — API-integration proof (labelled; not the player E2E). */
// eslint-disable-next-line eslint(complexity) — each API step records its own gate verdict.
async function runApiGates(client, jagentdeskHome, proxy, ctx) {
  const { fileKey, fileMetaName, configuredFrames, evidence } = ctx;
  const added = await figmaRequest(client, "figma.files.add.request", {
    connectionId: CONNECTION_ID,
    url: `https://www.figma.com/design/${fileKey}/w9-e2e`,
  });
  if (added.error) {
    failGate("api-file-add", `${classifyFigmaError(added.error)} (${added.error.message})`);
    return;
  }
  if (added.file?.name !== fileMetaName) {
    failGate(
      "api-file-add",
      `daemon stored "${added.file?.name}" but /v1/files/${fileKey}/meta said "${fileMetaName}"`,
    );
    return;
  }
  passGate("api-file-add", { name: added.file.name });

  const outlineStart = Date.now();
  const outlineResponse = await figmaRequest(client, "figma.file.outline.request", { fileKey });
  const outlineMs = Date.now() - outlineStart;
  if (outlineResponse.error) {
    failGate(
      "api-outline",
      `${classifyFigmaError(outlineResponse.error)} (${outlineResponse.error.message})`,
    );
    return;
  }
  const outline = outlineResponse.outline;
  if (!outline?.version) {
    failGate("api-outline", "outline response has no version — playback cannot pin a snapshot");
    return;
  }
  const outlineFrameCount = (outline.pages ?? []).reduce(
    (sum, p) => sum + (p.frames?.length ?? 0),
    0,
  );
  passGate("api-outline", {
    version: outline.version,
    pages: outline.pages?.length ?? 0,
    topFrames: outlineFrameCount,
    ms: outlineMs,
  });
  evidence.outlineVersion = outline.version;

  const frameIds = [
    ...new Set(
      configuredFrames.length > 0
        ? configuredFrames.slice(0, 10)
        : (outline.pages?.[0]?.frames ?? []).map((frame) => frame.id).slice(0, 10),
    ),
  ];
  assert(frameIds.length >= 1, "no real frames to play back — the outline returned zero frames");

  const proxyMark = proxy.log.length;
  const coldStart = Date.now();
  const cold = await figmaRequest(client, "figma.file.playback.request", {
    fileKey,
    version: outline.version,
    frameIds,
  });
  evidence.coldPlaybackMs = Date.now() - coldStart;
  if (cold.error) {
    failGate("api-playback-cold", `${classifyFigmaError(cold.error)} (${cold.error.message})`);
    return;
  }
  const returned = Object.keys(cold.frames ?? {}).length;
  if (returned !== frameIds.length) {
    failGate("api-playback-cold", `playback returned ${returned}/${frameIds.length} frames`);
    return;
  }
  passGate("api-playback-cold", {
    frames: returned,
    ms: evidence.coldPlaybackMs,
    restCalls: proxy.log.length - proxyMark,
    prototypeInteractions: cold.prototype?.interactions?.length ?? 0,
  });

  // Warm: same pinned version must add ZERO proxy traffic (trace-level proof, not budget counts).
  const warmMark = proxy.log.length;
  const warmStart = Date.now();
  const warm = await figmaRequest(client, "figma.file.playback.request", {
    fileKey,
    version: outline.version,
    frameIds,
  });
  evidence.warmPlaybackMs = Date.now() - warmStart;
  if (warm.error) {
    failGate(
      "api-playback-warm-zero-rest",
      `${classifyFigmaError(warm.error)} (${warm.error.message})`,
    );
    return;
  }
  const warmRequests = proxy.log.slice(warmMark);
  if (warmRequests.length === 0)
    passGate("api-playback-warm-zero-rest", { ms: evidence.warmPlaybackMs, extraRestCalls: 0 });
  else
    failGate(
      "api-playback-warm-zero-rest",
      `warm playback issued ${warmRequests.length} new REST calls: ${warmRequests
        .map((e) => e.pathname)
        .join(", ")}`,
    );

  const cacheDir = path.join(jagentdeskHome, "figma", "cache");
  evidence.cacheFiles = fs.existsSync(cacheDir) ? countFiles(cacheDir) : 0;
  if (evidence.cacheFiles === 0)
    evidence.cacheNote = "no versioned cache entries on disk after warm playback";

  // Bounds enforced by the running daemon (the logic tier covers the schema itself).
  const tooMany = await figmaRequest(client, "figma.file.playback.request", {
    fileKey,
    version: outline.version,
    frameIds: Array.from({ length: 11 }, (_, i) => `9:${i}`),
  });
  const none = await figmaRequest(client, "figma.file.playback.request", {
    fileKey,
    version: outline.version,
    frameIds: [],
  });
  const noVersion = await figmaRequest(client, "figma.file.playback.request", {
    fileKey,
    frameIds: [frameIds[0]],
  });
  evidence.bounds = {
    tooMany: tooMany.error?.code ?? null,
    none: none.error?.code ?? null,
    noVersion: noVersion.error?.code ?? null,
  };
}

/** File open + player driven through the actual product UI clicks. */
async function runUiPlaybackGates(
  page,
  ram,
  canvasDeadline,
  minFpsValue,
  electronPid,
  fileKey,
  { artifactDir, refreshUi },
) {
  await refreshUi();
  const card = page.getByTestId(`figma-file-${fileKey}`);
  if (!(await card.isVisible().catch(() => false))) {
    failGate(
      "ui-file-open",
      "the added file's card is not visible in the Figma files home after a real refresh",
    );
    return;
  }
  const openStart = Date.now();
  await card.click();
  const topBar = page.getByTestId("figma-top-bar");
  let canvasAt = null;
  try {
    await topBar.waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForSelector("canvas", { timeout: canvasDeadline });
    canvasAt = Date.now() - openStart;
  } catch {
    /* the 3 s gate below records the miss */
  }
  if (canvasAt !== null && canvasAt <= canvasDeadline) {
    passGate("ui-file-open", { canvasVisibleMs: canvasAt, budgetMs: canvasDeadline });
  } else {
    failGate(
      "ui-file-open",
      `canvas not mounted within ${canvasDeadline}ms of the real card click (took ${canvasAt ?? ">15s top-bar"}ms)`,
    );
  }
  await page.screenshot({ path: path.join(artifactDir, "file-canvas.png") });

  // Player through the product menu: top bar → More → Prototype.
  await page.getByTestId("figma-top-bar-more").click();
  await page.getByTestId("figma-prototype").click();
  const playerMarker = page.getByTestId("figma-show-hotspots");
  const chooseFlow = page.getByTestId("figma-choose-flow");
  try {
    await playerMarker.waitFor({ state: "visible", timeout: 20_000 });
  } catch {
    failGate(
      "ui-player-open",
      "the prototype player never presented its toolbar after the real menu click",
    );
    return;
  }
  if (await chooseFlow.isVisible().catch(() => false)) {
    const flowRow = chooseFlow.locator("[role=button], [accessibilityRole=button]").first();
    if (await flowRow.isVisible().catch(() => false)) {
      await flowRow.click();
      await playerMarker.waitFor({ state: "visible", timeout: 15_000 });
    }
  }
  try {
    await page.waitForSelector("canvas", { timeout: 15_000 });
  } catch {
    failGate("ui-player-open", "the player opened but no frame canvas was mounted");
    return;
  }
  passGate("ui-player-open", {
    via: "figma-top-bar-more → figma-prototype → real clicks",
    playerToolbarVisible: true,
  });
  await page.screenshot({ path: path.join(artifactDir, "player.png") });

  // Sustained frame rate while the player is live (spec 32.11 #2: >= 50 fps).
  const fps = await page.evaluate(
    async () =>
      await new Promise((resolve) => {
        let count = 0;
        const start = performance.now();
        const tick = () => {
          count += 1;
          if (performance.now() - start < 2_000) requestAnimationFrame(tick);
          else resolve(Number(((count / (performance.now() - start)) * 1000).toFixed(1)));
        };
        requestAnimationFrame(tick);
      }),
  );
  if (fps >= minFpsValue) passGate("perf-playback-fps", { fps, measuredMs: 2_000 });
  else
    failGate(
      "perf-playback-fps",
      `sustained ${fps} fps during playback — gate is >= ${minFpsValue}`,
    );

  // Close the player, capture after-close app-tree RAM.
  await page.keyboard.press("Escape");
  await playerMarker.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined);
  await delay(1_000);
  ram.afterCloseKb = treeRssKb(electronPid).totalKb || ram.afterCloseKb;
}

function runUrlTraceGate(proxyLog, fileKey) {
  const restEntries = proxyLog.filter((entry) => entry.pathname.startsWith("/v1/"));
  const offenders = [];
  for (const entry of restEntries) {
    if (entry.pathname === `/v1/files/${fileKey}`) {
      const depth = Number(entry.search?.depth ?? Number.POSITIVE_INFINITY);
      if (depth > 2)
        offenders.push(
          `full-document GET /v1/files/${fileKey} (depth=${entry.search?.depth ?? "unset"})`,
        );
    }
    if (entry.pathname === `/v1/files/${fileKey}/nodes` && entry.method === "GET") {
      const ids = String(entry.search?.ids ?? "")
        .split(",")
        .filter(Boolean);
      if (ids.length > 10) offenders.push(`nodes call carried ${ids.length} ids (max 10)`);
      if (!entry.search?.version) offenders.push("nodes call without a pinned version");
    }
  }
  const distinct = [...new Set(restEntries.map((entry) => `${entry.method} ${entry.pathname}`))];
  if (offenders.length === 0 && restEntries.length > 0) {
    passGate("net-url-trace", { restCalls: restEntries.length, distinctPaths: distinct });
  } else if (restEntries.length === 0) {
    failGate(
      "net-url-trace",
      "the app made no REST calls through the recording proxy — nothing to prove",
    );
  } else {
    failGate("net-url-trace", `${offenders.join("; ")} — paths: ${distinct.join(", ")}`);
  }
}

function finish(evidence, gateMap, artifactDir) {
  const missing = GATE_NAMES.filter((name) => !gateMap.has(name));
  for (const name of missing) {
    gateMap.set(name, { status: "UNEXERCISED", detail: "an earlier gate stopped the run" });
    console.log(`  UNEXERCISED ${name}: an earlier gate stopped the run`);
  }
  evidence.gates = Object.fromEntries(gateMap);
  evidence.finishedAt = new Date().toISOString();
  writeJson(path.join(artifactDir, "e2e-evidence.json"), evidence);
  console.log(`Evidence: ${path.join(artifactDir, "e2e-evidence.json")}`);
  const failed = [...gateMap].filter(([, gate]) => gate.status !== "PASS");
  if (failed.length === 0) {
    console.log(
      `\nFigma standalone E2E GREEN — all ${GATE_NAMES.length} gates exercised with real data.`,
    );
    return 0;
  }
  console.log(
    `\nFigma standalone E2E RED — ${failed.length}/${GATE_NAMES.length} gate(s) not green:`,
  );
  for (const [name, gate] of failed)
    console.log(`  - ${name}: ${gate.status}${gate.detail ? ` (${gate.detail})` : ""}`);
  console.log("There is no ALLOW_BLOCKED: an unexercised or blocked gate keeps the run RED.");
  return 1;
}

function countFiles(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    total += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return total;
}

await main();
