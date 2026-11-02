#!/usr/bin/env node
// Acceptance run for spec 25.16 (SSH servers) against a REAL daemon process built from this
// checkout (`npm run build:server`), driven over RPC with the daemon client. Never touches the
// daemon on 6767 or containers it did not create.
//
//   node packages/server/scripts/ssh-acceptance.mjs [--keep] [--port 47911]
//
// Topology (all containers `jad-verify-*`, host ports 2300–2319):
//   target   :2300  password sshd, also on jad-verify-net-a with postgres `db`
//   db              postgres:16-alpine on jad-verify-net-a only (reached through target)
//   hop1     :2301  sshd on bridge + jad-verify-jump1
//   hop2            sshd on jad-verify-jump1 + jad-verify-jump2 (no published port)
//   inner           sshd on jad-verify-jump2 only (reachable only through hop1 → hop2)
//   docker   :2302  sshd with the host Docker socket mounted
//   nodocker :2303  sshd without Docker
// The report goes to /tmp/jad-ssh-acceptance-report.md.

import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const DAEMON_PORT = Number(args[args.indexOf("--port") + 1] || 47911);
const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = "/tmp/jad-ssh-verify-home";
// The daemon's HOME: its ~/.ssh holds the ssh_config imported in criterion 13, so the real
// user's ~/.ssh is never read by the importer.
const FAKE_HOME = "/tmp/jad-ssh-verify-fakehome";
const AGENT_CWD = "/tmp/jad-ssh-verify-agent";
const REPORT = "/tmp/jad-ssh-acceptance-report.md";
const TRANSFER_DIR = "/tmp/jad-ssh-verify-transfer";
const DAEMON_LOG = "/tmp/jad-ssh-verify-daemon.log";
const PASSWORD = "jadtest";
const PG_PASSWORD = "jadverify";
const KEY_PASSPHRASE = `verify-pass-${randomBytes(4).toString("hex")}`;
const FORWARD_PORT = 15432;
// Criterion 13: a ProxyJump chain (one hop is another imported Host, one is inline), a
// ProxyCommand host and a wildcard block. Addresses point at the jad-verify containers.
const IMPORT_SSH_CONFIG = `# jad-verify import test (spec 25.16 #13)
Host verify-import-hop1
  HostName 127.0.0.1
  Port 2301
  User jad

Host verify-import-inner
  HostName jad-verify-inner
  Port 2222
  User jad
  ProxyJump verify-import-hop1,jad@jad-verify-hop2:2222

Host verify-import-proxycmd
  HostName 127.0.0.1
  Port 2303
  User jad
  ProxyCommand nc %h %p

Host *
  ServerAliveInterval 30
`;
const IMAGE = "lscr.io/linuxserver/openssh-server";
const SSH_SERVER_AGENT_LABEL = "jagentdesk.ssh.server.id";
const SECRET_NEEDLES = () => [PASSWORD, KEY_PASSPHRASE, "PRIVATE KEY", PG_PASSWORD];

const C = {
  target: "jad-verify-target",
  db: "jad-verify-db",
  hop1: "jad-verify-hop1",
  hop2: "jad-verify-hop2",
  inner: "jad-verify-inner",
  docker: "jad-verify-docker",
  nodocker: "jad-verify-nodocker",
  restartme: "jad-verify-restartme",
};
const NET = { a: "jad-verify-net-a", jump1: "jad-verify-jump1", jump2: "jad-verify-jump2" };

// ── small helpers ──

