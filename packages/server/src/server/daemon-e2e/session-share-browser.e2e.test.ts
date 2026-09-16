import { existsSync } from "node:fs";
import path from "node:path";
import { describe, test, expect, afterEach } from "vitest";
import pino from "pino";
import { chromium, type Browser } from "playwright";
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

async function makeAgent(ctx: DaemonTestContext): Promise<string> {
  const agent = await ctx.client.createAgent({
    provider: "codex",
    model: CODEX_MODEL,
    cwd: "/tmp",
    title: "Share Browser Agent",
  });
  return agent.id;
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
});
