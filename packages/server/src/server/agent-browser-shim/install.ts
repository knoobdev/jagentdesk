import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderAgentBrowserShim, SHIM_ENDPOINT_FILE, SHIM_MARKER_FILE } from "./shim-script.js";

export const AGENT_SHIM_DIR_NAME = "agent-bin";
export const BROWSER_SHIM_FILE = "jagentdesk-browser.js";

/** Where the shims live for one daemon home; stable across restarts. */
export function agentShimDir(jagentdeskHome: string): string {
  return path.join(jagentdeskHome, AGENT_SHIM_DIR_NAME);
}

/**
 * The environment every agent process gets: the shim directory first on PATH and BROWSER on the
 * `.js` shim. `basePath` is the PATH the agent would otherwise get.
 */
export function agentShimEnv(input: { dir: string; basePath: string | undefined }): {
  PATH: string;
  BROWSER: string;
} {
  const rest = (input.basePath ?? "")
    .split(path.delimiter)
    .filter((entry) => entry && entry !== input.dir);
  return {
    PATH: [input.dir, ...rest].join(path.delimiter),
    BROWSER: path.join(input.dir, BROWSER_SHIM_FILE),
  };
}

async function writeAtomic(file: string, content: string, mode: number): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, content, { mode });
  await chmod(temp, mode);
  await rename(temp, file);
}

/**
 * Writes the shims (spec 04 §27b item 3b). `open` is the macOS command, `xdg-open` the Linux one;
 * Windows gets `explorer.cmd`, because `start` and `Start-Process` are shell built-ins no PATH
 * entry can replace. The shims carry no secret; the endpoint file does and is owner-only.
 */
export async function installAgentBrowserShims(input: {
  dir: string;
  nodePath?: string;
  electron?: boolean;
  platform?: NodeJS.Platform;
}): Promise<void> {
  const platform = input.platform ?? process.platform;
  const source = renderAgentBrowserShim({
    nodePath: input.nodePath ?? process.execPath,
    electron: input.electron ?? Boolean(process.versions.electron),
  });
  await mkdir(input.dir, { recursive: true, mode: 0o700 });
  await writeAtomic(
    path.join(input.dir, SHIM_MARKER_FILE),
    "JAgentDesk agent shims (spec 04 §27b). Written by the daemon.\n",
    0o644,
  );
  await writeAtomic(
    path.join(input.dir, "package.json"),
    `${JSON.stringify({ type: "commonjs" })}\n`,
    0o644,
  );
  await writeAtomic(path.join(input.dir, BROWSER_SHIM_FILE), source, 0o755);
  if (platform === "win32") {
    await writeAtomic(path.join(input.dir, "explorer.js"), source, 0o755);
    const node = input.nodePath ?? process.execPath;
    const electron =
      (input.electron ?? Boolean(process.versions.electron))
        ? "set ELECTRON_RUN_AS_NODE=1\r\nset JAGENTDESK_SHIM_ELECTRON=1\r\n"
        : "";
    await writeAtomic(
      path.join(input.dir, "explorer.cmd"),
      `@echo off\r\nsetlocal\r\n${electron}"${node}" "%~dp0explorer.js" %*\r\n`,
      0o755,
    );
    return;
  }
  await writeAtomic(path.join(input.dir, "open"), source, 0o755);
  await writeAtomic(path.join(input.dir, "xdg-open"), source, 0o755);
}

/** Tells the shims where to send web targets; rewritten whenever the daemon binds a port. */
export async function writeAgentShimEndpoint(input: {
  dir: string;
  url: string | null;
  token: string;
}): Promise<void> {
  await mkdir(input.dir, { recursive: true, mode: 0o700 });
  await writeAtomic(
    path.join(input.dir, SHIM_ENDPOINT_FILE),
    `${JSON.stringify({ url: input.url, token: input.token })}\n`,
    0o600,
  );
}
