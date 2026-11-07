#!/usr/bin/env node
// Real OAuth/daemon/Electron observer; metadata-only RPC tracing, no Figma writes or auth reads.
// Arguments: runtime.json file-name first-page-name second-page-name artifacts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
const [manifest, fileName, pageA, pageB, out] = process.argv.slice(2);
assert(manifest && fileName && pageA && pageB && out, "Five arguments required");
const runtime = JSON.parse(fs.readFileSync(manifest, "utf8"));
assert(![6767, 6768].includes(runtime.daemonPort), "Production daemon forbidden");
assert(
  path.basename(runtime.runtimeDir).startsWith("jagentdesk-figma-oauth-review-"),
  "Owned runtime required",
);
process.kill(runtime.harnessPid, 0);
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${runtime.cdpPort}`);
const requests = [],
  pending = new Map(),
  stages = [];
let pausedGroup = null;
const save = () =>
  fs.writeFileSync(
    path.join(out, "proof.json"),
    JSON.stringify(
      {
        stages,
        requests,
        productionTouched: false,
        authorizationStarted: false,
        credentialsRead: false,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
function resumeDaemon() {
  if (pausedGroup !== null) {
    process.kill(-pausedGroup, "SIGCONT");
    pausedGroup = null;
  }
}
async function ready(page) {
  await page.waitForFunction(
    () => {
      const canvas = document.getElementById("jagentdesk-figma-canvas");
      return (
        canvas?.getAttribute("aria-label") === "Figma design canvas" &&
        !canvas.hasAttribute("aria-busy")
      );
    },
    null,
    { timeout: 90000 },
  );
}
try {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith(`http://localhost:${runtime.expoPort}/`));
  assert(page, "Review renderer missing");
  await page.getByTestId("figma-nav-browse-button").click();
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.webSocketFrameSent", (event) => {
    if (event.response.opcode !== 1) return;
    try {
      const envelope = JSON.parse(event.response.payloadData);
      const msg = envelope.type === "session" ? envelope.message : envelope;
      if (msg?.type !== "figma.file.outline.request") return;
      const row = {
        pagesOnly: msg.pagesOnly ?? false,
        pageId: msg.pageId ?? null,
        version: msg.version ?? null,
      };
      requests.push(row);
      pending.set(msg.requestId, { row, started: event.timestamp });
    } catch {}
  });
  cdp.on("Network.webSocketFrameReceived", (event) => {
    if (event.response.opcode !== 1) return;
    try {
      const envelope = JSON.parse(event.response.payloadData);
      const msg = envelope.type === "session" ? envelope.message : envelope;
      const entry = pending.get(msg?.payload?.requestId);
      if (!entry || msg.type !== "figma.file.outline.response") return;
      Object.assign(entry.row, {
        elapsedMs: (event.timestamp - entry.started) * 1000,
        bytes: Buffer.byteLength(event.response.payloadData),
        error: msg.payload.error?.code ?? null,
        responseVersion: msg.payload.outline?.version,
        pages: msg.payload.outline?.pages.map((p) => ({
          id: p.id,
          loaded: p.childrenLoaded,
          summaries: p.frames.length,
        })),
      });
      pending.delete(msg.payload.requestId);
    } catch {}
  });
  const start = performance.now();
  await page
    .getByTestId(/^figma-file-/)
    .filter({ hasText: fileName })
    .click();
  await ready(page);
  stages.push({ stage: "file-open", elapsedMs: performance.now() - start });
  save();
  const select = async (name, stage) => {
    const t = performance.now();
    const before = requests.length;
    const row = page.getByTestId(/^figma-nav-page-/).filter({ hasText: name });
    const id = (await row.getAttribute("data-testid")).slice("figma-nav-page-".length);
    await row.click();
    await page.waitForURL((url) => url.searchParams.get("page") === id);
    await page.getByLabel("Choose page", { exact: true }).filter({ hasText: name }).waitFor();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await ready(page);
    const selected = await page.getByLabel("Choose page", { exact: true }).innerText();
    assert(selected.includes(name), "Canvas page and selected page disagree");
    stages.push({
      stage,
      elapsedMs: performance.now() - t,
      outlineRequests: requests.length - before,
    });
    await page.screenshot({ path: path.join(out, stage + ".png") });
    save();
  };
  await select(pageA, "first-page");
  // Pause only this manifest-owned daemon process group. This exercises a real transport timeout
  // and the visible Retry, without inventing an API response or affecting the installed daemon.
  const daemon = runtime.children[0];
  const command = execFileSync("ps", ["-p", String(daemon.pid), "-o", "command="], {
    encoding: "utf8",
  });
  const pgid = Number(
    execFileSync("ps", ["-p", String(daemon.pid), "-o", "pgid="], { encoding: "utf8" }).trim(),
  );
  assert(
    command.includes(fs.realpathSync("packages/server/scripts/dev-runner.ts")),
    "Daemon ownership mismatch",
  );
  assert(pgid === daemon.pid && pgid === daemon.pgid, "Unexpected daemon process group");
  pausedGroup = pgid;
  process.kill(-pausedGroup, "SIGSTOP");
  try {
    await page
      .getByTestId(/^figma-nav-page-/)
      .filter({ hasText: pageB })
      .click();
    await page.getByTestId("figma-page-retry").waitFor({ state: "visible", timeout: 70000 });
    assert(
      (await page.locator("#jagentdesk-figma-canvas").count()) === 0,
      "Old page must not appear ready after a failed switch",
    );
    await page.screenshot({ path: path.join(out, "transport-error.png") });
    stages.push({ stage: "transport-error", visibleRetry: true, staleCanvas: false });
    save();
  } finally {
    resumeDaemon();
  }
  const retryStart = performance.now();
  await page.getByTestId("figma-page-retry").click();
  await ready(page);
  stages.push({ stage: "retry-recovered", elapsedMs: performance.now() - retryStart });
  save();
  await select(pageA, "cached-page-return");
  assert(
    stages.at(-1).outlineRequests === 0,
    "Returning to cached page should not request another outline",
  );
  const pinnedVersion = requests.find((entry) => entry.pagesOnly)?.responseVersion;
  const secondId = (
    await page
      .getByTestId(/^figma-nav-page-/)
      .filter({ hasText: pageB })
      .getAttribute("data-testid")
  ).slice("figma-nav-page-".length);
  assert(pinnedVersion && secondId, "Real snapshot identity missing");
  const historical = new URL(page.url());
  historical.searchParams.set("version", pinnedVersion);
  historical.searchParams.set("page", secondId);
  await page.goto(historical.toString(), { waitUntil: "domcontentloaded", timeout: 120000 });
  await ready(page);
  assert(
    (await page.getByLabel("Choose page", { exact: true }).innerText()).includes(pageB),
    "Historical deep link opened another page",
  );
  stages.push({ stage: "historical-deep-link", versionMatched: true });
  save();
  const missing = new URL(historical);
  missing.searchParams.set("page", "page_missing");
  await page.goto(missing.toString(), { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.getByText("Page page_missing is not in this file.", { exact: true }).waitFor();
  assert(
    (await page.locator("#jagentdesk-figma-canvas").count()) === 0,
    "Missing page displayed another page's canvas",
  );
  stages.push({ stage: "missing-page", visibleError: true, staleCanvas: false });
  save();
  await page.goto(historical.toString(), { waitUntil: "domcontentloaded", timeout: 120000 });
  await ready(page);
  assert(
    requests.every((entry) => entry.pagesOnly || entry.pageId),
    "UI requested a legacy full-file outline",
  );
  assert(
    requests
      .filter((entry) => entry.pagesOnly)
      .every((entry) => entry.pages?.every((p) => p.loaded === false && p.summaries === 0)),
    "Index was treated as page content",
  );
  assert(
    requests
      .filter((entry) => entry.pageId && !entry.error && entry.pages)
      .every(
        (entry) =>
          entry.version &&
          entry.pages.length === 1 &&
          entry.pages[0].id === entry.pageId &&
          entry.pages[0].loaded === true,
      ),
    "Page response crossed scope",
  );
  save();
  console.log(
    JSON.stringify({
      stages,
      outlineRequests: requests.length,
      errors: requests.filter((entry) => entry.error).map((entry) => entry.error),
    }),
  );
} finally {
  resumeDaemon();
  save();
  await browser.close();
}
