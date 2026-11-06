#!/usr/bin/env node
// Real Electron/daemon observer. No credential reads, Figma writes or test API responses.
// node <script> <runtime.json> <file-name> <page-name> <zoom> <pan-y-px> <artifact-dir>
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";
const [manifest, fileName, pageName, zoomText, panText, out] = process.argv.slice(2);
assert(
  manifest && fileName && pageName && zoomText && panText && out,
  "runtime.json, file name, page name, zoom, pan pixels, artifacts required",
);
const r = JSON.parse(fs.readFileSync(manifest, "utf8"));
assert(![6767, 6768].includes(r.daemonPort), "Production daemon forbidden");
assert(
  path.basename(r.runtimeDir).startsWith("jagentdesk-figma-oauth-review-"),
  "Owned review runtime required",
);
process.kill(r.harnessPid, 0);
const targetZoom = Number(zoomText),
  panPixels = Number(panText);
assert(
  Number.isFinite(targetZoom) &&
    targetZoom >= 0.02 &&
    targetZoom < 0.25 &&
    Number.isFinite(panPixels),
  "Overview zoom and finite pan required",
);
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${r.cdpPort}`);
const records = [],
  stages = [];
const pending = new Map();
function imageCounts(message) {
  const images = message.payload?.images;
  if (!images) return {};
  const values = Object.values(images);
  return {
    returnedImages: values.filter(Boolean).length,
    missingImages: values.filter((value) => !value).length,
  };
}
let interval;
try {
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().startsWith(`http://localhost:${r.expoPort}/`));
  await page.getByTestId("figma-nav-browse-button").click();
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  function message(event, received) {
    try {
      if (event.response.opcode !== 1) return;
      const env = JSON.parse(event.response.payloadData);
      const msg = env.type === "session" ? env.message : env;
      if (!msg?.type?.startsWith("figma.") || /oauth|connections/.test(msg.type)) return;
      if (!received) {
        const row = {
          type: msg.type,
          requestId: msg.requestId,
          startedMs: event.timestamp * 1000,
          ids: msg.ids?.length,
          scale: msg.scale,
          depth: msg.depth,
          format: msg.format,
          cachedOnly: msg.cachedOnly ?? false,
        };
        records.push(row);
        pending.set(msg.requestId, row);
      } else {
        const row = pending.get(msg.payload?.requestId ?? msg.requestId);
        if (row) {
          row.elapsedMs = event.timestamp * 1000 - row.startedMs;
          row.bytes = Buffer.byteLength(event.response.payloadData);
          row.error = msg.payload?.error?.code ?? null;
          Object.assign(row, imageCounts(msg));
          pending.delete(msg.payload?.requestId ?? msg.requestId);
        }
      }
    } catch {}
  }
  cdp.on("Network.webSocketFrameSent", (e) => message(e, false));
  cdp.on("Network.webSocketFrameReceived", (e) => message(e, true));
  const navigationStarted = performance.now();
  await page
    .getByTestId(/^figma-file-/)
    .filter({ hasText: fileName })
    .click();
  await page.getByLabel("Choose page", { exact: true }).click();
  await page.getByText(pageName, { exact: true }).last().click();
  await page.locator("#jagentdesk-figma-canvas").waitFor();
  const bounds = await page.locator("#jagentdesk-figma-canvas").boundingBox();
  const zoom = parseFloat(await page.getByTestId("figma-zoom-reset").innerText()) / 100;
  const started = performance.now();
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: bounds.x + 1,
    y: bounds.y + 1,
    deltaX: 0,
    deltaY: -Math.log(targetZoom / zoom) / 0.0025,
    modifiers: 2,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: bounds.x + 10,
    y: bounds.y + 10,
    deltaX: 0,
    deltaY: panPixels,
  });
  const state = async () => ({
    elapsedMs: performance.now() - started,
    label: await page.locator("#jagentdesk-figma-canvas").getAttribute("aria-label"),
    busy: await page.locator("#jagentdesk-figma-canvas").getAttribute("aria-busy"),
    zoom: await page.getByTestId("figma-zoom-reset").innerText(),
    pendingRpc: pending.size,
  });
  const snapshot = () =>
    fs.writeFileSync(
      out + "/progress.json",
      JSON.stringify(
        {
          stages,
          rpc: records.map(({ requestId: _requestId, startedMs: _startedMs, ...row }) => row),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  interval = setInterval(async () => {
    try {
      stages.push(await state());
      snapshot();
    } catch {}
  }, 1000);
  await page.waitForFunction(
    (value) => document.querySelector('[data-testid="figma-zoom-reset"]')?.textContent === value,
    Math.round(targetZoom * 100) + "%",
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  let readyAtMs = null;
  const readiness = page
    .waitForFunction(
      () => {
        const c = document.getElementById("jagentdesk-figma-canvas");
        return (
          c?.getAttribute("aria-label") === "Figma design canvas" && !c.hasAttribute("aria-busy")
        );
      },
      null,
      { timeout: 90000 },
    )
    .then(
      () => {
        readyAtMs = performance.now() - started;
        return true;
      },
      () => false,
    );
  await page.waitForTimeout(2000);
  await page.screenshot({ path: out + "/initial.png" });
  const ready = await readiness;
  stages.push(await state());
  snapshot();
  await page.screenshot({ path: out + "/final.png" });
  console.log(
    JSON.stringify({
      ready,
      viewportReadyMs: readyAtMs,
      fileNavigationReadyMs: readyAtMs === null ? null : started - navigationStarted + readyAtMs,
      final: stages.at(-1),
      rpc: records.length,
      errors: records.filter((x) => x.error).map(({ type, error }) => ({ type, error })),
    }),
  );
} finally {
  clearInterval(interval);
  await browser.close();
}
