import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pino from "pino";

export type PluginInstallResult =
  | { ok: true; dir: string; installed: boolean }
  | { ok: false; error: string };

const INSTALL_DIR_NAME = "@hdc/jagentdesk-plugin-figma-link";
const MANAGED_MARKER = ".jagentdesk-managed.json";

export interface PluginInstallOptions {
  logger: pino.Logger;
  /** Vendored plugin directory (default: this package's `vendor/figma-link-plugin`). */
  vendorPluginDir?: string;
  /** Install root; defaults to `~/lib/node_modules`. Tests point it at a temp dir. */
  installRoot?: string;
  /** Minimum interval between failed install attempts. */
  backoffMs?: number;
  /** Timestamp of the last failure; a fresh attempt must be later than this + backoff. */
  lastFailureAt?: number;
  now?: () => number;
}

/**
 * Locate the vendored plugin inside this package. Probes both the source
 * layout and the compiled layout because the daemon runs from `src` in dev
 * and from `dist` in production builds.
 */
export function resolveVendorPluginDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../../../vendor/figma-link-plugin"), // src/server/figma/link + dist/server/figma/link
    path.resolve(process.cwd(), "packages/server/vendor/figma-link-plugin"),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "manifest.json"))) return candidate;
  }
  return candidates[0];
}

/** sha256 over the manifest + both dist files — the plugin's whole payload. */
export async function computePluginChecksum(dir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of ["manifest.json", "dist/code.js", "dist/index.html"]) {
    const bytes = await fs.readFile(path.join(dir, file)).catch(() => null);
    hash.update(file);
    hash.update(bytes ?? Buffer.alloc(0));
  }
  return hash.digest("hex");
}

/**
 * Copy the vendored plugin into `~/lib/node_modules/@hdc/...` (spec 32 §Plugin
 * install) when the directory is missing, malformed, or built from a different
 * vendored payload. A directory the user placed there themselves (no managed
 * marker) is never clobbered.
 */
export async function installFigmaLinkPlugin(
  options: PluginInstallOptions,
): Promise<PluginInstallResult> {
  const now = options.now?.() ?? Date.now();
  const backoffMs = options.backoffMs ?? 5 * 60 * 1000;
  if (options.lastFailureAt && now - options.lastFailureAt < backoffMs) {
    return { ok: false, error: "backoff" };
  }
  const vendorDir = options.vendorPluginDir ?? resolveVendorPluginDir();
  if (!existsSync(path.join(vendorDir, "manifest.json"))) {
    return { ok: false, error: "vendor_missing" };
  }
  let manifest: { name?: string; id?: string; main?: string; ui?: string };
  try {
    manifest = JSON.parse(readFileSync(path.join(vendorDir, "manifest.json"), "utf8"));
    if (!manifest.main || !manifest.ui) throw new Error("missing main/ui");
  } catch (error) {
    return { ok: false, error: `vendor_manifest_invalid: ${String(error)}` };
  }

  const installRoot = options.installRoot ?? path.join(os.homedir(), "lib", "node_modules");
  const target = path.join(installRoot, INSTALL_DIR_NAME);

  const markerPath = path.join(target, MANAGED_MARKER);
  if (existsSync(markerPath)) {
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { checksum?: string };
      if (marker.checksum === (await computePluginChecksum(vendorDir))) {
        return { ok: true, dir: target, installed: false };
      }
    } catch {
      // fall through to reinstall
    }
  } else if (existsSync(target)) {
    const hasBundle = existsSync(path.join(target, "dist", "code.js"));
    if (hasBundle) return { ok: true, dir: target, installed: false }; // unmanaged user copy
  }

  try {
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target, { recursive: true });
    await fs.cp(path.join(vendorDir, "manifest.json"), path.join(target, "manifest.json"));
    await fs.cp(path.join(vendorDir, "dist"), path.join(target, "dist"), { recursive: true });
    await fs
      .cp(path.join(vendorDir, "LICENSE.md"), path.join(target, "LICENSE.md"))
      .catch(() => undefined);
    await fs.writeFile(
      markerPath,
      JSON.stringify({
        managedBy: "jagentdesk-server",
        pluginName: manifest.name ?? "JAgentDesk Figma Link",
        checksum: await computePluginChecksum(vendorDir),
      }),
    );
    return { ok: true, dir: target, installed: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
