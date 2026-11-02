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

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const DAEMON_PORT = Number(args[args.indexOf("--port") + 1] || 47911);
const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = "/tmp/jad-ssh-verify-home";
const SHIM_DIR = "/tmp/jad-ssh-verify-shim";
const REPORT = "/tmp/jad-ssh-acceptance-report.md";
const TRANSFER_DIR = "/tmp/jad-ssh-verify-transfer";
const DAEMON_LOG = "/tmp/jad-ssh-verify-daemon.log";
const PASSWORD = "jadtest";
const PG_PASSWORD = "jadverify";
const KEY_PASSPHRASE = `verify-pass-${randomBytes(4).toString("hex")}`;
const FORWARD_PORT = 15432;
const IMAGE = "lscr.io/linuxserver/openssh-server";

const C = {
  target: "jad-verify-target",
  db: "jad-verify-db",
  hop1: "jad-verify-hop1",
  hop2: "jad-verify-hop2",
  inner: "jad-verify-inner",
  docker: "jad-verify-docker",
  nodocker: "jad-verify-nodocker",
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
  for (const name of [C.target, C.hop1, C.hop2, C.inner, C.docker, C.nodocker])
    await waitForSshd(name);
  for (const name of [C.target, C.hop1, C.hop2]) enableForwarding(name);
  await waitFor(
    "postgres ready",
    () => !shQuiet(`docker exec ${C.db} pg_isready -U postgres`).startsWith("ERR"),
    60_000,
    1000,
  );
  await sleep(2000);
}

// ── daemon ──

// The daemon as built crash-loops: `import { Client, utils } from "ssh2"` fails under Node's ESM
// loader because ssh2 is CommonJS (see report, criterion 0). This loader hook serves a re-export
// wrapper for `ssh2` so the rest of the run can still produce evidence. No repository file changes.
function writeShim() {
  mkdirSync(SHIM_DIR, { recursive: true });
  writeFileSync(
    path.join(SHIM_DIR, "register.mjs"),
    `import { register } from "node:module";\nregister("./hooks.mjs", import.meta.url);\n`,
  );
  writeFileSync(
    path.join(SHIM_DIR, "hooks.mjs"),
    `const wrapper = new URL("./ssh2-wrapper.mjs", import.meta.url).href;\nexport async function resolve(specifier, context, next) {\n  if (specifier === "ssh2" && context.parentURL !== wrapper) return { url: wrapper, shortCircuit: true };\n  return next(specifier, context);\n}\n`,
  );
  writeFileSync(
    path.join(SHIM_DIR, "ssh2-wrapper.mjs"),
    `import { createRequire } from "node:module";\nconst ssh2 = createRequire(${JSON.stringify(path.join(SERVER_DIR, "package.json"))})("ssh2");\nexport const { Client, Server, utils, AgentProtocol, BaseAgent, createAgent, CygwinAgent, OpenSSHAgent, PageantAgent, HTTPAgent, HTTPSAgent } = ssh2;\nexport default ssh2;\n`,
  );
}

function portListening(port) {
  return (
    !shQuiet(`lsof -iTCP:${port} -sTCP:LISTEN -t`).startsWith("ERR") &&
    shQuiet(`lsof -iTCP:${port} -sTCP:LISTEN -t`) !== ""
  );
}

