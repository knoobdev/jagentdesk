import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// A plugin authored for Paseo reaches the SDK under the @getpaseo/@paseo scope and
// declares itself in paseo-plugin.json. JAgentDesk publishes the same SDK under its own
// scope and reads jagentdesk-plugin.json, so a freshly checked-out Paseo plugin is
// rewritten in place — on the throwaway install staging copy, never the author's tree —
// before the manifest reader and compiler ever see it. Only the SDK import specifier and
// the manifest are touched; a plugin's own use of the word "paseo" is left alone.
const PASEO_MANIFEST_FILENAME = "paseo-plugin.json";
const JAGENTDESK_MANIFEST_FILENAME = "jagentdesk-plugin.json";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", ".turbo", ".next"]);

// The SDK specifier inside an import/require/export string: the quote, the scope, and an
// optional subpath. Paseo splits its SDK across many subpaths (./client, ./client/react-native,
// ./client/ui, ./server/provider, ./server/acp, …); the fork publishes only ., ./server, ./host
// and ./react-native, so each upstream subpath is mapped onto the fork's real entry points.
const SDK_SPECIFIER = /(['"])@(?:getpaseo|paseo)\/plugin((?:\/[a-z0-9-]+)*)\1/g;

// Explicit map from a Paseo subpath to the fork's. Anything under /client collapses toward the
// package root (the fork re-exports the client API from `.`), /client/react-native and
// /client/host land on the fork's own ./react-native and ./host, and every ./server/* leaf
// folds onto ./server (the fork has no provider/acp split).
const SUBPATH_MAP: Record<string, string> = {
  "": "",
  "/client": "",
  "/client/ui": "",
  "/client/react-native": "/react-native",
  "/client/host": "/host",
  "/react-native": "/react-native",
  "/host": "/host",
  "/server": "/server",
};

function mapSpecifierSubpath(subpath: string): string {
  const mapped = SUBPATH_MAP[subpath] ?? (subpath.startsWith("/server") ? "/server" : "");
  return `@jagentdesk/plugin${mapped}`;
}

function rewriteSdkSpecifiers(source: string): string {
  return source.replace(SDK_SPECIFIER, (_match, quote: string, subpath: string) => {
    return `${quote}${mapSpecifierSubpath(subpath)}${quote}`;
  });
}

async function rewriteSourceTree(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) return;
        await rewriteSourceTree(path.join(directory, entry.name));
        return;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name))) return;
      const filePath = path.join(directory, entry.name);
      const source = await readFile(filePath, "utf8");
      const rewritten = rewriteSdkSpecifiers(source);
      if (rewritten !== source) await writeFile(filePath, rewritten);
    }),
  );
}

// The manifest keeps its plugin id and build steps; a Paseo version requirement moves onto
// the jagentdesk key so the marketplace can still read what the plugin expects. Unknown
// keys are dropped so the strict manifest reader accepts the result.
function rebrandManifest(raw: unknown): Record<string, unknown> {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const result: Record<string, unknown> = {};
  if (typeof source.id === "string") result.id = source.id;
  if (Array.isArray(source.build)) result.build = source.build;
  const requirements = source.requirements;
  if (typeof requirements === "object" && requirements !== null) {
    const mapped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(requirements as Record<string, unknown>)) {
      mapped[key === "paseo" ? "jagentdesk" : key] = value;
    }
    result.requirements = mapped;
  }
  return result;
}

const FORK_ENTRY_FILENAMES = ["index.ts", "index.tsx"];
// Paseo splits its entry into client/server files; the fork compiles a single index.ts
// (client-only plugins default-export their contribute function). A client entry is
// renamed to the fork's entry so themes and other client plugins load; a server-only
// plugin still needs API parity and is out of scope here.
const PASEO_CLIENT_ENTRIES = [
  ["index.client.ts", "index.ts"],
  ["index.client.tsx", "index.tsx"],
  ["index.client.js", "index.ts"],
  ["index.client.jsx", "index.tsx"],
] as const;

async function isFile(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    (info) => info.isFile(),
    () => false,
  );
}

async function bridgeEntryPoint(directory: string): Promise<void> {
  for (const filename of FORK_ENTRY_FILENAMES) {
    if (await isFile(path.join(directory, filename))) return;
  }
  for (const [paseoEntry, forkEntry] of PASEO_CLIENT_ENTRIES) {
    const source = path.join(directory, paseoEntry);
    if (await isFile(source)) {
      await rename(source, path.join(directory, forkEntry));
      return;
    }
  }
}

/**
 * Rebrand a checked-out Paseo plugin so the fork's manifest reader and compiler accept it.
 * A no-op when the plugin already targets JAgentDesk. Returns whether anything was rewritten.
 */
export async function rebrandPaseoPlugin(directory: string): Promise<boolean> {
  if (await isFile(path.join(directory, JAGENTDESK_MANIFEST_FILENAME))) {
    return false;
  }
  const paseoManifest = path.join(directory, PASEO_MANIFEST_FILENAME);
  if (!(await isFile(paseoManifest))) {
    return false;
  }
  const parsed = JSON.parse(await readFile(paseoManifest, "utf8")) as unknown;
  const jagentdeskManifest = path.join(directory, JAGENTDESK_MANIFEST_FILENAME);
  await writeFile(jagentdeskManifest, `${JSON.stringify(rebrandManifest(parsed), null, 2)}\n`);
  await rm(paseoManifest, { force: true });
  await rewriteSourceTree(directory);
  await bridgeEntryPoint(directory);
  return true;
}
