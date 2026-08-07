import { expect, type Page } from "@playwright/test";
import type { IsolatedHostDaemon } from "./isolated-host-daemon";
import type { OutdatedDaemon } from "./daemon-update";
import { openSettings, gotoAppShell } from "./app";
import {
  openSettingsHost,
  openSettingsHostSection,
  seedSavedSettingsHosts,
} from "./settings";

interface PairingHostInput {
  serverId: string;
  label: string;
  endpoint: string;
}

export async function preparePairingHost(
  page: Page,
  daemon: IsolatedHostDaemon | OutdatedDaemon,
  additionalHosts: PairingHostInput[] = [],
): Promise<void> {
  await seedSavedSettingsHosts(page, [
    {
      serverId: daemon.serverId,
      label: "Local pairing host",
      endpoint: "port" in daemon ? `127.0.0.1:${daemon.port}` : daemon.endpoint,
    },
    ...additionalHosts,
  ]);
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHost(page, daemon.serverId);
  await expect(page.getByTestId("host-page-pair-device-row")).toHaveCount(0);
  await openSettingsHostSection(page, daemon.serverId, "pair-device");
  await expect(page.getByTestId("host-page-pair-device-row")).toBeVisible();
}

export async function openPairDeviceModal(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Pair a device/ }).click();
  await expect(page.getByTestId("pair-device-modal")).toBeVisible();
}

export async function expectPairingUnavailable(page: Page): Promise<void> {
  const modal = page.getByTestId("pair-device-modal");
  await expect(modal.getByText("Pairing offer unavailable.")).toBeVisible();
  await expect(modal.getByRole("img", { name: "Pairing QR code" })).toHaveCount(0);
  await expect(modal.getByRole("textbox", { name: "Pairing link" })).toHaveCount(0);
  await expect(modal.getByRole("button", { name: "Copy", exact: true })).toHaveCount(0);
}