async function startDaemon({ withShim }) {
  if (DAEMON_PORT === 6767) throw new Error("refusing to use port 6767");
  if (portListening(DAEMON_PORT)) throw new Error(`port ${DAEMON_PORT} is busy`);
  const env = {
    ...process.env,
    JAGENTDESK_HOME: HOME,
    JAGENTDESK_LISTEN: `127.0.0.1:${DAEMON_PORT}`,
    JAGENTDESK_TAILSCALE_ENABLED: "0",
    ...(withShim ? { NODE_OPTIONS: `--import ${path.join(SHIM_DIR, "register.mjs")}` } : {}),
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
  const sshDirBefore = snapshotDir(path.join(os.homedir(), ".ssh"));
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  rmSync(TRANSFER_DIR, { recursive: true, force: true });
  mkdirSync(TRANSFER_DIR, { recursive: true });

  console.log("starting containers…");
  await startTopology();
  const topology = sh(
    `docker ps --filter name=jad-verify- --format '{{.Names}}\t{{.Ports}}\t{{.Networks}}'`,
  );

  // Criterion 0: the daemon as built must start.
  let daemon;
  await run("0", "Daemon built from this checkout starts (precondition)", async (c) => {
    c.step(
      `node dist/scripts/supervisor-entrypoint.js with JAGENTDESK_HOME=${HOME}, JAGENTDESK_LISTEN=127.0.0.1:${DAEMON_PORT}, JAGENTDESK_TAILSCALE_ENABLED=0, no shim`,
    );
    const plain = await startDaemon({ withShim: false }).catch((error) => ({ error }));
    await sleep(4000);
    const log = plain.log ? plain.log() : String(plain.error);
    const crash = log
      .split("\n")
      .filter((line) => /SyntaxError|Named export/.test(line))
      .slice(0, 2)
      .join("\n");
    const stillUp = plain.child
      ? plain.child.exitCode === null && portListening(DAEMON_PORT)
      : false;
    c.see("daemon process after 4 s", stillUp ? "listening" : "not listening / crashed");
    if (crash) c.see("worker crash", crash);
    c.see(
      "files importing named `utils` from ssh2 (dist)",
      shQuiet(`grep -rln 'import {[^}]*utils[^}]*} from "ssh2"' ${SERVER_DIR}/dist/server`),
    );
    if (plain.child) await stopDaemon(plain);
    rmSync(HOME, { recursive: true, force: true });
    mkdirSync(HOME, { recursive: true });
    c.set(stillUp && !crash ? "PASS" : "FAIL");
    c.step(
      "Evidence below was collected with a Node loader hook (NODE_OPTIONS=--import) that serves a CommonJS re-export wrapper for `ssh2`; no repository file was changed.",
    );
  });
  writeShim();
  daemon = await startDaemon({ withShim: true });
  writeFileSync(DAEMON_LOG, "");

  const desktop = await new Client("desktop", "browser").connect();
  const phone = await new Client("phone", "mobile").connect();
  const ids = {};

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
      const sshDirAfter = snapshotDir(path.join(os.homedir(), ".ssh"));
      c.see(
        "daemon ~/.ssh listing unchanged (name size mtime sha256[0:16])",
        sshDirAfter === sshDirBefore
          ? "identical before/after"
          : `CHANGED\nbefore:\n${sshDirBefore}\nafter:\n${sshDirAfter}`,
      );
      const noPassword =
        !keys.some((k) => /password/i.test(k) && k !== "hasPassword") &&
        !JSON.stringify(get).includes(PASSWORD);
      c.set(
        /jad\s*$/m.test(screen) &&
          noPassword &&
          !serversJson.includes(PASSWORD) &&
          sshDirAfter === sshDirBefore
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
    "Generate Ed25519 with passphrase, install on server, connect with the key; keys.json has no private key",
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
      c.see(
        "keys.json contains 'PRIVATE KEY' / passphrase",
        `${keysJson.includes("PRIVATE KEY")} / ${keysJson.includes(KEY_PASSPHRASE)}`,
      );
      const secrets = readFileSync(path.join(HOME, "ssh/secrets.json"), "utf8");
      c.see(
        "ssh/secrets.json (encrypted store) contains plaintext 'PRIVATE KEY'",
        String(secrets.includes("PRIVATE KEY")),
      );
      c.step("ssh.keys.install_to_server.request (spec 25.12)");
      let installWired = false;
      try {
        await desktop.daemon.sshModuleRequest({
          type: "ssh.keys.install_to_server.request",
          keyId: gen.key.id,
          serverId: ids.target,
        });
        installWired = true;
      } catch (error) {
        c.see(
          "ssh.keys.install_to_server",
          `not available: ${error.message.split("\n")[0].slice(0, 200)}`,
        );
      }
      c.step(
        "fallback through the daemon: append the public key to ~/.ssh/authorized_keys over ssh.sftp.read/write on `target`",
      );
      const endpoint = { kind: "server", serverId: ids.target };
      await desktop
        .module("ssh.sftp.mkdir.request", { endpoint, path: "/config/.ssh" })
        .catch(() => undefined);
      let existing = "";
      try {
        existing =
          (
            await desktop.module("ssh.sftp.read.request", {
              endpoint,
              path: "/config/.ssh/authorized_keys",
            })
          ).file?.content ?? "";
      } catch {
        existing = "";
      }
      const content = `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${gen.key.publicKey.trim()}\n`;
      const write = await desktop.module("ssh.sftp.write.request", {
        endpoint,
        path: "/config/.ssh/authorized_keys",
        content,
      });
      c.see("ssh.sftp.write result", write.result ?? write);
      await desktop.module("ssh.sftp.chmod.request", {
        endpoint,
        path: "/config/.ssh/authorized_keys",
        mode: "600",
      });
      c.see(
        "authorized_keys on target",
        dexec(
          C.target,
          "ls -la /config/.ssh/authorized_keys && grep -c verify-ed25519 /config/.ssh/authorized_keys || grep -c ssh-ed25519 /config/.ssh/authorized_keys",
        ),
      );
      c.step(
        "identity {keyId} + server {identityId, authMethods [key]} without a password; connect",
      );
      const identity = await desktop.daemon.sshIdentitiesSave({
        identity: { id: "", label: "verify-key-identity", username: "jad", keyId: gen.key.id },
      });
      if (identity.error) throw new Error(identity.error);
      const keyServer = await desktop.saveServer({
        label: "target-key",
        address: "127.0.0.1",
        port: 2300,
        username: "jad",
        identityId: identity.identity.id,
        authMethods: ["key"],
      });
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
      c.see(
        "sshd log line for this login",
        shQuiet(`docker logs ${C.target} 2>&1 | grep -i 'Accepted publickey' | tail -1`),
      );
      await desktop.daemon.killTerminal(tab.terminalId).catch(() => undefined);
      const keyOk =
        !keysJson.includes("PRIVATE KEY") &&
        !keysJson.includes(KEY_PASSPHRASE) &&
        gen.key.hasPassphrase;
      if (!installWired) c.set(keyOk ? "PARTIAL" : "FAIL");
      else c.set(keyOk ? "PASS" : "FAIL");
      c.step(
        installWired
          ? "install_to_server used"
          : "Generate + key auth through the daemon PASS; ssh.keys.install_to_server is NOT-YET-WIRED (logs-import module not in the ssh.* dispatch).",
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
      const prompts = desktop.prompts
        .slice(before)
        .map((p) => ({
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

  const notWired = async (id, title, probeType, note) =>
    run(id, title, async (c) => {
      c.step(`probe ${probeType} through the daemon client`);
      try {
        const res = await Promise.race([
          desktop.daemon.sshModuleRequest({ type: probeType }),
          sleep(8000).then(() => "no response in 8 s"),
        ]);
        c.see("response", res);
      } catch (error) {
        c.see("result", error.message.split("\n")[0].slice(0, 300));
      }
      c.step(note);
      c.set("NOT-YET-WIRED");
    });
  await notWired(
    "10",
    "Server chat with Docker: docker_* with serverId (no approval for reads, approval card for restart)",
    "ssh.environment.detect.request",
    "Environment/agent tools (S7) and remote Docker (S8) modules exist on feat/ssh-wire-b but are not in this daemon's ssh.* dispatch or protocol unions.",
  );
  await notWired(
    "11",
    "Server with Docker: Docker section lists `docker ps -a`; exec into a container",
    "ssh.docker.attach.request",
    "Remote Docker (S8) is not wired into this daemon.",
  );
  await notWired(
    "12",
    "Server without Docker: no Docker section; ServerEnvironment.docker absent",
    "ssh.environment.detect.request",
    "Environment detection (S7) is not wired into this daemon.",
  );
  await notWired(
    "13",
    "Import ~/.ssh/config with ProxyJump and ProxyCommand: jump chain created, ProxyCommand reported as skipped",
    "ssh.import.preview.request",
    "Import (S6 logs-import) is not wired into this daemon.",
  );

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
    `- Daemon: real process \`node packages/server/dist/scripts/supervisor-entrypoint.js\`, JAGENTDESK_HOME=${HOME}, 127.0.0.1:${DAEMON_PORT}, JAGENTDESK_TAILSCALE_ENABLED=0; driven over WebSocket RPC by two \`DaemonClient\`s ("desktop" browser client, "phone" mobile client). No UI was clicked.`,
  );
  lines.push(`- Script: \`packages/server/scripts/ssh-acceptance.mjs\``);
  lines.push("- Topology:" + fence(meta.topology));
  lines.push("");
  lines.push("## Findings for the S1 owner");
  lines.push("");
  lines.push(
    '1. **Daemon does not start as built (criterion 0).** `import { Client, utils } from "ssh2"` (ssh-connection.ts) and `import { utils } from "ssh2"` (ssh-service.ts, logs-import/key-files.ts) fail under Node\'s ESM loader: ssh2 is CommonJS and only `AgentProtocol, BaseAgent, Client, createAgent` are detectable named exports. vitest/tsx hide this. Fix: `import ssh2 from "ssh2"; const { utils } = ssh2;`. All other criteria ran with a loader hook that re-exports ssh2 (no repository file changed).',
  );
  lines.push(
    "2. **`DaemonClient.onSshModulePush` never fires.** It subscribes through `on(handler)`, which receives mapped `toEvent()` events, not raw messages; module pushes (`ssh.transfer.progress`, `ssh.forward.state`, `ssh.snippet.*`) are dropped there. `subscribeRawMessages` receives them (count in criterion 5). The app's SFTP/forwarding/snippet UIs that rely on this helper will not update live.",
  );
  lines.push(
    "3. **Not wired into the daemon's ssh.* dispatch:** `ssh.keys.install_to_server`, `ssh.import.*`, `ssh.logs.*` (S6), `ssh.environment.*` + server chat tools (S7), remote Docker/DB/Kubernetes (S8). Criteria 3 (install step), 10–13 depend on them.",
  );
  lines.push(
    '4. Criterion 9\'s "workspace with 3 panes" is app UI (`planSnippetWorkspace` + split view) and was not rendered here; the daemon side (one exec result per server) is what was verified.',
  );
  lines.push("");
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
  console.log(`report: ${REPORT}`);
  process.exit(0);
}
