import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { writePrivateFileAtomicSync } from "../private-files.js";

/** Editors such as Windows Notepad save UTF-8 with a byte order mark, which JSON.parse rejects. */
function parseConfigText(raw: string): unknown {
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

function configPath(jagentdeskHome: string): string {
  return path.join(jagentdeskHome, "config.json");
}

/**
 * Raw `agents.providers` entries of config.json (spec 34.2). Parsed without the
 * persisted-config schema so hand-written entries keep their unknown fields.
 */
export function readAgentProviderEntries(jagentdeskHome: string): Record<string, unknown> {
  const filePath = configPath(jagentdeskHome);
  if (!existsSync(filePath)) return {};
  let parsed: unknown;
  try {
    parsed = parseConfigText(readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
  const agents = (parsed as Record<string, unknown> | null)?.["agents"];
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) return {};
  const providers = (agents as Record<string, unknown>)["providers"];
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return {};
  return { ...(providers as Record<string, unknown>) };
}

/**
 * Writes one `agents.providers.<id>` entry (or removes it with `null`) atomically,
 * preserving every other key of config.json verbatim (spec 34.2).
 */
export function writeAgentProviderEntry(
  jagentdeskHome: string,
  id: string,
  entry: Record<string, unknown> | null,
): void {
  const filePath = configPath(jagentdeskHome);
  let root: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    const parsed = parseConfigText(readFileSync(filePath, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      root = { ...(parsed as Record<string, unknown>) };
    }
  }
  const agents = { ...(root["agents"] as Record<string, unknown> | undefined) };
  const providers = { ...(agents["providers"] as Record<string, unknown> | undefined) };
  if (entry === null) {
    delete providers[id];
  } else {
    providers[id] = entry;
  }
  agents["providers"] = providers;
  root["agents"] = agents;
  writePrivateFileAtomicSync(filePath, `${JSON.stringify(root, null, 2)}\n`);
}

/** Secret-store key holding the API key of one provider (never config.json). */
export function providerApiKeySecretId(providerId: string): string {
  return `provider.apikey.${providerId}`;
}
