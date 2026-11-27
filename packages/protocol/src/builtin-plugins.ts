import { z } from "zod";
import type { HostCapabilityId } from "./host-capabilities.js";

export {
  STATIC_BUILTIN_PLUGIN_IDS,
  BUNDLED_PLUGIN_IDS,
  BUILTIN_PLUGIN_IDS,
} from "./builtin-plugins.generated.js";
import {
  STATIC_BUILTIN_PLUGIN_IDS,
  BUILTIN_PLUGIN_IDS,
  GENERATED_BUILTIN_MANIFESTS,
} from "./builtin-plugins.generated.js";
export type BuiltinPluginId = (typeof BUILTIN_PLUGIN_IDS)[number];
export const BuiltinPluginIdSchema = z.enum(BUILTIN_PLUGIN_IDS);
export const BuiltinPluginConfigSchema = z.record(z.string(), z.object({ enabled: z.boolean() }));
export type BuiltinPluginConfig = z.infer<typeof BuiltinPluginConfigSchema>;

export interface BuiltinPluginManifest {
  id: BuiltinPluginId;
  name: string;
  description: string;
  defaultEnabled: boolean;
  /** Bundled providers need this executable on the host PATH. */
  command?: string;
  requires: readonly BuiltinPluginId[];
  /** Alternatives: at least one capability must be available. */
  hostCapabilities?: readonly HostCapabilityId[];
}

// Generated from plugins/*/jagentdesk-plugin.json; see scripts/generate-builtin-plugins.mjs.
export const BUILTIN_PLUGIN_MANIFESTS: readonly BuiltinPluginManifest[] =
  GENERATED_BUILTIN_MANIFESTS;

export const BUILTIN_PLUGIN_FEATURES = {
  "claude-usage-source": [],
  "codex-usage-source": [],
  "copilot-usage-source": [],
  "cursor-usage-source": [],
  "grok-usage-source": [],
  "kimi-usage-source": [],
  "minimax-usage-source": [],
  "opencode-go-usage-source": [],
  "openrouter-host-usage-source": [],
  "zai-usage-source": [],

  bots: ["bots", "botsOptionalIdentity", "botsOrca", "botsHooks", "botsSharing", "botsKickoff"],
  "goose-provider": [],
  "hermes-provider": [],
  "fx-provider": [],
  "hoplite-provider": [],
  "antigravity-provider": [],
  "muse-provider": [],
  "worktree-include": [],
  docker: ["docker"],
  clusters: ["clusters"],
  databases: ["databases"],
  "ssh-servers": ["sshServers"],
  "remote-tasks": ["remoteTasks"],
  "custom-providers": ["customProviders"],
  jira: ["jira"],
  argocd: ["argocd"],
  devices: ["devices", "sideload", "sideloadHostBrowse"],
  workbench: ["workbench"],
  "forge-hub": [
    "forgeHub",
    "forgeHubCode",
    "forgeHubReview",
    "forgeHubPipelines",
    "forgeHubReleases",
    "forgeHubIssues",
    "forgeHubCliInstall",
    "forgeHubLogin",
  ],
  skills: ["skills"],
  memory: ["memory"],
  "spec-mode": ["specMode"],
  autorun: ["autorun", "autorunApproval"],
  insights: ["insights"],
  "session-share": ["sessionSharing"],
  "browser-tools": ["browserTools"],
} as const satisfies Record<BuiltinPluginId, readonly string[]>;

