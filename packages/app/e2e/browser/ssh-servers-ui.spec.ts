import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { getServerId } from "../support/helpers/server-id";
import type { Page } from "@playwright/test";

// SSH session presentation (spec 25.13.1) against a real sshd, in both app themes and on
// desktop + phone. Opt-in: needs an sshd the e2e daemon can reach, e.g.
//   docker run -d --name jad-a-ui -p 127.0.0.1:2342:2222 -e PASSWORD_ACCESS=true \
//     -e USER_NAME=jad -e USER_PASSWORD=jadtest lscr.io/linuxserver/openssh-server
//   JAD_SSH_UI_SSHD_PORT=2342 JAD_SSH_UI_SHOTS=/tmp/jad-ssh-ui-shots/v2 npx playwright test ssh-servers-ui
// Screenshots go to JAD_SSH_UI_SHOTS when set.

const SSHD_PORT = Number(process.env.JAD_SSH_UI_SSHD_PORT ?? 0);
const SHOTS = process.env.JAD_SSH_UI_SHOTS ?? null;

interface SshSeedClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  sshServersSave(input: {
    server: Record<string, unknown>;
    password?: string;
  }): Promise<{ server: { id: string } | null; error: string | null }>;
  sshServersList(): Promise<{
    servers: Array<{ id: string; label: string }>;
    sessions: Array<{ terminalId: string }>;
  }>;
  sshServersDelete(input: { id: string }): Promise<{ error: string | null }>;
  killTerminal(terminalId: string): Promise<unknown>;
  sshKnownhostsDelete(input: { host: string; port: number }): Promise<{ error: string | null }>;
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function seedServer(): Promise<{ client: SshSeedClient; sshServerId: string }> {
  const client = await connectDaemonClient<SshSeedClient>({ clientIdPrefix: "ssh-ui" });
  const existing = await client.sshServersList();
  for (const session of existing.sessions) await client.killTerminal(session.terminalId);
  for (const server of existing.servers) await client.sshServersDelete({ id: server.id });
  await client.sshKnownhostsDelete({ host: "127.0.0.1", port: SSHD_PORT });
  const saved = await client.sshServersSave({
    server: {
      id: "",
      label: "web-prod",
      address: "127.0.0.1",
      port: SSHD_PORT,
      username: "jad",
      tags: ["prod"],
    },
    password: "jadtest",
  });
  if (!saved.server) throw new Error(saved.error ?? "seed failed");
  return { client, sshServerId: saved.server.id };
}

async function useTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.addInitScript((name) => {
    localStorage.setItem(
      "@jagentdesk:app-settings",
      JSON.stringify({ theme: name, defaultThemeVersion: 1 }),
    );
  }, theme);
}

async function connectAndRun(page: Page, sshServerId: string, prefix: string): Promise<void> {
  await page.goto(`/h/${encodeURIComponent(getServerId())}/servers`);
  await page.getByTestId(`servers-connect-${sshServerId}`).first().click();
  await page.getByTestId("ssh-hostkey-accept").first().click({ timeout: 20_000 });
  await expect(page.getByTestId("ssh-session-dot")).toBeVisible();
  const surface = page.getByTestId("terminal-surface").first();
  await expect(surface).toBeVisible();
  await expect(surface).toContainText("$", { timeout: 20_000 });
  await surface.click();
  await page.keyboard.type("uname -sm && echo SSH-UI-$((6*7)) && ls --color=always /\n");
  await expect(surface).toContainText("SSH-UI-42", { timeout: 15_000 });
  await shot(page, `${prefix}-terminal`);
}

async function eachTab(page: Page, prefix: string): Promise<void> {
  for (const tab of ["sftp", "forwarding", "snippets", "logs"]) {
    const tabButton = page.getByTestId(`ssh-section-${tab}`).first();
    if (!(await tabButton.isVisible().catch(() => false))) continue;
    await tabButton.click();
    await shot(page, `${prefix}-tab-${tab}`);
  }
  await page.getByTestId("ssh-section-terminal").first().click();
}

test.describe("SSH session presentation", () => {
  test.skip(!SSHD_PORT, "set JAD_SSH_UI_SSHD_PORT to an sshd the e2e daemon can reach");
  test.setTimeout(180_000);

  test("phone default theme: Servers is reachable from the mobile navigation", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await shot(page, "phone-default-home");
    await page.getByTestId("clickup-tab-workspaces").first().click();
    await shot(page, "phone-default-drawer");
    await page.getByTestId("sidebar-servers-nav").first().click();
    await expect(page).toHaveURL(/\/servers/);
    await shot(page, "phone-default-servers");
  });

  for (const theme of ["dark", "light"] as const) {
    test(`desktop ${theme}: one header row, one tab row, dark padded terminal`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await useTheme(page, theme);
      const { client, sshServerId } = await seedServer();
      try {
        await connectAndRun(page, sshServerId, `desktop-${theme}`);
        // The terminal frame is the dark terminal palette in both app themes (25.13.1).
        const frame = page.getByTestId("ssh-terminal-frame").first();
        await expect(frame).toHaveCSS("background-color", "rgb(24, 27, 26)");
        const surface = page.getByTestId("terminal-surface").first();
        const frameBox = await frame.boundingBox();
        const surfaceBox = await surface.boundingBox();
        expect(Math.round((surfaceBox?.x ?? 0) - (frameBox?.x ?? 0))).toBe(12);
        expect(Math.round((surfaceBox?.y ?? 0) - (frameBox?.y ?? 0))).toBe(12);
        await expect(page.getByTestId("sidebar-servers-nav-panel")).toBeVisible();
        await eachTab(page, `desktop-${theme}`);
        await page.getByTestId("ssh-session-menu").first().click();
        await shot(page, `desktop-${theme}-menu`);
        await page.keyboard.press("Escape");
      } finally {
        await client.close();
      }
    });

    test(`phone ${theme}: full-screen dark terminal, scrolling tabs, Servers entry`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await useTheme(page, theme);
      const { client, sshServerId } = await seedServer();
      try {
        await connectAndRun(page, sshServerId, `phone-${theme}`);
        await expect(page.getByTestId("terminal-extra-keys")).toBeVisible();
        await eachTab(page, `phone-${theme}`);
        // Known hosts lists the key trusted during this connect without a reload.
        await page.getByTestId("ssh-terminal-back").first().click();
        await page.getByTestId("servers-tab-hosts").first().click();
        await expect(page.getByText(`127.0.0.1:${SSHD_PORT}`).first()).toBeVisible();
        await shot(page, `phone-${theme}-known-hosts`);
      } finally {
        await client.close();
      }
    });
  }
});
