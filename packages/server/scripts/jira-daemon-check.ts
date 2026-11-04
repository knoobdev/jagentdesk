// Spec 29.7 check against a REAL daemon process built from this checkout (`npm run build:server`)
// and fake Jira sites (test-support, documented Cloud v3 / Software / DC v2 / OAuth shapes).
// Never touches the daemon on 6767.
//
//   npx tsx packages/server/scripts/jira-daemon-check.ts [--port 47931]
//
// Report: /tmp/jad-jira-daemon-check.md

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { FakeJiraServer } from "../src/server/jira/test-support/fake-jira-server.js";

const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf("--port") + 1] || 47931);
const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = "/tmp/jad-jira-home";
const LOG = "/tmp/jad-jira-daemon.log";
const REPORT = "/tmp/jad-jira-daemon-check.md";
const results: Array<{ name: string; ok: boolean; detail: string }> = [];

interface Ctx {
  client: DaemonClient;
  cloud: FakeJiraServer;
  dc: FakeJiraServer;
  logChunks: string[];
}

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}\n`);
}

// Jira writes only under jira/; every other daemon file is scanned too, except downloaded models.
function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === "models") return [];
    return statSync(full).isDirectory() ? allFiles(full) : [full];
  });
}

function fileContains(file: string, needle: string): boolean {
  try {
    return readFileSync(file, "utf8").includes(needle);
  } catch {
    return false; // removed while scanning (log rotation, temp files)
  }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

function startDaemon(cloud: FakeJiraServer, logChunks: string[]): ChildProcess {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  const entry = path.join(SERVER_DIR, "dist/scripts/supervisor-entrypoint.js");
  const daemon = spawn(process.execPath, [entry], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      JAGENTDESK_HOME: HOME,
      JAGENTDESK_LISTEN: `127.0.0.1:${PORT}`,
      JAGENTDESK_TAILSCALE_ENABLED: "0",
      JAGENTDESK_JIRA_AUTH_URL: cloud.baseUrl,
      JAGENTDESK_JIRA_API_URL: cloud.baseUrl,
      NODE_OPTIONS: "",
      JAGENTDESK_DICTATION_ENABLED: "0",
      JAGENTDESK_VOICE_MODE_ENABLED: "0",
      JAGENTDESK_DICTATION_STT_PROVIDER: "openai",
      JAGENTDESK_VOICE_TURN_DETECTION_PROVIDER: "openai",
      JAGENTDESK_VOICE_STT_PROVIDER: "openai",
      JAGENTDESK_VOICE_TTS_PROVIDER: "openai",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout?.on("data", (chunk) => logChunks.push(String(chunk)));
  daemon.stderr?.on("data", (chunk) => logChunks.push(String(chunk)));
  return daemon;
}

async function connect(client: DaemonClient): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await client.connect();
      return;
    } catch (error) {
      if (Date.now() - start > 60_000) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

async function checkBoot({ client }: Ctx): Promise<void> {
  const jira = await waitFor(
    () => client.getLastServerInfoMessage()?.features?.jira === true,
    10_000,
  );
  record("boot", jira, `built daemon on 127.0.0.1:${PORT}; server_info.features.jira=${jira}`);
}

async function checkApiToken({ client, cloud }: Ctx): Promise<string> {
  const added = await client.jiraRequest("jira.connections.add.request", {
    deployment: "cloud",
    siteUrl: cloud.baseUrl,
    method: "api_token",
    email: cloud.me.email,
    token: cloud.apiToken,
  });
  const connectionId = added.connection?.id ?? "";
  const { projects } = await client.jiraRequest("jira.projects.list.request", { connectionId });
  const { boards } = await client.jiraRequest("jira.boards.list.request", { connectionId });
  const keys = projects.map((p) => p.key).join(",");
  const names = boards.map((b) => b.name).join(",");
  const leak = allFiles(HOME).filter((file) => fileContains(file, cloud.apiToken));
  const ok = keys === "ABC,OPS" && names === "ABC board,OPS board" && leak.length === 0;
  record(
    "1 api token: projects + boards, no token on disk/log",
    ok,
    `projects=${keys} boards=${names} files-with-token=${leak.length}`,
  );
  return connectionId;
}

async function checkTransition({ client, cloud }: Ctx, connectionId: string): Promise<void> {
  const { transitions } = await client.jiraRequest("jira.issue.transitions.request", {
    connectionId,
    issueKey: "ABC-3",
  });
  const transitionId = transitions.find((t) => t.to.id === "3")?.id ?? "";
  await client.jiraRequest("jira.issue.transition.request", {
    connectionId,
    issueKey: "ABC-3",
    transitionId,
  });
  const done = transitions.find((t) => t.to.id === "5");
  const fields = done?.fields ?? [];
  const required = fields.some((f) => f.fieldId === "resolution" && f.required);
  const status = cloud.issues.get("ABC-3")?.statusId;
  const fieldList = fields.map((f) => `${f.fieldId}${f.required ? "*" : ""}`).join(",");
  record(
    "4 To Do → In Progress; Done shows required field",
    status === "3" && required,
    `ABC-3 status=${status}; Done screen fields=${fieldList}`,
  );
}

async function checkPolling({ client, cloud }: Ctx, connectionId: string): Promise<void> {
  const changes: string[][] = [];
  const off = client.onJiraPush("jira.board.changed", (message) => changes.push(message.issueKeys));
  await client.jiraRequest("jira.board.watch.request", {
    watchId: "check",
    connectionId,
    boardId: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const changedAt = Date.now();
  cloud.webTransition("ABC-6", "3");
  const seen = await waitFor(() => changes.length > 0, 25_000);
  const latency = Date.now() - changedAt;
  await client.jiraRequest("jira.board.unwatch.request", { watchId: "check" });
  const closedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 20_000));
  const after = cloud.requestsSince(closedAt).length;
  off();
  record(
    "5 web change ≤ 20 s; closed board stops polling",
    seen && latency <= 20_000 && after === 0,
    `latency=${latency} ms keys=${changes[0]?.join(",")}; requests in 20 s after unwatch=${after}`,
  );
}

async function checkAttachment({ client }: Ctx, connectionId: string): Promise<void> {
  const image = await client.jiraRequest("jira.issue.attachments.download.request", {
    connectionId,
    attachmentId: "30001",
    variant: "content",
  });
  const issue = await client.jiraRequest("jira.issue.get.request", {
    connectionId,
    issueKey: "ABC-2",
  });
  const wire = JSON.stringify(issue.issue);
  const leaks = ["/rest/", "/secure/", "/media/", "avatar", "self"].filter((n) => wire.includes(n));
  record(
    "9 image as bytes, no credentialed URL",
    image.mimeType === "image/png" && leaks.length === 0,
    `mime=${image.mimeType} bytes=${image.size} leaks=${leaks.join(",") || "none"}`,
  );
}

async function checkOAuth({ client, cloud }: Ctx): Promise<void> {
  const begun = await client.jiraRequest("jira.oauth.begin.request", {
    clientId: cloud.oauthClient.clientId,
    clientSecret: cloud.oauthClient.clientSecret,
  });
  const consent = await fetch(begun.authorizeUrl, { redirect: "manual" });
  const callbackUrl = consent.headers.get("location") ?? "";
  const completed = await client.jiraRequest("jira.oauth.complete.request", {
    state: begun.state,
    callbackUrl,
  });
  const connectionId = completed.connection?.id ?? "";
  record(
    "2 OAuth via pasted callback URL",
    completed.connection?.method === "oauth",
    `connection=${connectionId} cloudId=${completed.connection?.cloudId}`,
  );
  const refreshes = () => cloud.tokenRequests.filter((r) => r.grantType === "refresh_token").length;
  const counts: number[] = [];
  let allOk = true;
  for (let round = 1; round <= 3; round += 1) {
    cloud.expireAccessTokens();
    const [a, b] = await Promise.all([
      client.jiraRequest("jira.projects.list.request", { connectionId }),
      client.jiraRequest("jira.boards.list.request", { connectionId }),
    ]);
    counts.push(refreshes());
    allOk = allOk && a.error === null && b.error === null && refreshes() === round;
  }
  const listed = await client.jiraRequest("jira.connections.list.request", {});
  const state = listed.connections.find((c) => c.id === connectionId)?.authState;
  record(
    "3 one refresh per expiry with two parallel requests; connected after 3",
    allOk && state === "connected",
    `refresh counts after rounds=${counts.join(",")} authState=${state}`,
  );
}

async function checkDataCenter({ client, dc }: Ctx): Promise<void> {
  const added = await client.jiraRequest("jira.connections.add.request", {
    deployment: "datacenter",
    siteUrl: dc.baseUrl,
    method: "pat",
    token: dc.pat,
  });
  const connectionId = added.connection?.id ?? "";
  const board = await client.jiraRequest("jira.board.issues.request", { connectionId, boardId: 2 });
  const comments = await client.jiraRequest("jira.issue.comments.list.request", {
    connectionId,
    issueKey: "ABC-2",
  });
  await client.jiraRequest("jira.issue.comments.add.request", {
    connectionId,
    issueKey: "ABC-2",
    bodyMarkdown: "See [PR 7](https://git.test/pr/7)",
  });
  const { transitions } = await client.jiraRequest("jira.issue.transitions.request", {
    connectionId,
    issueKey: "OPS-1",
  });
  const transitionId = transitions.find((t) => t.to.id === "3")?.id ?? "";
  await client.jiraRequest("jira.issue.transition.request", {
    connectionId,
    issueKey: "OPS-1",
    transitionId,
  });
  const stored = String(dc.issues.get("ABC-2")?.comments.at(-1)?.body);
  const status = dc.issues.get("OPS-1")?.statusId;
  const markdown = comments.comments[0]?.body.markdown;
  record(
    "6 Data Center PAT: board, wiki comment, transition",
    board.issues.length === 4 && status === "3" && stored === "See [PR 7|https://git.test/pr/7]",
    `board issues=${board.issues.length}; comment markdown="${markdown}"; stored wiki="${stored}"; OPS-1 status=${status}`,
  );
}

function checkSecrets({ cloud, dc, logChunks }: Ctx): void {
  const log = logChunks.join("");
  writeFileSync(LOG, log);
  const secrets = [cloud.apiToken, cloud.oauthClient.clientSecret, dc.pat];
  const logLeaks = secrets.filter((secret) => log.includes(secret));
  const fileLeaks = allFiles(HOME).filter((file) => secrets.some((s) => fileContains(file, s)));
  record(
    "secrets absent from daemon log and $JAGENTDESK_HOME files",
    logLeaks.length === 0 && fileLeaks.length === 0,
    `log leaks=${logLeaks.length} file leaks=${fileLeaks.join(",") || "none"}`,
  );
}

function writeReport(): void {
  const lines = [
    "# Jira daemon check (spec 29.7)",
    "",
    `Built daemon: node packages/server/dist/scripts/supervisor-entrypoint.js, JAGENTDESK_HOME=${HOME}, 127.0.0.1:${PORT}, JAGENTDESK_TAILSCALE_ENABLED=0; fake Jira sites from test-support.`,
    "",
    ...results.map((r) => `- ${r.ok ? "PASS" : "FAIL"} ${r.name}: ${r.detail}`),
  ];
  writeFileSync(REPORT, `${lines.join("\n")}\n`);
}

async function runChecks(ctx: Ctx): Promise<void> {
  await connect(ctx.client);
  await checkBoot(ctx);
  const connectionId = await checkApiToken(ctx);
  await checkTransition(ctx, connectionId);
  await checkPolling(ctx, connectionId);
  await checkAttachment(ctx, connectionId);
  await checkOAuth(ctx);
  await checkDataCenter(ctx);
  checkSecrets(ctx);
}

async function main(): Promise<void> {
  const cloud = new FakeJiraServer({ deployment: "cloud" });
  const dc = new FakeJiraServer({ deployment: "datacenter" });
  await cloud.start();
  await dc.start();
  const logChunks: string[] = [];
  const daemon = startDaemon(cloud, logChunks);
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${PORT}/ws`,
    clientId: `clid_jira_check_${Date.now()}`,
    clientType: "browser",
    appVersion: "0.9.47",
    webSocketFactory: (url, options) =>
      new WebSocket(url, options?.protocols, { headers: options?.headers }),
  });
  try {
    await runChecks({ client, cloud, dc, logChunks });
  } finally {
    await client.close().catch(() => undefined);
    daemon.kill("SIGTERM");
    await cloud.stop();
    await dc.stop();
  }
  writeReport();
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

await main();