export const BuiltinPluginListItemSchema = z.object({
  id: BuiltinPluginIdSchema,
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  defaultEnabled: z.boolean(),
  requires: z.array(BuiltinPluginIdSchema),
  available: z.boolean(),
  unavailableReason: z.string().optional(),
});
export type BuiltinPluginListItem = z.infer<typeof BuiltinPluginListItemSchema>;
// COMPAT(adr0055): added in v0.9.60, remove after 2027-05-25 once the daemon floor no longer lists
// the removed Figma and Activity graph built-ins. Older daemons still send these ids; accept them on
// the wire so the whole list parses, and drop them in mergeBuiltinPluginWireState.
const REMOVED_BUILTIN_PLUGIN_IDS: ReadonlySet<string> = new Set(["figma", "activity-graph"]);
const BuiltinPluginWireListItemSchema = BuiltinPluginListItemSchema.extend({
  id: z.enum([...BUILTIN_PLUGIN_IDS, "figma", "activity-graph"] as const),
});
type BuiltinPluginWireListItem = z.infer<typeof BuiltinPluginWireListItemSchema>;
export const BuiltinPluginListRequestSchema = z.object({
  type: z.literal("plugins.builtin.list.request"),
  requestId: z.string(),
});
export const BuiltinPluginSetRequestSchema = z.object({
  type: z.literal("plugins.builtin.set.request"),
  requestId: z.string(),
  id: BuiltinPluginIdSchema,
  enabled: z.boolean(),
  cascade: z.boolean().optional(),
});
const listPayload = z.object({
  requestId: z.string(),
  plugins: z.array(BuiltinPluginWireListItemSchema),
  bundledPlugins: z.array(BuiltinPluginWireListItemSchema).optional(),
  canManage: z.boolean().optional(),
});
export const BuiltinPluginListResponseSchema = z.object({
  type: z.literal("plugins.builtin.list.response"),
  payload: listPayload,
});
export const BuiltinPluginSetResponseSchema = z.object({
  type: z.literal("plugins.builtin.set.response"),
  payload: listPayload,
});
export const BuiltinPluginChangedSchema = z.object({
  type: z.literal("plugins.builtin.changed"),
  payload: z.object({
    plugins: z.array(BuiltinPluginWireListItemSchema),
    bundledPlugins: z.array(BuiltinPluginWireListItemSchema).optional(),
  }),
});

/** Returns the whole dependency closure, excluding the requested id, in registry order. */
export function builtinPluginCascade(
  plugins: readonly Pick<BuiltinPluginListItem, "id" | "enabled" | "requires">[],
  id: BuiltinPluginId,
  enabled: boolean,
): BuiltinPluginId[] {
  const affected = new Set<BuiltinPluginId>([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const plugin of plugins) {
      if (enabled && affected.has(plugin.id)) {
        const missing = plugin.requires.filter(
          (required) =>
            !plugins.find((entry) => entry.id === required)?.enabled && !affected.has(required),
        );
        for (const required of missing) affected.add(required);
        if (missing.length) changed = true;
      } else if (
        !enabled &&
        plugin.enabled &&
        plugin.requires.some((required) => affected.has(required)) &&
        !affected.has(plugin.id)
      ) {
        affected.add(plugin.id);
        changed = true;
      }
    }
  }
  return plugins
    .filter((plugin) => plugin.id !== id && affected.has(plugin.id))
    .map((plugin) => plugin.id);
}

// COMPAT(bundledPluginList): added in v0.9.59; remove after 2027-05-24 once clients accept bundled ids.
// The original list used an enum. Keep its entries parseable by those clients; the app merges the
// optional extension into the same Settings list.
export function builtinPluginWireState(entries: BuiltinPluginListItem[]) {
  const staticIds: ReadonlySet<string> = new Set(STATIC_BUILTIN_PLUGIN_IDS);
  return {
    plugins: entries.filter((entry) => staticIds.has(entry.id)),
    bundledPlugins: entries.filter((entry) => !staticIds.has(entry.id)),
  };
}
export function mergeBuiltinPluginWireState(state: {
  plugins: BuiltinPluginWireListItem[];
  bundledPlugins?: BuiltinPluginWireListItem[];
}): BuiltinPluginListItem[] {
  return [...state.plugins, ...(state.bundledPlugins ?? [])].filter(
    (entry): entry is BuiltinPluginListItem => !REMOVED_BUILTIN_PLUGIN_IDS.has(entry.id),
  );
}
