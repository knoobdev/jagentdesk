#!/usr/bin/env node
// W9 real E2E for Figma standalone browsing + playback (ADR-0037, ADR-0038, ADR-0039, spec 32.11).
//
// FULL E2E, not a scaffold test: boots an isolated daemon and a real Electron app on reserved
// ports (the production daemon on 6767 is never restarted), drives the actual renderer through
// Playwright over CDP, and verifies the REST data flow through `figma.*` RPCs plus a recording
// pass-through proxy in front of api.figma.com. Every gate must be exercised with real data:
// there is no skip-to-green and no ALLOW_BLOCKED. A missing credential, a 403, or a missing
// website session is a RED with the unexercised gates listed.
//
// Inputs (environment): BOTH are required at run time — RED at the credentials gate before any
// heavy boot if either is absent. No user-file-specific default lives in this source; the
// parent's private link and its depth-3 numbers stay in the /tmp evidence and the report.
//   JAGENTDESK_FIGMA_E2E_ACCESS_TOKEN    a valid, read-only Figma access token, supplied by the
//                                        parent only during the actual final run. No refresh, no
//                                        rotation side effects: the harness never refreshes, never
//                                        reads the vault, and never prompts for auth (user is
//                                        AWAY — a missing website session is simply BLOCKED, no
//                                        manual-login attempt, no full-E2E green).
//   JAGENTDESK_FIGMA_E2E_FILE_KEY        real file key or full figma.com URL the account can read.
//   JAGENTDESK_FIGMA_E2E_FRAME_IDS       optional comma list of playback ids (default: NON-SECTION
//                                        independent FRAME/COMPONENT/INSTANCE/GROUP summaries or
//                                        flow starts from the depth=3 read — never a SECTION id)
//   JAGENTDESK_FIGMA_STANDALONE_E2E_NO_PICKER_PROBE
//                                        "1" = user AWAY mode: the native picker probe already
//                                        reached figma.com/login and was closed, so NO second
//                                        guest window is opened (no auth request). The website
//                                        gates are recorded BLOCKED (selection) / UNEXERCISED
//                                        (cancel) — never skipped to green — while the independent
//                                        API proof and the real UI read/perf gates still run.
//                                        Overall acceptance stays ALL-PASS, so this mode is RED.
//   JAGENTDESK_FIGMA_STANDALONE_E2E_ARTIFACT_DIR  evidence output directory
//
// Credential vars are NOT propagated to the booted children: JAGENTDESK_FIGMA_E2E_* is stripped
// from the daemon/desktop/Metro commonEnv so the token belongs only to THIS harness process and
// the isolated daemon home's sealed vault — the app never re-reads the E2E environment, and the
// caller's own provider config stays unforced.
//
// Identity is populated ONLY from the real `GET /v1/me` answer — never a fabricated account row,
// no dummy client credentials. The `Browse files` control (W2 ships it as figma-nav-browse /
// figma-nav-browse-button) and the prototype player are driven through actual product UI clicks;
// the WS outline/playback checks are API-integration proof and are labelled as such. The
// real-website browse gate stays its own separate gate and BLOCKED until an actual authenticated
// selection happens inside the guest — no injected location.assign, no DOM injection into Figma.
//
// The >=500-frame criterion (ADR-0039 / spec 32.11 #17) counts frame screens through the whole
// tree INCLUDING the ones nested inside SECTIONs, via a depth=3 pre-boot read-only data
// diagnostic — the request shape the parent measured (3546 FRAME / 422 flowStartingPoints /
// 15 pages in 17.4 MB / 9.4 s on THEIR file). An API-only run NEVER claims the <=3 s cold goal:
// that is the click-to-canvas UI gate's evidence alone.
//
// The recording-proxy trace keeps request classes distinct and correctly bounded: bounded
// depth<=3 outline calls, Section metadata at depth 1 (W4 optional capability / W5/W7 adaptive
// Sections), and full FRAME reads over /nodes — <=50 ids per spec 32.5.1 (independent
// NON-SECTION drawing summaries: GROUP/COMPONENT/INSTANCE/… are legitimate loads) with a pinned
// version and never a known SECTION id (no whole-SECTION downloads for viewport frames). The
// playback <=10 frameIds contract is enforced on actual UI WebSocket request messages / the
// correlated RPC trace, never by misreading REST /nodes URLs. The fps gate passes ONLY on
// compositor-presented frames counted with CDP Page.screencast while real CTRL+wheel-zoom,
// plain-wheel-pan and pointer-drag inputs move the canvas camera (each input must change the
// canvas 2D context CTM); pixel-change counts and rAF ticks measure the canvas's INTERNAL
// update cadence and are recorded as diagnostics — never renamed into a pass — and with no
// screencast data the bar stays UNEXERCISED. ui-file-open is a MOUNT bar: canvas mounted
// within budget while the daemon was provably still cold; a first COMPLETE frame is not
// claimed. The RAM gate measures the real Electron main+helper tree, not the dev-runner's
// Metro/Node descendants. New behavior rides the server_info capability advertisement, so an
// old host is gated, not guessed.
//
// Boot semantics (root-run lessons): the isolated daemon boots with
// JAGENTDESK_TAILSCALE_ENABLED=0 + JAGENTDESK_DESKTOP_MANAGED=1 — an EXPLICIT LOOPBACK READ
// TEST, not tailnet acceptance, needing no FigmaDesktop or Link plugin; the tailnet bridge's
// Supervisor restarts churn the port and false-pass a bare "port is open". The MANAGED flag is
// the product's own spawnDetachedDaemon env: without it the Desktop manager refused to reuse
// the harness daemon (root run 4: a second daemon spawned, died on the PID lock, and the UI
// showed "Something went wrong / local server failed to start"); with it the manager genuinely
// recognizes and reuses the harness-owned daemon and the Local flow's bootstrap registers the
// built-in host. boot-isolated-daemon PASS therefore requires a BOUNDED WebSocket handshake
// whose server_info actually arrives WITH a usable wire serverId. boot-electron-renderer is
// proven by the SUPPORTED product user flow observed live: the real preload bridge exists, the
// product's connected state is reached (bootstrap-registered host, or actual clicks — Local →
// Continue with Local → welcome → Direct connection → 127.0.0.1 + the reserved daemon port →
// Connect), the rendered error screen fails FAST, and the workspace row named by the
// server_info wire id becomes visible — no localStorage injection, no fake hosts, no Origin
// bypass, no Figma website auth. The desktop's MANAGED-daemon IPC status is recorded as a
// diagnostic only and never blocks; every page.evaluate IPC probe is individually
// bounded with withDeadline because the outer while loop cannot bound a hung await. Every
// client connect/wait carries a deadline, SIGINT/SIGTERM run the owned cleanup,
// runtimeDir/ports/child PGIDs are registered to runtime.json immediately for external
// recovery, and teardown RECORDS the isolated home's managed-PID-lock holder in evidence for
// root review — it never speculatively signals an untracked PID (stale lock / PID reuse), and
// no broad daemon scan ever touches the production daemon. figma.link.status.request is read
// before and after the run — linked files or a pending pairing mean the data flow may ride the
// plugin path, not standalone REST, and is recorded as a trace-gate offender (no user
// open/close of the Figma app is required).
import { spawn, execFileSync } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
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
const minFrames = 500; // spec 32.11 #17: >= 500 frame screens, SECTION-nested included
const maxNodesBatch = 50; // spec 32.5.1: full-canvas nodes requests carry <= 50 ids
const maxPlaybackBatch = 10; // playback RPC contract: frameIds <= 10 per request
const CONNECTION_ID = "fgc_w9_harness";
const WORKSPACE_ID = "figma-standalone-w9";
const FIGMA_API_ORIGIN = "https://api.figma.com";
const FIGMA_FILE_KINDS = new Set(["design", "file", "proto"]);
// No file-specific default lives in this tracked source: JAGENTDESK_FIGMA_E2E_FILE_KEY is
// REQUIRED at run time alongside the access token. The parent's real file is PRIVATE — its key,
// version and depth-3 numbers (3546 FRAME / 422 flowStartingPoints / 15 pages, 17.4 MB / 9.4 s)
// live in /tmp evidence and the report only.

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
  "ui-comments-readonly",
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
/**
 * Explicit UNEXERCISED: a gate whose real evidence could not be produced this run (e.g. no
 * rendering instrumentation available, or the no-probe mode declines to open a login window).
 * Recorded with its reason — never silently skipped to green, never a renamed diagnostic pass.
 */