function sh(command) {
  return execFileSync("bash", ["-c", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function shQuiet(command) {
  try {
    return sh(command);
  } catch (error) {
    return `ERR: ${error.stderr?.toString().trim() || error.message}`;
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function waitFor(label, check, timeoutMs = 30_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms: ${label}`);
    await sleep(intervalMs);
  }
}
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}
// No outer shell: `$` in `command` is expanded by the container's sh only.
function dexec(container, command) {
  return execFileSync("docker", ["exec", container, "sh", "-c", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function snapshotDir(dir) {
  if (!existsSync(dir)) return "(missing)";
  return readdirSync(dir)
    .sort()
    .map((name) => {
      const full = path.join(dir, name);
      const stat = statSync(full);
      const digest = stat.isFile()
        ? createHash("sha256").update(readFileSync(full)).digest("hex").slice(0, 16)
        : "dir";
      return `${name} ${stat.size} ${Math.round(stat.mtimeMs)} ${digest}`;
    })
    .join("\n");
}
function fence(text) {
  return `\n\`\`\`\n${String(text).trim()}\n\`\`\`\n`;
}

// ── report ──

const results = [];
const findings = [
  'Criterion 9\'s "workspace with 3 panes" is app UI (`planSnippetWorkspace` + split view) and was not rendered here; the daemon side (one exec result per server) is what was verified.',
];
function criterion(id, title) {
  const entry = { id, title, status: "FAIL", steps: [], observed: [] };
  results.push(entry);
  return {
    step: (text) => entry.steps.push(text),
    see: (label, value) =>
      entry.observed.push({
        label,
        value: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      }),
    set: (status) => (entry.status = status),
    entry,
  };
}
async function run(id, title, fn) {
  const c = criterion(id, title);
  const started = Date.now();
  try {
    await fn(c);
  } catch (error) {
    c.see(
      "error",
      error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
    );
    c.set("FAIL");
  }
  c.entry.durationMs = Date.now() - started;
  console.log(`[${c.entry.status}] ${id} ${title} (${c.entry.durationMs} ms)`);
}

// ── topology ──

function cleanupContainers() {
  shQuiet(`docker rm -f ${Object.values(C).join(" ")} 2>/dev/null`);
  for (const net of Object.values(NET)) shQuiet(`docker network rm ${net} 2>/dev/null`);
}

async function waitForSshd(container) {
  await waitFor(
    `${container} sshd`,
    () =>
      !shQuiet(`docker exec ${container} sh -c 'test -s /config/sshd.pid && echo ok'`).startsWith(
        "ERR",
      ),
    90_000,
    1000,
  );
}

function enableForwarding(container) {
  dexec(
    container,
    "sed -i 's/^AllowTcpForwarding no/AllowTcpForwarding yes/; s/^GatewayPorts no/GatewayPorts clientspecified/' /config/sshd/sshd_config && /command/s6-svc -r /run/service/svc-openssh-server",
  );
}

async function startTopology() {
  cleanupContainers();
  for (const net of Object.values(NET)) sh(`docker network create ${net} >/dev/null`);
  const sshd = (name, extra) =>
    sh(
      `docker run -d --name ${name} --hostname ${name} ${extra} -e PASSWORD_ACCESS=true -e USER_NAME=jad -e USER_PASSWORD=${PASSWORD} -e PUID=1000 -e PGID=1000 ${IMAGE} >/dev/null`,
    );
  sshd(C.target, "-p 2300:2222");
  sh(`docker network connect ${NET.a} ${C.target}`);
  sh(
    `docker run -d --name ${C.db} --network ${NET.a} --network-alias db -e POSTGRES_PASSWORD=${PG_PASSWORD} postgres:16-alpine >/dev/null`,
  );
  sshd(C.hop1, `-p 2301:2222`);
  sh(`docker network connect ${NET.jump1} ${C.hop1}`);
  sshd(C.hop2, `--network ${NET.jump1}`);
  sh(`docker network connect ${NET.jump2} ${C.hop2}`);
  sshd(C.inner, `--network ${NET.jump2}`);
  sshd(C.docker, "-p 2302:2222 -v /var/run/docker.sock:/var/run/docker.sock");
  sshd(C.nodocker, "-p 2303:2222");
  sh(`docker run -d --name ${C.restartme} alpine:3.20 sleep 86400 >/dev/null`);
  for (const name of [C.target, C.hop1, C.hop2, C.inner, C.docker, C.nodocker])
    await waitForSshd(name);
  // The mounted Docker socket is root:root 0660; group root gives `jad` the access a user in
  // group docker has on a real server.
  // sshd runs as jad (s6-setuidgid) and passes its own groups to sessions; enableForwarding
  // below restarts it (the image also ships AllowTcpForwarding no, which blocks the
  // streamlocal channel to the Docker socket).
  dexec(C.docker, "addgroup jad root");
  for (const name of [C.target, C.hop1, C.hop2, C.docker]) enableForwarding(name);
  await sleep(3000);
  await waitFor(
    "docker sshd banner",
    () => shQuiet("nc -w 2 127.0.0.1 2302 < /dev/null | head -c 4") === "SSH-",
    60_000,
    1000,
  );
  await waitFor(
    "postgres ready",
    () => !shQuiet(`docker exec ${C.db} pg_isready -U postgres`).startsWith("ERR"),
    60_000,
    1000,
  );
  await sleep(2000);
}

// ── daemon ──

function portListening(port) {
  return (
    !shQuiet(`lsof -iTCP:${port} -sTCP:LISTEN -t`).startsWith("ERR") &&
    shQuiet(`lsof -iTCP:${port} -sTCP:LISTEN -t`) !== ""
  );
}

async function startDaemon() {
  if (DAEMON_PORT === 6767) throw new Error("refusing to use port 6767");
  if (portListening(DAEMON_PORT)) throw new Error(`port ${DAEMON_PORT} is busy`);
  const env = {
    ...process.env,
    JAGENTDESK_HOME: HOME,
    JAGENTDESK_LISTEN: `127.0.0.1:${DAEMON_PORT}`,
    JAGENTDESK_TAILSCALE_ENABLED: "0",
    HOME: FAKE_HOME,
  };
  const child = spawn(
    process.execPath,
    [path.join(SERVER_DIR, "dist/scripts/supervisor-entrypoint.js")],
    {
      cwd: SERVER_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const chunks = [];
  child.stdout.on("data", (d) => chunks.push(d));
  child.stderr.on("data", (d) => chunks.push(d));
  const log = () => Buffer.concat(chunks).toString("utf8");
  try {
    await waitFor(
      "daemon listening",
      () => portListening(DAEMON_PORT) || child.exitCode !== null,
      60_000,
      500,
    );
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
  return { child, log, listening: portListening(DAEMON_PORT) };
}

async function stopDaemon(daemon) {
  if (!daemon || daemon.child.exitCode !== null) return;
  daemon.child.kill("SIGTERM");
  await waitFor(
    "daemon exit",
    () => daemon.child.exitCode !== null || !portListening(DAEMON_PORT),
    20_000,
    250,
  ).catch(() => daemon.child.kill("SIGKILL"));
}

// ── client ──

class Client {
  constructor(name, clientType) {
    this.name = name;
    this.prompts = [];
    this.states = [];
    this.decisions = new Map(); // serverId → "accept" | "reject"
    this.daemon = new DaemonClient({
      url: `ws://127.0.0.1:${DAEMON_PORT}/ws`,
      clientId: `clid_ssh_acceptance_${name}_${randomBytes(3).toString("hex")}`,
      clientType,
      appVersion: "0.9.46",
      webSocketFactory: (url, options) =>
        new WebSocket(url, options?.protocols, { headers: options?.headers }),
    });
  }
  async connect() {
    await this.daemon.connect();
    this.daemon.onSshHostkeyPrompt((prompt) => {
      this.prompts.push(prompt);
      const decision = this.decisions.get(prompt.serverId);
      if (decision)
        void this.daemon
          .sshHostkeyRespond({ promptId: prompt.promptId, decision })
          .catch(() => undefined);
    });
    this.daemon.onSshConnectionState((event) => this.states.push({ atMs: Date.now(), ...event }));
    return this;
  }
  async close() {
    await this.daemon.close();
  }
  async module(type, fields = {}) {
    const { payload } = await this.daemon.sshModuleRequest({ type, ...fields });
    if (payload.error) throw new Error(`${type}: ${JSON.stringify(payload.error)}`);
    return payload;
  }
  async saveServer(server, password) {
    const res = await this.daemon.sshServersSave({
      server: { id: "", ...server },
      ...(password ? { password } : {}),
    });
    if (res.error) throw new Error(`servers.save: ${res.error}`);
    return res.server;
  }
  /** Opens an SSH tab, answering host-key prompts for `serverId` with `decision`; resolves on connected/error. */
  async open(serverId, decision = "accept") {
    this.decisions.set(serverId, decision);
    const since = this.states.length;
    const res = await this.daemon.sshSessionCreate({ serverId, size: { cols: 120, rows: 32 } });
    if (res.error) return { terminalId: res.terminalId ?? null, error: res.error, state: null };
    const terminalId = res.terminalId;
    const state = await waitFor(
      `connect ${serverId}`,
      () =>
        this.states
          .slice(since)
          .find(
            (s) =>
              s.terminalId === terminalId &&
              (s.state === "connected" || s.state === "error" || s.state === "disconnected"),
          ),
      60_000,
    );
    return {
      terminalId,
      error: state.state === "connected" ? null : (state.error ?? state.state),
      state,
    };
  }
  async attach(terminalId) {
    const res = await this.daemon.subscribeTerminal(terminalId);
    if (res.error) throw new Error(`subscribe ${terminalId}: ${res.error}`);
    return res;
  }
  type(terminalId, data) {
    this.daemon.sendTerminalInput(terminalId, { type: "input", data });
  }
  async screen(terminalId) {
    const res = await this.daemon.captureTerminal(terminalId, { stripAnsi: true });
    return res.lines.join("\n");
  }
  async waitScreen(terminalId, needle, timeoutMs = 20_000) {
    return waitFor(
      `screen of ${terminalId} shows ${needle}`,
      async () => {
        const text = await this.screen(terminalId);
        return (typeof needle === "string" ? text.includes(needle) : needle.test(text))
          ? text
          : null;
      },
      timeoutMs,
      300,
    );
  }
}

function hostKeyFingerprint(container, wireKeyType) {
  let file = "ssh_host_rsa_key.pub";
  if (wireKeyType === "ssh-ed25519") file = "ssh_host_ed25519_key.pub";
  else if (wireKeyType.startsWith("ecdsa-")) file = "ssh_host_ecdsa_key.pub";
  const pub = dexec(container, `cat /config/ssh_host_keys/${file}`);
  return { file, line: sh(`echo ${JSON.stringify(pub)} | ssh-keygen -lf -`) };
}

async function snippetRun(client, source, serverIds, timeoutMs = 60_000) {
  const { run } = await client.module("ssh.snippet.run.request", { source, serverIds });
  return waitFor(
    `run ${run.runId}`,
    async () => {
      const { run: current } = await client.module("ssh.snippet.get_run.request", {
        runId: run.runId,
      });
      return current?.finishedAtMs ? current : null;
    },
    timeoutMs,
    500,
  );
}
function outputOf(target) {
  return target.output.map((chunk) => chunk.text).join("");
}

// ── criteria ──

async function main() {
  const startedAt = new Date();
  const head = sh(`git -C ${SERVER_DIR} rev-parse --short HEAD`);
  const branchInfo = shQuiet(`git -C ${SERVER_DIR} log -1 --format='%h %s'`);
  rmSync(FAKE_HOME, { recursive: true, force: true });
  mkdirSync(path.join(FAKE_HOME, ".ssh"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(FAKE_HOME, ".ssh/config"), IMPORT_SSH_CONFIG, { mode: 0o600 });
  rmSync(AGENT_CWD, { recursive: true, force: true });
  mkdirSync(AGENT_CWD, { recursive: true });
  const sshDirBefore = snapshotDir(path.join(os.homedir(), ".ssh"));
  const fakeSshDirBefore = snapshotDir(path.join(FAKE_HOME, ".ssh"));
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  rmSync(TRANSFER_DIR, { recursive: true, force: true });
  mkdirSync(TRANSFER_DIR, { recursive: true });

  console.log("starting containers…");
  await startTopology();
  const topology = sh(
    `docker ps --filter name=jad-verify- --format '{{.Names}}\t{{.Ports}}\t{{.Networks}}'`,
  );

  // Criterion 0: the daemon as built must start, with no loader hooks or other workarounds.
  let daemon;
  await run("0", "Daemon built from this checkout starts (precondition)", async (c) => {
    c.step(
      `node dist/scripts/supervisor-entrypoint.js with JAGENTDESK_HOME=${HOME}, JAGENTDESK_LISTEN=127.0.0.1:${DAEMON_PORT}, JAGENTDESK_TAILSCALE_ENABLED=0, HOME=${FAKE_HOME}; no NODE_OPTIONS`,
    );
    daemon = await startDaemon();
    await sleep(4000);
    const log = daemon.log();
    const crash = log
      .split("\n")
      .filter((line) => /SyntaxError|Named export|Worker crashed/.test(line))
      .slice(0, 3)
      .join("\n");
    const stillUp = daemon.child.exitCode === null && portListening(DAEMON_PORT);
    c.see(
      "daemon process after 4 s",
      stillUp ? `listening on 127.0.0.1:${DAEMON_PORT}` : "not listening / crashed",
    );
    c.see("crash lines in the daemon output", crash || "none");
    c.see("NODE_OPTIONS passed to the daemon", process.env.NODE_OPTIONS ?? "(unset)");
    if (!stillUp || crash) throw new Error("daemon did not start");
    c.set("PASS");
  });
  writeFileSync(DAEMON_LOG, "");

  const desktop = await new Client("desktop", "browser").connect();
  const phone = await new Client("phone", "mobile").connect();
  const ids = {};

  await run(
    "13",
    "Import ~/.ssh/config with ProxyJump and ProxyCommand: jump chain set, ProxyCommand reported skipped",
    async (c) => {
      c.step(`the daemon's HOME is ${FAKE_HOME}; its ~/.ssh/config:`);
      c.see("~/.ssh/config", IMPORT_SSH_CONFIG);
      c.step("ssh.import.preview {source ssh_directory}");
      const { preview } = await desktop.module("ssh.import.preview.request", {
        source: { kind: "ssh_directory" },
      });
      c.see(
        "preview: servers",
        preview.servers.map((d) => ({
          alias: d.alias,
          address: d.address,
          port: d.port,
          username: d.username,
          jumpChain: d.jumpChain,
          status: d.status,
        })),
      );
      c.see("preview: issues", preview.issues);
      c.step("ssh.import.apply {source ssh_directory, importKnownHosts false, keyPaths []}");
      const { result } = await desktop.module("ssh.import.apply.request", {
        source: { kind: "ssh_directory" },
        importKnownHosts: false,
        keyPaths: [],
      });
      c.see("apply result", {
        servers: result.servers,
        issues: result.issues.map(
          (i) => `${i.location.file}:${i.location.line} ${i.severity} ${i.code}: ${i.message}`,
        ),
      });
      const { servers } = await desktop.daemon.sshServersList();
      const byId = new Map(servers.map((s) => [s.id, s]));
      const inner = servers.find((s) => s.label === "verify-import-inner");
      const chain = (inner?.jumpChain ?? []).map((id) => {
        const hop = byId.get(id);
        return hop ? `${hop.label} (${hop.username ?? ""}@${hop.address}:${hop.port ?? 22})` : id;
      });
      c.see("imported verify-import-inner", {
        address: inner?.address,
        port: inner?.port,
        username: inner?.username,
        jumpChain: chain,
      });
      const proxyCmd = servers.find((s) => s.label === "verify-import-proxycmd");
      c.see("imported verify-import-proxycmd (no proxy field)", {
        address: proxyCmd?.address,
        port: proxyCmd?.port,
        proxy: proxyCmd?.proxy ?? null,
      });
      const proxySkipped = result.issues.some(
        (i) => i.code === "proxy_command" && i.severity === "skipped",
      );
      const hop1 = servers.find((s) => s.label === "verify-import-hop1");
      c.step("apply the same config again → everything is a duplicate");
      const { result: again } = await desktop.module("ssh.import.apply.request", {
        source: { kind: "ssh_directory" },
        importKnownHosts: false,
        keyPaths: [],
      });
      c.see("second apply: servers", again.servers);
      c.set(
        inner &&
          inner.jumpChain?.length === 2 &&
          inner.jumpChain[0] === hop1?.id &&
          byId.get(inner.jumpChain[1])?.address === C.hop2 &&
          proxySkipped &&
          proxyCmd &&
          !proxyCmd.proxy
          ? "PASS"
          : "FAIL",
      );
    },
  );

  await run(
    "1",
    "Save server (password) on desktop, connect from phone; ~/.ssh untouched; no password on the wire",
    async (c) => {
      c.step(
        "desktop: ssh.servers.save {address 127.0.0.1, port 2300, username jad, authMethods [password]} + password",
      );
      const server = await desktop.saveServer(
        {
          label: "target",
          address: "127.0.0.1",
          port: 2300,
          username: "jad",
          authMethods: ["password"],
        },
        PASSWORD,
      );
      ids.target = server.id;
      c.see("saved server", server);
      c.step(
        "phone (second client, clientType mobile): ssh.session.create, accept host key, subscribe, type `echo READY-$((6*7)); whoami`",
      );
      const tab = await phone.open(ids.target);
      if (tab.error) throw new Error(`connect failed: ${JSON.stringify(tab.error)}`);
      await phone.attach(tab.terminalId);
      phone.type(tab.terminalId, "echo READY-$((6*7)); whoami\r");
      const screen = await phone.waitScreen(tab.terminalId, "READY-42");
      c.see(
        "phone terminal screen (capture_terminal, stripAnsi)",
        screen
          .split("\n")
          .filter((l) => l.trim())
          .slice(-6)
          .join("\n"),
      );
      ids.targetTab = tab.terminalId;
      const get = await desktop.daemon.sshServersGet({ id: ids.target });
      const keys = Object.keys(get.server ?? {});
      c.see("ssh.servers.get keys", keys.join(", "));
      const serversJson = readFileSync(path.join(HOME, "ssh/servers.json"), "utf8");
      c.see("servers.json contains the password string", String(serversJson.includes(PASSWORD)));
      // The daemon runs with HOME=FAKE_HOME; check that ~/.ssh and the real user's ~/.ssh.
      const sshDirAfter = snapshotDir(path.join(os.homedir(), ".ssh"));
      const fakeSshDirAfter = snapshotDir(path.join(FAKE_HOME, ".ssh"));
      c.see(
        "~/.ssh listings (name size mtime sha256[0:16]) before/after",
        [
          `daemon HOME ${FAKE_HOME}/.ssh: ${fakeSshDirAfter === fakeSshDirBefore ? "identical" : `CHANGED\n${fakeSshDirBefore}\n→\n${fakeSshDirAfter}`}`,
          `real ${path.join(os.homedir(), ".ssh")}: ${sshDirAfter === sshDirBefore ? "identical" : "CHANGED"}`,
        ].join("\n"),
      );
      const noPassword =
        !keys.some((k) => /password/i.test(k) && k !== "hasPassword") &&
        !JSON.stringify(get).includes(PASSWORD);
      c.set(
        /jad\s*$/m.test(screen) &&
          noPassword &&
          !serversJson.includes(PASSWORD) &&
          sshDirAfter === sshDirBefore &&
          fakeSshDirAfter === fakeSshDirBefore
          ? "PASS"
          : "FAIL",
      );
    },
  );

  await run(
    "2",
    "Host key prompt fingerprint = ssh-keygen -lf; reject leaves no record; changed key → host_key_mismatch with both fingerprints",
    async (c) => {
      c.step("save `nodocker` (127.0.0.1:2303); first connect → reject the prompt");
      const server = await desktop.saveServer(
        {
          label: "nodocker",
          address: "127.0.0.1",
          port: 2303,
          username: "jad",
          authMethods: ["password"],
        },
        PASSWORD,
      );
      ids.nodocker = server.id;
      const before = desktop.prompts.length;
      const rejected = await desktop.open(ids.nodocker, "reject");
      const prompt = desktop.prompts.slice(before).find((p) => p.serverId === ids.nodocker);
      c.see("ssh.hostkey.prompt", prompt);
      const truth = hostKeyFingerprint(C.nodocker, prompt.keyType);
      c.see(`ssh-keygen -lf ${truth.file} (inside ${C.nodocker})`, truth.line);
      c.see("connect result after reject", rejected.error);
      const afterReject = (await desktop.daemon.sshKnownhostsList()).knownHosts.filter(
        (k) => k.port === 2303,
      );
      c.see("known hosts for 127.0.0.1:2303 after reject", afterReject);
      c.step("connect again → accept");
      const accepted = await desktop.open(ids.nodocker, "accept");
      const afterAccept = (await desktop.daemon.sshKnownhostsList()).knownHosts.filter(
        (k) => k.port === 2303,
      );
      c.see("known hosts for 127.0.0.1:2303 after accept", afterAccept);
      if (accepted.terminalId)
        await desktop.daemon.killTerminal(accepted.terminalId).catch(() => undefined);
      const fingerprintMatches = truth.line.includes(prompt.fingerprintSha256);
      c.entry.partial = {
        fingerprintMatches,
        rejectedEmpty: afterReject.length === 0,
        accepted: !accepted.error,
        stored: afterAccept[0]?.fingerprintSha256,
      };
      c.set("PENDING");
    },
  );

  await run(
    "3",
    "Generate Ed25519 with passphrase, install_to_server, connect with the key; keys.json has no private key",
    async (c) => {
      c.step("ssh.keys.generate {keyType ed25519, passphrase}");
      const gen = await desktop.daemon.sshKeysGenerate({
        label: "verify-ed25519",
        type: "ed25519",
        passphrase: KEY_PASSPHRASE,
      });
      if (gen.error) throw new Error(gen.error);
      c.see("generated key (wire)", gen.key);
      const keysJson = readFileSync(path.join(HOME, "ssh/keys.json"), "utf8");
      const secrets = readFileSync(path.join(HOME, "ssh/secrets.json"), "utf8");
      c.see(
        "keys.json contains 'PRIVATE KEY' / the passphrase; secrets.json contains plaintext 'PRIVATE KEY'",
        `${keysJson.includes("PRIVATE KEY")} / ${keysJson.includes(KEY_PASSPHRASE)}; ${secrets.includes("PRIVATE KEY")}`,
      );
      c.step("ssh.keys.install_to_server {keyId, serverId target} twice (idempotent)");
      const first = await desktop.module("ssh.keys.install_to_server.request", {
        keyId: gen.key.id,
        serverId: ids.target,
      });
      const second = await desktop.module("ssh.keys.install_to_server.request", {
        keyId: gen.key.id,
        serverId: ids.target,
      });
      c.see("install_to_server outcomes", {
        first: first.outcome,
        second: second.outcome,
        path: first.path,
      });
      const blob = gen.key.publicKey.trim().split(/\s+/)[1];
      c.see(
        "on target: stat ~/.ssh ~/.ssh/authorized_keys; lines with the key",
        dexec(
          C.target,
          `stat -c '%a %U %n' /config/.ssh /config/.ssh/authorized_keys; grep -c '${blob}' /config/.ssh/authorized_keys`,
        ),
      );
      const perms = dexec(C.target, "stat -c '%a' /config/.ssh /config/.ssh/authorized_keys").split(
        /\s+/,
      );
      const keyLines = Number(dexec(C.target, `grep -c '${blob}' /config/.ssh/authorized_keys`));
      const target = (await desktop.daemon.sshServersGet({ id: ids.target })).server;
      c.see("target after install (identityId, authMethods)", {
        identityId: target.identityId,
        authMethods: target.authMethods,
      });
      c.step(
        "fresh connection with the key only: server `target-key` {identityId from the install, authMethods [key]}, no password",
      );
      const keyServer = await desktop.saveServer({
        label: "target-key",
        address: "127.0.0.1",
        port: 2300,
        username: "jad",
        identityId: target.identityId,
        authMethods: ["key"],
      });
      const loginsBefore =
        Number(
          shQuiet(
            `docker exec ${C.target} sh -c "grep -c 'Accepted publickey' /config/logs/openssh/current"`,
          ),
        ) || 0;
      const tab = await desktop.open(keyServer.id);
      if (tab.error) throw new Error(`key connect failed: ${JSON.stringify(tab.error)}`);
      await desktop.attach(tab.terminalId);
      desktop.type(tab.terminalId, "echo KEYAUTH-$(whoami)\r");
      const screen = await desktop.waitScreen(tab.terminalId, "KEYAUTH-jad");
      c.see(
        "terminal over key auth",
        screen
          .split("\n")
          .filter((l) => l.includes("KEYAUTH"))
          .join("\n"),
      );
      // This image's sshd logs to /config/logs/openssh/current (s6-log), not to docker logs.
      const loginLines = shQuiet(
        `docker exec ${C.target} sh -c "grep 'Accepted publickey' /config/logs/openssh/current | tail -1"`,
      );
      const loginsAfter =
        Number(
          shQuiet(
            `docker exec ${C.target} sh -c "grep -c 'Accepted publickey' /config/logs/openssh/current"`,
          ),
        ) || 0;
      c.see(
        `sshd: 'Accepted publickey' lines ${loginsBefore} → ${loginsAfter}; latest`,
        loginLines,
      );
      await desktop.daemon.killTerminal(tab.terminalId).catch(() => undefined);
      c.set(
        !keysJson.includes("PRIVATE KEY") &&
          !keysJson.includes(KEY_PASSPHRASE) &&
          gen.key.hasPassphrase &&
          first.outcome === "installed" &&
          second.outcome === "already_present" &&
          perms[0] === "700" &&
          perms[1] === "600" &&
          keyLines === 1 &&
          loginsAfter > loginsBefore
          ? "PASS"
          : "FAIL",
      );
    },
  );
  await run(
    "4",
    "Close the app while `top` runs, reopen: tab still listed, screen restored, session alive",
    async (c) => {
      c.step("phone: in the target tab type `top`, wait for its header, then close the client");
      phone.type(ids.targetTab, "top\r");
      const topScreen = await phone.waitScreen(ids.targetTab, /load average|Mem:/);
      c.see("screen before closing (first lines)", topScreen.split("\n").slice(0, 4).join("\n"));
      await phone.close();
      await sleep(3000);
      c.step(
        "new client (reopened app): ssh.servers.list → sessions; subscribe the same terminalId; capture",
      );
      const reopened = await new Client("phone-reopened", "mobile").connect();
      const list = await reopened.daemon.sshServersList();
      const session = list.sessions.find((s) => s.terminalId === ids.targetTab);
      c.see("ssh.servers.list sessions", list.sessions);
      await reopened.attach(ids.targetTab);
      const restored = await reopened.waitScreen(ids.targetTab, /load average|Mem:/);
      c.see("restored screen (first lines)", restored.split("\n").slice(0, 4).join("\n"));
      reopened.type(ids.targetTab, "q");
      await sleep(500);
      reopened.type(ids.targetTab, "echo ALIVE-AFTER-REOPEN\r");
      await reopened.waitScreen(ids.targetTab, "ALIVE-AFTER-REOPEN");
      c.see("session still interactive", "typed `echo ALIVE-AFTER-REOPEN` → shown");
      ids.reopened = reopened;
      c.set(session && session.state === "connected" ? "PASS" : "FAIL");
    },
  );

  await run(
    "5",
    "SFTP: 100 MB server→daemon, pause ~50 %, resume → SHA-256 equal; server↔server copy",
    async (c) => {
      c.step("create /config/big.bin (100 MiB random) on target; sha256 inside the container");
      dexec(
        C.target,
        "head -c 104857600 /dev/urandom > /config/big.bin && head -c 8388608 /dev/urandom > /config/small.bin && chown 1000:1000 /config/big.bin /config/small.bin",
      );
      const remoteSha = dexec(C.target, "sha256sum /config/big.bin").split(/\s+/)[0];
      c.see("sha256 on target", remoteSha);
      const events = [];
      const off = desktop.daemon.onSshModulePush("ssh.transfer.progress", (m) =>
        events.push(m.transfer),
      );
      const rawPushes = [];
      const offRaw = desktop.daemon.subscribeRawMessages((m) => {
        if (m.type === "ssh.transfer.progress") rawPushes.push(m.transfer);
      });
      c.step(`ssh.sftp.copy target:/config/big.bin → daemon:${TRANSFER_DIR}; pause when ≥ 45 %`);
      const { transfers } = await desktop.module("ssh.sftp.copy.request", {
        source: { kind: "server", serverId: ids.target },
        sourcePaths: ["/config/big.bin"],
        target: { kind: "daemon" },
        targetDir: TRANSFER_DIR,
        conflict: "replace",
      });
      const id = transfers[0].id;
      c.see("ssh.sftp.copy → transfer", {
        id,
        status: transfers[0].status,
        bytesTotal: transfers[0].bytesTotal,
      });
      // Pushes and the queue listing both count; the listing alone is enough to see progress.
      const current = async (transferId) => {
        const pushed = events.filter((t) => t.id === transferId).at(-1);
        const { transfers: queue } = await desktop.module("ssh.transfer.list.request");
        return queue.find((t) => t.id === transferId) ?? pushed;
      };
      let pausedAt = null;
      try {
        await waitFor(
          "≥45 %",
          async () => {
            const t = await current(id);
            return (
              t &&
              (t.status === "completed" ||
                t.status === "failed" ||
                (t.bytesTotal > 0 && t.bytesTransferred / t.bytesTotal >= 0.45))
            );
          },
          120_000,
          20,
        );
      } catch (error) {
        c.see("transfer at timeout (ssh.transfer.list)", await current(id));
        c.see("ssh.transfer.progress pushes received", String(events.length));
        throw error;
      }
      const pause = await desktop.module("ssh.transfer.pause.request", { transferId: id });
      pausedAt = pause.transfer;
      c.see("ssh.transfer.pause → transfer", {
        status: pausedAt?.status,
        bytesTransferred: pausedAt?.bytesTransferred,
        bytesTotal: pausedAt?.bytesTotal,
        percent: pausedAt
          ? ((100 * pausedAt.bytesTransferred) / pausedAt.bytesTotal).toFixed(1)
          : null,
      });
      await sleep(1500);
      const pausedLater = await current(id);
      c.see("1.5 s later (still paused, bytes unchanged)", {
        status: pausedLater?.status,
        bytesTransferred: pausedLater?.bytesTransferred,
      });
      const partialSize = existsSync(path.join(TRANSFER_DIR, "big.bin"))
        ? statSync(path.join(TRANSFER_DIR, "big.bin")).size
        : 0;
      c.see("partial file on daemon while paused (bytes)", String(partialSize));
      const resume = await desktop.module("ssh.transfer.resume.request", { transferId: id });
      c.see("ssh.transfer.resume → status", resume.transfer?.status);
      const done = await waitFor(
        "completed",
        async () => {
          const t = await current(id);
          return t && (t.status === "completed" || t.status === "failed") ? t : null;
        },
        180_000,
        200,
      );
      c.see("final transfer", {
        status: done.status,
        bytesTransferred: done.bytesTransferred,
        error: done.error,
      });
      c.see(
        "ssh.transfer.progress pushes for this transfer: via onSshModulePush / via subscribeRawMessages",
        `${events.filter((t) => t.id === id).length} / ${rawPushes.filter((t) => t.id === id).length}`,
      );
      const localSha = await sha256File(path.join(TRANSFER_DIR, "big.bin"));
      c.see(`sha256 ${TRANSFER_DIR}/big.bin`, localSha);
      c.step("server↔server: ssh.sftp.copy target:/config/small.bin → nodocker:/config");
      const r2r = await desktop.module("ssh.sftp.copy.request", {
        source: { kind: "server", serverId: ids.target },
        sourcePaths: ["/config/small.bin"],
        target: { kind: "server", serverId: ids.nodocker },
        targetDir: "/config",
        conflict: "replace",
      });
      const r2rId = r2r.transfers[0].id;
      const r2rDone = await waitFor(
        "remote copy",
        async () => {
          const t = await current(r2rId);
          return t && (t.status === "completed" || t.status === "failed") ? t : null;
        },
        120_000,
        200,
      );
      const shaA = dexec(C.target, "sha256sum /config/small.bin").split(/\s+/)[0];
      const shaB = dexec(C.nodocker, "sha256sum /config/small.bin").split(/\s+/)[0];
      c.see("server↔server", { status: r2rDone.status, targetSha: shaA, nodockerSha: shaB });
      off();
      offRaw();
      // The pause response can still say "running"; the queue settles to "paused" right after.
      const pausedMid =
        pausedLater?.status === "paused" &&
        pausedLater.bytesTransferred < pausedAt.bytesTotal &&
        partialSize === pausedLater.bytesTransferred;
      c.set(
        localSha === remoteSha && pausedMid && r2rDone.status === "completed" && shaA === shaB
          ? "PASS"
          : "FAIL",
      );
    },
  );

  await run(
    "6",
    `Local forward 127.0.0.1:${FORWARD_PORT} → db:5432 via target; psql works; busy port → port_in_use`,
    async (c) => {
      c.step(
        `ssh.forward.save {kind local, serverId target, bindPort ${FORWARD_PORT}, destHost db, destPort 5432}; ssh.forward.start`,
      );
      const { rule } = await desktop.module("ssh.forward.save.request", {
        rule: {
          label: "pg",
          kind: "local",
          serverId: ids.target,
          bindPort: FORWARD_PORT,
          destHost: "db",
          destPort: 5432,
        },
      });
      const { state } = await desktop.module("ssh.forward.start.request", { id: rule.id });
      c.see("forward state", state);
      const psql = shQuiet(
        `PGPASSWORD=${PG_PASSWORD} psql -h 127.0.0.1 -p ${FORWARD_PORT} -U postgres -tAc "select current_user || ' @ ' || inet_server_addr() || ' ' || version()"`,
      );
      c.see(`psql -h 127.0.0.1 -p ${FORWARD_PORT} (on the daemon machine)`, psql);
      c.see(
        "db container address on jad-verify-net-a",
        sh(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${C.db}`),
      );
      c.step("second rule on the same port → start");
      const { rule: busy } = await desktop.module("ssh.forward.save.request", {
        rule: {
          label: "pg-busy",
          kind: "local",
          serverId: ids.target,
          bindPort: FORWARD_PORT,
          destHost: "db",
          destPort: 5432,
        },
      });
      const busyState = await desktop.daemon.sshModuleRequest({
        type: "ssh.forward.start.request",
        id: busy.id,
      });
      c.see("busy-port start", busyState.payload);
      await desktop.module("ssh.forward.stop.request", { id: rule.id });
      const busyCode =
        busyState.payload.state?.error?.code ??
        busyState.payload.error?.code ??
        busyState.payload.error;
      c.set(
        state.status === "active" &&
          psql.startsWith("postgres @") &&
          busyState.payload.state?.status === "error" &&
          busyCode === "port_in_use"
          ? "PASS"
          : "FAIL",
      );
    },
  );

  await run(
    "7",
    "Jump chain with 2 hops reaches a server only visible from hop 2; one host-key prompt per hop",
    async (c) => {
      c.step(
        "servers: hop1 (127.0.0.1:2301), hop2 (jad-verify-hop2:2222, reached via hop1), inner (jad-verify-inner:2222, jumpChain [hop1, hop2])",
      );
      const hop1 = await desktop.saveServer(
        {
          label: "hop1",
          address: "127.0.0.1",
          port: 2301,
          username: "jad",
          authMethods: ["password"],
        },
        PASSWORD,
      );
      const hop2 = await desktop.saveServer(
        {
          label: "hop2",
          address: C.hop2,
          port: 2222,
          username: "jad",
          authMethods: ["password"],
          jumpChain: [hop1.id],
        },
        PASSWORD,
      );
      const inner = await desktop.saveServer(
        {
          label: "inner",
          address: C.inner,
          port: 2222,
          username: "jad",
          authMethods: ["password"],
          jumpChain: [hop1.id, hop2.id],
        },
        PASSWORD,
      );
      c.see(
        "inner reachable from the daemon machine directly?",
        `published ports: '${shQuiet(`docker port ${C.inner}`) || "none"}'; networks: ${sh(`docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' ${C.inner}`)}`,
      );
      for (const s of [hop1, hop2, inner]) desktop.decisions.set(s.id, "accept");
      const before = desktop.prompts.length;
      const tab = await desktop.open(inner.id);
      const prompts = desktop.prompts.slice(before).map((p) => ({
        serverId: p.serverId,
        address: p.address,
        port: p.port,
        hopIndex: p.hopIndex,
        hopCount: p.hopCount,
        fingerprintSha256: p.fingerprintSha256,
      }));
      c.see("host-key prompts during the connect", prompts);
      if (tab.error) throw new Error(`connect failed: ${JSON.stringify(tab.error)}`);
      await desktop.attach(tab.terminalId);
      desktop.type(tab.terminalId, "echo ON-$(hostname)\r");
      const screen = await desktop.waitScreen(tab.terminalId, `ON-${C.inner}`);
      c.see(
        "terminal",
        screen
          .split("\n")
          .filter((l) => l.includes("ON-"))
          .join("\n"),
      );
      const truth = [C.hop1, C.hop2, C.inner].map((name) =>
        sh(
          `echo ${JSON.stringify(dexec(name, "cat /config/ssh_host_keys/ssh_host_ed25519_key.pub"))} | ssh-keygen -lf -`,
        ),
      );
      c.see("ssh-keygen -lf ed25519 per hop (hop1, hop2, inner)", truth.join("\n"));
      await desktop.daemon.killTerminal(tab.terminalId).catch(() => undefined);
      const distinct = new Set(prompts.map((p) => `${p.address}:${p.port}`));
      c.set(distinct.size === 3 ? "PASS" : "FAIL");
    },
  );

  await run(
    "9",
    "Snippet `uname -a` on 3 servers: one result per server, matching each server",
    async (c) => {
      const docker = await desktop.saveServer(
        {
          label: "docker",
          address: "127.0.0.1",
          port: 2302,
          username: "jad",
          authMethods: ["password"],
        },
        PASSWORD,
      );
      ids.docker = docker.id;
      desktop.decisions.set(ids.docker, "accept");
      const first = await desktop.open(ids.docker);
      if (first.terminalId)
        await desktop.daemon.killTerminal(first.terminalId).catch(() => undefined);
      c.step("the run starts immediately after kill_terminal on the docker server (no wait)");
      c.step(
        "ssh.snippets.save {label 'Kernel', script 'uname -a'}; ssh.snippet.run on [target, docker, nodocker]",
      );
      const { snippet } = await desktop.module("ssh.snippets.save.request", {
        snippet: {
          label: "Kernel",
          script: "uname -a",
          defaultTargets: [ids.target, ids.docker, ids.nodocker],
        },
      });
      const run9 = await snippetRun(desktop, { kind: "snippet", snippetId: snippet.id }, [
        ids.target,
        ids.docker,
        ids.nodocker,
      ]);
      const rows = run9.targets.map((t) => {
        const container = {
          [ids.target]: C.target,
          [ids.docker]: C.docker,
          [ids.nodocker]: C.nodocker,
        }[t.serverId];
        const truth = dexec(container, "uname -a");
        return {
          server: container,
          state: t.state,
          exitCode: t.exitCode,
          error: t.error,
          output: outputOf(t).trim(),
          dockerExecUname: truth,
          equal: outputOf(t).trim() === truth,
        };
      });
      c.see("per-server results", rows);
      c.step(
        "The workspace with one pane per server is the app's `planSnippetWorkspace` + split view; panes were not rendered (no UI driving in this run).",
      );
      c.set(
        rows.length === 3 && rows.every((r) => r.state === "exited" && r.exitCode === 0 && r.equal)
          ? "PASS"
          : "FAIL",
      );
    },
  );

  const containerNames = (text) => text.split("\n").filter(Boolean).sort();

  await run(
    "12",
    "Server without Docker: environment has no docker; no Docker section",
    async (c) => {
      c.step("ssh.environment.detect {serverId nodocker, force true}");
      const { payload } = await desktop.daemon.sshModuleRequest({
        type: "ssh.environment.detect.request",
        serverId: ids.nodocker,
        force: true,
      });
      const env = payload.environment;
      c.see("environment (os, docker)", {
        error: payload.error,
        os: env?.os,
        docker: env?.docker ?? null,
      });
      c.see(
        "`command -v docker; ls -l /var/run/docker.sock` on nodocker",
        shQuiet(
          `docker exec ${C.nodocker} sh -c 'command -v docker || echo no-docker-cli; ls -l /var/run/docker.sock 2>&1'`,
        ),
      );
      c.step("ssh.docker.attach on nodocker (what the Docker section would open)");
      const { payload: attach } = await desktop.daemon.sshModuleRequest({
        type: "ssh.docker.attach.request",
        serverId: ids.nodocker,
      });
      c.see("ssh.docker.attach", {
        dockerHost: attach.dockerHost,
        errorCode: attach.errorCode,
        error: attach.error,
      });
      c.set(
        env && env.docker === null && attach.errorCode === "docker_not_found" ? "PASS" : "FAIL",
      );
    },
  );

  await run(
    "11",
    "Server with Docker: Docker section lists `docker ps -a` of the server; exec into a container gives its shell",
    async (c) => {
      c.step(
        "ssh.environment.detect {serverId docker, force true} → the server screen shows Docker",
      );
      const { payload: det } = await desktop.daemon.sshModuleRequest({
        type: "ssh.environment.detect.request",
        serverId: ids.docker,
        force: true,
      });
      c.see("environment.docker", det.environment?.docker ?? null);
      c.step("ssh.docker.attach {serverId docker}; docker/list {serverId docker}");
      const { payload: attach } = await desktop.daemon.sshModuleRequest({
        type: "ssh.docker.attach.request",
        serverId: ids.docker,
      });
      c.see("ssh.docker.attach", {
        dockerHost: attach.dockerHost,
        remoteSocketPath: attach.remoteSocketPath,
        error: attach.error,
      });
      let list;
      let truth;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        list = await desktop.daemon.dockerList({ serverId: ids.docker });
        // The server's Docker is the socket mounted into it (this machine's engine).
        truth = containerNames(
          sh(`docker exec ${C.docker} sh -c true; docker ps -a --format '{{.Names}}'`),
        );
        if (JSON.stringify(list.containers.map((x) => x.name).sort()) === JSON.stringify(truth))
          break;
        await sleep(1000);
      }
      const listed = list.containers.map((x) => x.name).sort();
      c.see(
        "docker/list (serverId) container count / `docker ps -a` count",
        `${listed.length} / ${truth.length}`,
      );
      c.see("names only in one of the two", {
        onlyInList: listed.filter((n) => !truth.includes(n)),
        onlyInDockerPs: truth.filter((n) => !listed.includes(n)),
      });
      c.see(
        "jad-verify-* rows in docker/list",
        list.containers
          .filter((x) => x.name.startsWith("jad-verify-"))
          .map((x) => `${x.name}  ${x.image}  ${x.state}`)
          .join("\n"),
      );
      const viaSocket = containerNames(
        shQuiet(`docker -H ${attach.dockerHost} ps -a --format '{{.Names}}'`),
      );
      c.see("`docker -H <forwarded socket> ps -a` count", String(viaSocket.length));
      c.step(
        `docker/exec {serverId docker, container ${C.restartme}}; then a shell over the forwarded socket (the cockpit exec terminal runs \`docker -H <dockerHost> exec -it …\`)`,
      );
      const exec = await desktop.daemon.dockerExec({
        serverId: ids.docker,
        container: C.restartme,
        command: "echo IN-CONTAINER $(cat /etc/hostname) pid1=$(cat /proc/1/comm)",
      });
      const containerId = sh(`docker inspect -f '{{.Config.Hostname}}' ${C.restartme}`);
      c.see("docker/exec output", exec.output ?? exec.error);
      const shell = shQuiet(
        `printf 'echo SHELL-IN-$(hostname); exit\\n' | docker -H ${attach.dockerHost} exec -i ${C.restartme} sh`,
      );
      c.see("interactive sh over the forwarded socket", shell);
      c.see(`hostname of ${C.restartme} (docker inspect)`, containerId);
      await desktop.daemon.sshModuleRequest({
        type: "ssh.docker.detach.request",
        serverId: ids.docker,
      });
      c.set(
        det.environment?.docker?.socketAccessible === true &&
          JSON.stringify(listed) === JSON.stringify(truth) &&
          String(exec.output ?? "").includes(`IN-CONTAINER ${containerId}`) &&
          shell.includes(`SHELL-IN-${containerId}`)
          ? "PASS"
          : "FAIL",
      );
    },
  );

  await run(
    "10",
    "Server chat with Docker: docker_* with serverId lists `docker ps` without approval; restart → permission card → approved → restarted; no secrets in tool output",
    async (c) => {
      c.step(
        `server chat agent: createAgent {provider claude|codex|opencode (first that creates), labels {${SSH_SERVER_AGENT_LABEL}: docker}} with no prompt — no model is called (the daemon's HOME is ${FAKE_HOME}, which holds no provider credentials)`,
      );
      let agent = null;
      const attempts = [];
      for (const provider of ["claude", "codex", "opencode"]) {
        try {
          agent = await desktop.daemon.createAgent({
            provider,
            cwd: AGENT_CWD,
            title: "Server chat · docker (acceptance)",
            labels: { [SSH_SERVER_AGENT_LABEL]: ids.docker },
          });
          attempts.push(`${provider}: created ${agent.id}`);
          break;
        } catch (error) {
          attempts.push(`${provider}: ${error.message.split("\n")[0]}`);
        }
      }
      c.see("createAgent attempts", attempts.join("\n"));
      if (!agent) throw new Error("no provider could create the server-chat agent");
      c.see("agent", { id: agent.id, provider: agent.provider, labels: agent.labels });
      c.step(
        `tools through the daemon's agent MCP endpoint: POST http://127.0.0.1:${DAEMON_PORT}/mcp/agents?callerAgentId=<agent>`,
      );
      const mcp = new McpClient({ name: "jad-ssh-acceptance", version: "1.0.0" });
      await mcp.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${DAEMON_PORT}/mcp/agents?callerAgentId=${agent.id}`),
        ),
      );
      const { tools } = await mcp.listTools();
      c.see(
        "ssh_*/docker_* tools in the catalog",
        tools
          .map((t) => t.name)
          .filter((n) => /^(ssh_|docker_)/.test(n))
          .join(", "),
      );
      const outputs = [];
      const call = async (name, args) => {
        const result = await mcp.callTool({ name, arguments: args }, undefined, {
          timeout: 180_000,
        });
        const text = (result.content ?? []).map((part) => part.text ?? "").join("\n");
        outputs.push({ name, text });
        return { isError: result.isError ?? false, text };
      };
      const pending = async () =>
        (await desktop.daemon.fetchAgent(agent.id))?.agent?.pendingPermissions ?? [];

      c.step("docker_ps {allContainers: true} (no serverId → the chat's server)");
      const ps = await call("docker_ps", { allContainers: true });
      const pendingAfterPs = (await pending()).length;
      const truthIds = sh(`docker ps -a --format '{{.ID}}'`).split("\n").filter(Boolean);
      const missing = truthIds.filter((id) => !ps.text.includes(id));
      c.see(
        "docker_ps result (jad-verify-* lines)",
        ps.text
          .split("\n")
          .filter((l) => l.includes("jad-verify-"))
          .join("\n"),
      );
      c.see("container ids from `docker ps -a` missing from docker_ps", {
        total: truthIds.length,
        missing,
      });
      c.see("pending permissions after docker_ps", String(pendingAfterPs));
      c.step("docker_ps {serverId: docker} (explicit serverId)");
      const psExplicit = await call("docker_ps", { serverId: ids.docker });
      c.see(
        "explicit serverId lists the restart target",
        String(psExplicit.text.includes(C.restartme)),
      );

      c.step(`docker_restart {container: ${C.restartme}} → wait for the permission card → approve`);
      const startedBefore = sh(`docker inspect -f '{{.State.StartedAt}}' ${C.restartme}`);
      const restartCall = call("docker_restart", { container: C.restartme });
      const permission = await waitFor(
        "permission card",
        async () => (await pending()).find((p) => p.name === "docker_restart"),
        60_000,
        300,
      );
      c.see("permission request on the agent (before approval)", permission);
      const startedWhilePending = sh(`docker inspect -f '{{.State.StartedAt}}' ${C.restartme}`);
      await desktop.daemon.respondToPermission(agent.id, permission.id, { behavior: "allow" });
      const restart = await restartCall;
      const startedAfter = sh(`docker inspect -f '{{.State.StartedAt}}' ${C.restartme}`);
      c.see("docker_restart result", restart);
      c.see(
        "container StartedAt: before / while the card was pending / after approval",
        `${startedBefore}\n${startedWhilePending}\n${startedAfter}`,
      );

      c.step(
        "ssh_list_servers and ssh_run {command: 'id -un'} (approved) — output scanned for secrets",
      );
      await call("ssh_list_servers", {});
      const runCall = call("ssh_run", { command: "id -un" });
      const runPermission = await waitFor(
        "ssh_run card",
        async () => (await pending()).find((p) => p.name === "ssh_run"),
        60_000,
        300,
      );
      await desktop.daemon.respondToPermission(agent.id, runPermission.id, { behavior: "allow" });
      const run10 = await runCall;
      c.see("ssh_run output", run10.text.slice(0, 400));
      const leaks = outputs.flatMap((o) =>
        SECRET_NEEDLES()
          .filter((n) => o.text.includes(n))
          .map(() => o.name),
      );
      c.see(
        "tool outputs scanned / outputs containing a password, passphrase or private key",
        `${outputs.length} / ${leaks.length ? leaks.join(", ") : "none"}`,
      );
      await mcp.close();
      c.set(
        !ps.isError &&
          missing.length === 0 &&
          pendingAfterPs === 0 &&
          psExplicit.text.includes(C.restartme) &&
          permission &&
          startedWhilePending === startedBefore &&
          !restart.isError &&
          startedAfter !== startedBefore &&
          leaks.length === 0
          ? "PASS"
          : "FAIL",
      );
    },
  );

  // Criterion 2, part 2: change the host key of nodocker.
  {
    const c2 = results.find((r) => r.id === "2");
    try {
      // sshd reads /etc/ssh/ssh_host_* (HostKey lines are commented out); /config/ssh_host_keys
      // holds the copies the image made at first start. Regenerate the real ones and copy them.
      dexec(
        C.nodocker,
        "for t in ed25519 ecdsa rsa; do rm -f /etc/ssh/ssh_host_${t}_key /etc/ssh/ssh_host_${t}_key.pub; ssh-keygen -q -N '' -t $t -f /etc/ssh/ssh_host_${t}_key; done; cp /etc/ssh/ssh_host_* /config/ssh_host_keys/",
      );
      // Restart the container: an sshd service restart keeps existing sessions (and the
      // daemon's pooled connection) alive, so no new handshake would happen.
      sh(`docker restart ${C.nodocker} >/dev/null`);
      await waitForSshd(C.nodocker);
      await waitFor(
        "nodocker banner",
        () => shQuiet("nc -w 2 127.0.0.1 2303 < /dev/null | head -c 4") === "SSH-",
        60_000,
        1000,
      );
      c2.observed.push({
        label: "new ed25519 host key on nodocker (ssh-keygen -lf)",
        value: hostKeyFingerprint(C.nodocker, "ssh-ed25519").line,
      });
      const tab = await desktop.open(ids.nodocker, "accept");
      const mismatch = desktop.states
        .filter((s) => s.serverId === ids.nodocker && s.error?.code === "host_key_mismatch")
        .at(-1);
      c2.observed.push({
        label: "after regenerating nodocker host keys: connect",
        value: JSON.stringify({ error: tab.error, event: mismatch?.error }, null, 2),
      });
      const stored = (await desktop.daemon.sshKnownhostsList()).knownHosts.filter(
        (k) => k.port === 2303,
      );
      c2.observed.push({
        label: "known hosts unchanged after mismatch",
        value: JSON.stringify(stored, null, 2),
      });
      const p = c2.partial;
      const both =
        mismatch?.error?.storedFingerprint &&
        mismatch?.error?.receivedFingerprint &&
        mismatch.error.storedFingerprint !== mismatch.error.receivedFingerprint;
      c2.status =
        p &&
        p.fingerprintMatches &&
        p.rejectedEmpty &&
        p.accepted &&
        both &&
        stored[0]?.fingerprintSha256 === p.stored
          ? "PASS"
          : "FAIL";
    } catch (error) {
      c2.observed.push({ label: "error", value: String(error?.stack ?? error) });
      c2.status = "FAIL";
    }
    delete c2.partial;
    console.log(`[${c2.status}] 2 (completed)`);
  }

  await run("8", "Network drop 20 s: tab reconnects by itself, screen history kept", async (c) => {
    const server = await desktop.saveServer(
      {
        label: "target-reconnect",
        address: "127.0.0.1",
        port: 2300,
        username: "jad",
        authMethods: ["password"],
        keepaliveIntervalS: 5,
        autoReconnect: true,
      },
      PASSWORD,
    );
    const tab = await desktop.open(server.id);
    if (tab.error) throw new Error(JSON.stringify(tab.error));
    await desktop.attach(tab.terminalId);
    desktop.type(tab.terminalId, "echo BEFORE-DROP-$((40+2))\r");
    await desktop.waitScreen(tab.terminalId, "BEFORE-DROP-42");
    const since = desktop.states.length;
    c.step(`docker pause ${C.target} (20 s), docker unpause`);
    const pausedAt = Date.now();
    sh(`docker pause ${C.target}`);
    await sleep(20_000);
    sh(`docker unpause ${C.target}`);
    const back = await waitFor(
      "reconnected",
      () =>
        desktop.states
          .slice(since)
          .find((s) => s.terminalId === tab.terminalId && s.state === "connected"),
      120_000,
      500,
    );
    const timeline = desktop.states
      .slice(since)
      .filter((s) => s.terminalId === tab.terminalId)
      .map(
        (s) =>
          `${((s.atMs - pausedAt) / 1000).toFixed(1)}s ${s.state}${s.error ? ` ${s.error.code}` : ""}`,
      );
    c.see("connection states for the tab (seconds after pause)", timeline.join("\n"));
    desktop.type(tab.terminalId, "echo AFTER-RECONNECT\r");
    const screen = await desktop.waitScreen(tab.terminalId, "AFTER-RECONNECT", 30_000);
    c.see(
      "same terminalId screen keeps the earlier output",
      screen
        .split("\n")
        .filter((l) => /BEFORE-DROP|AFTER-RECONNECT/.test(l))
        .join("\n"),
    );
    const dropped = timeline.some((line) => !line.endsWith("connected"));
    c.set(back && dropped && screen.includes("BEFORE-DROP-42") ? "PASS" : "FAIL");
  });

  await run("14", "Daemon logs contain no password, passphrase or private key", async (c) => {
    writeFileSync(DAEMON_LOG, daemon.log());
    const files = [
      DAEMON_LOG,
      ...sh(`find ${HOME} -type f \\( -name '*.log' -o -name '*.jsonl' \\) 2>/dev/null || true`)
        .split("\n")
        .filter(Boolean),
    ];
    c.step(
      `grep ${files.length} log file(s) for the server password, the key passphrase, 'PRIVATE KEY' and the Postgres password`,
    );
    const needles = [PASSWORD, KEY_PASSPHRASE, "PRIVATE KEY", PG_PASSWORD];
    const hits = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const needle of needles)
        if (text.includes(needle))
          hits.push(
            `${file}: contains ${needle === PASSWORD ? "<server password>" : needle === KEY_PASSPHRASE ? "<key passphrase>" : needle === PG_PASSWORD ? "<pg password>" : needle}`,
          );
    }
    c.see("log files scanned", files.map((f) => `${f} (${statSync(f).size} bytes)`).join("\n"));
    c.see("hits", hits.length ? hits.join("\n") : "none");
    c.set(hits.length === 0 ? "PASS" : "FAIL");
  });

  await ids.reopened?.close().catch(() => undefined);
  await desktop.close().catch(() => undefined);
  writeFileSync(DAEMON_LOG, daemon.log());
  await stopDaemon(daemon);
  return { startedAt, head, branchInfo, topology };
}

function writeReport(meta) {
  const order = [
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "11",
    "12",
    "13",
    "14",
    "X",
  ];
  const sorted = order.map((id) => results.find((r) => r.id === id)).filter(Boolean);
  const lines = [];
  lines.push("# Spec 25.16 acceptance evidence — SSH servers");
  lines.push("");
  lines.push(`- Run: ${meta.startedAt.toISOString()} → ${new Date().toISOString()}`);
  lines.push(
    `- Code: \`${meta.branchInfo}\` (detached feat/ssh-servers), daemon built with \`npm run build:server\``,
  );
  lines.push(
    `- Daemon: real process \`node packages/server/dist/scripts/supervisor-entrypoint.js\`, JAGENTDESK_HOME=${HOME}, 127.0.0.1:${DAEMON_PORT}, JAGENTDESK_TAILSCALE_ENABLED=0, HOME=${FAKE_HOME}, no NODE_OPTIONS; driven over WebSocket RPC by two \`DaemonClient\`s ("desktop" browser client, "phone" mobile client). No UI was clicked.`,
  );
  lines.push(`- Script: \`packages/server/scripts/ssh-acceptance.mjs\``);
  lines.push("- Topology:" + fence(meta.topology));
  lines.push("");
  if (findings.length) {
    lines.push("## Findings");
    lines.push("");
    findings.forEach((f, i) => lines.push(`${i + 1}. ${f}`));
    lines.push("");
  }
  lines.push("| # | Criterion | Result |");
  lines.push("|---|---|---|");
  for (const r of sorted)
    lines.push(`| ${r.id} | ${r.title.replace(/\|/g, "\\|")} | **${r.status}** |`);
  lines.push("");
  for (const r of sorted) {
    lines.push(`## ${r.id}. ${r.title} — ${r.status}`);
    lines.push("");
    if (r.steps.length) {
      lines.push("Steps:");
      for (const s of r.steps) lines.push(`- ${s}`);
      lines.push("");
    }
    for (const o of r.observed) {
      lines.push(`Observed — ${o.label}:` + fence(o.value));
    }
  }
  writeFileSync(REPORT, `${lines.join("\n")}\n`);
}

let meta = { startedAt: new Date(), head: "", branchInfo: "", topology: "" };
try {
  meta = await main();
} catch (error) {
  console.error(error);
  results.push({
    id: "X",
    title: "Run aborted",
    status: "FAIL",
    steps: [],
    observed: [{ label: "error", value: String(error?.stack ?? error) }],
  });
} finally {
  writeReport(meta);
  if (!KEEP) cleanupContainers();
  rmSync(TRANSFER_DIR, { recursive: true, force: true });
  rmSync(AGENT_CWD, { recursive: true, force: true });
  if (!KEEP) rmSync(FAKE_HOME, { recursive: true, force: true });
  console.log(`report: ${REPORT}`);
  process.exit(0);
}
