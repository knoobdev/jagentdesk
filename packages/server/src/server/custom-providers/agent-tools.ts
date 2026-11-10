// The `provider_*` agent tools of spec 34.7, bound to one caller. Registered like the remote_*
// tools (remote-exec/agent-tools.ts): provider_list / provider_test auto-run, provider_add /
// provider_update / provider_remove raise the permission card (04.21 / ADR-0046 — auto-approved
// in bypass). The API key never appears in a card or a tool output: cards carry `hasApiKey`
// only, and ApiProviderRecord has no key field.
import { z } from "zod";
import type { AgentPermissionResponse } from "../agent/agent-sdk-types.js";
import type {
  JAgentDeskToolConfig,
  JAgentDeskToolDefinition,
  JAgentDeskToolExecutionContext,
  JAgentDeskToolResult,
} from "../agent/tools/types.js";
import {
  CustomProviderError,
  type ApiProtocol,
  type ApiProviderModel,
  type ApiProviderRecord,
  type ApiRoute,
  type CustomProviderService,
  type SaveApiProviderInput,
} from "./types.js";

/** Same request the catalog's `requestHostToolPermission` takes (the permission card, 04.21). */
export interface CustomProviderPermissionRequest {
  name: string;
  kind: "tool";
  title: string;
  description: string;
  input: Record<string, unknown>;
}

export type RequestToolPermission = (
  agentId: string,
  request: CustomProviderPermissionRequest,
) => Promise<AgentPermissionResponse>;

export interface CustomProviderAgentToolDependencies {
  service: CustomProviderService;
  /** The agent using this catalog; permission cards are raised on its behalf. */
  callerAgentId: string | null;
  requestPermission: RequestToolPermission;
  /** Label of a saved SSH server (spec 25), for cards of via:"ssh" providers; null when unknown. */
  sshServerLabel(serverId: string): string | null;
}

export interface CustomProviderAgentTool extends JAgentDeskToolDefinition {
  /** True for tools that change state; their handler raises a permission card first. */
  requiresPermission: boolean;
}

class ToolFailure extends Error {}

function jsonResult(value: unknown): JAgentDeskToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string): JAgentDeskToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function toToolMessage(error: unknown): string {
  if (error instanceof CustomProviderError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

interface PermissionAsk {
  name: string;
  title: string;
  description: string;
  input: Record<string, unknown>;
}

async function requireApproval(deps: CustomProviderAgentToolDependencies, ask: PermissionAsk) {
  if (!deps.callerAgentId) {
    throw new ToolFailure(`${ask.name} is only available to agent-scoped tool sessions.`);
  }
  const decision = await deps.requestPermission(deps.callerAgentId, { kind: "tool", ...ask });
  if (decision.behavior !== "allow") throw new ToolFailure("The user declined");
}

interface ToolSpec<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  requiresPermission: boolean;
  run: (input: z.infer<z.ZodObject<Shape>>) => Promise<JAgentDeskToolResult>;
}

function defineTool<Shape extends z.ZodRawShape>(spec: ToolSpec<Shape>): CustomProviderAgentTool {
  const schema = z.object(spec.inputSchema);
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: spec.inputSchema,
    requiresPermission: spec.requiresPermission,
    async handler(input: unknown) {
      try {
        return await spec.run(schema.parse(input));
      } catch (error) {
        return errorResult(toToolMessage(error));
      }
    },
  };
}

/** Spec 34.2: `via: "ssh"` tunnels through a saved SSH server, so the server id is required. */

/**
 * Route for a save: the caller's via/sshServerId, falling back to the existing record's for an
 * update that does not touch the route. An update that moves off "ssh" drops the server id.
 */
function resolveRoute(
  changes: { via?: "direct" | "tailnet" | "ssh"; sshServerId?: string },
  existing: Pick<ApiProviderRecord, "via" | "sshServerId"> | null,
): { via?: "direct" | "tailnet" | "ssh"; sshServerId?: string } {
  const via = changes.via ?? existing?.via;
  const sshServerId =
    changes.via !== undefined
      ? changes.sshServerId
      : (changes.sshServerId ?? existing?.sshServerId);
  if (via === "ssh" && !sshServerId) {
    throw new ToolFailure('via "ssh" needs sshServerId: the SSH server to tunnel through.');
  }
  if (via !== "ssh" && sshServerId !== undefined) {
    throw new ToolFailure('sshServerId is only valid when via is "ssh".');
  }
  return {
    ...(via !== undefined ? { via } : {}),
    ...(sshServerId !== undefined ? { sshServerId } : {}),
  };
}

