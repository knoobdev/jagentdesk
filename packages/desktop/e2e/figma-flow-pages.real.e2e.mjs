#!/usr/bin/env node
// Real Electron/OAuth read-only observer. Arguments: runtime.json file pageA pageB artifacts.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { WebSocket } from "ws";
import { DaemonClient } from "../../client/dist/daemon-client.js";
const [manifest, fileName, pageA, pageB, out] = process.argv.slice(2);
assert(manifest && fileName && pageA && pageB && out, "Five arguments required");
const runtime = JSON.parse(fs.readFileSync(manifest, "utf8"));
assert(![6767, 6768].includes(runtime.daemonPort), "Production forbidden");
assert(path.basename(runtime.runtimeDir).startsWith("jagentdesk-figma-oauth-review-"));
process.kill(runtime.harnessPid, 0);
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${runtime.cdpPort}`);
const client = new DaemonClient({
  url: `ws://127.0.0.1:${runtime.daemonPort}/ws`,
  clientId: "clid_figma_flow_page_observer",
  clientType: "cli",
  appVersion: "0.9.55",
  webSocketFactory: (url, options) =>
    new WebSocket(url, options?.protocols, { headers: options?.headers }),
});
const proof = {
  stages: [],
  requests: [],
  credentialsRead: false,
  authorizationStarted: false,
  figmaWrites: false,
};
const save = () =>
  fs.writeFileSync(path.join(out, "proof.json"), JSON.stringify(proof, null, 2), { mode: 0o600 });
