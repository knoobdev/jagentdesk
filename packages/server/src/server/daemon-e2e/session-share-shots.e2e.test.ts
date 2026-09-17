import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test, expect, afterEach } from "vitest";
import pino from "pino";
import { chromium, type Browser, type Page } from "playwright";
import type { SessionShare } from "@jagentdesk/protocol/messages";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

// Screenshot harness for the real-app guest surface (ADR-0019). Boots a real daemon on the freshly
// built guest bundle, shares an agent with EVERY capability granted (files, terminal, modelMode,
// artifacts), pairs a headless-Chromium guest, and captures a PNG of each granted tab so a human can
// eyeball exactly what a guest sees. Screenshots land in SHOT_DIR. Not a pass/fail contract — it
// asserts only that each tab mounts, then snapshots it.

const CODEX_MODEL = "gpt-5.4-mini";
const APP_DIST = path.resolve("dist/server/share-app-dist");
const SHOT_DIR = path.resolve(process.env.JAD_SHOT_DIR ?? "/tmp/share-shots");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const hasBundle = existsSync(path.join(APP_DIST, "index.html"));

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

describe.skipIf(!hasBundle)("session sharing — capability screenshots", () => {
  let ctx: DaemonTestContext;
  let browser: Browser | undefined;

  afterEach(async () => {
    await browser?.close().catch(() => {});
    browser = undefined;
    await ctx?.cleanup();
  }, 30000);

  test("captures every granted guest tab", async () => {
    process.env.JAGENTDESK_SHARE_APP_DIST = APP_DIST;
    mkdirSync(SHOT_DIR, { recursive: true });

    let sharePort = 0;
    const logger = makePortCapturingLogger((p) => {
      sharePort = p;
    });
    ctx = await createDaemonTestContext({ sessionSharingEnabled: true, logger });

    const workspace = await mkdtemp(path.join(tmpdir(), "jad-share-shots-"));
    await writeFile(
      path.join(workspace, "READY.md"),
      "# guest can read me\n\nHello from the shared workspace.\n",
    );
    const agent = await ctx.client.createAgent({
      provider: "codex",
      model: CODEX_MODEL,
      cwd: workspace,
      title: "Share Shots Agent",
    });
    const agentId = agent.id;
    await ctx.client.createTerminal(workspace, "guestterm");

    const streamed: SessionShare[] = [];
    const unsub = ctx.client.subscribeSessionShareStream((s) => {
      if (s.agentId === agentId) streamed.push(s);
    });
    const share = await ctx.client.sessionShareCreate(agentId, {
      capabilities: { files: true, terminal: true, modelMode: true, artifacts: true },
    });
    expect(sharePort).toBeGreaterThan(0);

    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      unsub();
      await ctx.client.sessionShareStop(share.shareId);
      return;
    }
    const page = await browser.newPage({ viewport: { width: 1200, height: 860 } });
    await page.goto(`http://127.0.0.1:${sharePort}/`, { waitUntil: "domcontentloaded" });

    // Snapshot the join screen before pairing.
    await page.getByText("Join this session", { exact: false }).waitFor({ timeout: 30000 });
    await page.screenshot({ path: path.join(SHOT_DIR, "01-join.png") });

    await pairInBrowser(page, ctx, share.shareId, streamed, "Capability Guest");

    // Chat: send a message; the fake agent replies "state saved". Screenshot the live reply.
    const composer = page.locator('[placeholder^="Message"]').first();
    await composer.waitFor({ timeout: 30000 });
    await composer.click();
    await composer.fill("say 'state saved'");
    await composer.press("Enter");
    await page.getByText("state saved", { exact: false }).first().waitFor({ timeout: 30000 });
    await sleep(800);
    await page.screenshot({ path: path.join(SHOT_DIR, "02-chat.png") });

    // Ask the agent to emit a fenced HTML block so the Artifacts canvas has a real artifact.
    await composer.click();
    await composer.fill("emit artifact");
    await composer.press("Enter");
    await page.getByText("Shared Artifact", { exact: false }).first().waitFor({ timeout: 30000 });
    await sleep(800);

    // Files tab: browse the workspace and open READY.md.
    await page.getByText("Files", { exact: true }).click();
    await page.getByText("READY.md", { exact: false }).first().waitFor({ timeout: 30000 });
    await page.screenshot({ path: path.join(SHOT_DIR, "03-files.png") });
    await page.getByText("READY.md", { exact: false }).first().click();
    await sleep(1200);
    await page.screenshot({ path: path.join(SHOT_DIR, "04-file-open.png") });

    // Changes tab.
    await page.getByText("Changes", { exact: true }).click();
    await sleep(1500);
    await page.screenshot({ path: path.join(SHOT_DIR, "05-changes.png") });

    // Artifacts tab — the fenced HTML block renders in the sandboxed canvas iframe.
    await page.getByText("Artifacts", { exact: true }).click();
    await sleep(2000);
    await page.screenshot({ path: path.join(SHOT_DIR, "06-artifacts.png") });

    // Terminal tab.
    await page.getByText("Terminal", { exact: true }).click();
    await sleep(800);
    await page.screenshot({ path: path.join(SHOT_DIR, "07-terminal-list.png") });
    const row = page.locator('[data-testid="guest-terminal-row"]').first();
    try {
      await row.waitFor({ timeout: 15000 });
      await row.click();
      await sleep(1500);
      await page.screenshot({ path: path.join(SHOT_DIR, "08-terminal-open.png") });
    } catch {
      /* no terminal row — snapshot already captured */
    }

    // Back to Chat and open the composer's model/mode control (modelMode capability).
    await page.getByText("Chat", { exact: true }).click();
    await sleep(600);
    await page.screenshot({ path: path.join(SHOT_DIR, "09-chat-composer.png") });

    // eslint-disable-next-line no-console
    console.log(`[shots] wrote screenshots to ${SHOT_DIR}`);

    unsub();
    await browser.close().catch(() => {});
    browser = undefined;
    await ctx.client.sessionShareStop(share.shareId);
  }, 180000);
});