/** The via/sshServerId the caller actually set, for resolveRoute. */
function pickRoute(changes: { via?: ApiRoute; sshServerId?: string }): {
  via?: ApiRoute;
  sshServerId?: string;
} {
  return {
    ...(changes.via !== undefined ? { via: changes.via } : {}),
    ...(changes.sshServerId !== undefined ? { sshServerId: changes.sshServerId } : {}),
  };
}

/** Names of the fields the caller actually set (a card lists what an update changes). */
function changedFields(changes: Record<string, unknown>): string[] {
  return Object.keys(changes).filter((key) => changes[key] !== undefined);
}

/** The update's provider fields: the caller's changes over the stored record. */
function mergedProvider(
  id: string,
  changes: {
    label?: string;
    description?: string;
    protocol?: ApiProtocol;
    baseUrl?: string;
    models?: ApiProviderModel[];
    enabled?: boolean;
    order?: number;
  },
  existing: ApiProviderRecord | null,
  route: { via?: ApiRoute; sshServerId?: string },
): SaveApiProviderInput["provider"] {
  return {
    id,
    label: changes.label ?? existing?.label ?? id,
    protocol: changes.protocol ?? existing?.protocol ?? "openai",
    baseUrl: changes.baseUrl ?? existing?.baseUrl ?? "",
    ...route,
    ...(changes.description !== undefined ? { description: changes.description } : {}),
    ...(changes.models !== undefined ? { models: changes.models as ApiProviderModel[] } : {}),
    ...(changes.enabled !== undefined ? { enabled: changes.enabled } : {}),
    ...(changes.order !== undefined ? { order: changes.order } : {}),
  };
}

/** Card summary of a provider change (spec 34.7): never the API key. */
function cardSummary(
  provider: {
    id: string;
    label: string;
    protocol: string;
    baseUrl: string;
    via?: "direct" | "tailnet" | "ssh";
    sshServerId?: string;
  },
  modelCount: number | null,
  hasApiKey: boolean,
  deps: CustomProviderAgentToolDependencies,
): Record<string, unknown> {
  const via = provider.via ?? "direct";
  const summary: Record<string, unknown> = {
    id: provider.id,
    label: provider.label,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    via,
  };
  if (via === "ssh" && provider.sshServerId) {
    summary.server = deps.sshServerLabel(provider.sshServerId) ?? provider.sshServerId;
  }
  if (modelCount !== null) summary.models = modelCount;
  summary.hasApiKey = hasApiKey;
  return summary;
}

async function findProvider(
  deps: CustomProviderAgentToolDependencies,
  id: string,
): Promise<ApiProviderRecord | null> {
  const { providers } = await deps.service.list();
  return providers.find((provider) => provider.id === id) ?? null;
}

const sshWorkflow =
  'For a model server you installed on a remote machine with remote_run, use via "ssh" with ' +
  'that machine\'s serverId and baseUrl "http://127.0.0.1:<port>/v1" — the shell on this machine ' +
  "has no route to the remote machine, only the daemon's SSH connection does. Or use via " +
  '"tailnet" when the endpoint is reachable on the tailnet.';

