import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const JAGENTDESK_HOME = process.env.JAGENTDESK_HOME ?? join(homedir(), ".jagentdesk");
const CLIENT_SESSION_KEY_FILE = join(JAGENTDESK_HOME, "cli-client-id");
// COMPAT(predecessorCliClientId): read-only fallback for the old default home;
// new CLI identities always live under `~/.jagentdesk`.
const LEGACY_CLIENT_SESSION_KEY_FILE = join(homedir(), ".jagentdesk", "cli-client-id");

let cachedClientId: string | null = null;

function normalizeClientId(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function generateClientId(): string {
  return `cid_${randomUUID().replace(/-/g, "")}`;
}

export async function getOrCreateCliClientId(): Promise<string> {
  if (cachedClientId) {
    return cachedClientId;
  }

  try {
    const existing = normalizeClientId(await readFile(CLIENT_SESSION_KEY_FILE, "utf8"));
    if (existing) {
      cachedClientId = existing;
      return existing;
    }
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  if (CLIENT_SESSION_KEY_FILE !== LEGACY_CLIENT_SESSION_KEY_FILE) {
    try {
      const existing = normalizeClientId(await readFile(LEGACY_CLIENT_SESSION_KEY_FILE, "utf8"));
      if (existing) {
        cachedClientId = existing;
        await mkdir(dirname(CLIENT_SESSION_KEY_FILE), { recursive: true });
        await writeFile(CLIENT_SESSION_KEY_FILE, existing, { mode: 0o600 });
        return existing;
      }
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  const nextValue = generateClientId();
  await mkdir(dirname(CLIENT_SESSION_KEY_FILE), { recursive: true });
  await writeFile(CLIENT_SESSION_KEY_FILE, nextValue, { mode: 0o600 });
  cachedClientId = nextValue;
  return nextValue;
}
