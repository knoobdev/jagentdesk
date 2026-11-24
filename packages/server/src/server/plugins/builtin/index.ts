import { BUILTIN_PLUGIN_MANIFESTS } from "@jagentdesk/protocol/builtin-plugins";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Usage-source built-ins are owned by the Usage batch. Keep this list limited to
// built-ins whose host API is present in this fork.
export const builtinPlugins = [
  "hoplite-provider",
  "antigravity-provider",
  "muse-provider",
  "worktree-include",
] as const;

export function resolveBuiltinPluginsRoot(moduleUrl: string | URL = import.meta.url): string {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    path.resolve(moduleDir, "..", "..", "..", "builtin-plugins"),
    path.resolve(moduleDir, "..", "..", "..", "..", "..", "..", "plugins"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
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
