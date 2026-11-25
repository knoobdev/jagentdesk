import { z } from "zod";
import type {
  BuiltinToolContext,
  JAgentDeskToolExecutionContext,
  RegisterBuiltinTool,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";

// Kubectl tools are core cluster functionality and must be available to every agent (the k8s chat
// agent relies on them). The catalog installs them before its voice-only early return.
export function registerKubectlTools(
  registerTool: RegisterBuiltinTool,
  context: BuiltinToolContext,
): void {
  registerTool(
    "kubectl_get",
    {
      title: "Kubectl get",
      description: "Read Kubernetes resources from a connected cluster. Auto-approved (read-only).",
      inputSchema: {
        clusterId: z.string().min(1),
        action: z.enum(["get", "list", "describe", "logs"]),
        kind: z.string().optional(),
        namespace: z.string().optional(),
        name: z.string().optional(),
      },
    },
    async (input: {
      clusterId: string;
      action: "get" | "list" | "describe" | "logs";
      kind?: string;
      namespace?: string;
      name?: string;
    }) => {
      const client = context.clusters?.getClient(input.clusterId);
      if (!client) {
        return {
          content: [
            { type: "text", text: `Cluster not found or not connected: ${input.clusterId}` },
          ],
          isError: true,
        };
      }
      let text: string;
      try {
        switch (input.action) {
          case "list": {
            if (!input.kind) throw new Error("kind is required for list action");
            const items = await client.listGeneric(input.kind, input.namespace);
            // Return a COMPACT summary, not the full objects — a namespace of pods
            // serializes to hundreds of KB (managedFields, full spec/status) and
            // blows past the MCP result size limit. Use action=get/describe for the
            // full manifest of a single resource.
            const summary = items.map((raw) => {
              const md = (raw.metadata as Record<string, unknown> | undefined) ?? {};
              const status = (raw.status as Record<string, unknown> | undefined) ?? {};
              const cs = (status.containerStatuses as Array<{ ready?: boolean }> | undefined) ?? [];
              const ready = cs.length
                ? `${cs.filter((c) => c.ready).length}/${cs.length}`
                : undefined;
              return {
                name: md.name,
                namespace: md.namespace,
                status: status.phase ?? undefined,
                ready,
                replicas: status.readyReplicas ?? status.availableReplicas ?? undefined,
                created: md.creationTimestamp,
              };
            });
            text = JSON.stringify(
              {
                kind: input.kind,
                namespace: input.namespace ?? "all",
                count: items.length,
                items: summary,
              },
              null,
              2,
            );
            break;
          }
          case "logs": {
            if (!input.namespace || !input.name)
              throw new Error("namespace and name are required for logs action");
            text = await client.getPodLogs(input.namespace, input.name);
            break;
          }
          case "get":
          case "describe": {
            if (!input.kind || !input.name)
              throw new Error("kind and name are required for get/describe action");
            text = await client.getGeneric(input.kind, input.namespace, input.name);
            break;
          }
          default:
            throw new Error(`Unknown action: ${input.action}`);
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text }] };
    },
  );

  registerTool(
    "kubectl_apply",
    {
      title: "Kubectl apply",
      description:
        "Write (apply/delete/scale/restart) Kubernetes resources. Requires user approval via permission card.",
      inputSchema: {
        clusterId: z.string().min(1),
        action: z.enum(["apply", "delete", "scale", "restart"]),
        manifestYaml: z.string().optional(),
        kind: z.string().optional(),
        namespace: z.string().optional(),
        name: z.string().optional(),
        replicas: z.number().optional(),
      },
    },
    async (
      input: {
        clusterId: string;
        action: "apply" | "delete" | "scale" | "restart";
        manifestYaml?: string;
        kind?: string;
        namespace?: string;
        name?: string;
        replicas?: number;
      },
      _context: JAgentDeskToolExecutionContext,
    ) => {
      if (!context.callerAgentId) {
        return {
          content: [
            { type: "text", text: "kubectl_apply is only available to agent-scoped tool sessions" },
          ],
          isError: true,
        };
      }
      const client = context.clusters?.getClient(input.clusterId);
      if (!client) {
        return {
          content: [
            { type: "text", text: `Cluster not found or not connected: ${input.clusterId}` },
          ],
          isError: true,
        };
      }
      const description =
        input.manifestYaml ?? `${input.action} ${input.kind ?? "?"}/${input.name ?? "?"}`;
      const decision = await context.requestHostToolPermission!(context.callerAgentId, {
        name: "kubectl_apply",
        kind: "tool",
        title: `${input.action} on ${input.clusterId}`,
        description,
        input: input as unknown as Record<string, unknown>,
      });
      if (decision.behavior !== "allow") {
        return { content: [{ type: "text", text: "Denied by user." }], isError: true };
      }
      try {
        const result = await client.applyWrite({
          kind: input.kind ?? "",
          namespace: input.namespace,
          name: input.name ?? "",
          action: input.action,
          replicas: input.replicas,
          manifestYaml: input.manifestYaml,
          dryRun: false,
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    },
  );

  // Lets ANY agent (a workspace/project agent, not just the k8s chat) discover
  // the clusters connected in the app and their clusterId, so it can then drive
  // them with kubectl_get/kubectl_apply — the bridge between workspace agents and
  // the Kubernetes feature.
  registerTool(
    "cluster_list",
    {
      title: "List Kubernetes clusters",
      description:
        "List the Kubernetes clusters connected in the app (clusterId, name, state, node/pod counts). Pass a returned clusterId to kubectl_get/kubectl_apply. Auto-approved (read-only).",
      inputSchema: {},
    },
    async () => {
      const clusters = context.clusters?.list() ?? [];
      const summary = clusters.map((c) => ({
        clusterId: c.id,
        name: c.displayName ?? c.contextName,
        context: c.contextName,
        state: c.state,
        nodes: c.nodeCount,
        pods: c.podCount,
      }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: summary.length, clusters: summary }, null, 2),
          },
        ],
      };
    },
  );
}
