import { z } from "zod";
import type {
  ArgoCdAppDetail,
  ArgoCdAppRef,
  ArgoCdSyncRequestOptions,
  ArgoCdTreeNode,
} from "@jagentdesk/protocol/argocd/rpc-schemas";
import type { AgentPermissionResponse } from "../agent/agent-sdk-types.js";
import type { JAgentDeskToolDefinition, JAgentDeskToolResult } from "../agent/tools/types.js";
import { ArgoCdError, toArgoCdError } from "./errors.js";
import { buildSyncBody, previewSync, type ArgoCdService } from "./service.js";

// The `argocd_*` agent tools (spec 30.4). Reads run without asking; every state change raises
// the permission card (04.21) first and sends nothing to Argo CD unless the user allows it.
// Deleting an application has no tool.

const RESULT_MAX_BYTES = 48 * 1024;
const LOG_LINES_DEFAULT = 200;
const LOG_LINES_MAX = 2000;
const TREE_NODES_MAX = 300;
const HISTORY_MAX = 10;

export interface ArgoCdToolPermissionRequest {
  name: string;
  kind: "tool";
  title: string;
  description: string;
  input: Record<string, unknown>;
}

export type RequestArgoCdToolPermission = (
  agentId: string,
  request: ArgoCdToolPermissionRequest,
) => Promise<AgentPermissionResponse>;

export interface ArgoCdAgentToolDependencies {
  service: ArgoCdService;
  /** The agent using this catalog; permission cards are raised on its behalf. */
  callerAgentId: string | null;
  /** The instance an Argo CD chat is bound to (its `ARGOCD_INSTANCE_AGENT_LABEL`), else null. */
  defaultInstanceId: string | null;
  requestPermission: RequestArgoCdToolPermission;
}

/** `auto` runs at once; `ask` raises the card; `ask_when_hard` asks only for a hard refresh. */
export type ArgoCdToolPermission = "auto" | "ask" | "ask_when_hard";

export interface ArgoCdAgentTool extends JAgentDeskToolDefinition {
  permission: ArgoCdToolPermission;
}

function jsonResult(value: unknown): JAgentDeskToolResult {
  let text = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text) > RESULT_MAX_BYTES) {
    text = `${Buffer.from(text).subarray(0, RESULT_MAX_BYTES).toString("utf8")}\n… (truncated)`;
  }
  return { content: [{ type: "text", text }] };
}

function errorResult(message: string): JAgentDeskToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

const instanceField = {
  instanceId: z
    .string()
    .optional()
    .describe("Argo CD instance (`acd_…`). Defaults to the instance this chat is bound to."),
};
const appFields = {
  ...instanceField,
  app: z.string().min(1).describe("Application name"),
  appNamespace: z.string().optional().describe("Application namespace (apps in any namespace)"),
};
const resourceFields = {
  group: z.string().describe("API group, empty for core"),
  version: z.string().describe("API version, e.g. v1"),
  kind: z.string(),
  namespace: z.string(),
  name: z.string(),
};

interface AppInput {
  instanceId?: string;
  app: string;
  appNamespace?: string;
}

function appRef(input: AppInput): ArgoCdAppRef {
  return { name: input.app, appNamespace: input.appNamespace ?? null };
}

function resolveInstance(deps: ArgoCdAgentToolDependencies, requested: string | undefined): string {
  const instanceId = requested ?? deps.defaultInstanceId;
  if (!instanceId) {
    throw new ArgoCdError(
      "invalid_input",
      "instanceId is required: this chat is not bound to an Argo CD instance. Call argocd_list_instances.",
    );
  }
  return instanceId;
}