const providerTools = (deps: CustomProviderAgentToolDependencies): CustomProviderAgentTool[] => [
  defineTool({
    name: "provider_list",
    title: "List model providers",
    description:
      "List the model providers available in JAgentDesk: the built-in ones plus custom API " +
      "providers (id, label, protocol, base URL, route, models with thinking options, enabled " +
      "state), and hand-written env-based providers read-only. No API keys are returned. " +
      "Auto-approved (read-only).",
    inputSchema: {},
    requiresPermission: false,
    async run() {
      return jsonResult(await deps.service.list());
    },
  }),
  defineTool({
    name: "provider_test",
    title: "Test a model endpoint",
    description:
      "Probe a model endpoint and list the models it serves (GET /models, 10 s timeout): " +
      'protocol "openai" (OpenAI-compatible) or "anthropic" (Anthropic-compatible). ' +
      sshWorkflow +
      " Pass apiKey to test an unsaved endpoint, or id to use the stored key of that provider. " +
      "Changes nothing. Auto-approved (read-only).",
    inputSchema: {
      protocol: z.enum(["openai", "anthropic"]),
      baseUrl: z.string().min(1),
      via: z.enum(["direct", "tailnet", "ssh"]).optional(),
      sshServerId: z
        .string()
        .optional()
        .describe('Required when via is "ssh": the SSH server (see ssh_list_servers) to use.'),
      apiKey: z.string().optional(),
      id: z.string().optional().describe("Use the stored API key of this provider id."),
    },
    requiresPermission: false,
    async run(input) {
      const route = resolveRoute(pickRoute(input), null);
      return jsonResult(
        await deps.service.test({
          protocol: input.protocol,
          baseUrl: input.baseUrl,
          ...route,
          ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
          ...(input.id !== undefined ? { id: input.id } : {}),
        }),
      );
    },
  }),
  defineTool({
    name: "provider_add",
    title: "Add a custom API provider",
    description:
      "Add a custom API provider to JAgentDesk so its models appear in the composer right away " +
      '(no daemon restart): an OpenAI-compatible ("openai") or Anthropic-compatible ("anthropic") ' +
      "endpoint. " +
      sshWorkflow +
      " After a successful provider_test, call this with the same protocol/baseUrl/via. Requires " +
      "the user's approval.",
    inputSchema: {
      id: z
        .string()
        .regex(/^[a-z][a-z0-9-]*$/)
        .describe("Provider id, lowercase letters, digits and dashes."),
      label: z.string().min(1),
      protocol: z.enum(["openai", "anthropic"]),
      baseUrl: z.string().min(1),
      via: z.enum(["direct", "tailnet", "ssh"]).optional(),
      sshServerId: z
        .string()
        .optional()
        .describe('Required when via is "ssh": the SSH server (see ssh_list_servers) to use.'),
      apiKey: z.string().optional(),
      description: z.string().optional(),
      models: z
        .array(
          z.object({
            id: z.string().min(1),
            label: z.string().min(1),
            isDefault: z.boolean().optional(),
            contextWindow: z.number().int().positive().optional(),
            thinkingOptions: z
              .array(
                z.object({
                  id: z.string().min(1),
                  label: z.string().min(1),
                  isDefault: z.boolean().optional(),
                }),
              )
              .optional(),
          }),
        )
        .optional()
        .describe(
          "Omit to let the daemon discover the models the endpoint serves; declare them when " +
            "discovery is not possible.",
        ),
      enabled: z.boolean().optional(),
      order: z.number().int().optional(),
    },
    requiresPermission: true,
    async run(input) {
      const route = resolveRoute(pickRoute(input), null);
      const cardInput = cardSummary(
        { ...input, ...route },
        input.models?.length ?? null,
        input.apiKey !== undefined,
        deps,
      );
      await requireApproval(deps, {
        name: "provider_add",
        title: `Add provider ${input.label}`,
        description: `${input.protocol} endpoint ${input.baseUrl}`,
        input: cardInput,
      });
      const saveInput: SaveApiProviderInput = {
        mode: "create",
        provider: {
          id: input.id,
          label: input.label,
          protocol: input.protocol,
          baseUrl: input.baseUrl,
          ...route,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.models !== undefined ? { models: input.models } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.order !== undefined ? { order: input.order } : {}),
        },
        ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
      };
      return jsonResult(await deps.service.save(saveInput));
    },
  }),
  defineTool({
    name: "provider_update",
    title: "Update a custom API provider",
    description:
      "Update a custom API provider you added before (id from provider_list): change its label, " +
      "description, base URL, route, models or enabled state, or replace its API key (empty " +
      "string deletes the key). Hand-written env-based providers cannot be updated. " +
      sshWorkflow +
      " Requires the user's approval.",
    inputSchema: {
      id: z.string().min(1),
      label: z.string().min(1).optional(),
      description: z.string().optional(),
      protocol: z.enum(["openai", "anthropic"]).optional(),
      baseUrl: z.string().min(1).optional(),
      via: z.enum(["direct", "tailnet", "ssh"]).optional(),
      sshServerId: z
        .string()
        .optional()
        .describe('Required when via is "ssh": the SSH server (see ssh_list_servers) to use.'),
      apiKey: z
        .string()
        .optional()
        .describe("Omit to keep the stored key; empty string deletes it; otherwise replaces it."),
      models: z
        .array(
          z.object({
            id: z.string().min(1),
            label: z.string().min(1),
            isDefault: z.boolean().optional(),
            contextWindow: z.number().int().positive().optional(),
            thinkingOptions: z
              .array(
                z.object({
                  id: z.string().min(1),
                  label: z.string().min(1),
                  isDefault: z.boolean().optional(),
                }),
              )
              .optional(),
          }),
        )
        .optional(),
      enabled: z.boolean().optional(),
      order: z.number().int().optional(),
    },
    requiresPermission: true,
    async run(input) {
      const { id, ...changes } = input;
      const existing = await findProvider(deps, id);
      const route = resolveRoute(pickRoute(changes), existing);
      const provider = mergedProvider(id, changes, existing, route);
      const changed = changedFields(changes);
      // hasApiKey on the card = whether a key ends up stored after this update.
      const cardInput = cardSummary(
        provider,
        changes.models?.length ?? null,
        changes.apiKey !== undefined ? changes.apiKey !== "" : (existing?.hasApiKey ?? false),
        deps,
      );
      if (changed.length > 0) cardInput.changed = changed;
      await requireApproval(deps, {
        name: "provider_update",
        title: `Update provider ${provider.label}`,
        description: changed.length > 0 ? `Changes: ${changed.join(", ")}` : "No changes",
        input: cardInput,
      });
      return jsonResult(
        await deps.service.save({
          mode: "update",
          provider,
          ...(changes.apiKey !== undefined ? { apiKey: changes.apiKey } : {}),
        }),
      );
    },
  }),
  defineTool({
    name: "provider_remove",
    title: "Remove a custom API provider",
    description:
      "Remove a custom API provider you added before (id from provider_list). Its stored API key " +
      "is deleted with it. Hand-written env-based providers cannot be removed. Requires the " +
      "user's approval.",
    inputSchema: { id: z.string().min(1) },
    requiresPermission: true,
    async run(input) {
      const existing = await findProvider(deps, input.id);
      await requireApproval(deps, {
        name: "provider_remove",
        title: `Remove provider ${existing?.label ?? input.id}`,
        description: existing ? `${existing.protocol} endpoint ${existing.baseUrl}` : input.id,
        input: {
          id: input.id,
          ...(existing
            ? {
                label: existing.label,
                protocol: existing.protocol,
                baseUrl: existing.baseUrl,
                via: existing.via,
                ...(existing.sshServerId !== undefined
                  ? { server: deps.sshServerLabel(existing.sshServerId) ?? existing.sshServerId }
                  : {}),
                models: existing.models.length,
                hasApiKey: existing.hasApiKey,
              }
            : {}),
        },
      });
      await deps.service.delete(input.id);
      return jsonResult({ id: input.id, removed: true });
    },
  }),
];

/**
 * The spec 34.7 tool set for one caller. Always offered: the tools work on every daemon
 * (provider_list needs no remote endpoint; mutating tools surface the service's errors).
 */
export function createCustomProviderAgentTools(
  deps: CustomProviderAgentToolDependencies,
): CustomProviderAgentTool[] {
  return providerTools(deps);
}

type RegisterTool = (
  name: string,
  config: JAgentDeskToolConfig,
  handler: (
    input: unknown,
    context: JAgentDeskToolExecutionContext,
  ) => Promise<JAgentDeskToolResult>,
) => void;

/** Adds the tools to a catalog through its `registerTool` (jagentdesk-tools.ts). */
export function registerCustomProviderAgentTools(
  registerTool: RegisterTool,
  tools: CustomProviderAgentTool[],
): void {
  for (const tool of tools) {
    registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
      tool.handler,
    );
  }
}
