import { z } from "zod";
import type { HostCapabilityId } from "./host-capabilities.js";

export const STATIC_BUILTIN_PLUGIN_IDS = [
  "docker",
  "clusters",
  "databases",
  "ssh-servers",
  "remote-tasks",
  "custom-providers",
  "figma",
  "jira",
  "argocd",
  "devices",
  "workbench",
  "forge-hub",
  "skills",
  "spec-mode",
  "autorun",
  "activity-graph",
  "insights",
  "session-share",
  "browser-tools",
] as const;
export const BUNDLED_PLUGIN_IDS = [
  "worktree-include",
  "muse-provider",
  "antigravity-provider",
  "hoplite-provider",
  "fx-provider",
] as const;
export const BUILTIN_PLUGIN_IDS = [...STATIC_BUILTIN_PLUGIN_IDS, ...BUNDLED_PLUGIN_IDS] as const;
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

// Static manifests are shared by the daemon loader and the statically linked app registry.
export const BUILTIN_PLUGIN_MANIFESTS: readonly BuiltinPluginManifest[] = [
  {
    id: "docker",
    name: "Docker",
    description: "Manage containers, images and Compose projects.",
    defaultEnabled: true,
    requires: [],
  },
  {
    id: "clusters",
    name: "Kubernetes",
    description: "Manage clusters, workloads and Helm releases.",
    defaultEnabled: true,
    requires: [],
  },
  {
    id: "databases",
    name: "Databases",
    description: "Browse databases and run SQL queries.",
    defaultEnabled: true,
    requires: [],
  },
  {
    id: "ssh-servers",
    name: "SSH servers",
    description: "Connect to servers, transfer files and forward ports.",
    defaultEnabled: true,
    requires: [],
  },
  {
    id: "remote-tasks",
    name: "Remote tasks",
    description: "Run and monitor tasks on SSH servers.",
    defaultEnabled: true,
    requires: ["ssh-servers"],
  },
  {
    id: "custom-providers",
    name: "Custom API providers",
    description: "Configure custom model API providers.",
    defaultEnabled: true,
    requires: [],
  },
  {
    id: "figma",
    name: "Figma",
    description: "Inspect designs and work with Figma files.",
    defaultEnabled: true,
    requires: [],
  },
  {
    id: "jira",
    name: "Jira",
    description: "Browse boards and manage Jira issues.",
    defaultEnabled: true,
    requires: [],
  },
  {
    id: "argocd",
    name: "Argo CD",
    description: "Monitor and deploy Kubernetes applications.",
    defaultEnabled: true,
    requires: ["clusters"],
  },
  {
    id: "devices",
    name: "Devices & simulators",
    description: "Control devices and simulators, and sideload apps.",
    defaultEnabled: true,
    requires: [],
    hostCapabilities: [
      "iosSimulators",
      "androidDevices",
      "androidPhysical",
      "iosPhysical",
      "iosSideload",
    ],
  },
  {
    id: "workbench",
    name: "Workbench",
    description: "Capture and inspect device network traffic.",
    defaultEnabled: true,
    requires: ["devices"],
  },
  {
    id: "forge-hub",
    name: "Forge Hub",
    description: "Browse repositories, reviews, issues and pipelines.",
    defaultEnabled: true,
    requires: [],
  },
  {
    id: "skills",
    name: "Skills",
    description: "Create and manage reusable agent skills.",
    defaultEnabled: true,
    requires: [],
  },
  {
    id: "spec-mode",
    name: "Spec mode",
    description: "Plan and implement work from a specification.",
    defaultEnabled: true,
    requires: ["skills"],
  },
  {
    id: "autorun",
    name: "Autonomous run",
    description: "Let agents continue working until stopped.",
    defaultEnabled: false,
    requires: [],
  },
  {
    id: "activity-graph",
    name: "Activity graph",
    description: "Explore an agent’s activity and plan graph.",
    defaultEnabled: true,
    requires: [],
  },
  {
    id: "insights",
    name: "Insights",
    description: "View usage history and costs.",
    defaultEnabled: true,
    requires: [],
  },
  {
    id: "session-share",
    name: "Session sharing",
    description: "Share a scoped agent session with guests.",
    defaultEnabled: false,
    requires: [],
  },
  {
    id: "browser-tools",
    name: "Agentic browser",
    description: "Give agents tools to control the browser.",
    defaultEnabled: false,
    requires: [],
  },
  {
    id: "worktree-include",
    name: "Worktree include",
    description: "Copy ignored local files listed in .worktreeinclude into new worktrees.",
    defaultEnabled: true,
    requires: [],
  },
  {
    id: "muse-provider",
    name: "Muse Code",
    description: "Run Muse Code through its local muse CLI.",
    defaultEnabled: true,
    requires: [],
    command: "muse",
  },
  {
    id: "antigravity-provider",
    name: "Antigravity",
    description: "Run Antigravity through its local agy CLI.",
    defaultEnabled: true,
    requires: [],
    command: "agy",
  },
  {
    id: "hoplite-provider",
    name: "Hoplite",
    description: "Run Hoplite through its local hoplite CLI.",
    defaultEnabled: false,
    requires: [],
    command: "hoplite",
  },
  {
    id: "fx-provider",
    name: "fx",
    description: "Run fx through its local fx CLI.",
    defaultEnabled: false,
    requires: [],
    command: "fx",
  },
];

/** Existing and new server-info flags owned by each feature. Core forge checkout stays independent. */
export const BUILTIN_PLUGIN_FEATURES = {
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
  figma: [
    "figma",
    "figmaPlayback",
    "figmaNodeDepth",
    "figmaPagedOutline",
    "figmaRemoteWrites",
    "figmaCommentRegions",
    "figmaRenderFidelity",
    "figmaTextOutlines",
    "figmaCachedRender",
  ],
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
  "spec-mode": ["specMode"],
  autorun: ["autorun", "autorunApproval"],
  "activity-graph": ["activityGraph"],
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
  plugins: z.array(BuiltinPluginListItemSchema),
  bundledPlugins: z.array(BuiltinPluginListItemSchema).optional(),
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
    plugins: z.array(BuiltinPluginListItemSchema),
    bundledPlugins: z.array(BuiltinPluginListItemSchema).optional(),
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
  plugins: BuiltinPluginListItem[];
  bundledPlugins?: BuiltinPluginListItem[];
}) {
  return [...state.plugins, ...(state.bundledPlugins ?? [])];
}
