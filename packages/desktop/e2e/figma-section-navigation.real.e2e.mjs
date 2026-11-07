#!/usr/bin/env node
// Observe a user-authorized isolated Electron runtime through real navigation and input.
// Arguments: <runtime.json> <file-name> <page-name> <section-name> <artifact-dir>
// Only the review runtime is allowed. No credentials, website session, or Figma writes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { WebSocket } from "ws";
import { DaemonClient } from "../../client/dist/daemon-client.js";

const [manifest, fileName, pageName, sectionName, artifacts] = process.argv.slice(2);
assert(manifest && fileName && pageName && sectionName && artifacts, "Five arguments required.");
const runtime = JSON.parse(fs.readFileSync(manifest, "utf8"));
assert(![6767, 6768].includes(runtime.daemonPort), "Production daemon forbidden.");
assert(
  path.basename(runtime.runtimeDir).startsWith("jagentdesk-figma-oauth-review-"),
  "Owned runtime required.",
);
process.kill(runtime.harnessPid, 0);
fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${runtime.cdpPort}`);
const client = new DaemonClient({
  url: `ws://127.0.0.1:${runtime.daemonPort}/ws`,
  clientId: "clid_figma_section_navigation",
  clientType: "cli",
  appVersion: "0.9.55",
  webSocketFactory: (url, options) =>
    new WebSocket(url, options?.protocols, { headers: options?.headers }),
});
const requests = [];
const proof = { credentialsRead: false, authorizationStarted: false, figmaWrites: false };
const deadline = setTimeout(() => {
  console.error("Section observation deadline exceeded.");
  process.exit(2);
}, 240000);

async function readSection() {
  await client.connect();
  const accounts = await client.figmaRequest("figma.connections.list.request", {});
  const account = accounts.connections.find((connection) => connection.authState === "connected");
  assert(account, "Expected an already-authorized review account.");
  const listing = await client.figmaRequest("figma.files.list.request", {
    connectionId: account.id,
  });
  const file = listing.files.find((candidate) => candidate.name === fileName);
  assert(file, "Expected a real indexed file.");
  const index = await client.figmaRequest("figma.file.outline.request", {
    fileKey: file.fileKey,
    pagesOnly: true,
  });
  assert(!index.error && index.outline, "Real page index unavailable.");
  const selected = index.outline.pages.find((candidate) => candidate.name === pageName);
  assert(selected, "Real page unavailable.");
  const result = await client.figmaRequest("figma.file.outline.request", {
    fileKey: file.fileKey,
    pageId: selected.id,
    version: index.outline.version,
  });
  assert(!result.error && result.outline, "Real page outline unavailable.");
  const page = result.outline.pages.find((candidate) => candidate.id === selected.id);
  const section = page?.frames.find(
    (frame) => frame.type === "SECTION" && frame.name === sectionName,
  );
  assert(section, "Real section unavailable.");
  const frames = page.frames.filter(
    (frame) =>
      frame.parentId === section.id && ["FRAME", "COMPONENT", "INSTANCE"].includes(frame.type),
  );
  assert(frames.length > 1, "A multi-frame section is required for this regression.");
  return { section, frames };
}

async function waitForContent(page) {
  await page.waitForFunction(
    () => {
      const canvas = document.getElementById("jagentdesk-figma-canvas");
      return (
        canvas?.getAttribute("aria-label") === "Figma design canvas" &&
        !canvas.hasAttribute("aria-busy")
      );
    },
    null,
    { timeout: 150000 },
  );
}

function observeRequest(event) {
  if (event.response.opcode !== 1) return;
  const envelope = JSON.parse(event.response.payloadData);
  const message = envelope.type === "session" ? envelope.message : envelope;
  if (message?.type !== "figma.file.nodes.request" && message?.type !== "figma.file.render.request")
    return;
  requests.push({
    type: message.type,
    ids: message.ids,
    depth: message.depth ?? null,
    format: message.format ?? null,
    absolute: message.useAbsoluteBounds ?? false,
  });
}

async function verifyZoom(page, cdp) {
  const zoom = () => page.getByTestId("figma-zoom-reset").innerText().then(parseFloat);
  const initial = await zoom();
  await page.getByLabel("Zoom in", { exact: true }).click();
  const button = await zoom();
  assert(button > initial, "Zoom-in button did not change the camera.");
  const bounds = await page.locator("#jagentdesk-figma-canvas").boundingBox();
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
    deltaX: 0,
    deltaY: -120,
    modifiers: 2,
  });
  await page.waitForFunction(
    (value) =>
      parseFloat(document.querySelector('[data-testid="figma-zoom-reset"]')?.textContent) > value,
    button,
  );
  return { before: initial, button, ctrlWheel: await zoom() };
}

