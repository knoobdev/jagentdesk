import { app, safeStorage, session } from "electron";
import type { Cookie, WebContents } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import log from "electron-log";
import { JAGENTDESK_BROWSER_PROFILE_PARTITION } from "./browser-profile.js";

/**
 * "Connected logins" vault. Captures the current cookies for a tab's domain,
 * encrypts them with the OS keychain via Electron safeStorage (same mechanism as
 * the Tailscale auth key in desktop-settings.ts), and stores them local-only.
 * Lets the user see which sites are logged in, forget one (clears its cookies),
 * and restore a saved session. No sync, no plaintext — see ADR-0011.
 */
export interface ConnectedLogin {
  domain: string;
  cookieCount: number;
  savedAt: number;
}

interface VaultEntry extends ConnectedLogin {
  /** base64 of safeStorage-encrypted JSON cookie array (or plain base64 fallback). */
  blob: string;
  encrypted: boolean;
}

interface VaultFile {
  version: 1;
  entries: Record<string, VaultEntry>;
}

function vaultPath(): string {
  return path.join(app.getPath("userData"), "browser-connected-logins.json");
}

async function readVault(): Promise<VaultFile> {
  try {
    const raw = await fs.readFile(vaultPath(), "utf8");
    const parsed = JSON.parse(raw) as VaultFile;
    if (parsed && parsed.version === 1 && parsed.entries) {
      return parsed;
    }
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code !== "ENOENT") {
      log.warn("[browser-vault] read failed", { error: String(error) });
    }
  }
  return { version: 1, entries: {} };
}

async function writeVault(vault: VaultFile): Promise<void> {
  await fs.writeFile(vaultPath(), JSON.stringify(vault), { mode: 0o600 });
}

function encryptJson(json: string): { blob: string; encrypted: boolean } {
  if (safeStorage.isEncryptionAvailable()) {
    return { blob: safeStorage.encryptString(json).toString("base64"), encrypted: true };
  }
  return { blob: Buffer.from(json, "utf8").toString("base64"), encrypted: false };
}

function decryptJson(entry: VaultEntry): string | null {
  try {
    const buf = Buffer.from(entry.blob, "base64");
    return entry.encrypted ? safeStorage.decryptString(buf) : buf.toString("utf8");
  } catch (error) {
    log.warn("[browser-vault] decrypt failed", { domain: entry.domain, error: String(error) });
    return null;
  }
}

function registrableDomain(hostname: string): string {
  const parts = hostname.replace(/^\./, "").split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : hostname.replace(/^\./, "");
}

function domainOfUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return host ? registrableDomain(host) : null;
  } catch {
    return null;
  }
}

function getProfileSession(): Electron.Session {
  return session.fromPartition(JAGENTDESK_BROWSER_PROFILE_PARTITION);
}

function cookieUrl(cookie: Cookie): string {
  const host = (cookie.domain ?? "").replace(/^\./, "");
  const scheme = cookie.secure ? "https" : "http";
  return `${scheme}://${host}${cookie.path ?? "/"}`;
}

/** Capture + encrypt the cookies for the tab's current domain. */
export async function saveConnectedLoginForContents(
  contents: WebContents,
): Promise<ConnectedLogin | null> {
  const domain = domainOfUrl(contents.getURL());
  if (!domain) {
    return null;
  }
  const ses = getProfileSession();
  const cookies = await ses.cookies.get({ domain });
  if (cookies.length === 0) {
    return null;
  }
  const { blob, encrypted } = encryptJson(JSON.stringify(cookies));
  const entry: VaultEntry = {
    domain,
    cookieCount: cookies.length,
    savedAt: Date.now(),
    blob,
    encrypted,
  };
  const vault = await readVault();
  vault.entries[domain] = entry;
  await writeVault(vault);
  log.info("[browser-vault] saved", { domain, cookieCount: cookies.length, encrypted });
  return { domain, cookieCount: cookies.length, savedAt: entry.savedAt };
}

export async function listConnectedLogins(): Promise<ConnectedLogin[]> {
  const vault = await readVault();
  return Object.values(vault.entries)
    .map((e) => ({ domain: e.domain, cookieCount: e.cookieCount, savedAt: e.savedAt }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

/** Forget a saved login: remove its encrypted entry and clear its live cookies. */
export async function deleteConnectedLogin(domain: string): Promise<void> {
  const vault = await readVault();
  delete vault.entries[domain];
  await writeVault(vault);
  const ses = getProfileSession();
  const cookies = await ses.cookies.get({ domain });
  await Promise.all(
    cookies.map((cookie) => ses.cookies.remove(cookieUrl(cookie), cookie.name).catch(() => {})),
  );
  log.info("[browser-vault] deleted", { domain, cleared: cookies.length });
}

/** Restore a saved session's cookies back into the shared browser profile. */
export async function restoreConnectedLogin(domain: string): Promise<boolean> {
  const vault = await readVault();
  const entry = vault.entries[domain];
  if (!entry) {
    return false;
  }
  const json = decryptJson(entry);
  if (!json) {
    return false;
  }
  const cookies = JSON.parse(json) as Cookie[];
  const ses = getProfileSession();
  await Promise.all(
    cookies.map((cookie) =>
      ses.cookies
        .set({
          url: cookieUrl(cookie),
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          ...(cookie.expirationDate ? { expirationDate: cookie.expirationDate } : {}),
        })
        .catch(() => {}),
    ),
  );
  log.info("[browser-vault] restored", { domain, cookieCount: cookies.length });
  return true;
}