const deadline = setTimeout(() => {
  save();
  process.exit(2);
}, 240000);
try {
  await client.connect();
  const accounts = await client.figmaRequest("figma.connections.list.request", {});
  const account = accounts.connections.find((entry) => entry.authState === "connected");
  assert(account, "Existing review grant required");
  const listing = await client.figmaRequest("figma.files.list.request", {
    connectionId: account.id,
  });
  const file = listing.files.find((entry) => entry.name === fileName);
  assert(file, "Real indexed file required");
  const index = await client.figmaRequest("figma.file.outline.request", {
    fileKey: file.fileKey,
    pagesOnly: true,
  });
  assert(index.outline && !index.error);
  const pinned = index.outline.version;
  const pages = [];
  // These explicit provider-backed reads establish expected flow identities, warming the daemon
  // cache. This is functional evidence, never a cold performance benchmark.
  for (const name of [pageA, pageB]) {
    const entry = index.outline.pages.find((candidate) => candidate.name === name);
    assert(entry, `Page missing: ${name}`);
    const response = await client.figmaRequest("figma.file.outline.request", {
      fileKey: file.fileKey,
      pageId: entry.id,
      version: pinned,
    });
    assert(response.outline && !response.error && response.outline.version === pinned);
    const loaded = response.outline.pages[0];
    assert(loaded.childrenLoaded && loaded.flowStartingPoints.length);
    pages.push(loaded);
  }
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((entry) => entry.url().startsWith(`http://localhost:${runtime.expoPort}/`));
  assert(page, "Owned renderer missing");
  await page.keyboard.press("Escape");
  await page.getByTestId("figma-nav-browse-button").click();
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.webSocketFrameSent", (event) => {
    if (event.response.opcode !== 1) return;
    try {
      const envelope = JSON.parse(event.response.payloadData);
      const msg = envelope.type === "session" ? envelope.message : envelope;
      if (!msg?.type?.startsWith("figma.")) return;
      if (msg.type.endsWith(".request"))
        proof.requests.push({
          type: msg.type,
          pagesOnly: msg.pagesOnly ?? null,
          pageId: msg.pageId ?? null,
          version: msg.version ?? null,
          frameIds: msg.frameIds ?? null,
        });
    } catch {}
  });
  await page
    .getByTestId(/^figma-file-/)
    .filter({ hasText: fileName })
    .click();
  await page.getByTestId(`figma-nav-page-${pages[0].id}`).click();
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
  const backgroundUrl = page.url();
  await page.getByTestId("figma-top-bar-more").click();
  await page.getByTestId("figma-prototype").click();
  const toolbar = page.getByTestId("figma-prototype-toolbar");
  await toolbar.waitFor();
  await page.getByTestId("figma-flow-page-trigger").filter({ hasText: pageA }).waitFor();
  // Wait for the initial playback request, then provider/frame readiness before probing page-only navigation.
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("canvas")].some(
        (canvas) =>
          canvas.getAttribute("aria-label") === "Figma prototype frame" &&
          !canvas.hasAttribute("aria-busy"),
      ),
    null,
    { timeout: 90000 },
  );
  const playbackBefore = proof.requests.filter(
    (entry) => entry.type === "figma.file.playback.request",
  ).length;
  const triggerBefore = await page.getByTestId("figma-flow-trigger").innerText();
  await page.getByTestId("figma-flow-page-trigger").click();
  await page.getByTestId(`figma-flow-page-item-${pages[1].id}`).click();
  await page.getByTestId("figma-flow-page-trigger").filter({ hasText: pageB }).waitFor();
  const flowTrigger = page.getByTestId("figma-flow-trigger");
  await flowTrigger.click();
  const menuItems = page.getByTestId(/^figma-flow-item-/);
  await menuItems
    .filter({ hasText: pages[1].flowStartingPoints[0].name })
    .first()
    .waitFor({ timeout: 90000 });
  const flowNames = await menuItems.allTextContents();
  assert.equal(
    flowNames.length,
    pages[1].flowStartingPoints.length,
    "All page flows must be listed",
  );
  assert.equal(page.url(), backgroundUrl, "Browsing flow pages changed background route");
  assert.equal(
    proof.requests.filter((entry) => entry.type === "figma.file.playback.request").length,
    playbackBefore,
    "Browsing pages switched playback",
  );
  assert.equal(await flowTrigger.innerText(), triggerBefore, "Browsing renamed the active flow");
  proof.stages.push({
    stage: "browse-other-page",
    flows: flowNames.length,
    backgroundPreserved: true,
    playbackPreserved: true,
  });
  const menu = page.getByTestId("figma-flow-menu");
  const menuBounds = await menu.boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert(
    menuBounds &&
      menuBounds.x >= 0 &&
      menuBounds.y >= 0 &&
      menuBounds.x + menuBounds.width <= viewport.width + 1 &&
      menuBounds.y + menuBounds.height <= viewport.height + 1,
    "Flow menu escaped viewport",
  );
  const lastFlow = page.getByTestId(`figma-flow-item-${pages[1].flowStartingPoints.at(-1).nodeId}`);
  await lastFlow.scrollIntoViewIfNeeded();
  await page.waitForFunction(
    (lastId) => {
      const menuSurface = document.querySelector('[data-testid="figma-flow-menu"]');
      const last = document.querySelector(`[data-testid="${lastId}"]`);
      if (!menuSurface || !last) return false;
      const bounds = menuSurface.getBoundingClientRect();
      const item = last.getBoundingClientRect();
      return item.y >= bounds.y && item.bottom <= bounds.bottom + 1;
    },
    `figma-flow-item-${pages[1].flowStartingPoints.at(-1).nodeId}`,
    { timeout: 5000 },
  );
  proof.stages.push({ stage: "scroll-menu", viewportContained: true, lastFlowVisible: true });
  await page.screenshot({ path: path.join(out, "other-page-flows.png") });
  await page.keyboard.press("Escape");
  await page.getByTestId("figma-flow-page-trigger").click();
  const loadedMarker = await page.getByTestId(`figma-flow-page-item-${pages[1].id}`).innerText();
  proof.stages.push({
    stage: "page-marker",
    loaded: !/not loaded|loading|failed/.test(loadedMarker),
  });
  save();
  assert(
    !/not loaded|loading|failed/.test(loadedMarker),
    "A loaded flow page still has an unread/error marker",
  );
  await page.getByTestId(`figma-flow-page-item-${pages[1].id}`).click();
  await flowTrigger.click();
  const selected = pages[1].flowStartingPoints[0];
  await page.getByTestId(`figma-flow-item-${selected.nodeId}`).click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("canvas")].some(
        (canvas) =>
          canvas.getAttribute("aria-label") === "Figma prototype frame" &&
          !canvas.hasAttribute("aria-busy"),
      ),
    null,
    { timeout: 90000 },
  );
  assert(
    proof.requests.some(
      (entry) =>
        entry.type === "figma.file.playback.request" &&
        entry.frameIds?.includes(selected.nodeId) &&
        entry.version === pinned,
    ),
    "Selected flow did not load its pinned frame",
  );
  proof.stages.push({ stage: "play-selected-flow", versionMatched: true });
  await page.getByTestId("figma-prototype-close").click();
  assert.equal(page.url(), backgroundUrl);
  await page.getByLabel("Choose page", { exact: true }).filter({ hasText: pageA }).waitFor();
  assert(
    !proof.requests.some(
      (entry) =>
        entry.type === "figma.file.prototype.request" ||
        (entry.type === "figma.file.outline.request" && !entry.pagesOnly && !entry.pageId),
    ),
    "Unexpected full-file read",
  );
  proof.stages.push({ stage: "close", backgroundPagePreserved: true });
  await page.screenshot({ path: path.join(out, "background-preserved.png") });
  save();
  console.log(
    JSON.stringify({ passed: true, stages: proof.stages, requests: proof.requests.length }),
  );
} finally {
  save();
  clearTimeout(deadline);
  await client.close();
  await browser.close();
}
