import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test, expect, afterEach } from "vitest";
import pino from "pino";
import { chromium, type Browser, type Page } from "playwright";
import type { SessionShare } from "@jagentdesk/protocol/messages";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

// Stage-3 browser E2E for the real-app guest surface (spec §21 / ADR-0019). Boots a real daemon
// pointed at the freshly built guest web bundle (packages/server/dist/server/share-app-dist), serves
// it through the per-share ShareServer, and drives an actual headless Chromium through the guest
// join flow: request → host approves → 6-digit code → the REAL AgentConversationPanel + composer
// render over the scoped /ws with the guest token. This proves the guest sees the real app chat
// (not a bespoke page) once fetch_agents/timeline responses reach the guest.
//
// Requires the built guest bundle + a Playwright Chromium. Skips gracefully if either is missing.

const CODEX_MODEL = "gpt-5.4-mini";
const APP_DIST = path.resolve("dist/server/share-app-dist");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const hasBundle = existsSync(path.join(APP_DIST, "index.html"));

async function makeAgent(ctx: DaemonTestContext, cwd = "/tmp"): Promise<string> {
  const agent = await ctx.client.createAgent({
    provider: "codex",
    model: CODEX_MODEL,
    cwd,
    title: "Share Browser Agent",
  });
  return agent.id;
}

// A pino logger that captures the loopback ShareServer port from the daemon's own logs.
function makePortCapturingLogger(setPort: (p: number) => void) {
  return pino(
    { level: "info" },
    {
      write: (line: string) => {
        try {
          const o = JSON.parse(line);
          if (o.msg === "Share server listening" && typeof o.port === "number") setPort(o.port);
        } catch {
          /* ignore */
        }
      },
    },
  );
}

// Drive the guest join screen in the browser through to the approved 6-digit code (host approves
// via the real host client), leaving the page on the connected guest surface.
async function pairInBrowser(
  page: Page,
  ctx: DaemonTestContext,
  shareId: string,
  streamed: SessionShare[],
  label: string,
): Promise<void> {
  await page.getByText("Join this session", { exact: false }).waitFor({ timeout: 30000 });
  await page.getByPlaceholder("Your name").fill(label);
  await page.getByText("Request to join", { exact: false }).click();

  let req: SessionShare["pendingRequests"][number] | undefined;
  for (let i = 0; i < 60 && !req; i++) {
    req = streamed
      .flatMap((s) => s.pendingRequests)
      .find((r) => r.status === "pending" && r.label === label);
    if (!req) await sleep(150);
  }
  if (!req) throw new Error("host never saw the join request");
  await ctx.client.sessionShareRespond(shareId, req.requestId, true);

  let code: string | undefined;
  for (let i = 0; i < 60 && !code; i++) {
    code = streamed[streamed.length - 1]?.pendingRequests.find(
      (r) => r.requestId === req!.requestId,
    )?.code;
    if (!code) await sleep(150);
  }
  if (!code) throw new Error("no 6-digit code minted");
  await page.getByPlaceholder("••••••").fill(code);
}

