import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { getServerId } from "../support/helpers/server-id";
import {
  FAKE_IOS_UDID,
  writeFakeGoIos,
} from "../../../server/src/server/devices/test-utils/fake-go-ios";

// Spec 27.4 / 27.5 / ADR-0033 decision 8 in the app against the e2e daemon, whose go-ios is the
// test stand-in (one cabled iPhone, screenshot service, no WebDriverAgent, no Apple account):
// Enable control shows the screen at once, and the first tap opens Enable touch in place with
// Add Apple ID inline. Screenshots go to JAD_IPHONE_SHOTS when set.

// Before the worker daemon starts (it inherits this process's environment). Run this spec on its
// own or first in its worker: a daemon another spec already started has the host's go-ios.
// Playwright loads spec files in its runner process too; each process removes its own copy.
const fakeDir = mkdtempSync(path.join(tmpdir(), "jad-e2e-go-ios-"));
process.on("exit", () => rmSync(fakeDir, { recursive: true, force: true }));
const fake = writeFakeGoIos(fakeDir);
process.env.JAGENTDESK_GO_IOS_BIN = fake.binary;

const SHOTS = process.env.JAD_IPHONE_SHOTS ?? null;
const UDID = `ios:${FAKE_IOS_UDID}`;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

test.describe("Sims: iPhone view first", () => {
  // The worker daemon starts from source (tsx) on the first test; give it room on slow hosts.
  test.describe.configure({ timeout: 300_000 });

  test("screen without WDA, first tap opens Enable touch with Add Apple ID inline", async ({
    page,
  }) => {
    page.on("dialog", (dialog) => void dialog.accept());
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.goto(`/h/${encodeURIComponent(getServerId())}/simulator`);

    const tile = page.getByTestId(`sim-tile-${UDID}`);
    await expect(tile).toBeVisible({ timeout: 60_000 });
    await tile.click();
    await page.getByTestId("device-enable-control").click();

    // View first: the screen streams with no WebDriverAgent and no Apple account.
    await expect(page.getByTestId("device-readiness-needs_wda")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("device-screen-status")).toContainText("Live", {
      timeout: 30_000,
    });
    await expect(page.getByTestId("device-screen-status")).toContainText(
      "Tap the screen to turn on touch",
    );
    await expect(page.getByTestId(`device-badge-${UDID}`)).toHaveText("View only");
    await expect(page.getByText("Prepare device")).toHaveCount(0);
    await shot(page, "01-view-first");

    // First tap: Enable touch in place; no account saved → Add Apple ID in the same dialog.
    await page.getByTestId("device-live-screen").click();
    const dialog = page.getByTestId("device-touch-setup");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("device-touch-setup-add-apple-id")).toBeVisible({
      timeout: 30_000,
    });
    await expect(dialog).toContainText("secondary Apple ID");
    await expect(dialog).not.toContainText("in Sideload first");
    await shot(page, "02-touch-dialog-terms");
    await page.getByTestId("sideload-terms-accept").click();
    await expect(page.getByTestId("sideload-apple-id-email")).toBeVisible();
    await shot(page, "03-touch-dialog-add-apple-id");
  });
});