function unexercisedGate(name, detail) {
  gates.set(name, { status: "UNEXERCISED", detail });
  console.log(`  UNEXERCISED ${name}: ${detail}`);
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

/** Race any promise against a hard deadline so no harness wait can hang unbounded. */
function withDeadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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

/**
 * Teardown evidence for the managed-boot architecture (ROOT RUN 4 SAFETY RULE): a live PID
 * with desktopManaged:true in <home>/jagentdesk.pid is NOT sufficient ownership proof — the
 * lock can be stale and PIDs get reused — so the harness NEVER speculatively signals a
 * daemon outside its tracked process groups. With the managed boot the Desktop manager REUSES
 * the harness-owned daemon (matching version + transport mode), so the tracked groups already
 * own everything that was started; this records the lock holder for root review instead.
 * `unownedLive: true` flags a replacement the manager spawned but we do not track (e.g. after
 * a version/transport-mismatch restart) — no broad daemon scan, and the production daemon is
 * never touched.
 */
function managedPidLockState(jagentdeskHome, trackedChildPids) {
  let lock = null;
  try {
    lock = JSON.parse(fs.readFileSync(path.join(jagentdeskHome, "jagentdesk.pid"), "utf8"));
  } catch {
    return { present: false };
  }
  const pid = typeof lock?.pid === "number" ? lock.pid : null;
  let live = false;
  if (pid !== null && pid > 1) {
    try {
      process.kill(pid, 0);
      live = true;
    } catch {
      /* dead */
    }
  }
  const tracked = pid !== null && pid > 1 && trackedChildPids.has(pid);
  return {
    present: true,
    desktopManaged: lock?.desktopManaged === true,
    pid,
    live,
    tracked,
    unownedLive: live && !tracked,
  };
}

/**
 * Locate the REAL Electron main process among the dev-runner's descendants. The dev-runner's
 * own command line also references desktopDir (it lives in scripts/), and helper processes
 * inherit it, so the main is uniquely: contains the desktopDir argument, no `--type=` flag
 * (helpers carry one), not `dev-runner` itself, and runs the Electron binary proper.
 */
function findElectronMainPid(desktopDirPath) {
  let out;
  try {
    out = execFileSync("ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pidText, command] = match;
    if (!command.includes(desktopDirPath)) continue;
    if (command.includes("--type=") || command.includes("dev-runner")) continue;
    if (
      /Electron\.app\/Contents\/MacOS\/Electron(\s|$)|electron\/dist\/electron(\s|$)/.test(command)
    )
      return Number(pidText);
  }
  return null;
}

/** RSS of every descendant of rootPid (used for the daemon tree). */
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
 * Count nodes of a type through the WHOLE document tree. Frame screens nest inside SECTIONs
 * (depth-2 yields 24 top FRAME + 209 SECTION), so only a recursive count answers the
 * >=500-frame criterion (ADR-0039 / spec 32.11 #17) — and SECTION itself must be counted
 * through the tree, not just at top level.
 */
function countNodesByType(node, type) {
  if (!node || typeof node !== "object") return 0;
  let total = String(node.type).toUpperCase() === type ? 1 : 0;
  for (const child of node.children ?? []) total += countNodesByType(child, type);
  return total;
}

/** Ids of every node of a type, used to classify REST /nodes fetches (SECTION downloads). */
function collectNodeIdsByType(node, type) {
  const ids = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (String(n.type).toUpperCase() === type && n.id) ids.push(String(n.id));
    for (const child of n.children ?? []) walk(child);
  };
  walk(node);
  return ids;
}

/** Page (CANVAS) count and flow-start count from the real depth=3 answer, both cross-checked. */
function countFlowStartingPoints(document, body) {
  const fromRoot = Object.keys(body?.flows ?? {}).length;
  const walk = (node) => {
    if (!node || typeof node !== "object") return 0;
    let total = Array.isArray(node.flowStartingPoints) ? node.flowStartingPoints.length : 0;
    for (const child of node.children ?? []) total += walk(child);
    return total;
  };
  return Math.max(fromRoot, walk(document));
}

/**
 * Default playback ids for the harness's own calls: REAL independent drawing summaries —
 * FRAME/COMPONENT/INSTANCE/GROUP/COMPONENT_SET plus flow-start nodes — collected recursively
 * from the depth=3 tree. Never SECTION ids: requesting a whole SECTION from /nodes downloads
 * its full subtree (what spec 32.11 #17 forbids for viewport frames).
 */
function collectPlaybackCandidates(document, body) {
  const allowed = new Set(["FRAME", "COMPONENT", "INSTANCE", "GROUP", "COMPONENT_SET"]);
  const ids = [];
  const kinds = {};
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    const type = String(node.type).toUpperCase();
    if (allowed.has(type) && node.id) {
      if (!ids.includes(String(node.id))) {
        ids.push(String(node.id));
        kinds[type] = (kinds[type] ?? 0) + 1;
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(document);
  const flowStartIds = [];
  const collectFlowStarts = (entries) => {
    for (const entry of entries ?? []) {
      const id = entry?.node_id ?? entry?.nodeId ?? entry?.id;
      if (id && !flowStartIds.includes(String(id))) flowStartIds.push(String(id));
    }
  };
  for (const flow of Object.values(body?.flows ?? {}))
    collectFlowStarts(flow?.flowStartingPoints ?? flow);
  const walkFlows = (node) => {
    if (!node || typeof node !== "object") return;
    collectFlowStarts(node.flowStartingPoints);
    for (const child of node.children ?? []) walkFlows(child);
  };
  walkFlows(document);
  return { ids: [...new Set([...flowStartIds, ...ids])], kinds, flowStartIds };
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

/**
 * The renderer is trustworthy only when the REAL preload bridge exists. Each probe is a
 * page.evaluate that can hang against a churning Metro context, so every call runs under a
 * hard withDeadline — the outer while loop cannot bound a hung await on its own (root-run
 * lesson). No bridge after the deadline is a FAIL, never a silent continue.
 */
async function waitForPreloadBridge(page) {
  const deadline = Date.now() + bootTimeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const ready = await withDeadline(
        page.evaluate(() => typeof globalThis.window?.jagentdeskDesktop?.invoke === "function"),
        15_000,
        "preload bridge probe",
      );
      if (ready) return true;
    } catch (error) {
      lastError = error; // Metro may replace the execution context during the initial load.
    }
    await delay(250);
  }
  throw new Error(
    `Electron preload bridge (jagentdeskDesktop.invoke) never appeared${lastError ? `; last error: ${lastError.message}` : ""}`,
  );
}

/**
 * The desktop's MANAGED-daemon IPC status — recorded as a DIAGNOSTIC only, never a
 * precondition (root run 2 lesson: the outer while cannot bound a hung await, and no IPC
 * payload may gate what the real user flow proves). Root run 4 exposed that an EXTERNALLY
 * started UNMANAGED daemon is not reusable by the manager (second daemon, PID-lock fatal), so
 * the harness daemon now boots with the product's own JAGENTDESK_DESKTOP_MANAGED=1; the honest
 * expected shape here is desktopManaged:true / status:"running" / listen on OUR reserved port
 * with a real
 * serverId — the same payload the manager uses to REUSE the daemon. A still-"stopped" read
 * is recorded evidence, not a blocker; bounded per call, a failed probe degrades to an
 * evidence string, it cannot hang or block.
 */
async function readManagedDaemonStatusDiagnostic(page) {
  try {
    return await withDeadline(
      page.evaluate(async () => {
        if (typeof globalThis.window?.jagentdeskDesktop?.invoke !== "function")
          return { __noBridge: true };
        return await globalThis.window.jagentdeskDesktop.invoke("desktop_daemon_status");
      }),
      15_000,
      "desktop_daemon_status IPC probe",
    );
  } catch (error) {
    return { __diagnosticError: String(error?.message ?? error) };
  }
}

/**
 * REAL product onboarding through the SUPPORTED user flow — actual clicks on the controls the
 * product itself renders (root runs 2 and 4 walked these states by hand). Because the harness
 * daemon boots DESKTOP-MANAGED-shaped, the Local flow's daemon-start returns a genuinely
 * running status and the desktop bootstrap registers the built-in host itself
 * (daemon-start-service upsertDesktopDaemonConnection, local mode), so the connected state can
 * arrive WITHOUT the welcome step. If the product does show onboarding, the supported path is
 * /tailscale-login → connection-type-local → connection-local-continue ("Continue with Local")
 * → /welcome → welcome-direct-connection → direct-host-input "127.0.0.1" + direct-port-input
 * <reserved port> → ONE direct-host-submit; the optional password field (the seeded daemon is
 * password-less) is cleared inside the modal BEFORE that single submit (35b440ca3/7e01172aa),
 * never cleared + resubmitted after. Completion proof is the WIRED
 * server_info identity: sidebar-workspace-row-<serverId>:<workspaceId> becomes visible, i.e.
 * the renderer genuinely connected to the isolated daemon and listed the seeded workspace. The
 * rendered "Something went wrong / local server failed to start" screen (the run-4 symptom)
 * fails FAST with the page text instead of timing out. No localStorage injection, no fake
 * hosts, no Origin bypass, no Figma website auth — and no product change; these are the
 * shipped testIDs. Preload ready does NOT imply React ready: every state is observed live.
 */
async function completeDirectConnectionOnboarding(page, daemonPort, wireServerId) {
  const steps = [];
  const rowTest = `sidebar-workspace-row-${wireServerId}:${WORKSPACE_ID}`;
  const row = page.getByTestId(rowTest);
  const errorScreen = page.getByText(/Something went wrong|local server failed to start/i);
  const visible = async (locator) =>
    locator
      .first()
      .isVisible()
      .catch(() => false);
  let localClicked = false;
  let directSubmitted = false;
  const deadline = Date.now() + bootTimeoutMs;
  while (Date.now() < deadline) {
    if (await visible(row)) {
      steps.push(`connected — wired workspace row visible: ${rowTest}`);
      return steps;
    }
    // Route restoration can finish after preload initialization. The Figma sidebar hides
    // the workspace list; use its real Back control once it renders, then prove connection.
    const leaveFigma = page.getByTestId("sidebar-figma-leave").filter({ visible: true }).last();
    if (await visible(leaveFigma)) {
      await leaveFigma.click();
      steps.push("left restored Figma sidebar to expose the workspace list");
      continue;
    }
    if (await visible(errorScreen)) {
      const text =
        (await errorScreen
          .first()
          .textContent()
          .catch(() => "")) ?? "";
      throw new Error(
        `onboarding reached the product's error screen instead of a connected host: "${text.trim().slice(0, 200)}"; steps: ${steps.join(" -> ")}`,
      );
    }
    if (!localClicked && (await visible(page.getByTestId("tailscale-login-screen")))) {
      steps.push("fresh onboarding detected at /tailscale-login");
      const localChoice = page.getByTestId("connection-type-local");
      if (await visible(localChoice)) {
        await localChoice.click();
        steps.push("clicked connection-type-local");
      }
      await page.getByTestId("connection-local-continue").click({ timeout: 15_000 });
      steps.push("clicked connection-local-continue");
      localClicked = true;
      continue;
    }
    if (!directSubmitted && (await visible(page.getByTestId("welcome-direct-connection")))) {
      await page.getByTestId("welcome-direct-connection").click({ timeout: 15_000 });
      steps.push("clicked welcome-direct-connection");
      await page.getByTestId("add-host-modal").waitFor({ state: "visible", timeout: 15_000 });
      await page.getByTestId("direct-host-input").fill("127.0.0.1");
      await page.getByTestId("direct-port-input").fill(String(daemonPort));
      // The optional password field is visible from the start; the seeded daemon is
      // password-less, so it is cleared BEFORE the single submit (root's integration fix
      // 35b440ca3/7e01172aa) — never cleared + resubmitted after, which double-submits while
      // the first connection attempt is still pending.
      const password = page.getByTestId("direct-password-input");
      if (await visible(password)) await password.fill("");
      steps.push(`filled direct-host-input 127.0.0.1 + direct-port-input ${daemonPort}`);
      await page.getByTestId("direct-host-submit").click();
      directSubmitted = true;
      continue;
    }
    await delay(500);
  }
  const url = page.url();
  throw new Error(
    `Direct connection onboarding never reached the connected workspace row ${rowTest}; steps: ${steps.join(" -> ")}; last url: ${url}`,
  );
}

/**
 * Wait for the renderer to be USABLE: real preload bridge, then a genuinely connected host —
 * completing the supported onboarding with actual clicks when the product shows it. The
 * managed IPC status never gates here (see readManagedDaemonStatusDiagnostic).
 */
async function waitForReadyRenderer(page, daemonPort, wireServerId) {
  await waitForPreloadBridge(page);
  await completeDirectConnectionOnboarding(page, daemonPort, wireServerId);
}

async function connectDaemonClient(port) {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId: `clid_figma_w9_${randomBytes(3).toString("hex")}`,
    clientType: "cli",
    appVersion: "0.9.54",
    webSocketFactory: (u, o) => new WebSocket(u, o?.protocols, { headers: o?.headers }),
  });
  // client.connect() was observed HANGING unbounded against a daemon that had opened its
  // port but never completed the handshake (tailnet bridge restart). Bound it, close the
  // half-open client on failure, and let the caller record a FAIL, not a hung run.
  try {
    await withDeadline(client.connect(), bootTimeoutMs, `DaemonClient connect (port ${port})`);
  } catch (error) {
    try {
      client.close();
    } catch {
      /* already dead */
    }
    throw error;
  }
  await delay(500);
  return client;
}

/**
 * Boot readiness = bounded WS handshake + server_info arrival, NOT a bare open port: the
 * tailnet bridge's Supervisor restarts left a transient-open port that satisfied waitForPort
 * while the real daemon was still churning (root run: boot gate false-passed). The client
 * used for readiness is closed on failure so nothing leaks.
 */
async function waitForDaemonReadiness(port, processInfo) {
  const started = Date.now();
  const client = await connectDaemonClient(port);
  try {
    const deadline = Date.now() + bootTimeoutMs;
    while (Date.now() < deadline) {
      if (processInfo?.child.exitCode !== null) {
        throw new Error(
          `isolated daemon exited (code ${processInfo.child.exitCode}) before server_info; see ${processInfo.logPath}`,
        );
      }
      const info = client.getLastServerInfoMessage();
      if (info) {
        // The WIRE identity — not the desktop-managed IPC status — is what names the real
        // host rows in the product UI, so server_info must carry a usable serverId; an empty
        // one here means the daemon is not truly ready and the boot gate must FAIL, not drift.
        const serverId = typeof info.serverId === "string" ? info.serverId.trim() : "";
        if (serverId === "")
          throw new Error(
            `server_info arrived without a usable serverId: ${JSON.stringify(info).slice(0, 300)}`,
          );
        return {
          readyMs: Date.now() - started,
          serverId,
          version: info.version ?? null,
          features: info.features ?? {},
        };
      }
      await delay(100);
    }
    throw new Error(`no server_info within ${bootTimeoutMs}ms of the WS connect`);
  } catch (error) {
    try {
      client.close();
    } catch {
      /* already dead */
    }
    throw error;
  }
}

/**
 * Link-plugin quiescence proof (spec 32.4 is a DIFFERENT data path than standalone REST).
 * Read figma.link.status.request before and after the run: the data-side evidence is only
 * attributable to the REST source when no file is linked through the plugin and no pairing
 * is pending. A violation is an offender for the trace gate; the user is away, so the run
 * never asks anyone to open/close FigmaDesktop or the plugin — the state is simply proven.
 */
async function recordLinkStatus(client, phase, evidence) {
  const res = await figmaRequest(client, "figma.link.status.request", {});
  const summary = res.error
    ? { error: `${classifyFigmaError(res.error)} (${res.error.message})` }
    : {
        server: res.status?.server ?? null,
        files: res.status?.files ?? [],
        pendingPairing: res.status?.pendingPairing ?? null,
      };
  evidence[`linkStatus${phase}`] = summary;
  const problems = [];
  if (res.error) {
    problems.push(`link status (${phase.toLowerCase()}) unavailable: ${res.error.message}`);
  } else {
    if ((res.status?.files ?? []).length > 0)
      problems.push(
        `link status (${phase.toLowerCase()}) has ${res.status.files.length} linked file(s) — data flow may ride the plugin path, not standalone REST`,
      );
    if (res.status?.pendingPairing)
      problems.push(
        `link status (${phase.toLowerCase()}) has a plugin awaiting pairing — the user is away and no one will type the code`,
      );
  }
  return problems;
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
    // Negative bound probes can be rejected by the REAL client schema before any WS send.
    // Keep that distinct from a daemon rejection, and continue recording the other gates.
    if (error?.name === "ZodError" && Array.isArray(error.issues)) {
      return {
        error: { code: "client_validation", message: String(error.message) },
        __harnessOrigin: "client_validation_before_send",
      };
    }
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
  const fileKeyInput = process.env.JAGENTDESK_FIGMA_E2E_FILE_KEY ?? "";
  const configuredFrames = (process.env.JAGENTDESK_FIGMA_E2E_FRAME_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const fileKey = fileKeyInput ? parseFileKeyInput(fileKeyInput) : null;
  // NO-PICKER-PROBE MODE (user AWAY): the native probe already reached figma.com/login and was
  // closed (see evidence/native-picker-manual-state.json). Opening another guest window would
  // just request auth again. With this mode the website-selection gates are recorded
  // BLOCKED/UNEXERCISED — never skipped to green — while the independent API proof and the
  // real UI read/perf gates still run. Default acceptance still requires ALL gates PASS.
  const noPickerProbe = process.env.JAGENTDESK_FIGMA_STANDALONE_E2E_NO_PICKER_PROBE === "1";

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

    const missingInputs = [];
    if (!accessToken) missingInputs.push("JAGENTDESK_FIGMA_E2E_ACCESS_TOKEN");
    if (!fileKeyInput) missingInputs.push("JAGENTDESK_FIGMA_E2E_FILE_KEY");
    if (missingInputs.length > 0) {
      failGate(
        "credentials",
        `${missingInputs.join(" and ")} missing — the parent supplies the token AND the private file key at run time (no defaults live in this tracked source); RED without booting the app`,
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

    // ADR-0039 / spec 32.11 #17 real read: depth=3 returns every frame screen INCLUDING those
    // nested inside SECTIONs. The parent's verified numbers for THEIR file (3546 FRAME + 422
    // flowStartingPoints / 15 pages, 17.4 MB / 9.4 s at depth=3) are PRIVATE and live in /tmp
    // evidence only — no file-specific default is baked into this tracked source. This is a
    // pre-boot read-only DATA diagnostic against api.figma.com; an API-only run here never
    // claims the <=3 s cold goal — that is the click-to-canvas UI gate's proof alone.
    const depth3Start = Date.now();
    const depth3 = await figmaApiGet(accessToken, `/v1/files/${encodeURIComponent(fileKey)}`, {
      depth: 3,
    });
    evidence.dataDiagnostic = {
      shape: `GET /v1/files/${fileKey}?depth=3`,
      ms: Date.now() - depth3Start,
    };
    if (depth3.status !== 200) {
      failGate("file-size-500-frames", `depth=3 data diagnostic answered ${depth3.status}`);
    } else {
      const frames = countNodesByType(depth3.body?.document, "FRAME");
      const sections = countNodesByType(depth3.body?.document, "SECTION");
      const pages = (depth3.body?.document?.children ?? []).filter(
        (node) => String(node?.type).toUpperCase() === "CANVAS",
      ).length;
      const flows = countFlowStartingPoints(depth3.body?.document, depth3.body);
      // Known SECTION ids let the REST trace gate flag a whole-SECTION download specifically:
      // independent NON-SECTION drawing summaries (GROUP/COMPONENT/INSTANCE/…) may legitimately
      // be fetched by id, so "not an outline frame id" alone is not an offender.
      evidence.sectionNodeIds = collectNodeIdsByType(depth3.body?.document, "SECTION");
      // Default playback ids are NON-SECTION independent summaries (or flow starts), never a
      // whole SECTION — the harness's own outline/playback requests use these below.
      const candidates = collectPlaybackCandidates(depth3.body?.document, depth3.body);
      evidence.playbackCandidates = candidates.ids.slice(0, 40);
      evidence.playbackCandidateKinds = candidates.kinds;
      evidence.flowStartCandidateCount = candidates.flowStartIds.length;
      Object.assign(evidence.dataDiagnostic, {
        frames,
        sections,
        pages,
        flowStartingPoints: flows,
      });
      if (frames >= minFrames)
        passGate("file-size-500-frames", {
          frames,
          sections,
          pages,
          flowStartingPoints: flows,
          method:
            "recursive frame-screen count of the depth=3 document — SECTION-nested screens included (pre-boot read-only data diagnostic)",
        });
      else
        failGate(
          "file-size-500-frames",
          `real file has ${frames} FRAME nodes through the tree (SECTIONs included) — spec 32.11 #17 demands >= ${minFrames}; pick a bigger file for green`,
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

  // Children must not inherit the harness's credential contract: the token/file key belong to
  // THIS process (pre-boot diagnostics + seeding). Outside the isolated daemon home the app
  // gets the token through the sealed vault only; leaking E2E_* vars into Metro/desktop
  // (and their env-hash caches) buys nothing and risks re-reading them as configuration.
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv))
    if (key.startsWith("JAGENTDESK_FIGMA_E2E_")) delete childEnv[key];
  if (noPickerProbe) childEnv.JAGENTDESK_FIGMA_STANDALONE_E2E_NO_PICKER_PROBE = "1";

  const children = [];
  let browser = null;
  let client = null;
  let proxy = null;
  let ramSampler = null;

  // Root-recovery registry: written the moment ports are reserved and updated on every spawn,
  // so an interrupted or hung run leaves a discoverable runtimeDir + child PGIDs (kill
  // -TERM -<pid>) without tailing logs. Boot/output logs under artifactDir stay root-readable.
  const processRegistry = [];
  const writeRegistry = () =>
    writeJson(path.join(runtimeDir, "runtime.json"), {
      harnessPid: process.pid,
      startedAt: new Date().toISOString(),
      runtimeDir,
      jagentdeskHome,
      artifactDir,
      ports: { daemonPort, expoPort, cdpPort },
      children: processRegistry,
    });
  writeRegistry();
  const trackChild = (label, info) => {
    children.push(info.child);
    processRegistry.push({
      label,
      pid: info.child.pid,
      pgid: info.child.pid,
      logPath: info.logPath,
    });
    writeRegistry();
  };
  // SIGINT/SIGTERM must run the OWNED cleanup (stop child groups, close proxy, write
  // evidence) — otherwise an externally stopped harness leaves the isolated daemon and
  // Electron groups orphaned, exactly what the root run had to clean by hand.
  let signalCleanupDone = false;
  const ownedSignalCleanup = () => {
    if (signalCleanupDone) return;
    signalCleanupDone = true;
    try {
      if (ramSampler) clearInterval(ramSampler);
      for (const child of children.toReversed()) stopProcess(child);
      evidence.managedPidLock = managedPidLockState(
        jagentdeskHome,
        new Set(children.map((child) => child.pid)),
      );
      if (proxy?.server) proxy.server.close();
      client?.close?.()?.catch?.(() => undefined);
      browser?.close?.()?.catch?.(() => undefined);
      evidence.interruptedBySignal = true;
      finish(evidence, gates, artifactDir);
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    } catch {
      /* best effort while exiting on signal */
    }
    process.exit(130);
  };
  process.on("SIGINT", ownedSignalCleanup);
  process.on("SIGTERM", ownedSignalCleanup);

  try {
    proxy = await startFigmaProxy();
    const commonEnv = {
      ...childEnv,
      JAGENTDESK_HOME: jagentdeskHome,
      JAGENTDESK_LISTEN: listen,
      JAGENTDESK_DAEMON_ENDPOINT: `localhost:${daemonPort}`,
      // Explicit ISOLATED LOOPBACK read test: the tailnet bridge starts Tailscale, binds and
      // forwards the port, and restarts the Supervisor — its transient port churn false-passed
      // a bare waitForPort in the root run (daemon.log/desktop.log). This harness never claims
      // tailnet ACCEPTANCE and needs no FigmaDesktop or Link plugin, so the bridge is off.
      JAGENTDESK_TAILSCALE_ENABLED: "0",
      // ROOT RUN 4 FIX: the Desktop daemon manager only REUSES a daemon whose <home>/
      // jagentdesk.pid lock carries desktopManaged:true (daemon-manager.ts readManagedDaemon
      // PidSync); our externally-spawned UNMANAGED daemon failed that check, so the Local
      // onboarding's start_desktop_daemon spawned a SECOND daemon that died on the PID lock
      // ("Another JAgentDesk daemon is already running") and the real UI showed "Something
      // went wrong / local server failed to start". Booting with the product's OWN managed
      // flag (exactly what spawnDetachedDaemon sets) makes the manager genuinely recognize
      // and reuse the harness daemon — a real managed-shape daemon, not a faked status. The
      // tailnet bridge stays OFF, and with it disabled the daemon writes tailscale-status.json
      // enabled:false, which is the transport mode the Local flow's reuse guard demands.
      JAGENTDESK_DESKTOP_MANAGED: "1",
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
    trackChild("daemon", daemon);
    await waitForPort(daemonPort, "isolated daemon", daemon);
    assert(daemonPort !== 6767, "isolated daemon must not use the production port 6767");
    // An OPEN port is only a stage marker, never readiness: the root run false-passed here
    // when the tailnet bridge's Supervisor restarts left the port transiently open. PASS
    // requires a bounded WS handshake whose server_info arrives; failure throws so the
    // boot gate FAILS with a reason instead of the run hanging or claiming a false green.
    const readiness = await waitForDaemonReadiness(daemonPort, daemon);
    passGate("boot-isolated-daemon", {
      daemonPort,
      bootMs: Date.now() - daemonBootStart,
      wsReadyAfterPortOpenMs: readiness.readyMs,
      serverId: readiness.serverId,
      serverInfoVersion: readiness.version,
      productionDaemonBusy,
      note: "isolated LOOPBACK read test with JAGENTDESK_TAILSCALE_ENABLED=0 and JAGENTDESK_DESKTOP_MANAGED=1 (the product's own managed-boot flag, so the Desktop daemon manager genuinely recognizes and REUSES this harness-owned daemon instead of spawning a second one; no tailnet acceptance claimed, no separate Tailscale daemon started); readiness = bounded WS server_info with a usable wire serverId, not a bare open port",
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
    trackChild("desktop", desktop);
    await waitForPort(cdpPort, "Electron CDP", desktop);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const page = await waitForAppPage(browser, expoPort);
    // Renderer boot = the SUPPORTED product user flow with actual clicks, proven by the
    // connected UI — never by an IPC status alone (root run 2 lesson: demanding running+
    // healthy on a correctly-idle managed payload timed the run out at 240 s; the gate that
    // counts is the wire-id workspace row becoming visible). Root run 4 proved an EXTERNALLY
    // started UNMANAGED daemon is not reusable: the manager spawned a second daemon that died
    // on the PID lock. The harness daemon therefore now boots with the product's own
    // JAGENTDESK_DESKTOP_MANAGED=1 so the manager genuinely reuses
    // it and the Local onboarding no longer spawns a conflicting second daemon; the IPC
    // status is still recorded as a DIAGNOSTIC only. PASS requires the real preload bridge,
    // the product's own connected state reached live (bootstrap-registered host or the
    // Local → Continue with Local → welcome → Direct connection → Connect clicks), and the
    // workspace row named by the WS server_info wire id visible — the host is genuinely
    // connected.
    await waitForReadyRenderer(page, daemonPort, readiness.serverId);
    const managedStatusDiagnostic = await readManagedDaemonStatusDiagnostic(page);
    passGate("boot-electron-renderer", {
      serverId: readiness.serverId,
      via: "supported product user flow, observed live: connected workspace row (bootstrap-registered built-in host on the reused desktop-managed daemon, or connection-type-local → connection-local-continue → welcome-direct-connection → direct-host-submit with real clicks)",
      hostConnectedUi: `${`sidebar-workspace-row-${readiness.serverId}:${WORKSPACE_ID}`} visible`,
      managedDaemonStatus: managedStatusDiagnostic,
      managedStatusNote:
        "desktop-managed status is DIAGNOSTIC ONLY — the harness daemon boots with the product's own JAGENTDESK_DESKTOP_MANAGED=1 so the manager recognizes and reuses it (expected honest shape: desktopManaged:true/running/healthy on the reserved port); an idle or errored read is recorded, never a precondition",
      bootMs: Date.now() - appBootStart,
    });

    // ── correlated UI RPC trace: capture the renderer's OWN WebSocket requests ──────
    // A REST /nodes URL alone cannot tell the logical caller apart (canvas subtree loads
    // are allowed <=50 ids per spec 32.5.1; the playback RPC contract is <=10). So the
    // playback limit is proven against the actual WS request messages the UI sent, not
    // against raw proxy lines. The listener is registered here — BEFORE the product-UI
    // reload in runUiPlaybackGates re-creates the socket — and matches the daemon PORT
    // regardless of host (the app may dial localhost: not just 127.0.0.1).
    const uiRequests = {
      types: new Set(),
      counts: {},
      commentsResponses: [],
      renderRequests: [],
      renderPending: new Set(),
      renderResponses: [],
      playbackFrameCounts: [],
      nodesIdCounts: [],
      apiPlaybackFrameCounts: [],
      apiNodesIdCounts: [],
      playerOpened: false,
    };
    page.on("websocket", (ws) => {
      let url;
      try {
        url = new URL(ws.url());
      } catch {
        return;
      }
      if (url.port !== String(daemonPort)) return;
      ws.on("framesent", (frame) => {
        try {
          // Wire shape (daemon-client figmaRequest): { type, ...params } — params are flat.
          const msg = JSON.parse(String(frame.payload));
          const type = msg?.type;
          if (typeof type !== "string" || !type.startsWith("figma.")) return;
          uiRequests.types.add(type);
          uiRequests.counts[type] = (uiRequests.counts[type] ?? 0) + 1;
          if (type === "figma.file.render.request") {
            uiRequests.renderRequests.push({ at_ms: Date.now(), ...msg });
            uiRequests.renderPending.add(msg.requestId);
          }
          if (type === "figma.file.playback.request")
            uiRequests.playbackFrameCounts.push((msg?.frameIds ?? []).length);
          if (type === "figma.file.nodes.request")
            uiRequests.nodesIdCounts.push((msg?.ids ?? []).length);
        } catch {
          /* binary or non-JSON frame */
        }
      });
      ws.on("framereceived", (frame) => {
        try {
          const envelope = JSON.parse(String(frame.payload));
          const msg = envelope?.type === "session" ? envelope.message : envelope;
          if (msg?.type === "figma.file.comments.list.response")
            uiRequests.commentsResponses.push({ errorCode: msg.payload?.error?.code ?? null });
          if (msg?.type === "figma.file.render.response") {
            uiRequests.renderPending.delete(msg.payload?.requestId);
            uiRequests.renderResponses.push({
              requestId: msg.payload?.requestId,
              errorCode: msg.payload?.error?.code ?? null,
              images: Object.fromEntries(
                Object.entries(msg.payload?.images ?? {}).map(([id, bytes]) => [
                  id,
                  bytes ? { mimeType: bytes.mimeType, byteLength: bytes.byteLength } : null,
                ]),
              ),
            });
          }
        } catch {
          /* binary or non-JSON frame */
        }
      });
    });

    // App-tree RAM must be the REAL Electron main + helper processes (spec 32.11 #2), NOT
    // the dev-runner's Metro/Node/compiler descendants. Locate the main by its launch
    // signature (the desktop dir argument, no --type= helper flag) and measure that tree;
    // the daemon tree is recorded separately and never mixed in.
    const electronMainPid = findElectronMainPid(desktopDir);
    const electronFound = electronMainPid !== null;
    if (!electronFound)
      console.log(
        "  note       Electron main process not located among dev-runner descendants — perf-app-ram-tree will fail rather than measure the wrong tree",
      );
    const ram = { baselineKb: 0, peakKb: 0, afterCloseKb: null, samples: [] };
    ramSampler = setInterval(() => {
      const { totalKb } = treeRssKb(electronMainPid ?? 0);
      if (totalKb > 0) {
        ram.samples.push({ at: Date.now(), totalKb });
        ram.peakKb = Math.max(ram.peakKb, totalKb);
      }
    }, 250);
    ram.baselineKb = treeRssKb(electronMainPid ?? 0).totalKb;
    evidence.electronMainPid = electronMainPid;
    evidence.devRunnerTreeNote =
      "dev-runner (Metro/node/compiler) descendants excluded from the measured tree";
    evidence.daemonRssKb = treeRssKb(daemon.child.pid).totalKb;

    client = await connectDaemonClient(daemonPort);
    const serverInfo = client.getLastServerInfoMessage();
    assert(serverInfo, "no server_info after connect");
    // ADR-0039 behavior (depth<=3 outline, SECTION-nested frames, no whole-SECTION viewport
    // downloads) rides the capability advertisement: an old host is gated by what it actually
    // advertises — recorded here so the evidence shows the host's real feature set and version.
    // figmaNodeDepth is the depth-capable outline advertisement; without it the SECTION-nested
    // frames and bounded-depth trace classes are not trustworthy, so it is REQUIRED, not assumed.
    const features = serverInfo.features ?? {};
    const requiredCapabilities = ["figma", "figmaPlayback", "figmaNodeDepth"];
    const missingCapabilities = requiredCapabilities.filter((k) => features[k] !== true);
    if (missingCapabilities.length === 0) {
      passGate("capability-advertisement", {
        figma: true,
        figmaPlayback: true,
        figmaNodeDepth: true,
        hostVersion: serverInfo.version ?? null,
        advertisedFeatures: serverInfo.features,
      });
    } else {
      failGate(
        "capability-advertisement",
        `server_info.features=${JSON.stringify(features)} — missing advertisement: ${missingCapabilities.join(", ")}`,
      );
    }

    // ── Link attribution (root-run requirement): the standalone data path is REST via the
    // recording proxy; Figma Link is a separate source. Prove quiescence BEFORE the run —
    // status.files empty and no pendingPairing — so the REST-side evidence is attributable.
    // No FigmaDesktop/plugin needs to run and the user never has to open/close anything.
    const linkProblems = [];
    linkProblems.push(...(await recordLinkStatus(client, "Before", evidence)));

    // ── UI: open the Figma section through the real sidebar ────────────────────
    const openFigmaSection = async () => {
      await page
        .getByTestId(`sidebar-workspace-row-${readiness.serverId}:${WORKSPACE_ID}`)
        .click({ timeout: bootTimeoutMs });
      const figmaNav = page
        .getByTestId("rail-figma")
        .or(page.getByTestId("sidebar-figma-nav"))
        .first();
      await figmaNav.waitFor({ state: "visible", timeout: 30_000 });
      await figmaNav.click();
      await page
        .getByTestId("figma-files-empty")
        .or(page.getByTestId("figma-files-home"))
        .filter({ visible: true })
        .last()
        .waitFor({ state: "visible", timeout: 30_000 });
    };
    await openFigmaSection();
    passGate("ui-figma-section", { reached: "figma files home" });
    await page.screenshot({ path: path.join(artifactDir, "figma-section.png") });

    // ── UI: Browse files (W2 product control — actual testIDs from latest source) ──
    const browseButton = page.getByTestId("figma-nav-browse-button");
    const browseRow = page.getByTestId("figma-nav-browse");
    if (await browseButton.isVisible().catch(() => false)) {
      passGate("ui-browse-files", {
        via: "real product control figma-nav-browse-button (W2, ADR-0038)",
      });
    } else if (await browseRow.isVisible().catch(() => false)) {
      passGate("ui-browse-files", {
        via: "real product control figma-nav-browse row (W2, ADR-0038)",
      });
    } else {
      unimplementedGate(
        "ui-browse-files",
        "no Browse files control on this tree yet — W2's button ships as figma-nav-browse / figma-nav-browse-button (commit 7c4d1bbc6); the gate resolves automatically once merged",
      );
    }

    // ── UI: real selection through the picker guest (W1 seed bridge) ────────────
    await runPickerGate(page, browser, artifactDir, { fileKey, noPickerProbe, evidence });

    // ── cold UI FIRST: file added through the product RPC, then the real click while
    // the daemon's outline/nodes caches are still empty. Running the harness's own API
    // gates first would warm those caches and make ui-file-open a WARM-only proof —
    // unable to carry the <=3 s cold bar (spec 32.11 #2). ───────────────────────────
    await runFileAddGate(client, { fileKey, fileMetaName: evidence.fileMeta.name });
    await runUiPlaybackGates(page, ram, canvasDeadlineMs, minFps, electronMainPid, fileKey, {
      artifactDir,
      uiRequests,
      proxy,
      jagentdeskHome,
      evidence,
      refreshUi: async () => {
        // The file entered the daemon store over WS; reload and re-navigate the real product
        // UI so the files home shows it — a user-visible refresh, not DOM injection into Figma.
        // After reload the host connection is persisted, so waitForReadyRenderer only proves
        // the bridge + connected row are back (it re-runs the supported onboarding if the
        // product dropped to it, still with real clicks).
        await page.reload({ waitUntil: "domcontentloaded", timeout: bootTimeoutMs });
        await waitForReadyRenderer(page, daemonPort, readiness.serverId);
        await openFigmaSection();
      },
    });

    await runCommentsReadOnlyUiProof(page, uiRequests, artifactDir, evidence, account.handle);

    // ── API-integration proof AFTER the UI (harness's own WS RPCs; labelled) ──────
    await runApiGates(client, jagentdeskHome, proxy, {
      fileKey,
      configuredFrames,
      evidence,
      uiRequests,
    });

    // ── app-tree RAM gate ──────────────────────────────────────────────────────
    if (!electronFound) {
      failGate(
        "perf-app-ram-tree",
        "the real Electron main process was never located — measuring dev-runner (Metro/node) descendants would have manufactured green",
      );
    } else if (ram.samples.length === 0) {
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
    linkProblems.push(...(await recordLinkStatus(client, "After", evidence)));
    runUrlTraceGate(
      proxy.log,
      fileKey,
      evidence.sectionNodeIds ? new Set(evidence.sectionNodeIds) : null,
      uiRequests,
      linkProblems,
    );
    // Optional same-frame evidence AFTER performance gates; never changes their thresholds.
    await captureRenderQuality(page, uiRequests, artifactDir, evidence);
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
    // Managed-boot safety record (never a speculative signal): note who holds the isolated
    // home's PID lock so an unowned manager replacement is visible to root for review.
    evidence.managedPidLock = managedPidLockState(
      jagentdeskHome,
      new Set(children.map((child) => child.pid)),
    );
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
async function runPickerGate(page, browser, artifactDir, { fileKey, noPickerProbe, evidence }) {
  if (noPickerProbe) {
    // User AWAY mode: the native probe already reached figma.com/login and was closed
    // (evidence/native-picker-manual-state.json). Do NOT open another guest window — that
    // would request auth again. The website gates stay honestly BLOCKED / UNEXERCISED, never
    // skipped to green; every other gate (API + real UI read/perf) still runs in full.
    blockedGate(
      "ui-picker-selection",
      "no-probe mode (user away): website session unverified, no second login window opened; the earlier probe reached figma.com/login and was closed",
    );
    unexercisedGate(
      "ui-picker-cancel",
      "no-probe mode (user away): cancel path unexercised because no guest window was opened",
    );
    evidence.pickerProbe = "skipped-no-auth";
    return;
  }
  const openGuest = async () => {
    const before = new Set(browser.contexts().flatMap((context) => context.pages()));
    await withDeadline(
      page.evaluate(() => {
        globalThis.__jagentdeskFigmaPicker =
          globalThis.window?.jagentdeskDesktop?.figma?.pickFile?.() ??
          Promise.resolve({ kind: "no-bridge" });
      }),
      15_000,
      "picker bridge invoke",
    );
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
  // USER IS AWAY: the harness never waits for or attempts a manual login. One probe, verdict
  // recorded (a native probe reaching figma.com/login just gets BLOCKED and the guest closed),
  // missing website session keeps the run RED — never a green full-E2E by login patience.
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

/**
 * Product-RPC file add — the UI gates need the file in the daemon store, and this doubles as
 * api-integration proof of figma.files.add.request, cross-checked against the real /meta name.
 * Runs BEFORE the cold UI click; it is seeding config, not the warm-up the API gates cause.
 */
async function runFileAddGate(client, { fileKey, fileMetaName }) {
  const added = await figmaRequest(client, "figma.files.add.request", {
    connectionId: CONNECTION_ID,
    url: `https://www.figma.com/design/${fileKey}/w9-e2e`,
  });
  if (added.error) {
    failGate("api-file-add", `${classifyFigmaError(added.error)} (${added.error.message})`);
    return false;
  }
  if (added.file?.name !== fileMetaName) {
    failGate(
      "api-file-add",
      `daemon stored "${added.file?.name}" but /v1/files/${fileKey}/meta said "${fileMetaName}"`,
    );
    return false;
  }
  passGate("api-file-add", { name: added.file.name });
  return true;
}

/**
 * WS outline/playback + warm cache — API-integration proof (labelled; not the player E2E).
 * Runs AFTER the cold UI gates: the harness's own outline/playback pushes would otherwise
 * warm the daemon caches and leave ui-file-open a warm-only proof. Because the UI has run,
 * the daemon may already be warm here — that is recorded honestly (restCalls in the gate
 * measurements), and the cold <=3 s claim belongs to ui-file-open alone.
 */
// eslint-disable-next-line eslint(complexity) — each API step records its own gate verdict.
async function runApiGates(client, jagentdeskHome, proxy, ctx) {
  const { fileKey, configuredFrames, evidence, uiRequests } = ctx;
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
  const outlineFrameIds = [
    ...new Set((outline.pages ?? []).flatMap((p) => (p.frames ?? []).map((frame) => frame.id))),
  ];
  evidence.outlineFrameIds =
    configuredFrames.length > 0
      ? [...new Set([...outlineFrameIds, ...configuredFrames])]
      : outlineFrameIds;
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

  // Default playback ids: NON-SECTION independent drawing summaries from the depth=3 read
  // (FRAME/COMPONENT/INSTANCE/GROUP/COMPONENT_SET or flow starts) — never a whole SECTION id,
  // which would download the SECTION's full subtree. Env override still wins.
  const frameIds = [
    ...new Set(
      configuredFrames.length > 0
        ? configuredFrames.slice(0, maxPlaybackBatch)
        : (evidence.playbackCandidates ?? []).slice(0, maxPlaybackBatch),
    ),
  ];
  assert(
    frameIds.length >= 1,
    "no real frames to play back — the depth=3 diagnostic returned no independent (non-SECTION) summaries; pass JAGENTDESK_FIGMA_E2E_FRAME_IDS",
  );
  const sectionIdSet = new Set(evidence.sectionNodeIds ?? []);
  assert(
    frameIds.every((id) => !sectionIdSet.has(id)),
    `default playback ids include a SECTION id (${frameIds.filter((id) => sectionIdSet.has(id)).join(",")}) — whole-SECTION downloads are forbidden`,
  );
  // Correlated RPC trace: the harness's OWN playback requests are recorded separately from
  // the UI's WS-captured messages — API-pushed counts never substitute for UI-side evidence.
  uiRequests?.apiPlaybackFrameCounts.push(frameIds.length);

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
    note: "runs after the UI gates by design (own API tests later); if restCalls === 0 these ids were already cached by the real UI open — the cold <=3 s proof belongs to ui-file-open alone, this gate is API-integration proof",
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
    rejectionSource: {
      tooMany: tooMany.__harnessOrigin ?? "daemon_response",
      none: none.__harnessOrigin ?? "daemon_response",
      noVersion: noVersion.__harnessOrigin ?? "daemon_response",
    },
  };
}

/**
 * File open + player driven through the actual product UI clicks. Runs BEFORE the harness's
 * API gates so the <=3 s canvas bar is a COLD proof (empty daemon outline/nodes cache), and
 * the warm reopen is recorded separately after close. Canvas-view pan/zoom is measured with
 * CTRL+wheel zoom and real drags, asserting the render camera (canvas CTM) actually changed
 * for every input; the fps bar uses real presentation evidence (pixels changed per frame) —
 * rAF cadence is recorded as a diagnostic only and never renamed into a pass.
 */
// eslint-disable-next-line eslint(complexity) — each UI step records its own gate verdict.
async function runUiPlaybackGates(
  page,
  ram,
  canvasDeadline,
  minFpsValue,
  electronPid,
  fileKey,
  { artifactDir, uiRequests, proxy, jagentdeskHome, evidence, refreshUi },
) {
  // Cold precondition: the daemon's outline/nodes handlers must not have fetched anything yet.
  // (file-add's /meta call is not a content-cache write — rest.ts only caches in content.ts —
  // and the pre-boot /me, /meta and depth=3 diagnostics hit api.figma.com directly, never
  // through this proxy.) A warm witness here means the run order drifted and the <=3 s number
  // is no longer a cold proof.
  const cacheDir = path.join(jagentdeskHome, "figma", "cache");
  const cacheFilesBefore = fs.existsSync(cacheDir) ? countFiles(cacheDir) : 0;
  const preClickContentRest = proxy.log.filter(
    (entry) =>
      entry.pathname === `/v1/files/${fileKey}/nodes` ||
      (entry.pathname === `/v1/files/${fileKey}` && entry.search?.depth !== undefined),
  );
  await refreshUi();
  const card = page.getByTestId(`figma-file-${fileKey}`).filter({ visible: true }).last();
  if (!(await card.isVisible().catch(() => false))) {
    failGate(
      "ui-file-open",
      "the added file's card is not visible in the Figma files home after a real refresh",
    );
    return;
  }
  const openStart = Date.now();
  const proxyMark = proxy.log.length;
  await card.click();
  const topBar = page.getByTestId("figma-top-bar").filter({ visible: true }).last();
  let canvasAt = null;
  try {
    await topBar.waitFor({ state: "visible", timeout: 15_000 });
    // The file canvas view mounts its own <canvas id="jagentdesk-figma-canvas"> — mount of
    // THAT element is the product proof, not any <canvas> in the tree.
    await page.waitForSelector("#jagentdesk-figma-canvas", { timeout: canvasDeadline });
    canvasAt = Date.now() - openStart;
  } catch {
    /* the 3 s gate below records the miss */
  }
  const mountRest = proxy.log
    .slice(proxyMark)
    .filter((entry) => entry.pathname.startsWith(`/v1/files/${fileKey}`));
  const coldWitness = {
    cacheFilesBefore,
    preClickContentRest: preClickContentRest.map((e) => e.pathname),
  };
  const isCold = cacheFilesBefore === 0 && preClickContentRest.length === 0;
  const coldLabel = isCold
    ? "cold (daemon had not fetched outline/nodes before the click)"
    : `WARM witness: cache ${cacheFilesBefore} files, ${preClickContentRest.length} outline/nodes REST before click — <=3s is not a cold proof`;
  if (canvasAt !== null && canvasAt <= canvasDeadline && isCold) {
    passGate("ui-file-open", {
      canvasVisibleMs: canvasAt,
      budgetMs: canvasDeadline,
      cold: true,
      ...coldWitness,
      restDuringMountWindow: mountRest.map((e) => e.pathname),
      note: coldLabel,
      frameBarLimit:
        "MOUNT-ONLY bar: #jagentdesk-figma-canvas mounted within budget — a first COMPLETE frame is not claimed by this harness",
    });
  } else {
    failGate(
      "ui-file-open",
      `#jagentdesk-figma-canvas not COLD-mounted within ${canvasDeadline}ms of the real card click (took ${canvasAt ?? ">15s top-bar"}ms; ${coldLabel}; ${JSON.stringify(coldWitness)})`,
    );
  }
  await page.screenshot({ path: path.join(artifactDir, "file-canvas.png") });

  // ── pan/zoom fps on the CANVAS VIEW — before the player (the player has no wheel/pan
  // handler; measuring inputs against it would prove nothing). Every input must move the
  // render camera: read the canvas 2D context transform before/after each gesture.
  const canvasExists = await withDeadline(
    page.evaluate(() => !!document.getElementById("jagentdesk-figma-canvas")),
    15_000,
    "canvas presence probe",
  ).catch(() => false);
  if (!canvasExists) {
    const idleRaf = await sampleRafCadence(page, 1_000);
    unexercisedGate(
      "perf-playback-fps",
      `no #jagentdesk-figma-canvas element to drive pan/zoom against — rAF cadence recorded as diagnostic only: ${JSON.stringify(idleRaf)}`,
    );
  } else {
    const inputs = [];
    const readCtm = async () =>
      await withDeadline(
        page.evaluate(() => {
          const c = document.getElementById("jagentdesk-figma-canvas");
          const ctx = c?.getContext?.("2d");
          if (!ctx) return null;
          const t = ctx.getTransform();
          return [t.a, t.b, t.c, t.d, t.e, t.f];
        }),
        15_000,
        "canvas CTM read",
      ).catch(() => null);
    const canvasBox = await page.locator("#jagentdesk-figma-canvas").boundingBox();
    const cx = canvasBox ? canvasBox.x + canvasBox.width / 2 : 400;
    const cy = canvasBox ? canvasBox.y + canvasBox.height / 2 : 300;
    await page.mouse.move(cx, cy);
    const idleRaf = await sampleRafCadence(page, 1_000);
    const applyInput = async (label, action) => {
      const before = await readCtm();
      await action();
      await delay(200); // let the camera state round-trip through React into the renderer
      const after = await readCtm();
      inputs.push({ label, ctmChanged: JSON.stringify(before) !== JSON.stringify(after) });
    };
    // COMPOSITOR-PRESENTED evidence: CDP Page.screencast delivers frames as the compositor
    // presents them for this tab, so its rate — not an rAF tick count, and not a getImageData
    // pixel diff (canvas INTERNAL update cadence) — is what may pass the >= 50 fps bar.
    // Both of those are still recorded, truthfully labelled as diagnostics.
    let cdp = null;
    let castFrames = 0;
    try {
      cdp = await page.context().newCDPSession(page);
      cdp.on("Page.screencastFrame", (frame) => {
        castFrames += 1;
        cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
      });
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 40,
        everyNthFrame: 1,
      });
    } catch {
      cdp = null;
    }
    // Start the pixel-cadence sampler FIRST, then keep the viewport genuinely changing for
    // the whole window: ctrl+wheel zoom, plain-wheel pan, real pointer-drag pan.
    const presentation = sampleCanvasPresentation(page, 2_500);
    const castStart = Date.now();
    const wheelZoom = async () => {
      await page.keyboard.down("Control");
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, -240);
      await page.keyboard.up("Control");
    };
    const wheelPan = async () => {
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, -240);
    };
    const dragPan = async () => {
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx - 180, cy - 60, { steps: 10 });
      await page.mouse.up();
    };
    for (let round = 0; round < 2; round += 1) {
      await applyInput(`ctrl+wheel zoom #${round + 1}`, wheelZoom);
      await applyInput(`plain-wheel pan #${round + 1}`, wheelPan);
      await applyInput(`pointer-drag pan #${round + 1}`, dragPan);
    }
    const canvasUpdateCadence = await presentation;
    let compositor = null;
    if (cdp) {
      const windowMs = Date.now() - castStart;
      await cdp.send("Page.stopScreencast").catch(() => {});
      await cdp.detach().catch(() => {});
      if (windowMs > 0 && castFrames > 0)
        compositor = {
          presentedFps: Number(((castFrames / windowMs) * 1000).toFixed(1)),
          frames: castFrames,
          windowMs,
        };
    }
    const everyInputMovedCamera = inputs.every((i) => i.ctmChanged);
    if (!compositor) {
      unexercisedGate(
        "perf-playback-fps",
        `no compositor-presented FPS evidence this run (${cdp ? "CDP screencast delivered zero frames" : "CDP screencast unavailable"}) — inputs ran with per-input CTM proof ${everyInputMovedCamera}; canvas internal update cadence ${JSON.stringify(canvasUpdateCadence)} and idle rAF ${JSON.stringify(idleRaf)} recorded as DIAGNOSTICS ONLY, never renamed into a pass`,
      );
    } else {
      const gate = {
        compositorPresented: compositor,
        inputs,
        everyInputMovedCamera,
        canvasUpdateCadence,
        canvasUpdateCadenceNote:
          "pixel-change/rAF = canvas internal update cadence, NOT compositor-presented fps",
        idleRafCadence: idleRaf,
      };
      if (compositor.presentedFps >= minFpsValue && everyInputMovedCamera)
        passGate("perf-playback-fps", gate);
      else
        failGate(
          "perf-playback-fps",
          `compositor presented ${compositor.presentedFps} fps during live inputs (gate >= ${minFpsValue}), per-input CTM proof ${everyInputMovedCamera}: ${JSON.stringify(gate)}`,
        );
    }
  }

  // ── Player through the product menu: top bar → More → Prototype. ────────────────
  await page.getByTestId("figma-top-bar-more").filter({ visible: true }).last().click();
  await page.getByTestId("figma-prototype").filter({ visible: true }).last().click();
  const playerMarker = page.getByTestId("figma-show-hotspots").filter({ visible: true }).last();
  const chooseFlow = page.getByTestId("figma-choose-flow").filter({ visible: true }).last();
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
  // Player green requires its OWN stage canvas with loaded frame pixels: any <canvas> can
  // match the file canvas still mounted behind the player, and the toolbar alone is not a
  // frame. The file canvas is identified by id, so the player stage is the LARGEST canvas
  // without it — and it must have painted content, proving a frame actually loaded. The
  // toolbar appears WHILE the frame RPC is still loading, so a single immediate pixel sample
  // false-fails; poll the same honest bar (largest id-less canvas, width >= 100, nonempty
  // painted pixels) until it passes or the canvas budget expires. No complete-frame proof is
  // manufactured here — only that a frame actually painted, and how long that took.
  const readPlayerStage = () =>
    withDeadline(
      page.evaluate(() => {
        const candidates = [...document.querySelectorAll("canvas:not(#jagentdesk-figma-canvas)")];
        const canvas = candidates.sort((a, b) => b.width * b.height - a.width * a.height)[0];
        if (!canvas) return null;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        const w = Math.min(160, canvas.width);
        const h = Math.min(160, canvas.height);
        const x = Math.floor((canvas.width - w) / 2);
        const y = Math.floor((canvas.height - h) / 2);
        const data = ctx.getImageData(x, y, w, h).data;
        let paintedSamplePixels = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) paintedSamplePixels += 1;
        return {
          canvasCount: candidates.length,
          width: canvas.width,
          height: canvas.height,
          paintedSamplePixels,
        };
      }),
      15_000,
      "player stage canvas sample",
    ).catch(() => null);
  const stageStart = Date.now();
  let playerStage = await readPlayerStage();
  while (
    (!playerStage || playerStage.width < 100 || playerStage.paintedSamplePixels === 0) &&
    Date.now() - stageStart < canvasDeadline
  ) {
    await delay(500);
    playerStage = await readPlayerStage();
  }
  const stagePaintWaitMs = Date.now() - stageStart;
  if (!playerStage || playerStage.width < 100 || playerStage.paintedSamplePixels === 0) {
    failGate(
      "ui-player-open",
      `player toolbar visible but no player-specific stage canvas with loaded pixels after ${stagePaintWaitMs}ms of polling (got ${JSON.stringify(playerStage)}); "canvas" alone would match the file canvas behind the player`,
    );
    // Keep the failed timing gate. A separate bounded observation lets us inspect eventual
    // rendering on a real slow API response instead of losing the window before pixels arrive.
    const observationDeadline = Date.now() + 30_000;
    while (
      (!playerStage || playerStage.width < 100 || playerStage.paintedSamplePixels === 0) &&
      Date.now() < observationDeadline
    ) {
      await delay(500);
      playerStage = await readPlayerStage();
    }
    evidence.playerAfterDeadline = {
      stage: playerStage,
      elapsedMs: Date.now() - stageStart,
      note: "diagnostic only; ui-player-open FAIL above is unchanged",
    };
    await page.screenshot({ path: path.join(artifactDir, "player-after-deadline.png") });
    const extendedObservationMs = Math.min(
      60_000,
      Math.max(0, Number(process.env.JAGENTDESK_FIGMA_E2E_AFTER_FAILURE_OBSERVE_MS) || 0),
    );
    if (extendedObservationMs > 0) {
      console.log(
        `  DIAGNOSTIC player assets observation: ${extendedObservationMs}ms; failed gate unchanged`,
      );
      await delay(extendedObservationMs);
      evidence.playerExtendedObservation = {
        ms: extendedObservationMs,
        stage: await readPlayerStage(),
      };
      await page.screenshot({ path: path.join(artifactDir, "player-assets-observation.png") });
    }
    return;
  }
  uiRequests.playerOpened = true;
  passGate("ui-player-open", {
    via: "figma-top-bar-more → figma-prototype → real clicks",
    playerToolbarVisible: true,
    playerStage,
    stagePaintWaitMs,
    note: "stage canvas is canvas:not(#jagentdesk-figma-canvas) with nonempty painted pixels, polled until painted (toolbar visibility alone does not gate)",
  });
  await page.screenshot({ path: path.join(artifactDir, "player.png") });

  // Close the player, capture after-close app-tree RAM.
  await page.keyboard.press("Escape");
  await playerMarker.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined);
  await delay(1_000);
  ram.afterCloseKb = treeRssKb(electronPid ?? 0).totalKb || ram.afterCloseKb;

  // ── WARM UI, recorded separately (NOT a gate): reopen through the product UI after close.
  // The reload resets renderer query state, so the reopen exercises the DAEMON-side versioned
  // cache — expected zero new REST in the reopen window.
  const warmMark = proxy.log.length;
  const warmStart = Date.now();
  await refreshUi();
  await page.getByTestId(`figma-file-${fileKey}`).filter({ visible: true }).last().click();
  await page
    .waitForSelector("#jagentdesk-figma-canvas", { timeout: 30_000 })
    .catch(() => undefined);
  const warmRest = proxy.log
    .slice(warmMark)
    .filter((entry) => entry.pathname.startsWith(`/v1/files/${fileKey}`));
  evidence.warmUiReopen = {
    mountMs: Date.now() - warmStart,
    restDuringReopen: warmRest.map((e) => e.pathname),
    note: "warm reopen recorded separately from the cold ui-file-open gate",
  };
}

/**
 * Canvas-internal update sampler (DIAGNOSTIC ONLY): counts rAF ticks and the ticks whose
 * centre-region pixel sample of the file canvas actually changed (pixels re-rendered) during
 * live inputs. Neither number is compositor-presented FPS — that bar is the CDP screencast
 * measurement above; these never pass anything on their own.
 */
async function sampleCanvasPresentation(page, sampleMs) {
  return await withDeadline(
    page.evaluate(async (ms) => {
      const canvas = document.getElementById("jagentdesk-figma-canvas");
      if (!canvas) return null;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      const w = Math.min(120, canvas.width);
      const h = Math.min(120, canvas.height);
      const x = Math.floor((canvas.width - w) / 2);
      const y = Math.floor((canvas.height - h) / 2);
      const read = () => ctx.getImageData(x, y, w, h).data;
      let prev = read();
      let rafFrames = 0;
      let presented = 0;
      const start = performance.now();
      return await new Promise((resolve) => {
        const tick = (now) => {
          rafFrames += 1;
          const next = read();
          let changed = false;
          for (let i = 0; i < next.length; i += 4) {
            if (next[i] !== prev[i] || next[i + 1] !== prev[i + 1] || next[i + 2] !== prev[i + 2]) {
              changed = true;
              break;
            }
          }
          if (changed) {
            presented += 1;
            prev = next;
          }
          if (now - start < ms) requestAnimationFrame(tick);
          else
            resolve({
              presentedFps: Number(((presented / (now - start)) * 1000).toFixed(1)),
              rafFps: Number(((rafFrames / (now - start)) * 1000).toFixed(1)),
              presentedFrames: presented,
              rafFrames,
              sampleMs: Math.round(now - start),
            });
        };
        requestAnimationFrame(tick);
      });
    }, sampleMs),
    sampleMs + 15_000,
    `sampleCanvasPresentation (page.evaluate, ${sampleMs}ms window)`,
  ).catch(() => null);
}

/**
 * rAF cadence sample: callback count per second plus the real inter-callback intervals.
 * Chromium drives rAF from the display vsync while the page repaints, so the intervals are
 * the honest presentation cadence DURING input — reported with the gate so an idle raf
 * cannot masquerade as a pan/zoom fps.
 */
async function sampleRafCadence(page, sampleMs) {
  return await withDeadline(
    page.evaluate(
      async (ms) =>
        await new Promise((resolve) => {
          const stamps = [];
          const start = performance.now();
          const tick = (now) => {
            stamps.push(now);
            if (now - start < ms) requestAnimationFrame(tick);
            else {
              const intervals = [];
              for (let i = 1; i < stamps.length; i += 1) intervals.push(stamps[i] - stamps[i - 1]);
              intervals.sort((a, b) => a - b);
              resolve({
                fps: Number(
                  (((stamps.length - 1) / (stamps.at(-1) - stamps[0])) * 1000).toFixed(1),
                ),
                frames: stamps.length,
                sampleMs: Math.round(stamps.at(-1) - stamps[0]),
                medianFrameIntervalMs: intervals.length
                  ? Number(intervals[Math.floor(intervals.length / 2)].toFixed(2))
                  : null,
                worstFrameIntervalMs: intervals.length ? Number(intervals.at(-1).toFixed(2)) : null,
              });
            }
          };
          requestAnimationFrame(tick);
        }),
      sampleMs,
    ),
    sampleMs + 15_000,
    `sampleRafCadence (page.evaluate, ${sampleMs}ms window)`,
  ).catch(() => null);
}

/**
 * REST trace gate (spec 32.11 #15, ADR-0039 #17): the recording proxy proves WHICH request
 * shapes the app made, keeping the three classes distinct:
 *   - outline: a BOUNDED /v1/files/:key call with depth <= 3 and a pinned version (W5/W7 move
 *     the outline to depth 3 so SECTION-nested screens appear; W4's optional Section metadata
 *     rides depth 1)
 *   - Section metadata: depth=1 calls, never a whole-SECTION tree download
 *   - full FRAME reads: /v1/files/:key/nodes — <=50 ids per spec 32.5.1 (canvas subtree loads
 *     are legitimately independent NON-SECTION drawing summaries: GROUP/COMPONENT/INSTANCE/…),
 *     pinned version, and NEVER a known SECTION id: a SECTION id in /nodes means its whole
 *     subtree was downloaded, which spec 32.11 #17 forbids for viewport frames.
 * A REST URL alone cannot tell the logical caller apart, so the playback <=10 frameIds contract
 * is enforced against the actual UI WebSocket request messages (correlated RPC trace), never by
 * shrinking the 50-id canvas budget under the playback limit.
 * The app must NEVER issue an unbounded (no depth) full-document /v1/files/:key GET.
 */
// eslint-disable-next-line eslint(complexity) -- every request class records its own offender.
function runUrlTraceGate(proxyLog, fileKey, sectionNodeIds, uiRequests, linkProblems = []) {
  const restEntries = proxyLog.filter((entry) => entry.pathname.startsWith("/v1/"));
  const offenders = [];
  // Link quiescence violations fold into the trace verdict: with a plugin-linked file or a
  // pending pairing, "the app got its data over standalone REST" is no longer proven.
  for (const problem of linkProblems)
    offenders.push(`Link plugin path, not standalone REST proof — ${problem}`);
  const outlineDepths = [];
  let sectionMetadataCalls = 0;
  let nodesBatches = 0;
  for (const entry of restEntries) {
    if (entry.pathname === `/v1/files/${fileKey}`) {
      const rawDepth = entry.search?.depth;
      const depth = rawDepth === undefined ? Number.POSITIVE_INFINITY : Number(rawDepth);
      if (!Number.isFinite(depth) || depth > 3) {
        offenders.push(`full-document GET /v1/files/${fileKey} (depth=${rawDepth ?? "unset"})`);
      } else if (depth === 1) {
        sectionMetadataCalls += 1;
      } else {
        outlineDepths.push(depth);
        if (!entry.search?.version)
          offenders.push(`outline files call at depth=${depth} without a pinned version`);
      }
    } else if (entry.pathname === `/v1/files/${fileKey}/nodes` && entry.method === "GET") {
      nodesBatches += 1;
      const ids = String(entry.search?.ids ?? "")
        .split(",")
        .filter(Boolean);
      if (ids.length === 0) offenders.push("nodes call with no ids");
      if (ids.length > maxNodesBatch)
        offenders.push(
          `nodes call carried ${ids.length} ids (full-canvas budget is <= ${maxNodesBatch})`,
        );
      if (!entry.search?.version) offenders.push("nodes call without a pinned version");
      if (sectionNodeIds) {
        const sectionIds = ids.filter((id) => sectionNodeIds.has(id));
        if (sectionIds.length > 0)
          offenders.push(
            `nodes call fetched known SECTION ids (whole-SECTION download): ${sectionIds.join(",")}`,
          );
      }
    }
  }
  // Playback <=10 frameIds is an RPC-contract limit, proven on the UI's own WS requests and
  // the harness's correlated API calls — recorded as SEPARATE lists so API-pushed counts can
  // never substitute for missing UI-side evidence.
  if (uiRequests?.playerOpened && (uiRequests.playbackFrameCounts?.length ?? 0) === 0)
    offenders.push(
      "the player gate passed but the renderer WebSocket never sent a figma.file.playback.request — no UI-side playback evidence (harness API calls are not a substitute)",
    );
  for (const [source, counts] of [
    ["UI WS", uiRequests?.playbackFrameCounts ?? []],
    ["harness API", uiRequests?.apiPlaybackFrameCounts ?? []],
  ]) {
    const tooBig = counts.filter((n) => n > maxPlaybackBatch);
    if (tooBig.length > 0)
      offenders.push(
        `${source} playback requests carried ${tooBig.join(",")} frameIds (contract <= ${maxPlaybackBatch})`,
      );
  }
  // Full-canvas subtree loads are a DIFFERENT logical caller: budget <=50, never held to 10.
  const allNodesCounts = [
    ...(uiRequests?.nodesIdCounts ?? []),
    ...(uiRequests?.apiNodesIdCounts ?? []),
  ];
  {
    const tooBig = allNodesCounts.filter((n) => n > maxNodesBatch);
    if (tooBig.length > 0)
      offenders.push(
        `nodes requests carried ${tooBig.join(",")} ids (spec 32.5.1 budget is <= ${maxNodesBatch})`,
      );
  }
  const distinct = [...new Set(restEntries.map((entry) => `${entry.method} ${entry.pathname}`))];
  if (restEntries.length === 0) {
    failGate(
      "net-url-trace",
      "the app made no REST calls through the recording proxy — nothing to prove",
    );
  } else if (offenders.length === 0) {
    passGate("net-url-trace", {
      restCalls: restEntries.length,
      outlineBoundedDepths: [...new Set(outlineDepths)],
      sectionMetadataCalls,
      nodesBatches,
      distinctPaths: distinct,
      uiFigmaRpcTypes: uiRequests ? [...uiRequests.types].sort() : [],
      uiPlaybackBatchSizes: uiRequests?.playbackFrameCounts ?? [],
      uiNodesBatchSizes: uiRequests?.nodesIdCounts ?? [],
      apiPlaybackBatchSizes: uiRequests?.apiPlaybackFrameCounts ?? [],
      apiNodesBatchSizes: uiRequests?.apiNodesIdCounts ?? [],
      uiPlayerOpened: uiRequests?.playerOpened === true,
      playbackLimitNote:
        "playback <=10 enforced on captured UI WS requests; REST /nodes budget is <=50 per spec 32.5.1",
    });
  } else {
    failGate("net-url-trace", `${offenders.join("; ")} — paths: ${distinct.join(", ")}`);
  }
}

// These are real controls and real comment reads, never post/reply/react/delete. This gate
// proves the read/filter layout only; write/resolve/mention/presence acceptance stays separate.
async function runCommentsReadOnlyUiProof(page, requests, artifactDir, evidence, searchTerm) {
  const result = { writesAttempted: false, layouts: [], refreshConfirmed: false };
  evidence.commentsReadOnlyUi = result;
  const visible = (id) => page.getByTestId(id).filter({ visible: true }).last();
  try {
    if (
      await visible("figma-show-hotspots")
        .isVisible()
        .catch(() => false)
    ) {
      const close = visible("figma-prototype-close");
      // A label can sit under the Inspector. Inspect actual hit testing before clicking.
      const reachable = await close.evaluate((element) => {
        const r = element.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return Boolean(hit && (hit === element || element.contains(hit)));
      });
      if (!reachable) throw new Error("Prototype Close is covered by another panel");
      await close.click({ timeout: 10_000 });
      await visible("figma-show-hotspots").waitFor({ state: "hidden", timeout: 10_000 });
    }
    await visible("figma-panel-comments").click({ timeout: 10_000 });
    await visible("figma-comment-input").waitFor({ state: "visible", timeout: 20_000 });
    await visible("figma-comment-search").fill(searchTerm);
    for (const id of ["figma-comment-filter-mine", "figma-comment-filter-resolved"]) {
      await visible(id).click();
      await visible(id).click();
    }
    await visible("figma-comment-sort-oldest").click();
    await visible("figma-comment-sort-latest").click();
    await visible("figma-comment-search").fill("");
    const readCount = requests.commentsResponses.length;
    await visible("figma-comment-refresh").click();
    const deadline = Date.now() + 20_000;
    while (requests.commentsResponses.length <= readCount && Date.now() < deadline)
      await delay(100);
    if (requests.commentsResponses.length <= readCount)
      throw new Error("Refresh sent no completed comment-list response within 20s");
    const refreshed = requests.commentsResponses.at(-1);
    if (refreshed.errorCode) throw new Error(`Comments Refresh failed: ${refreshed.errorCode}`);
    result.refreshConfirmed = true;

    for (const viewport of [null, { width: 390, height: 844 }]) {
      if (viewport) {
        await page.setViewportSize(viewport);
        await visible("figma-compact-panel").click({ timeout: 10_000 });
      }
      const search = visible("figma-comment-search");
      await search.waitFor({ state: "visible", timeout: 10_000 });
      const panel = search.locator("..").locator("..");
      const bounds = await panel.boundingBox();
      if (!bounds) throw new Error("Comments panel has no measurable bounds");
      const overflowing = [];
      for (const id of [
        "figma-comment-refresh",
        "figma-comment-filter-all",
        "figma-comment-filter-node",
        "figma-comment-filter-mine",
        "figma-comment-filter-resolved",
        "figma-comment-sort-latest",
        "figma-comment-sort-oldest",
        "figma-comment-input",
        "figma-comment-post",
      ]) {
        const b = await visible(id).boundingBox();
        if (!b || b.x < bounds.x - 2 || b.x + b.width > bounds.x + bounds.width + 2)
          overflowing.push(id);
      }
      const name = viewport ? "comments-phone-web" : "comments-desktop";
      await page.screenshot({ path: path.join(artifactDir, `${name}.png`) });
      result.layouts.push({ name, width: bounds.width, overflowing });
      if (overflowing.length)
        throw new Error(`${name}: controls overflow: ${overflowing.join(", ")}`);
    }
    // Leave the compact inspector through its real close control, then exercise the player
    // toolbar in that same narrow viewport. Merely seeing Close was insufficient in run 12.
    await page
      .getByRole("button", { name: "Close", exact: true })
      .filter({ visible: true })
      .last()
      .click();
    await visible("figma-comment-search").waitFor({ state: "hidden", timeout: 10_000 });
    await visible("figma-top-bar-more").click();
    await visible("figma-prototype").click();
    const phoneClose = visible("figma-prototype-close");
    await phoneClose.waitFor({ state: "visible", timeout: 10_000 });
    await page.screenshot({ path: path.join(artifactDir, "prototype-phone-toolbar.png") });
    await phoneClose.click({ timeout: 10_000 });
    await visible("figma-show-hotspots").waitFor({ state: "hidden", timeout: 10_000 });
    result.prototypeCloseOnPhone = true;
    const writes = Object.entries(requests.counts).filter(
      ([type, count]) =>
        count > 0 &&
        /^figma\.(?:file\.comments\.(?:post|delete|react)|remote\.execute|link\.op|pending\.add)\.request$/.test(
          type,
        ),
    );
    if (writes.length) throw new Error("Unexpected Figma write RPC observed in read-only UI run");
    result.pass = true;
    passGate("ui-comments-readonly", result);
  } catch (error) {
    result.pass = false;
    result.error = error instanceof Error ? error.message : String(error);
    await page
      .screenshot({ path: path.join(artifactDir, "comments-readonly-failure.png") })
      .catch(() => {});
    failGate("ui-comments-readonly", result.error);
  }
}

/** Private target ids/version arrive via env; this captures evidence, never declares fidelity PASS. */
async function captureRenderQuality(page, requests, artifactDir, evidence) {
  const target = {
    page: process.env.JAGENTDESK_FIGMA_E2E_QUALITY_PAGE,
    node: process.env.JAGENTDESK_FIGMA_E2E_QUALITY_NODE,
    version: process.env.JAGENTDESK_FIGMA_E2E_QUALITY_VERSION,
  };
  if (!Object.values(target).some(Boolean)) return;
  const result = {
    target,
    captures: [],
    note: "Visual review required; stable pixels alone do not prove complete or correct assets.",
  };
  evidence.renderQuality = result;
  try {
    if (!Object.values(target).every(Boolean))
      throw new Error("Quality target needs page, node and version");
    await page.setViewportSize({ width: 1920, height: 1080 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 2,
      mobile: false,
    });
    const url = new URL(page.url());
    for (const [key, value] of Object.entries(target)) url.searchParams.set(key, value);
    const requestStart = requests.renderRequests.length;
    const responseStart = requests.renderResponses.length;
    requests.renderPending.clear(); // the old page's closed socket cannot settle after navigation
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
    const canvas = page.locator("#jagentdesk-figma-canvas");
    await canvas.waitFor({ state: "visible", timeout: 60_000 });
    await page.getByTestId("figma-zoom-reset").filter({ visible: true }).last().click();
    // Canvas pixels and the real renderer's outstanding export requests must both settle.
    // This is only a capture readiness hint; missing fonts/subtrees still need visual review.
    const settle = async () => {
      const deadline = Date.now() + 120_000;
      let previous = "",
        stableSince = Date.now();
      while (Date.now() < deadline) {
        const image = await canvas.evaluate((c) => c.toDataURL("image/png"));
        const hash = createHash("sha256").update(image).digest("hex");
        if (hash !== previous || requests.renderPending.size) stableSince = Date.now();
        previous = hash;
        if (Date.now() - stableSince >= 8_000) return { stable: true, pending: 0, hash };
        await delay(1_000);
      }
      return { stable: false, pending: requests.renderPending.size };
    };
    let currentZoom = 1;
    for (const zoom of [1, 2, 3.32]) {
      if (zoom !== currentZoom) {
        const box = await canvas.boundingBox();
        if (!box) throw new Error("No canvas bounds");
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.keyboard.down("Control");
        try {
          await page.mouse.wheel(0, -Math.log(zoom / currentZoom) / 0.0025);
        } finally {
          await page.keyboard.up("Control");
        }
      }
      currentZoom = zoom;
      const readiness = await settle();
      const geometry = await canvas.evaluate((c) => {
        const m = c.getContext("2d").getTransform();
        const r = c.getBoundingClientRect();
        return {
          dpr: window.devicePixelRatio,
          width: c.width,
          height: c.height,
          css: { x: r.x, y: r.y, width: r.width, height: r.height },
          transform: { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f },
        };
      });
      const name = `quality-${Math.round(zoom * 100)}`;
      await page.screenshot({ path: path.join(artifactDir, `${name}.png`) });
      await canvas.screenshot({ path: path.join(artifactDir, `${name}-canvas.png`) });
      fs.writeFileSync(
        path.join(artifactDir, `${name}-pixels.png`),
        Buffer.from(
          (await canvas.evaluate((c) => c.toDataURL("image/png"))).split(",")[1],
          "base64",
        ),
      );
      result.captures.push({ name, requestedZoom: zoom, readiness, geometry });
    }
    result.renderRequests = requests.renderRequests.slice(requestStart);
    result.renderResponses = requests.renderResponses.slice(responseStart);
    result.finalUrl = page.url();
    console.log(`  diagnostic render-quality ${JSON.stringify(result.captures)}`);
  } catch (error) {
    result.error = String(error?.message ?? error);
    await page.screenshot({ path: path.join(artifactDir, "quality-failure.png") }).catch(() => {});
    console.log(`  diagnostic render-quality failed: ${result.error}`);
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
