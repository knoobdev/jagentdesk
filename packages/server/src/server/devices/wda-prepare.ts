import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync, zipSync, type Zippable } from "fflate";
import type { SimSignerAccount } from "@jagentdesk/protocol/simulator/rpc-schemas";
import { WDA_VERSION } from "./wda.js";

// "Prepare device" (spec 27.4): the unsigned real-device WebDriverAgent runner from Appium's pinned
// release, re-packed as an .ipa and handed to the Apple-account signer of spec 26.

// The seam owned by the Sideload feature (packages/server/src/server/sideload/sideload-service.ts).
// Physical devices only ever ask it to sign and install; Apple ID handling stays there.
export interface DeviceSigner {
  listAccounts(): Promise<SimSignerAccount[]>;
  signAndInstall(input: {
    accountId: string;
    deviceUdid: string;
    ipaPath: string;
    options?: Record<string, unknown>;
    autoRefresh?: boolean;
  }): Promise<{ appId: string; bundleId: string; expiresAt_ms: number }>;
}

const WDA_ASSET_URL = `https://github.com/appium/WebDriverAgent/releases/download/v${WDA_VERSION}/WebDriverAgentRunner-Runner.zip`;
export const WDA_ASSET_SHA256 = "2176793538d902f6b1e61291e9997f68d306541f222ea715d256a7c6ce9d4fc5";

export type FetchBytes = (url: string) => Promise<Uint8Array>;

export const defaultFetchBytes: FetchBytes = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  return new Uint8Array(await response.arrayBuffer());
};

export class ChecksumMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`WebDriverAgent download checksum mismatch (expected ${expected}, got ${actual})`);
    this.name = "ChecksumMismatchError";
  }
}

// `WebDriverAgentRunner-Runner.app/…` → `Payload/WebDriverAgentRunner-Runner.app/…`.
export function runnerZipToIpa(runnerZip: Uint8Array): Uint8Array {
  const entries = unzipSync(runnerZip);
  const payload: Zippable = {};
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith("/")) continue;
    if (name.includes(".dSYM/")) continue;
    payload[`Payload/${name}`] = data;
  }
  if (Object.keys(payload).length === 0) throw new Error("The WebDriverAgent archive is empty");
  return zipSync(payload, { level: 6 });
}

export async function ensureWdaIpa(
  jagentdeskHome: string,
  fetchBytes: FetchBytes,
): Promise<string> {
  const dir = path.join(jagentdeskHome, "devices", "wda", WDA_VERSION);
  const ipaPath = path.join(dir, "WebDriverAgentRunner.ipa");
  if (existsSync(ipaPath)) return ipaPath;
  const zipPath = path.join(dir, "WebDriverAgentRunner-Runner.zip");
  let zip: Uint8Array;
  if (existsSync(zipPath)) {
    zip = new Uint8Array(await readFile(zipPath));
  } else {
    zip = await fetchBytes(WDA_ASSET_URL);
  }
  const actual = createHash("sha256").update(zip).digest("hex");
  if (actual !== WDA_ASSET_SHA256) throw new ChecksumMismatchError(WDA_ASSET_SHA256, actual);
  await mkdir(dir, { recursive: true });
  await writeFile(zipPath, zip);
  await writeFile(ipaPath, runnerZipToIpa(zip));
  return ipaPath;
}
