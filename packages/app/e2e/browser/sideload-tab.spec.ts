import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { getServerId } from "../support/helpers/server-id";
import type { Page } from "@playwright/test";

// Sideload tab of Sims (spec 26.9) against the e2e daemon: the IPA inspection a real upload
// returns, the terms dialog before the first Apple ID, and a sign-in failure that stays
// visible. The failing sign-in points at an anisette server nobody runs, so no request
// reaches Apple. Screenshots go to JAD_SIDELOAD_SHOTS when set.

// Playwright runs from packages/app; the daemon reads the fixture straight from disk.
const PROBE_IPA = path.resolve("../server/src/server/sideload/test-fixtures/probe.ipa");
const SHOTS = process.env.JAD_SIDELOAD_SHOTS ?? null;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

async function openSideload(page: Page): Promise<void> {
  await page.goto(`/h/${encodeURIComponent(getServerId())}/simulator`);
  await page.getByTestId("sims-tab-sideload").click();
  await expect(page.getByTestId("sideload-pane")).toBeVisible();
}

// Browse host… (26.9): start at the daemon's home folder, jump to the filesystem root with the
// breadcrumb, then open each folder down to the fixture and pick it.
async function pickOnHost(page: Page, file: string): Promise<void> {
  await page.getByTestId("sideload-browse-host").click();
  const sheet = page.getByTestId("sideload-host-browse");
  await sheet.getByTestId("sideload-host-browse-crumbs").getByText("/", { exact: true }).click();
  for (const folder of path.dirname(file).split(path.sep).filter(Boolean)) {
    await sheet.getByTestId(`sideload-host-entry-${folder}`).click();
  }
  await sheet.getByTestId(`sideload-host-entry-${path.basename(file)}`).click();
}

async function inspectProbe(page: Page): Promise<void> {
  await pickOnHost(page, PROBE_IPA);
  const card = page.getByTestId("sideload-ipa-card");
  await expect(card).toContainText("JAD Probe");
  await expect(card).toContainText("dev.jagentdesk.probe.app");
  await expect(card).toContainText("arm64");
  await expect(card).toContainText("JAD Probe Share");
}

async function failSignIn(page: Page): Promise<void> {
  await page.getByTestId("sideload-tab-accounts").click();
  await page.getByTestId("sideload-add-apple-id").click();
  await expect(page.getByTestId("sideload-terms")).toContainText("secondary Apple ID");
  await shot(page, "terms");
  await page.getByTestId("sideload-terms-accept").click();
  await page.getByTestId("sideload-apple-id-email").fill("tester@example.invalid");
  await page.getByTestId("sideload-apple-id-password").fill("not-a-real-password");
  await page.getByRole("button", { name: "Remote server" }).last().click();
  await page.getByPlaceholder("http://<host>:6969").last().fill("http://127.0.0.1:9");
  await page.getByTestId("sideload-apple-id-submit").click();
  await expect(page.getByText("Sign-in failed")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("sideload-apple-id-sheet")).toContainText(
    "Could not reach the anisette server at http://127.0.0.1:9",
  );
  await shot(page, "sign-in-failed");
}

test.describe("Sideload tab", () => {
  // The worker daemon starts from source (tsx) on the first test; give it room on slow hosts.
  test.describe.configure({ timeout: 300_000 });
  test("desktop: inspect an IPA, terms before the first Apple ID, failure stays visible", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1360, height: 900 });
    await openSideload(page);
    await expect(page.getByTestId("sideload-install")).toContainText("Device");
    await inspectProbe(page);
    await page.getByTestId("sideload-advanced-toggle").click();
    await expect(page.getByTestId("sideload-advanced")).toContainText("Remove device restrictions");
    await expect(page.getByTestId("sideload-install-run")).toBeDisabled();
    await shot(page, "desktop-install");
    await page.getByTestId("sideload-tab-installed").click();
    await expect(page.getByTestId("sideload-installed")).toContainText("Nothing sideloaded yet");
    await shot(page, "desktop-installed");
    await page.getByTestId("sideload-tab-accounts").click();
    await expect(page.getByTestId("sideload-accounts")).toContainText("No Apple account yet");
    await shot(page, "desktop-accounts");
    await failSignIn(page);
  });

  test("phone: the same tab fits a compact screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSideload(page);
    await inspectProbe(page);
    await shot(page, "phone-install");
    await page.getByTestId("sideload-tab-accounts").click();
    await expect(page.getByTestId("sideload-accounts")).toContainText("No Apple account yet");
    await shot(page, "phone-accounts");
  });
});
