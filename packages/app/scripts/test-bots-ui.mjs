import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(path.join(root, "package.json"));
const { chromium } = require("playwright");
const { WebSocket } = require("ws");
const { DaemonClient } = await import(
  pathToFileURL(path.join(root, "packages/client/dist/daemon-client.js"))
);
const { BUILTIN_PLUGIN_IDS } = await import(
  pathToFileURL(path.join(root, "packages/protocol/dist/builtin-plugins.js"))
);
const run = promisify(execFile);
const output = process.env.JAGENTDESK_BOTS_UI_OUTPUT ?? "/tmp/jad-plat";
const port = Number(process.env.JAGENTDESK_BOTS_UI_PORT ?? 6940);
assert(Number.isInteger(port) && port > 0 && port <= 65535, "Invalid Bots UI test port");
const endpoint = `127.0.0.1:${port}`;
await fs.mkdir(path.join(output, "reports"), { recursive: true });
const home = await fs.mkdtemp(path.join(output, "botsapp-live-"));
const repo = path.join(home, "sum-repo");
await fs.mkdir(repo);
await fs.writeFile(path.join(repo, "package.json"), JSON.stringify({ type: "module" }));
await fs.writeFile(path.join(repo, "sum.js"), "export function sum(a, b) { return a - b; }\n");
await fs.writeFile(
  path.join(repo, "sum.test.js"),
  "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {sum} from './sum.js'; test('adds',()=>assert.equal(sum(2,3),5));\n",
);
for (const args of [
  ["init", "-b", "main"],
  ["config", "user.email", "bots-ui@test.invalid"],
  ["config", "user.name", "Bots UI test"],
  ["add", "."],
  ["commit", "-m", "Reproduce broken addition"],
])
  await run("git", args, { cwd: repo });
