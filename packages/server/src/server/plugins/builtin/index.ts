import { BUILTIN_PLUGIN_MANIFESTS, BUNDLED_PLUGIN_IDS } from "@jagentdesk/protocol/builtin-plugins";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const builtinPlugins = BUNDLED_PLUGIN_IDS;

export function resolveBuiltinPluginsRoot(
  moduleUrl: string | URL = import.meta.url,
  exists: (file: string) => boolean = existsSync,
): string {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    path.resolve(moduleDir, "..", "..", "..", "builtin-plugins"),
    path.resolve(moduleDir, "..", "..", "..", "..", "..", "..", "plugins"),
  ];
  const root = candidates.find((candidate) => exists(candidate)) ?? candidates[0]!;
  return preferAsarUnpacked(root, exists);
}

/**
 * Plugin sources are compiled by esbuild, a native binary that cannot read
 * inside Electron's app.asar. The desktop package unpacks the built-in plugin
 * sources next to it, so hand esbuild the real files when they are there.
 */
function preferAsarUnpacked(root: string, exists: (file: string) => boolean): string {
  const asarSegment = `${path.sep}app.asar${path.sep}`;
  if (!root.includes(asarSegment)) return root;
  const unpacked = root.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`);
  return exists(unpacked) ? unpacked : root;
}

export interface BuiltinPlugin {
  id: string;
  directory: string;
}

export class BuiltinPluginLoader {
  readonly ids: ReadonlySet<string>;
  readonly featureManifests = BUILTIN_PLUGIN_MANIFESTS;

  constructor(
    private readonly root = resolveBuiltinPluginsRoot(),
    private readonly list: readonly string[] = builtinPlugins,
  ) {
    this.ids = new Set([...list, ...this.featureManifests.map(({ id }) => id)]);
  }

  async load(start: (plugin: BuiltinPlugin) => Promise<void>): Promise<void> {
    for (const id of this.list) {
      await start({ id, directory: path.join(this.root, id) });
    }
  }
}