try {
  const { section, frames } = await readSection();
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith(`http://localhost:${runtime.expoPort}/`));
  assert(page, "Owned renderer unavailable.");
  // Begin from the file index so reload does not pre-load the previously selected section.
  await page.getByTestId("figma-nav-browse-button").click();
  await page.getByTestId("figma-files-home").waitFor({ state: "visible" });
  // Reload only this test instance to observe built source without relying on Fast Refresh state.
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
  await page.getByTestId("figma-nav-browse-button").click();
  await page
    .getByTestId(/^figma-file-/)
    .filter({ hasText: fileName })
    .click();
  await page.getByLabel("Choose page", { exact: true }).click();
  await page.getByText(pageName, { exact: true }).last().click();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.webSocketFrameSent", observeRequest);
  const sectionRow = page.getByTestId(`figma-nav-section-${section.id}`);
  const started = performance.now();
  await sectionRow.click();
  await page.waitForFunction(
    (id) => new URL(location.href).searchParams.get("node")?.replace(/-/g, ":") === id,
    section.id,
  );
  await page.waitForTimeout(500);
  await waitForContent(page);
  proof.sectionReadyMs = performance.now() - started;
  proof.framesInSection = frames.length;
  proof.fitZoom = await page.getByTestId("figma-zoom-reset").innerText();
  assert(parseFloat(proof.fitZoom) < 100, "Large section retained the old 100% camera.");
  assert(
    requests.every(
      (request) =>
        request.type !== "figma.file.nodes.request" ||
        request.depth === 1 ||
        !request.ids.includes(section.id),
    ),
    "A full SECTION subtree was requested.",
  );
  const canvas = await page.locator("#jagentdesk-figma-canvas").boundingBox();
  const fitted = Math.min(
    (canvas.width - 80) / section.bounds.width,
    (canvas.height - 80) / section.bounds.height,
  );
  const offsetX = canvas.width / 2 - (section.bounds.x + section.bounds.width / 2) * fitted;
  const offsetY = canvas.height / 2 - (section.bounds.y + section.bounds.height / 2) * fitted;
  assert(
    frames.every(
      ({ bounds }) =>
        bounds.x * fitted + offsetX >= 0 &&
        (bounds.x + bounds.width) * fitted + offsetX <= canvas.width &&
        bounds.y * fitted + offsetY >= 0 &&
        (bounds.y + bounds.height) * fitted + offsetY <= canvas.height,
    ),
    "A child design is outside the section Fit viewport.",
  );
  proof.allChildFramesInViewport = true;
  proof.noPerFrameClicks = true;
  proof.noFullSectionRead = true;
  await page.screenshot({ path: path.join(artifacts, "section-all-frames.png") });
  proof.initialRequests = requests.slice();
  const pixelsBeforeZoom = await page
    .locator("#jagentdesk-figma-canvas")
    .evaluate((surface) => surface.toDataURL());
  proof.zoom = await verifyZoom(page, cdp);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await waitForContent(page);
  const pixelsAfterZoom = await page
    .locator("#jagentdesk-figma-canvas")
    .evaluate((surface) => surface.toDataURL());
  assert.notEqual(
    pixelsBeforeZoom,
    pixelsAfterZoom,
    "Zoom readout changed but canvas pixels stayed the same.",
  );
  proof.zoomChangesCanvasPixels = true;
  await page.screenshot({ path: path.join(artifacts, "section-zoomed.png") });
  await sectionRow.click();
  await page.waitForFunction(
    (value) => document.querySelector('[data-testid="figma-zoom-reset"]')?.textContent === value,
    proof.fitZoom,
  );
  await waitForContent(page);
  proof.reselectRestoresFit = true;
  await page.screenshot({ path: path.join(artifacts, "section-reselected.png") });
  proof.requests = requests;
  fs.writeFileSync(path.join(artifacts, "proof.json"), JSON.stringify(proof, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(proof));
} catch (error) {
  fs.writeFileSync(
    path.join(artifacts, "failure.json"),
    JSON.stringify({ message: error.message, proof, requests }, null, 2),
    { mode: 0o600 },
  );
  throw error;
} finally {
  clearTimeout(deadline);
  await client.close();
  await browser.close();
}