describe.skipIf(!hasBundle)("session sharing — real app guest surface (browser)", () => {
  let ctx: DaemonTestContext;
  let browser: Browser | undefined;

  afterEach(async () => {
    await browser?.close().catch(() => {});
    browser = undefined;
    await ctx?.cleanup();
  }, 30000);

  test("guest pairs in the real app and the real composer renders", async () => {
    process.env.JAGENTDESK_SHARE_APP_DIST = APP_DIST;

    let sharePort = 0;
    const logger = pino(
      { level: "info" },
      {
        write: (line: string) => {
          try {
            const o = JSON.parse(line);
            if (o.msg === "Share server listening" && typeof o.port === "number")
              sharePort = o.port;
          } catch {
            /* ignore */
          }
        },
      },
    );

    ctx = await createDaemonTestContext({ sessionSharingEnabled: true, logger });
    const agentId = await makeAgent(ctx);

    const streamed: SessionShare[] = [];
    const unsub = ctx.client.subscribeSessionShareStream((s) => {
      if (s.agentId === agentId) streamed.push(s);
    });
    const share = await ctx.client.sessionShareCreate(agentId);
    expect(sharePort).toBeGreaterThan(0);

    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      // Chromium not installed — nothing to prove here.
      unsub();
      await ctx.client.sessionShareStop(share.shareId);
      return;
    }
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto(`http://127.0.0.1:${sharePort}/`, { waitUntil: "domcontentloaded" });

    // Stage 1: the real app boots into the guest join screen.
    await page.getByText("Join this session", { exact: false }).waitFor({ timeout: 30000 });
    await page.getByPlaceholder("Your name").fill("Browser Guest");
    await page.getByText("Request to join", { exact: false }).click();

    // Host side: approve the pending request and read the minted code.
    let req: SessionShare["pendingRequests"][number] | undefined;
    for (let i = 0; i < 60 && !req; i++) {
      req = streamed
        .flatMap((s) => s.pendingRequests)
        .find((r) => r.status === "pending" && r.label === "Browser Guest");
      if (!req) await sleep(150);
    }
    expect(req, "host received the join request").toBeTruthy();
    await ctx.client.sessionShareRespond(share.shareId, req!.requestId, true);

    let code: string | undefined;
    for (let i = 0; i < 60 && !code; i++) {
      code = streamed[streamed.length - 1]?.pendingRequests.find(
        (r) => r.requestId === req!.requestId,
      )?.code;
      if (!code) await sleep(150);
    }
    expect(code, "approved request carries a 6-digit code").toMatch(/^\d{6}$/);

    // Stage 2: the code auto-verifies (no button) once 6 digits are entered.
    await page.getByPlaceholder("••••••").fill(code!);

    // Stage 3: the REAL composer renders — proof the scoped session reached "online" and the app
    // mounted AgentConversationPanel (not a bespoke page).
    await page.locator('[placeholder^="Message"]').first().waitFor({ timeout: 30000 });

    expect(errors, `no uncaught page errors: ${errors.join(" | ")}`).toEqual([]);

    // Stage 4: the guest sends a message through the real composer and the host sees it in the
    // shared agent's timeline — proving send_agent_message flows over the scoped session (and that
    // the real composer does not truncate the text the way the old bespoke page did).
    const guestText = `hello from guest ${Date.now()}`;
    const composer = page.locator('[placeholder^="Message"]').first();
    await composer.click();
    await composer.fill(guestText);
    await composer.press("Enter");

    let sawGuestMessage = false;
    for (let i = 0; i < 40 && !sawGuestMessage; i++) {
      const tl = await ctx.client.fetchAgentTimeline(agentId, { direction: "tail", limit: 20 });
      sawGuestMessage = JSON.stringify(tl ?? {}).includes(guestText);
      if (!sawGuestMessage) await sleep(200);
    }
    expect(sawGuestMessage, "host timeline received the guest's message").toBe(true);

    unsub();
    // Close the guest browser (drops the scoped /ws) BEFORE stopping the share, so teardown does not
    // race an active guest connection.
    await browser.close().catch(() => {});
    browser = undefined;
    await ctx.client.sessionShareStop(share.shareId);
  }, 120000);

  test("files + terminal: guest gets Files/Changes/Terminal tabs and browses the shared workspace", async () => {
    process.env.JAGENTDESK_SHARE_APP_DIST = APP_DIST;

    let sharePort = 0;
    const logger = makePortCapturingLogger((p) => {
      sharePort = p;
    });
    ctx = await createDaemonTestContext({ sessionSharingEnabled: true, logger });

    const workspace = await mkdtemp(path.join(tmpdir(), "jad-share-ui-"));
    await writeFile(path.join(workspace, "READY.md"), "# guest can read me\n");
    const agentId = await makeAgent(ctx, workspace);
    // A terminal the guest should be able to see under the Terminal tab.
    await ctx.client.createTerminal(workspace, "guestterm");

    const streamed: SessionShare[] = [];
    const unsub = ctx.client.subscribeSessionShareStream((s) => {
      if (s.agentId === agentId) streamed.push(s);
    });
    // Share WITH files + terminal so the guest surface shows Files/Changes/Terminal tabs.
    const share = await ctx.client.sessionShareCreate(agentId, {
      capabilities: { files: true, terminal: true },
    });
    expect(sharePort).toBeGreaterThan(0);

    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      unsub();
      await ctx.client.sessionShareStop(share.shareId);
      return;
    }
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${sharePort}/`, { waitUntil: "domcontentloaded" });

    try {
      await pairInBrowser(page, ctx, share.shareId, streamed, "Files UI Guest");
    } catch (e) {
      const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      throw new Error(
        `pairing failed: ${String(e)}\npageErrors=${errors.join(" | ")}\nbodyText=${body.slice(0, 500)}`,
        { cause: e },
      );
    }

    // Chat renders first (the default tab).
    await page.locator('[placeholder^="Message"]').first().waitFor({ timeout: 30000 });

    // The capability granted the Files + Changes tabs; open Files and browse the workspace.
    await page.getByText("Files", { exact: true }).click();
    try {
      await page.getByText("READY.md", { exact: false }).first().waitFor({ timeout: 30000 });
    } catch (e) {
      const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      throw new Error(
        `Files tab did not list READY.md: ${String(e)}\npageErrors=${errors.join(" | ")}\nbodyText=${body.slice(0, 800)}`,
        { cause: e },
      );
    }

    // Changes tab renders the working-diff panel without crashing.
    await page.getByText("Changes", { exact: true }).click();
    await sleep(1500);

    // Terminal tab lists the workspace's terminal; opening it mounts the real terminal panel.
    await page.getByText("Terminal", { exact: true }).click();
    try {
      const row = page.locator('[data-testid="guest-terminal-row"]').first();
      await row.waitFor({ timeout: 30000 });
      await row.click();
      await page.getByText("‹ Terminals", { exact: false }).waitFor({ timeout: 30000 });
    } catch (e) {
      const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      throw new Error(
        `Terminal tab did not show the terminal: ${String(e)}\npageErrors=${errors.join(" | ")}\nbodyText=${body.slice(0, 800)}`,
        { cause: e },
      );
    }

    expect(errors, `no uncaught page errors: ${errors.join(" | ")}`).toEqual([]);

    unsub();
    await browser.close().catch(() => {});
    browser = undefined;
    await ctx.client.sessionShareStop(share.shareId);
  }, 120000);
});
