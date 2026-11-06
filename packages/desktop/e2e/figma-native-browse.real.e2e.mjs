#!/usr/bin/env node
// External observer of an already-authorized, isolated Electron/daemon instance. No credentials
// or website sessions are read. The expected file must have real metadata in that daemon's index;
// this proves browsing/opening a known file, never account-wide discovery.
// node packages/desktop/e2e/figma-native-browse.real.e2e.mjs <runtime.json> <file-name> <artifact-dir>
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const [manifest, expectedName, artifacts] = process.argv.slice(2);
assert(
  manifest && expectedName && artifacts,
  "Runtime manifest, real file name, and artifact directory are required.",
);
const runtime = JSON.parse(fs.readFileSync(manifest, "utf8"));
assert(![6767, 6768].includes(runtime.daemonPort), "Production daemon is forbidden.");
assert(
  path.basename(runtime.runtimeDir).startsWith("jagentdesk-figma-oauth-review-"),
  "Expected the owned review runtime.",
);
process.kill(runtime.harnessPid, 0);
fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${runtime.cdpPort}`);
const proof = { accountWideDiscovery: false, credentialsRead: false, authorizationStarted: false };
try {
  const pages = () => browser.contexts().flatMap((context) => context.pages());
  const page = pages().find((candidate) =>
    candidate.url().startsWith(`http://localhost:${runtime.expoPort}/`),
  );
  assert(page, "Owned JAgentDesk renderer missing.");
  // Close only obsolete Figma guest windows in this isolated Electron instance, never the user's
  // browser or installed application. Closing a picker is its normal cancellation operation.
  for (const guest of pages()) {
    const url = new URL(guest.url());
    if (url.protocol === "https:" && ["figma.com", "www.figma.com"].includes(url.hostname))
      await guest.close();
  }
  const originalWindows = pages().length;
  const browse = page.getByTestId("figma-nav-browse-button");
  await browse.waitFor({ state: "visible", timeout: 30000 });
  await browse.click();
  await page.getByTestId("figma-files-home").waitFor({ state: "visible", timeout: 30000 });
  await page.getByText("Files added to JAgentDesk", { exact: true }).waitFor();
  const search = page.getByTestId("figma-files-search");
  await search.fill(expectedName);
  const card = page.getByTestId(/^figma-file-/).filter({ hasText: expectedName });
  await card.waitFor({ state: "visible", timeout: 30000 });
  assert.equal(await card.count(), 1, "Expected exactly the real indexed file.");
  assert.equal(pages().length, originalWindows, "Browse opened another window.");
  proof.nativeList = true;
  proof.nameSearch = true;
  await page.screenshot({ path: path.join(artifacts, "native-file-browser.png") });
  await card.click();
  const canvas = page.locator("#jagentdesk-figma-canvas");
  await canvas.waitFor({ state: "visible", timeout: 180000 });
  const canvasBounds = await canvas.boundingBox();
  assert(
    canvasBounds && canvasBounds.width > 0 && canvasBounds.height > 0,
    "Canvas has no visible viewport.",
  );
  assert(
    new URL(page.url()).searchParams.get("fileKey"),
    "Opening the file did not select a file.",
  );
  proof.realFileCanvasMounted = true;
  await page.waitForFunction(
    () => {
      const element = document.getElementById("jagentdesk-figma-canvas");
      return (
        element?.getAttribute("role") === "img" &&
        element.getAttribute("aria-label") === "Figma design canvas" &&
        !element.hasAttribute("aria-busy")
      );
    },
    null,
    { timeout: 150000 },
  );
  proof.visibleCanvasReady = true;
  proof.completeCanvasContentVerified = false;
  await page.screenshot({ path: path.join(artifacts, "native-file-opened.png") });
  await browse.click();
  await page.getByTestId("figma-files-home").waitFor({ state: "visible", timeout: 30000 });
  const url = new URL(page.url());
  for (const key of ["fileKey", "page", "node", "version"])
    assert.equal(url.searchParams.get(key), null);
  assert.equal(pages().length, originalWindows, "Returning to files opened another window.");
  await search.fill("<no-matching-saved-file>");
  await page.getByText("No matching files", { exact: true }).waitFor();
  await search.fill("");
  await card.waitFor({ state: "visible" });
  proof.canvasToFiles = true;
  proof.noMatchRecovery = true;
  proof.newWindows = pages().length - originalWindows;
  fs.writeFileSync(
    path.join(artifacts, "native-browse-proof.json"),
    JSON.stringify(proof, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(proof));
} finally {
  await browser.close();
}
