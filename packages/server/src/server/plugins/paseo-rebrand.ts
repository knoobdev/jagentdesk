import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import intersects from "semver/ranges/intersects.js";
import validRange from "semver/ranges/valid.js";

// A plugin authored for Paseo reaches the SDK under the @getpaseo/@paseo scope and
// declares itself in paseo-plugin.json. JAgentDesk publishes the same SDK under its own
// scope and reads jagentdesk-plugin.json, so a freshly checked-out Paseo plugin is
// rewritten in place — on the throwaway install staging copy, never the author's tree.
// The manifest is renamed before the plugin's own build steps run; the SDK imports are
// rewritten after them, because the plugin's bundler resolves @getpaseo/plugin from its own
// node_modules. Only the SDK import specifier and the manifest are touched; a plugin's own
// use of the word "paseo" is left alone.
const PASEO_MANIFEST_FILENAME = "paseo-plugin.json";
const JAGENTDESK_MANIFEST_FILENAME = "jagentdesk-plugin.json";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
// Build output (dist, build) is rewritten too: it runs after the plugin's build steps and a
// bundle that keeps the SDK external still imports it by the Paseo scope.
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", ".turbo", ".next"]);

/**
 * The Paseo plugin API versions JAgentDesk implements: the split API up to the last ported
 * Paseo release, plus the pre-split plugins it still loads. Bump the upper bound when a Paseo
 * release is ported.
 */
export const SUPPORTED_PASEO_PLUGIN_API = ">=0.8.0-0 <=0.10.2";

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

// `requirements.paseo` is a Paseo version range, not a JAgentDesk one, so it is checked here
// against the Paseo plugin API JAgentDesk implements and then dropped. Comparing it with the
// JAgentDesk version rejected plugins that need Paseo 0.10 and passed ^0.9.0 only by chance.
function assertSupportedPaseoRange(id: unknown, range: unknown): void {
  if (range === undefined) return;
  const name = typeof id === "string" ? id : "plugin";
  if (typeof range !== "string" || validRange(range) === null) {
    throw new Error(`Plugin "${name}" has an invalid requirements.paseo: ${JSON.stringify(range)}`);
  }
  if (intersects(range, SUPPORTED_PASEO_PLUGIN_API, { includePrerelease: true })) return;
  throw new Error(
    `Plugin "${name}" requires Paseo ${range}. JAgentDesk supports Paseo plugins for ${SUPPORTED_PASEO_PLUGIN_API}. Use a compatible plugin version.`,
  );
}

// The manifest keeps its plugin id, build steps and any JAgentDesk requirement. Unknown keys
// are dropped so the strict manifest reader accepts the result.
function rebrandManifest(raw: unknown): Record<string, unknown> {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const result: Record<string, unknown> = {};
  if (typeof source.id === "string") result.id = source.id;
  if (Array.isArray(source.build)) result.build = source.build;
  const requirements = source.requirements;
  if (typeof requirements === "object" && requirements !== null) {
    const { paseo, ...rest } = requirements as Record<string, unknown>;
    assertSupportedPaseoRange(source.id, paseo);
    if (Object.keys(rest).length > 0) result.requirements = rest;
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
 * Rename a checked-out Paseo plugin's manifest so the fork's manifest reader accepts it, and
 * reject a plugin that needs a Paseo version JAgentDesk does not support. A no-op when the
 * plugin already targets JAgentDesk. Returns whether the plugin was authored for Paseo.
 */
export async function rebrandPaseoManifest(directory: string): Promise<boolean> {
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
  return true;
}

/**
 * Point every SDK import under `root` at the JAgentDesk scope. `root` is the whole checkout, not
 * only the plugin folder: a monorepo's shared helper packages import the SDK too.
 */
export async function rewritePaseoSdkImports(root: string): Promise<void> {
  await rewriteSourceTree(root);
}

/** Rebrand a Paseo plugin that has no build step: manifest and SDK imports in one pass. */
export async function rebrandPaseoPlugin(directory: string): Promise<boolean> {
  if (!(await rebrandPaseoManifest(directory))) return false;
  await rewritePaseoSdkImports(directory);
  return true;
}