await assert.rejects(run(process.execPath, ["--test"], { cwd: repo }));
const reserved = net.createServer();
await new Promise((resolve, reject) =>
  reserved.once("error", reject).listen(port, "127.0.0.1", resolve),
);
await new Promise((resolve) => reserved.close(resolve));
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("CLAUDE")) delete env[key];
Object.assign(env, {
  JAGENTDESK_HOME: home,
  JAGENTDESK_LISTEN: endpoint,
  JAGENTDESK_TAILSCALE_ENABLED: "0",
  JAGENTDESK_RELAY_ENABLED: "0",
  JAGENTDESK_REQUIRE_LOCAL_PAIRING: "0",
  JAGENTDESK_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
  JAGENTDESK_DICTATION_ENABLED: "0",
  JAGENTDESK_VOICE_MODE_ENABLED: "0",
  JAGENTDESK_WEB_UI_ENABLED: "1",
  JAGENTDESK_WEB_UI_DIST_DIR: path.join(root, "packages/app/dist"),
});
await fs.writeFile(
  path.join(home, "config.json"),
  JSON.stringify({
    daemon: { relay: { enabled: false } },
    builtinPlugins: Object.fromEntries(
      BUILTIN_PLUGIN_IDS.map((id) => [id, { enabled: id === "bots" }]),
    ),
    agents: {
      providers: Object.fromEntries(
        ["claude", "codex", "copilot", "opencode", "pi", "omp"].map((id) => [
          id,
          { enabled: id === "claude" },
        ]),
      ),
    },
  }),
);
const log = createWriteStream(path.join(output, "reports/botsapp-live-daemon.log"));
const child = spawn(process.execPath, ["packages/server/dist/scripts/supervisor-entrypoint.js"], {
  cwd: root,
  env,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
const origin = `http://${endpoint}`;
const result = {
  home,
  repo,
  port,
  claudeEnvKeys: Object.keys(env).filter((key) => key.startsWith("CLAUDE")),
  checks: [],
  screenshots: [],
  errors: [],
  transitions: [],
};
let browser, page, client;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check, label, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(500);
  }
  throw new Error("Timed out: " + label);
}
function visible(id) {
  return page.getByTestId(id).filter({ visible: true });
}
async function shot(name) {
  const target = path.join(output, `botsapp-${name}.png`);
  await page.screenshot({ path: target, fullPage: true });
  result.screenshots.push(target);
}
async function send(text) {
  await visible("bots-message").fill(text);
  await visible("bots-send").click();
}
async function clickTab(tab) {
  await visible(`bot-tab-${tab}`).click();
}
async function approveCards() {
  const card = page
    .locator(
      '[data-testid="permission-request-accept"], [data-testid^="permission-request-action-"]',
    )
    .filter({ visible: true })
    .first();
  if (await card.count()) {
    await card.click();
    result.approvals = (result.approvals ?? 0) + 1;
    return true;
  }
  return false;
}
try {
  await eventually(
    async () => {
      if (child.exitCode !== null) throw new Error("Daemon exited " + child.exitCode);
      try {
        return (await fetch(origin + "/api/health")).ok;
      } catch {
        return false;
      }
    },
    "daemon health",
    90000,
  );
  client = new DaemonClient({
    url: origin.replace("http:", "ws:") + "/ws",
    clientId: "clid_botsapp_live",
    appVersion: "0.9.59",
    webSocketFactory: (url, options) =>
      new WebSocket(url, options?.protocols, { headers: options?.headers }),
  });
  await client.connect();
  const serverId = client.getLastServerInfoMessage().serverId;
  const botUrl = origin + "/h/" + encodeURIComponent(serverId) + "/bots";
  browser = await chromium.launch({
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const now = new Date().toISOString();
  const connection = { id: `direct:${endpoint}`, type: "directTcp", endpoint };
  const testHost = {
    serverId,
    label: "Bots UI isolated host",
    connections: [connection],
    preferredConnectionId: connection.id,
    createdAt: now,
    updatedAt: now,
  };
  await context.addInitScript(
    ({ host }) => {
      localStorage.setItem("@jagentdesk:daemon-registry", JSON.stringify([host]));
      localStorage.setItem(
        "@jagentdesk:app-settings",
        JSON.stringify({ theme: "clickup", defaultThemeVersion: 1, language: "en" }),
      );
    },
    { host: testHost },
  );
  page = await context.newPage();
  let disconnectBrowser = false;
  const browserSockets = [];
  await page.routeWebSocket(new RegExp(`:${port}/ws`), (socket) => {
    if (disconnectBrowser) {
      socket.close();
      return;
    }
    browserSockets.push(socket);
    socket.connectToServer();
  });

  page.on("pageerror", (error) => result.errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") result.errors.push(message.text());
  });
  await page.route(/:(6767|6790)\b/, (route) => route.abort());
  await page.routeWebSocket(/:(6767|6790)\b/, (socket) => socket.close());
  await page.goto(botUrl);
  await visible("bots-create").waitFor({ timeout: 60000 });
  await visible("rail-bots").waitFor();
  await visible("bots-left-panel").waitFor();
  await shot("empty-desktop");
  await visible("bots-create").click();
  await visible("bot-name").fill("Sum helper");
  await visible("bot-slug").fill("sum-helper");
  await page
    .getByTestId("bot-identity")
    .fill("A concise assistant that delegates fixes and reports verified results.");
  await visible("bot-repo").fill(repo);
  await visible("bot-provider").click();
  await page.getByRole("button", { name: "Claude", exact: true }).click({ timeout: 90000 });
  await visible("bot-save").click();
  await visible("bot-tab-chat").waitFor({ timeout: 60000 });
  const bot = (await client.botsRequest("bots.list.request", {})).bots.find(
    (entry) => entry.slug === "sum-helper",
  );
  assert(bot);
  assert.equal(bot.unattended, false);
  result.botId = bot.id;
  result.checks.push(
    "Created an attended bot through the app sheet with actual provider/model catalog",
  );
  console.log(result.checks.at(-1));
  await page
    .getByTestId("bots-left-panel")
    .getByRole("button", { name: "New bot", exact: true })
    .click();
  await visible("bot-name").fill("Review helper");
  await visible("bot-slug").fill("sum-helper");
  await visible("bot-identity").fill("An attended worker permission test assistant.");
  await visible("bot-repo").fill(repo);
  await visible("bot-provider").click();
  await page.getByRole("button", { name: "Claude", exact: true }).click();
  await visible("bot-save").click();
  await visible("bots-error").filter({ hasText: "Bot slug already exists" }).waitFor();
  assert.equal(await visible("bot-slug").inputValue(), "sum-helper");
  await shot("create-error-desktop");
  await visible("bot-slug").fill("review-helper");
  await visible("bot-save").click();
  await visible("bot-tab-chat").waitFor();
  const attendedBot = (await client.botsRequest("bots.list.request", {})).bots.find(
    (entry) => entry.slug === "review-helper",
  );
  assert(attendedBot);
  result.attendedBotId = attendedBot.id;
  await client.botsRequest("bots.update.request", {
    botId: attendedBot.id,
    patch: { modeId: "default" },
  });
  result.checks.push(
    "Duplicate slug error stays visible with the draft intact; correcting it successfully creates another attended bot",
  );
  await page.goto(botUrl + "?botId=" + bot.id);
  await visible("bot-tab-chat").waitFor();
  await send(
    'Create one bot item titled Choose review scope, doneMeans Owner has chosen a scope. Then bot_item_set it to needs_you with exactly one question: Which scope? options ["Small fix", "Full review"], recommended 0. End your turn. After I answer, record the answer in a comment, mark this non-worker item done, and reply Answer received.',
  );
  await visible("permission-request-question").first().waitFor({ timeout: 180000 });
  await shot("permission-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("permission-mobile");
  const questionItem = await eventually(async () => {
    await approveCards();
    const { items } = await client.botsRequest("bots.items.list.request", {
      botId: bot.id,
      includeClosed: true,
    });
    return items.find((item) => item.status === "needs_you");
  }, "Needs you item");
  await clickTab("items");
  await visible("bot-item-" + questionItem.id).click();
  await visible("bot-answer-option-0").waitFor();
  await shot("needs-you-mobile");
  await visible("bot-answer-option-0").click();
  await eventually(async () => {
    const { items } = await client.botsRequest("bots.items.list.request", {
      botId: bot.id,
      includeClosed: true,
    });
    return items.find((item) => item.id === questionItem.id)?.questions?.[0].answer === "Small fix";
  }, "quick answer persisted");
  result.checks.push(
    "Default tool permission card visible on desktop and compact mobile; Needs you quick option answered on mobile",
  );
  console.log(result.checks.at(-1));
  await clickTab("chat");
  await eventually(async () => {
    await approveCards();
    const { items } = await client.botsRequest("bots.items.list.request", {
      botId: bot.id,
      includeClosed: true,
    });
    return items.find((item) => item.id === questionItem.id)?.status === "done";
  }, "bot resumed after answer");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await clickTab("settings");
  assert.equal(await visible("bot-name").inputValue(), "Sum helper");
  page.once("dialog", (dialog) => {
    result.unattendedWarning = dialog.message();
    void dialog.accept();
  });
  await visible("bot-unattended").click();
  assert.match(
    result.unattendedWarning,
    /This bot and its workers will run tools without asking\./,
  );
  await visible("bot-save").click();
  await eventually(
    async () =>
      (await client.botsRequest("bots.list.request", {})).bots.find((entry) => entry.id === bot.id)
        ?.unattended,
    "unattended setting",
  );
  result.checks.push("Enabled unattended in Settings after the exact spec warning");
  await clickTab("chat");
  client.onBotsPush("bots.item.changed", ({ payload: { item } }) => {
    if (item.botId === bot.id)
      result.transitions.push({
        at: Date.now(),
        id: item.id,
        status: item.status,
        worktree: item.worktree,
        roles: item.reviews.map((review) => review.role),
      });
  });
  await send(
    `Fix the failing node --test in ${repo}/sum.js. Create exactly one new bot item titled Fix addition. Start a worker in a NEW worktree via bot_worker_start, assignment smallest fix and run node --test, no peers, no commit/push/merge. End your turn immediately after dispatch. Let daemon cross-review close the item.`,
  );
  const working = await eventually(
    async () => {
      const { items } = await client.botsRequest("bots.items.list.request", {
        botId: bot.id,
        includeClosed: true,
      });
      return items.find((item) => item.title === "Fix addition" && item.workerAgentIds.length);
    },
    "working code item",
    240000,
  );
  await send(
    "While that worker runs, what is your role? Reply in one short sentence, no tools or new items.",
  );
  const done = await eventually(
    async () => {
      const { items } = await client.botsRequest("bots.items.list.request", {
        botId: bot.id,
        includeClosed: true,
      });
      const item = items.find((entry) => entry.id === working.id);
      if (item?.status === "needs_you")
        throw new Error("Review needs owner: " + JSON.stringify(item));
      return item?.status === "done" && item;
    },
    "reviewed code item done",
    600000,
  );
  assert(done.diff);
  assert(done.summary);
  assert.notEqual(done.worktree, repo);
  assert.deepEqual(
    done.reviews.slice(-3).map((review) => review.role),
    ["ba", "tester", "pentester"],
  );
  result.item = done;
  result.workerTests = (await run(process.execPath, ["--test"], { cwd: done.worktree })).stdout;
  assert.match(await fs.readFile(path.join(repo, "sum.js"), "utf8"), /a - b/);
  await clickTab("items");
  await visible("bot-item-" + done.id).click();
  await page.getByText("Reviewed diff", { exact: true }).waitFor();
  await page.getByText("Reviewed diff", { exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "sum.js · +1 −1", exact: true }).click();
  await visible("bot-worktree-file").waitFor();
  assert.match(await visible("bot-worktree-file").innerText(), /return a \+ b/);
  await page.getByText("Reviewed diff", { exact: true }).scrollIntoViewIfNeeded();
  await shot("reviewed-item-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await visible("bot-item-detail").waitFor();
  await page.getByText("Reviewed diff", { exact: true }).scrollIntoViewIfNeeded();
  await shot("reviewed-item-mobile");
  result.checks.push(
    "Real worker in a new worktree completed BA/Tester/Pentester review; diff and summary visible in desktop and compact item detail; fixed tests pass and original checkout remains broken",
  );
  console.log(result.checks.at(-1));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await clickTab("soulMemory");
  await visible("bot-home-editor").waitFor();
  const soul = await visible("bot-home-editor").inputValue();
  assert.match(soul, /# Sum helper/);
  await visible("bot-home-editor").fill(soul + "\nOwner test: keep changes small.\n");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Saved", { exact: true }).waitFor();
  assert.match(
    await fs.readFile(path.join(home, "bots/sum-helper/SOUL.md"), "utf8"),
    /Owner test: keep changes small/,
  );
  result.checks.push("Edited SOUL.md through file read/write RPCs in the Supervisor home");
  const conflictDraft = soul + "\nOwner draft stays visible after a conflict.\n";
  await visible("bot-home-editor").fill(conflictDraft);
  await fs.appendFile(path.join(home, "bots/sum-helper/SOUL.md"), "\nChanged on the host.\n");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByTestId("bots-error")
    .filter({ hasText: "This file changed on the host" })
    .waitFor();
  assert.equal(await visible("bot-home-editor").inputValue(), conflictDraft);
  await shot("file-conflict-desktop");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await eventually(
    async () => (await visible("bot-home-editor").inputValue()).includes("Changed on the host."),
    "reload conflicting home file",
  );
  result.checks.push(
    "A conflicting file save preserves the draft and shows an actionable error; Reload reads the host version",
  );
  await clickTab("schedules");
  await visible("bot-new-schedule").click();
  await visible("bot-schedule-name").fill("Minute check");
  await visible("bot-schedule-cron").fill("* * * * *");
  await page
    .getByTestId("bot-schedule-prompt")
    .fill("Reply with SCHEDULE_TICK only, no tools or new items.");
  await visible("bot-schedule-save").click();
  const schedule = await eventually(
    async () =>
      (await client.botsRequest("bots.schedules.list.request", { botId: bot.id })).schedules[0],
    "schedule saved",
  );
  await eventually(
    async () =>
      (await client.botsRequest("bots.chat.history.request", { botId: bot.id })).messages.find(
        (message) => message.text.includes("SCHEDULE_TICK") && message.source !== "chat",
      ),
    "minute schedule fires",
    90000,
  );
  await clickTab("settings");
  await visible("bot-pause").click();
  await eventually(
    async () =>
      (await client.botsRequest("bots.list.request", {})).bots.find((entry) => entry.id === bot.id)
        ?.paused,
    "paused",
  );
  const beforePause = (
    await client.botsRequest("bots.chat.history.request", { botId: bot.id })
  ).messages.filter(
    (message) =>
      message.role === "system" &&
      message.source !== "chat" &&
      message.text.includes("SCHEDULE_TICK"),
  ).length;
  await delay(65000);
  const afterPause = (
    await client.botsRequest("bots.chat.history.request", { botId: bot.id })
  ).messages.filter(
    (message) =>
      message.role === "system" &&
      message.source !== "chat" &&
      message.text.includes("SCHEDULE_TICK"),
  ).length;
  assert.equal(afterPause, beforePause);
  result.schedule = schedule;
  result.checks.push("Minute schedule fired; pause prevented a subsequent minute tick");
  await page.goto(botUrl);
  await visible("bots-new-room").click();
  await visible("bot-room-name").fill("Review room");
  await visible("bot-room-member-sum-helper").click();
  await visible("bot-room-save").click();
  await visible("bots-room").waitFor();
  await send("@sum-helper Check this room when you resume.");
  const room = (await client.botsRequest("bots.rooms.list.request", {})).rooms[0];
  assert(room.messages.some((message) => message.text.includes("@sum-helper")));
  await shot("room-desktop");
  result.checks.push("Created a room, selected a member and posted an @mention through the app");
  await page.goto(botUrl + "?botId=" + attendedBot.id);
  await visible("bot-tab-chat").waitFor();
  await send(
    "Create one bot item titled Permission proof. Start a worker in a new worktree of the default repo with assignment: use Bash to run node --test and report the result; make no changes. End your turn after dispatch.",
  );
  const permissionProof = await eventually(
    async () => {
      const currentBot = (await client.botsRequest("bots.list.request", {})).bots.find(
        (entry) => entry.id === attendedBot.id,
      );
      const entries = (
        await client.botsRequest("bots.items.list.request", {
          botId: attendedBot.id,
          includeClosed: true,
        })
      ).items;
      const proofItem = entries.find((entry) => entry.title === "Permission proof");
      if (proofItem)
        for (const workerId of proofItem.workerAgentIds) {
          const worker = await client.fetchAgent(workerId);
          if (worker?.agent.pendingPermissions.length)
            return { item: proofItem, worker: worker.agent };
        }
      if (currentBot?.agentId) {
        const supervisor = await client.fetchAgent(currentBot.agentId);
        for (const permission of supervisor?.agent.pendingPermissions ?? [])
          await client.respondToPermissionAndWait(
            currentBot.agentId,
            permission.id,
            { behavior: "allow" },
            15000,
          );
      }
      return false;
    },
    "attended worker permission",
    240000,
  );
  await visible("bots-worker-permissions").waitFor();
  await shot("worker-permission-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await visible("bots-worker-permissions").waitFor();
  await shot("worker-permission-mobile");
  result.workerPermission = permissionProof.worker.pendingPermissions[0];
  await client.botsRequest("bots.pause.request", { botId: attendedBot.id, paused: true });
  await client.botsRequest("bots.items.cancel.request", {
    botId: attendedBot.id,
    itemId: permissionProof.item.id,
    reason: "Owner completed permission UI verification",
  });
  result.checks.push(
    "An attended worker tool permission uses the same card in desktop and compact mobile bot chat",
  );
  await page.goto(botUrl + "?botId=" + bot.id + "&tab=items&itemId=" + done.id);
  await visible("bot-item-detail").waitFor();
  await page.getByText("Reviewed diff", { exact: true }).scrollIntoViewIfNeeded();
  await shot("reviewed-diff-mobile");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await visible("bot-item-detail").waitFor();
  await page.getByText("Reviewed diff", { exact: true }).scrollIntoViewIfNeeded();
  await shot("reviewed-diff-desktop");
  result.checks.push(
    "The Items tab and selected item survive viewport changes and open directly from an item URL",
  );

  await page.goto(botUrl + "?botId=" + bot.id + "&tab=chat");
  await visible("bots-message").fill("Keep this draft while the host reconnects.");
  disconnectBrowser = true;
  for (const socket of browserSockets)
    await socket.close({ code: 1001, reason: "Offline UI acceptance" }).catch(() => {});
  await page
    .getByText("Host disconnected. Reconnect to continue.", { exact: true })
    .filter({ visible: true })
    .waitFor({ timeout: 30000 });
  assert.equal(
    await visible("bots-message").inputValue(),
    "Keep this draft while the host reconnects.",
  );
  assert(await visible("bots-send").isDisabled());
  await shot("offline-draft-desktop");
  disconnectBrowser = false;
  await eventually(
    async () => !(await visible("bots-send").isDisabled()),
    "browser reconnects",
    60000,
  );
  assert.equal(
    await visible("bots-message").inputValue(),
    "Keep this draft while the host reconnects.",
  );
  result.checks.push(
    "Disconnect keeps the chat draft visible and disables Send; reconnect preserves the draft and restores Send",
  );
  await client.setBuiltinPlugin("bots", false);
  await visible("rail-bots").waitFor({ state: "detached", timeout: 5000 });
  await visible("builtin-plugin-turned-off").waitFor();
  await shot("plugin-off-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("plugin-off-mobile");
  result.checks.push(
    "Turning Bots off hid the rail and gated the deep link with Plugin turned off",
  );
  await client.setBuiltinPlugin("bots", true);
  await page.goto(origin + "/open-project");
  await visible("clickup-tab-workspaces").click();
  await visible("rail-bots").waitFor();
  await shot("mobile-grid-enabled");
  await client.setBuiltinPlugin("bots", false);
  await visible("rail-bots").waitFor({ state: "detached", timeout: 5000 });
  await shot("mobile-grid-disabled");
  result.checks.push("Compact mobile grid tile disappears live when Bots is turned off");

  assert.deepEqual(result.errors, []);
  result.ok = true;
} catch (error) {
  result.ok = false;
  result.failure = error.stack;
  if (page) {
    result.pageUrl = page.url();
    result.pageBody = (await page.locator("body").innerText()).slice(-12000);
    await shot("failure");
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  await browser?.close();
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  await Promise.race([once(child, "exit"), delay(10000)]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
  log.end();
  result.exitCode = child.exitCode;
  await fs.writeFile(
    path.join(output, "reports/botsapp-live.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
}