function appSummaryForAgent(app: ArgoCdAppDetail) {
  return {
    name: app.name,
    appNamespace: app.appNamespace,
    project: app.project,
    health: app.health,
    sync: app.sync,
    revision: app.syncRevision,
    sources: app.sources,
    destination: { server: app.destServer, name: app.destName, namespace: app.destNamespace },
    autoSync: app.autoSync ? { prune: app.autoSyncPrune, selfHeal: app.autoSyncSelfHeal } : false,
    syncOptions: app.syncOptions,
    conditions: app.conditions.map((condition) => `${condition.type}: ${condition.message}`),
    operation: app.operationState
      ? {
          phase: app.operationState.phase,
          message: app.operationState.message,
          startedAt: app.operationState.startedAt_ms,
          finishedAt: app.operationState.finishedAt_ms,
          failedResources: app.operationState.resources.filter(
            (resource) => resource.status !== "Synced" && resource.status !== "Pruned",
          ),
        }
      : null,
    unhealthyResources: app.resources
      .filter((resource) => resource.health && resource.health.status !== "Healthy")
      .map((resource) => ({
        kind: resource.kind,
        namespace: resource.namespace,
        name: resource.name,
        health: resource.health,
        sync: resource.sync,
      })),
    outOfSyncResources: app.resources
      .filter((resource) => resource.sync !== "Synced")
      .map((resource) => `${resource.kind}/${resource.namespace}/${resource.name}`),
    images: app.images,
    lastCommit: app.revisionMetadata,
  };
}

// Default: only nodes that are not Healthy, plus their ancestors (reference §4.2).
function compactTree(nodes: ArgoCdTreeNode[], all: boolean) {
  let kept = nodes;
  if (!all) {
    const byUid = new Map(nodes.map((node) => [node.uid, node]));
    const keep = new Set<string>();
    for (const node of nodes) {
      if (!node.health || node.health.status === "Healthy") continue;
      const stack = [node];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (keep.has(current.uid)) continue;
        keep.add(current.uid);
        const parents = current.parentRefs.map((parent) => byUid.get(parent.uid ?? ""));
        stack.push(...parents.filter((parent): parent is ArgoCdTreeNode => parent !== undefined));
      }
    }
    kept = nodes.filter((node) => keep.has(node.uid));
  }
  return kept.slice(0, TREE_NODES_MAX).map((node) => ({
    kind: node.kind,
    group: node.group,
    version: node.version,
    namespace: node.namespace,
    name: node.name,
    uid: node.uid,
    health: node.health,
    parents: node.parentRefs.map((parent) => `${parent.kind}/${parent.name}`),
    info: node.info.map((info) => `${info.name}: ${info.value}`),
    images: node.images,
  }));
}

function syncCard(
  app: ArgoCdAppDetail,
  options: ArgoCdSyncRequestOptions,
  body: Record<string, unknown>,
): ArgoCdToolPermissionRequest {
  const cluster = app.destName ?? app.destServer ?? "?";
  const preview = previewSync(app, options);
  const flags = [
    options.prune ? "PRUNE: resources missing from Git will be DELETED" : "prune: off",
    `force: ${options.force ? "on" : "off"}`,
    `dryRun: ${options.dryRun ? "on" : "off"}`,
    ...(options.applyOnly ? ["apply only (no hooks)"] : []),
  ];
  const selected =
    options.resources && options.resources.length > 0
      ? options.resources.map(
          (resource) => `${resource.kind}/${resource.namespace}/${resource.name}`,
        )
      : ["all resources"];
  const description = [
    `Revision: ${options.revision ?? app.sources[0]?.targetRevision ?? "HEAD"}`,
    ...flags,
    ...(options.syncOptions.length > 0 ? [`Sync options: ${options.syncOptions.join(", ")}`] : []),
    `Resources: ${selected.join(", ")}`,
    `Diff: ${preview.toChange} to change, ${preview.toPrune} to prune`,
    ...preview.resources.slice(0, 20).map((resource) => `  • ${resource}`),
  ].join("\n");
  return {
    name: "argocd_sync",
    kind: "tool",
    title: `Sync ${app.project}/${app.name} → ${cluster}/${app.destNamespace ?? ""}`,
    description,
    input: body,
  };
}

