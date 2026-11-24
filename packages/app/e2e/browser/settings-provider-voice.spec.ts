import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import {
  openAddHostFlow,
  openHostSection,
  openSettingsHost,
  selectHostConnectionType,
} from "../support/helpers/settings";
import path from "node:path";

test("voice, providers, built-in plugins and Connections remain reachable", async ({
  page,
}, testInfo) => {
  const capture = async (name: string) =>
    page.screenshot({
      path: process.env.JAGENTDESK_SETTINGS_CAPTURE_DIR
        ? path.join(process.env.JAGENTDESK_SETTINGS_CAPTURE_DIR, `b12-${name}.png`)
        : testInfo.outputPath(`${name}.png`),
      fullPage: true,
    });
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHost(page, getServerId());
  await expect(page.getByTestId("host-page-connections-card")).toBeVisible();
  await capture("connections");
  await openHostSection(page, getServerId(), "voice");
  await expect(page.getByTestId("voice-settings")).toBeVisible();
  await capture("voice");
  await page.getByTestId("voice-site-voiceMode.stt").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Base URL" })).toBeVisible();
  await capture("voice-provider");
  await page.keyboard.press("Escape");
  await openHostSection(page, getServerId(), "providers");
  await expect(page.getByTestId("host-page-custom-providers-card")).toBeVisible();
  const mockRow = page.getByTestId("provider-row-mock");
  await expect(mockRow).toBeVisible();
  const toggle = mockRow.getByRole("switch");
  await expect(toggle).toBeVisible();
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("provider-settings-sheet")).not.toBeVisible();
  await expect(mockRow).toContainText("Disabled");
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("provider-settings-sheet")).not.toBeVisible();
  const search = page.getByTestId("provider-catalog-search");
  await search.fill("gemini");
  await expect(page.getByTestId("provider-catalog-tile-gemini")).toBeVisible();
  await capture("providers");
  await page.getByTestId("provider-catalog-search-clear").click();
  await page.getByRole("button", { name: "Claude provider details", exact: true }).click();
  await expect(page.getByTestId("provider-settings-sheet")).toBeVisible();
  await expect(page.getByTestId("provider-installation")).toBeVisible();
  await expect(page.getByTestId("provider-docs-link")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toHaveCount(1);
  const models = page.getByTestId("provider-discovered-models");
  await expect(models).toBeVisible();
  await expect(models).toHaveCSS("max-height", "320px");
  await capture("provider-details");
  await page.keyboard.press("Escape");
  await page.getByTestId("settings-host-section-plugins").click();
  await expect(page.getByText("Built-in", { exact: true })).toBeVisible();
  await expect(page.getByTestId("builtin-plugin-custom-providers")).toBeVisible();
  await capture("plugins");
  await openAddHostFlow(page);
  await selectHostConnectionType(page, "direct");
  await expect(page.getByTestId("direct-host-input")).toBeVisible();
  for (const id of ["direct-host-input", "direct-port-input", "direct-password-input"]) {
    const field = page.getByTestId(id);
    await expect(field).toHaveCSS("border-top-width", "1px");
    await expect(field).not.toHaveCSS("padding-left", "0px");
    await expect(field).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  }
  await page.getByTestId("direct-host-input").fill("http://127.0.0.1:6942/path");
  await capture("direct-connection");
});
