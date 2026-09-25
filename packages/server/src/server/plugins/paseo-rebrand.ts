import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
// optional subpath. The fork publishes the same SDK subpaths as Paseo (., ./client,
// ./client/ui, ./client/react-native, ./client/host, ./server, ./server/provider,
// ./server/acp), so only the scope changes; an unknown subpath keeps its name and fails
// resolution loudly in the compiler rather than silently landing on another entry.
const SDK_SPECIFIER = /(['"])@(?:getpaseo|paseo)\/plugin((?:\/[a-z0-9-]+)*)\1/g;

function mapSpecifierSubpath(subpath: string): string {
  return `@jagentdesk/plugin${subpath}`;
}

function rewriteSdkSpecifiers(source: string): string {
  return source.replace(SDK_SPECIFIER, (_match, quote: string, subpath: string) => {
    return `${quote}${mapSpecifierSubpath(subpath)}${quote}`;
  });
}

// The SDK's runtime exports whose names carry the brand. Types are erased at compile time, so
// only these values would fail at run time ("usePaseo is not a function") if left alone. Matched
// as whole words so a plugin's own identifiers are not touched.
const SDK_RUNTIME_RENAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\busePaseoContextValue\b/g, "useJAgentDeskContextValue"],
  [/\busePaseo\b/g, "useJAgentDesk"],
  [/\bPaseoApiProvider\b/g, "JAgentDeskApiProvider"],
  [/\bgetPaseoClient\b/g, "getJAgentDeskClient"],
];

function rewriteSdkRuntimeNames(source: string): string {
  if (!SDK_SPECIFIER_PRESENT.test(source)) return source;
  let result = source;
  for (const [pattern, replacement] of SDK_RUNTIME_RENAMES) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
// Only files that import the SDK are renamed (checked before the specifier rewrite).
const SDK_SPECIFIER_PRESENT = /['"]@(?:getpaseo|paseo)\/plugin(?:\/[a-z0-9-]+)*['"]/;

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
      const rewritten = rewriteSdkSpecifiers(rewriteSdkRuntimeNames(source));
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

async function isFile(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    (info) => info.isFile(),
    () => false,
  );
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
  return true;
}