export function createArgoCdAgentTools(deps: ArgoCdAgentToolDependencies): ArgoCdAgentTool[] {
  const { service } = deps;

  async function ask(request: ArgoCdToolPermissionRequest): Promise<boolean> {
    if (!deps.callerAgentId) {
      throw new ArgoCdError("invalid_input", `${request.name} needs an agent-scoped tool session.`);
    }
    const decision = await deps.requestPermission(deps.callerAgentId, request);
    return decision.behavior === "allow";
  }

  function tool<T>(
    definition: {
      name: string;
      title: string;
      description: string;
      permission: ArgoCdToolPermission;
      inputSchema: z.ZodRawShape;
    },
    run: (input: T) => Promise<JAgentDeskToolResult>,
  ): ArgoCdAgentTool {
    return {
      ...definition,
      handler: async (input) => {
        try {
          return await run(input as T);
        } catch (error) {
          const failure = toArgoCdError(error);
          return errorResult(`${failure.code}: ${failure.message}`);
        }
      },
    };
  }

  const denied = errorResult("Denied by user.");

  return [
    tool<Record<string, never>>(
      {
        name: "argocd_list_instances",
        title: "List Argo CD instances",
        description:
          "List the Argo CD instances added in JAgentDesk (instanceId, URL, user, sign-in state). Auto-approved (read-only).",
        permission: "auto",
        inputSchema: {},
      },
      async () =>
        jsonResult(
          service.listInstances().map((instance) => ({
            instanceId: instance.id,
            name: instance.displayName,
            url: instance.url,
            user: instance.username,
            state: instance.state,
            serverVersion: instance.serverVersion,
          })),
        ),
    ),
    tool<{
      instanceId?: string;
      project?: string;
      health?: string;
      sync?: string;
      namespace?: string;
      cluster?: string;
      repo?: string;
      label?: string;
    }>(
      {
        name: "argocd_list_apps",
        title: "List Argo CD applications",
        description:
          "List applications with health, sync, revision, destination and operation phase. Filters are optional. Auto-approved (read-only).",
        permission: "auto",
        inputSchema: {
          ...instanceField,
          project: z.string().optional(),
          health: z
            .string()
            .optional()
            .describe("Healthy, Progressing, Degraded, Suspended, Missing, Unknown"),
          sync: z.string().optional().describe("Synced, OutOfSync, Unknown"),
          namespace: z.string().optional().describe("Destination namespace"),
          cluster: z.string().optional().describe("Destination server URL or name"),
          repo: z.string().optional(),
          label: z.string().optional().describe("key=value"),
        },
      },
      async (input) => {
        const instanceId = resolveInstance(deps, input.instanceId);
        const [labelKey, labelValue] = (input.label ?? "").split("=");
        const apps = (await service.listApps(instanceId)).filter(
          (app) =>
            (!input.project || app.project === input.project) &&
            (!input.health || app.health === input.health) &&
            (!input.sync || app.sync === input.sync) &&
            (!input.namespace || app.destNamespace === input.namespace) &&
            (!input.cluster ||
              app.destServer === input.cluster ||
              app.destName === input.cluster) &&
            (!input.repo || app.sources.some((source) => source.repoURL.includes(input.repo!))) &&
            (!labelKey || app.labels[labelKey] === labelValue),
        );
        return jsonResult({
          instanceId,
          count: apps.length,
          apps: apps.map((app) => ({
            name: app.name,
            appNamespace: app.appNamespace,
            project: app.project,
            health: app.health,
            sync: app.sync,
            revision: app.syncRevision,
            destination: `${app.destName ?? app.destServer ?? "?"}/${app.destNamespace ?? ""}`,
            autoSync: app.autoSync,
            operationPhase: app.operationPhase,
          })),
        });
      },
    ),
    tool<AppInput>(
      {
        name: "argocd_get_app",
        title: "Get an Argo CD application",
        description:
          "Sources, sync policy, conditions, last operation (with failed resources), unhealthy and out-of-sync resources. Auto-approved (read-only).",
        permission: "auto",
        inputSchema: appFields,
      },
      async (input) => {
        const instanceId = resolveInstance(deps, input.instanceId);
        const app = await service.getApp(instanceId, appRef(input));
        return jsonResult({
          ...appSummaryForAgent(app),
          jagentdeskClusterId: await service.linkedClusterId(instanceId, app),
        });
      },
    ),
    tool<AppInput & { all?: boolean }>(
      {
        name: "argocd_resource_tree",
        title: "Argo CD resource tree",
        description:
          "Resource tree of an application. By default only nodes that are not Healthy plus their parents; all=true returns every node (capped). Auto-approved (read-only).",
        permission: "auto",
        inputSchema: { ...appFields, all: z.boolean().optional() },
      },
      async (input) => {
        const instanceId = resolveInstance(deps, input.instanceId);
        const tree = await service.tree(instanceId, appRef(input));
        const nodes = compactTree(tree.nodes, input.all === true);
        return jsonResult({ total: tree.nodes.length, returned: nodes.length, nodes });
      },
    ),
    tool<AppInput>(
      {
        name: "argocd_diff",
        title: "Argo CD diff",
        description:
          "Unified diff (live vs desired, YAML) of every modified resource of an application. Auto-approved (read-only).",
        permission: "auto",
        inputSchema: appFields,
      },
      async (input) => {
        const instanceId = resolveInstance(deps, input.instanceId);
        const items = (await service.diff(instanceId, appRef(input))).filter(
          (item) => item.modified,
        );
        return {
          content: [
            {
              type: "text",
              text:
                items.length === 0
                  ? "No differences: every managed resource matches Git."
                  : items
                      .map((item) => item.diff)
                      .join("\n")
                      .slice(0, RESULT_MAX_BYTES),
            },
          ],
        };
      },
    ),
    tool<AppInput & { revision?: string; resource?: z.infer<z.ZodObject<typeof resourceFields>> }>(
      {
        name: "argocd_manifests",
        title: "Argo CD manifests",
        description:
          "Desired manifests at a revision (default: the target), or the live manifest of one resource when `resource` is given. Auto-approved (read-only).",
        permission: "auto",
        inputSchema: {
          ...appFields,
          revision: z.string().optional(),
          resource: z.object(resourceFields).optional(),
        },
      },
      async (input) => {
        const instanceId = resolveInstance(deps, input.instanceId);
        const manifests = await service.manifests(instanceId, appRef(input), {
          revision: input.revision,
          resource: input.resource,
        });
        return {
          content: [{ type: "text", text: manifests.join("---\n").slice(0, RESULT_MAX_BYTES) }],
        };
      },
    ),
    tool<AppInput & { resourceName?: string; resourceNamespace?: string; resourceUid?: string }>(
      {
        name: "argocd_events",
        title: "Argo CD events",
        description:
          "Kubernetes events of an application, or of one resource when resourceName + resourceNamespace + resourceUid are given (uid from argocd_resource_tree). Auto-approved (read-only).",
        permission: "auto",
        inputSchema: {
          ...appFields,
          resourceName: z.string().optional(),
          resourceNamespace: z.string().optional(),
          resourceUid: z.string().optional(),
        },
      },
      async (input) => {
        const instanceId = resolveInstance(deps, input.instanceId);
        const resource =
          input.resourceName && input.resourceUid
            ? {
                group: "",
                kind: "",
                name: input.resourceName,
                namespace: input.resourceNamespace ?? "",
                uid: input.resourceUid,
              }
            : undefined;
        const events = await service.events(instanceId, appRef(input), resource);
        return jsonResult(
          events.slice(0, 100).map((event) => ({
            type: event.type,
            reason: event.reason,
            object: `${event.objectKind}/${event.objectName}`,
            message: event.message,
            count: event.count,
            last: event.lastTimestamp_ms,
          })),
        );
      },
    ),
    tool<
      AppInput & {
        podName?: string;
        namespace: string;
        container?: string;
        tailLines?: number;
        previous?: boolean;
        filter?: string;
        kind?: string;
        group?: string;
        resourceName?: string;
      }
    >(
      {
        name: "argocd_logs",
        title: "Argo CD logs",
        description:
          "Recent logs (no follow) of one pod (podName) or of every pod of a resource (kind + resourceName, e.g. a Deployment). Auto-approved (read-only).",
        permission: "auto",
        inputSchema: {
          ...appFields,
          namespace: z.string(),
          podName: z.string().optional(),
          kind: z.string().optional(),
          group: z.string().optional(),
          resourceName: z.string().optional(),
          container: z.string().optional(),
          tailLines: z.number().int().positive().max(LOG_LINES_MAX).optional(),
          previous: z.boolean().optional(),
          filter: z.string().optional(),
        },
      },
      async (input) => {
        const instanceId = resolveInstance(deps, input.instanceId);
        if (!input.podName && !(input.kind && input.resourceName)) {
          throw new ArgoCdError("invalid_input", "Pass podName, or kind + resourceName.");
        }
        const chunk = await service.readLogs(instanceId, appRef(input), {
          podName: input.podName,
          resource:
            input.kind && input.resourceName
              ? { kind: input.kind, group: input.group ?? "", name: input.resourceName }
              : undefined,
          namespace: input.namespace,
          container: input.container,
          tailLines: Math.min(input.tailLines ?? LOG_LINES_DEFAULT, LOG_LINES_MAX),
          follow: false,
          filter: input.filter,
          previous: input.previous ?? false,
        });
        const text = chunk.entries
          .map((entry) => (input.podName ? entry.content : `[${entry.podName}] ${entry.content}`))
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: (text || "(no log lines)") + (chunk.error ? `\n(error: ${chunk.error})` : ""),
            },
          ],
        };
      },
    ),
    tool<AppInput>(
      {
        name: "argocd_history",
        title: "Argo CD deploy history",
        description:
          "Deploy history (id for argocd_rollback, revision, deployedAt, author, message). Auto-approved (read-only).",
        permission: "auto",
        inputSchema: appFields,
      },
      async (input) => {
        const instanceId = resolveInstance(deps, input.instanceId);
        const ref = appRef(input);
        const app = await service.getApp(instanceId, ref);
        const entries = await Promise.all(
          app.history.slice(0, HISTORY_MAX).map(async (entry) => {
            const metadata = entry.revision
              ? await service.revisionMetadata(instanceId, ref, entry.revision)
              : null;
            return {
              id: entry.id,
              revision: entry.revision ?? entry.revisions.join(","),
              deployedAt_ms: entry.deployedAt_ms,
              initiatedBy: entry.initiatedBy,
              author: metadata?.author ?? null,
              message: metadata?.message ?? null,
            };
          }),
        );
        return jsonResult({ autoSync: app.autoSync, history: entries });
      },
    ),
    tool<AppInput & z.infer<z.ZodObject<typeof resourceFields>>>(
      {
        name: "argocd_list_resource_actions",
        title: "Argo CD resource actions",
        description:
          "Actions available on a resource (restart, scale, suspend…). Auto-approved (read-only).",
        permission: "auto",
        inputSchema: { ...appFields, ...resourceFields },
      },
      async (input) => {
        const instanceId = resolveInstance(deps, input.instanceId);
        return jsonResult(
          await service.resourceActions(instanceId, appRef(input), {
            group: input.group,
            version: input.version,
            kind: input.kind,
            namespace: input.namespace,
            name: input.name,
          }),
        );
      },
    ),
    tool<{ instanceId?: string; resource: string; action: string; subresource: string }>(
      {
        name: "argocd_can_i",
        title: "Argo CD can-i",
        description:
          "Check an RBAC permission of the signed-in user, e.g. resource=applications action=sync subresource=<project>/<app>. Auto-approved (read-only).",
        permission: "auto",
        inputSchema: {
          ...instanceField,
          resource: z.string(),
          action: z.string(),
          subresource: z.string(),
        },
      },
      async (input) => {
        const instanceId = resolveInstance(deps, input.instanceId);
        const allowed = await service.canI(instanceId, input);
        return jsonResult({ allowed });
      },
    ),
    tool<{ instanceId?: string }>(
      {
        name: "argocd_list_projects",
        title: "Argo CD projects",
        description: "AppProjects with source repos and destinations. Auto-approved (read-only).",
        permission: "auto",
        inputSchema: instanceField,
      },
      async (input) =>
        jsonResult(await service.listProjects(resolveInstance(deps, input.instanceId))),
    ),
    tool<{ instanceId?: string }>(
      {
        name: "argocd_list_appsets",
        title: "Argo CD ApplicationSets",
        description:
          "ApplicationSets with generator types and conditions. Auto-approved (read-only).",
        permission: "auto",
        inputSchema: instanceField,
      },
      async (input) =>
        jsonResult(await service.listAppSets(resolveInstance(deps, input.instanceId))),
    ),
    tool<{ instanceId?: string }>(
      {
        name: "argocd_list_clusters",
        title: "Argo CD clusters",
        description:
          "Destination clusters with connection state. No credentials. Auto-approved (read-only).",
        permission: "auto",
        inputSchema: instanceField,
      },
      async (input) =>
        jsonResult(await service.listClusters(resolveInstance(deps, input.instanceId))),
    ),
    tool<{ instanceId?: string }>(
      {
        name: "argocd_list_repos",
        title: "Argo CD repositories",
        description:
          "Repositories with connection state. No credentials. Auto-approved (read-only).",
        permission: "auto",
        inputSchema: instanceField,
      },
      async (input) => jsonResult(await service.listRepos(resolveInstance(deps, input.instanceId))),
    ),
    tool<AppInput & { hard?: boolean }>(
      {
        name: "argocd_refresh",
        title: "Argo CD refresh",
        description:
          "Re-read Git and compare. Normal refresh is auto-approved; hard=true (drops the manifest cache) needs the user's approval.",
        permission: "ask_when_hard",
        inputSchema: { ...appFields, hard: z.boolean().optional() },
      },
      async (input) => {
        const instanceId = resolveInstance(deps, input.instanceId);
        if (input.hard) {
          const allowed = await ask({
            name: "argocd_refresh",
            kind: "tool",
            title: `Hard refresh ${input.app}`,
            description:
              "Drops Argo CD's manifest cache for this app and regenerates manifests from Git.",
            input: {
              instanceId,
              app: input.app,
              appNamespace: input.appNamespace ?? null,
              refresh: "hard",
            },
          });
          if (!allowed) return denied;
        }
        const app = await service.refresh(instanceId, appRef(input), input.hard === true);
        return jsonResult({ health: app.health, sync: app.sync, revision: app.syncRevision });
      },
    ),
    tool<
      AppInput & {
        revision?: string;
        prune?: boolean;
        dryRun?: boolean;
        force?: boolean;
        applyOnly?: boolean;
        resources?: Array<{ group: string; kind: string; namespace: string; name: string }>;
        syncOptions?: string[];
      }
    >(
      {
        name: "argocd_sync",
        title: "Argo CD sync",
        description:
          "Sync an application (optionally a revision, prune, dryRun, force, apply-only, selected resources, sync options like ApplyOutOfSyncOnly=true). Always needs the user's approval, dryRun included.",
        permission: "ask",
        inputSchema: {
          ...appFields,
          revision: z.string().optional(),
          prune: z.boolean().optional(),
          dryRun: z.boolean().optional(),
          force: z.boolean().optional(),
          applyOnly: z.boolean().optional(),
          resources: z
            .array(
              z.object({
                group: z.string(),
                kind: z.string(),
                namespace: z.string(),
                name: z.string(),
              }),
            )
            .optional(),
          syncOptions: z.array(z.string()).optional(),
        },
      },
      async (input) => {
        const instanceId = resolveInstance(deps, input.instanceId);
        const ref = appRef(input);
        const app = await service.getApp(instanceId, ref);
        const options: ArgoCdSyncRequestOptions = {
          revision: input.revision,
          prune: input.prune ?? false,
          dryRun: input.dryRun ?? false,
          force: input.force ?? false,
          applyOnly: input.applyOnly ?? false,
          resources: input.resources,
          syncOptions: input.syncOptions ?? [],
        };
        const body = buildSyncBody(ref, app.project, options);
        if (!(await ask(syncCard(app, options, body)))) return denied;
        const synced = await service.sync(instanceId, ref, options);
        return jsonResult({
          started: true,
          operationPhase: synced.operationState?.phase ?? null,
          sync: synced.sync,
          health: synced.health,
        });
      },
    ),
    tool<AppInput & { id: number; prune?: boolean; dryRun?: boolean }>(
      {
        name: "argocd_rollback",
        title: "Argo CD rollback",
        description:
          "Roll back to a history id from argocd_history. Fails without asking when auto-sync is on. Needs the user's approval.",
        permission: "ask",
        inputSchema: {
          ...appFields,
          id: z.number().int(),
          prune: z.boolean().optional(),
          dryRun: z.boolean().optional(),
        },
      },
      async (input) => {
        const instanceId = resolveInstance(deps, input.instanceId);
        const ref = appRef(input);
        const app = await service.getApp(instanceId, ref);
        if (app.autoSync) {
          throw new ArgoCdError(
            "rollback_auto_sync",
            `Rollback is not possible while auto-sync is on for ${app.name}. Ask the user to turn off auto-sync first.`,
          );
        }
        const target = app.history.find((entry) => entry.id === input.id);
        if (!target) throw new ArgoCdError("not_found", `History id ${input.id} does not exist.`);
        const allowed = await ask({
          name: "argocd_rollback",
          kind: "tool",
          title: `Roll back ${app.project}/${app.name} to #${input.id}`,
          description: [
            `Target revision: ${target.revision ?? target.revisions.join(", ")}`,
            `Deployed: ${target.deployedAt_ms ? new Date(target.deployedAt_ms).toISOString() : "?"}`,
            `prune: ${input.prune ? "ON — resources not in that revision will be deleted" : "off"}`,
            `dryRun: ${input.dryRun ? "on" : "off"}`,
          ].join("\n"),
          input: {
            instanceId,
            app: app.name,
            appNamespace: app.appNamespace,
            id: input.id,
            prune: input.prune ?? false,
            dryRun: input.dryRun ?? false,
          },
        });
        if (!allowed) return denied;
        const rolled = await service.rollback(instanceId, ref, {
          historyId: input.id,
          prune: input.prune ?? false,
          dryRun: input.dryRun ?? false,
        });
        return jsonResult({ started: true, operationPhase: rolled.operationState?.phase ?? null });
      },
    ),
    tool<AppInput>(
      {
        name: "argocd_terminate_operation",
        title: "Argo CD terminate operation",
        description:
          "Terminate the running sync operation of an application. Needs the user's approval.",
        permission: "ask",
        inputSchema: appFields,
      },
      async (input) => {
        const instanceId = resolveInstance(deps, input.instanceId);
        const allowed = await ask({
          name: "argocd_terminate_operation",
          kind: "tool",
          title: `Terminate the operation on ${input.app}`,
          description: "Stops the running sync; resources already applied stay applied.",
          input: { instanceId, app: input.app, appNamespace: input.appNamespace ?? null },
        });
        if (!allowed) return denied;
        await service.terminate(instanceId, appRef(input));
        return jsonResult({ terminated: true });
      },
    ),
    tool<
      AppInput &
        z.infer<z.ZodObject<typeof resourceFields>> & {
          action: string;
          params?: Array<{ name: string; value: string }>;
        }
    >(
      {
        name: "argocd_resource_action",
        title: "Argo CD resource action",
        description:
          "Run a resource action listed by argocd_list_resource_actions (restart, scale with params…). Needs the user's approval.",
        permission: "ask",
        inputSchema: {
          ...appFields,
          ...resourceFields,
          action: z.string().min(1),
          params: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
        },
      },
      async (input) => {
        const instanceId = resolveInstance(deps, input.instanceId);
        const resource = {
          group: input.group,
          version: input.version,
          kind: input.kind,
          namespace: input.namespace,
          name: input.name,
        };
        const params = input.params ?? [];
        const allowed = await ask({
          name: "argocd_resource_action",
          kind: "tool",
          title: `${input.action} ${input.kind}/${input.namespace}/${input.name}`,
          description: [
            `App: ${input.app}`,
            `Resource: ${input.group || "core"}/${input.kind} ${input.namespace}/${input.name}`,
            ...(params.length > 0
              ? [`Params: ${params.map((param) => `${param.name}=${param.value}`).join(", ")}`]
              : []),
          ].join("\n"),
          input: {
            instanceId,
            app: input.app,
            appNamespace: input.appNamespace ?? null,
            resource,
            action: input.action,
            params,
          },
        });
        if (!allowed) return denied;
        await service.runResourceAction(instanceId, appRef(input), {
          resource,
          action: input.action,
          params,
        });
        return jsonResult({ done: true });
      },
    ),
    tool<
      AppInput & z.infer<z.ZodObject<typeof resourceFields>> & { force?: boolean; orphan?: boolean }
    >(
      {
        name: "argocd_delete_resource",
        title: "Argo CD delete resource",
        description:
          "Delete one live resource of an application (not the application). Needs the user's approval.",
        permission: "ask",
        inputSchema: {
          ...appFields,
          ...resourceFields,
          force: z.boolean().optional(),
          orphan: z.boolean().optional(),
        },
      },
      async (input) => {
        const instanceId = resolveInstance(deps, input.instanceId);
        const resource = {
          group: input.group,
          version: input.version,
          kind: input.kind,
          namespace: input.namespace,
          name: input.name,
        };
        const allowed = await ask({
          name: "argocd_delete_resource",
          kind: "tool",
          title: `Delete ${input.kind}/${input.namespace}/${input.name}`,
          description: [
            `App: ${input.app}`,
            `force: ${input.force ? "on" : "off"}`,
            `orphan: ${input.orphan ? "on (dependents kept)" : "off"}`,
          ].join("\n"),
          input: {
            instanceId,
            app: input.app,
            appNamespace: input.appNamespace ?? null,
            resource,
            force: input.force ?? false,
            orphan: input.orphan ?? false,
          },
        });
        if (!allowed) return denied;
        await service.deleteResource(instanceId, appRef(input), {
          resource,
          force: input.force ?? false,
          orphan: input.orphan ?? false,
        });
        return jsonResult({ deleted: true });
      },
    ),
  ];
}
