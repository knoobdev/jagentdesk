import type { Logger } from "pino";
import { BUILTIN_PROVIDER_IDS } from "@jagentdesk/protocol/provider-manifest";
import type { SecretStore } from "../database/secret-store.js";
import type { TailnetSocksProxy } from "../tsnet-listener.js";
import type { AcquireSshClient } from "../ssh/ssh-client-lease.js";
import { ProviderForwarder } from "./forwarder.js";
import {
  providerApiKeySecretId,
  readAgentProviderEntries,
  writeAgentProviderEntry,
} from "./config-storage.js";
import {
  buildClaudeSpawnEnv,
  buildOpenCodeProviderConfig,
  type OpenCodeProviderInjection,
} from "./materialization.js";
import { validateSaveApiProviderInput, validateTestApiProviderInput } from "./validation.js";
import type {
  ApiProviderModel,
  ApiProviderRecord,
  ApiProtocol,
  ApiRoute,
  CustomProviderService,
  EnvProviderSummary,
  ProviderTestResult,
  SaveApiProviderInput,
  TestApiProviderInput,
} from "./types.js";
import { CustomProviderError } from "./types.js";

export interface CustomProviderServiceDeps {
  jagentdeskHome: string;
  logger: Logger;
  secretStore: SecretStore;
  /** Loopback SOCKS5 of the daemon's tsnet node; null while the tailnet is down. */
  getTailnetSocks: () => TailnetSocksProxy | null;
  /** Client lease for an SSH server (spec 25), used by via:"ssh" forwards. */
  acquireSshClient?: AcquireSshClient;
  /** Whether an SSH server id exists; absent deps skip the existence check. */
  sshServerExists?: (serverId: string) => boolean;
  /** Hot reload (spec 34.6): rebuild the provider registry + snapshot after a write. */
  reloadRegistry: (removeProviders: readonly string[]) => Promise<void> | void;
}

export interface CustomProviderServiceExtras {
  /** The OpenCode provider definition for one api entry, or null when not an openai one. */
  materializeOpenCodeProvider(providerId: string): Promise<OpenCodeProviderInjection | null>;
  /** The Claude spawn env for one api entry, or null when not an anthropic one. */
  materializeClaudeEnv(providerId: string): Promise<Record<string, string> | null>;
  /** Closes every open forward; called on daemon shutdown. */
  closeAll(): void;
}

interface RawApiBlock {
  protocol: ApiProtocol;
  baseUrl: string;
  via?: string;
  sshServerId?: string;
}

function apiBlockOf(entry: unknown): RawApiBlock | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const api = (entry as Record<string, unknown>)["api"];
  if (!api || typeof api !== "object" || Array.isArray(api)) return null;
  const block = api as Record<string, unknown>;
  if (typeof block["protocol"] !== "string" || typeof block["baseUrl"] !== "string") return null;
  return {
    protocol: block["protocol"] as ApiProtocol,
    baseUrl: block["baseUrl"],
    ...(typeof block["via"] === "string" ? { via: block["via"] } : {}),
    ...(typeof block["sshServerId"] === "string" ? { sshServerId: block["sshServerId"] } : {}),
  };
}

function modelsOf(entry: unknown): ApiProviderModel[] {
  const models = (entry as Record<string, unknown> | null)?.["models"];
  if (!Array.isArray(models)) return [];
  return models.filter(
    (model): model is ApiProviderModel =>
      !!model &&
      typeof model === "object" &&
      typeof (model as ApiProviderModel).id === "string" &&
      typeof (model as ApiProviderModel).label === "string",
  );
}

const ANTHROPIC_DISALLOWED_TOOLS = ["WebSearch"];

export function createCustomProviderService(
  deps: CustomProviderServiceDeps,
): CustomProviderService & CustomProviderServiceExtras {
  const { logger } = deps;
  const forwarder = new ProviderForwarder({
    logger,
    getTailnetSocks: deps.getTailnetSocks,
    acquireSshClient: deps.acquireSshClient,
  });
  const changeListeners = new Set<() => void>();

  const readEntries = () => readAgentProviderEntries(deps.jagentdeskHome);

  function assertSaveAllowed(
    mode: SaveApiProviderInput["mode"],
    validated: { id: string; via: ApiRoute; sshServerId?: string },
    existing: unknown,
  ): void {
    if (mode === "create") {
      if (existing !== undefined) {
        throw new CustomProviderError("duplicate_id", `Provider "${validated.id}" already exists`);
      }
      if ((BUILTIN_PROVIDER_IDS as readonly string[]).includes(validated.id)) {
        throw new CustomProviderError(
          "duplicate_id",
          `Provider "${validated.id}" collides with a built-in provider`,
        );
      }
    } else {
      if (existing === undefined) {
        throw new CustomProviderError("provider_not_found", `Unknown provider "${validated.id}"`);
      }
      if (!apiBlockOf(existing)) {
        throw new CustomProviderError(
          "provider_not_managed",
          `Provider "${validated.id}" is not managed by JAgentDesk`,
        );
      }
    }
    if (
      validated.via === "ssh" &&
      deps.sshServerExists &&
      !deps.sshServerExists(validated.sshServerId ?? "")
    ) {
      throw new CustomProviderError(
        "invalid_provider",
        `Unknown SSH server "${validated.sshServerId}"`,
      );
    }
  }

  /** Spec 34.5: a save without models discovers them; a failed discovery rejects the save. */
  async function discoverModels(
    validated: {
      id: string;
      protocol: ApiProtocol;
      baseUrl: string;
      via: ApiRoute;
      sshServerId?: string;
    },
    explicitApiKey: string | undefined,
  ): Promise<ApiProviderModel[]> {
    const secretId = providerApiKeySecretId(validated.id);
    const discoveryKey =
      explicitApiKey === undefined ? await deps.secretStore.get(secretId) : explicitApiKey || null;
    const discovered = await testProvider({
      protocol: validated.protocol,
      baseUrl: validated.baseUrl,
      via: validated.via,
      ...(validated.sshServerId ? { sshServerId: validated.sshServerId } : {}),
      ...(discoveryKey ? { apiKey: discoveryKey } : {}),
    });
    if (!discovered.ok) {
      throw new CustomProviderError(
        "models_unavailable",
        discovered.error?.message ?? "The models endpoint could not be reached",
      );
    }
    return discovered.models.map((model) => ({ id: model.id, label: model.id }));
  }

  async function toRecord(id: string, entry: unknown): Promise<ApiProviderRecord | null> {
    const api = apiBlockOf(entry);
    if (!api) return null;
    const source = entry as Record<string, unknown>;
    const hasApiKey = (await deps.secretStore.get(providerApiKeySecretId(id))) !== null;
    return {
      id,
      label: typeof source["label"] === "string" ? source["label"] : id,
      ...(typeof source["description"] === "string" ? { description: source["description"] } : {}),
      protocol: api.protocol,
      baseUrl: api.baseUrl,
      via: api.via === "tailnet" || api.via === "ssh" ? api.via : "direct",
      ...(api.sshServerId ? { sshServerId: api.sshServerId } : {}),
      hasApiKey,
      models: modelsOf(entry),
      enabled: source["enabled"] !== false,
      ...(typeof source["order"] === "number" ? { order: source["order"] } : {}),
    };
  }

  async function notifyChanged(removeProviders: readonly string[] = []): Promise<void> {
    await deps.reloadRegistry(removeProviders);
    for (const listener of changeListeners) listener();
  }

  async function resolveEndpoint(
    input: { baseUrl: string; via?: string; sshServerId?: string },
    forwardKey: string,
  ): Promise<string> {
    const via = input.via === "tailnet" || input.via === "ssh" ? input.via : "direct";
    return await forwarder.effectiveBaseUrl(forwardKey, {
      baseUrl: input.baseUrl,
      via,
      ...(input.sshServerId ? { sshServerId: input.sshServerId } : {}),
    });
  }

  async function fetchModels(
    protocol: ApiProtocol,
    baseUrl: string,
    apiKey: string | null,
  ): Promise<Array<{ id: string }>> {
    const trimmed = baseUrl.replace(/\/+$/, "");
    const url = protocol === "anthropic" ? `${trimmed}/v1/models` : `${trimmed}/models`;
    const headers: Record<string, string> = {};
    if (protocol === "anthropic") {
      headers["anthropic-version"] = "2023-06-01";
      if (apiKey) headers["x-api-key"] = apiKey;
    } else if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new CustomProviderError(
        "endpoint_unreachable",
        `The models endpoint answered HTTP ${response.status}`,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new CustomProviderError(
        "endpoint_unreachable",
        "The models endpoint returned a non-JSON body",
      );
    }
    const data = (payload as Record<string, unknown> | null)?.["data"];
    const fallbackModels = (payload as Record<string, unknown> | null)?.["models"];
    let list: unknown[] | null = null;
    if (Array.isArray(data)) {
      list = data;
    } else if (Array.isArray(fallbackModels)) {
      list = fallbackModels;
    }
    if (!list) {
      throw new CustomProviderError(
        "endpoint_unreachable",
        "The models endpoint returned no model list",
      );
    }
    return list.flatMap((item) => {
      let id: string | null = null;
      if (typeof item === "string") {
        id = item;
      } else if (typeof (item as Record<string, unknown> | null)?.["id"] === "string") {
        id = (item as Record<string, unknown>)["id"] as string;
      }
      return id ? [{ id }] : [];
    });
  }

  function entryToConfig(
    validated: ReturnType<typeof validateSaveApiProviderInput>,
    models: ApiProviderModel[],
  ): Record<string, unknown> {
    const anthropic = validated.protocol === "anthropic";
    return {
      extends: anthropic ? "claude" : "opencode",
      label: validated.label,
      ...(validated.description !== undefined ? { description: validated.description } : {}),
      api: {
        protocol: validated.protocol,
        baseUrl: validated.baseUrl,
        via: validated.via,
        ...(validated.sshServerId ? { sshServerId: validated.sshServerId } : {}),
      },
      models,
      ...(anthropic ? { disallowedTools: ANTHROPIC_DISALLOWED_TOOLS } : {}),
      ...(validated.enabled !== undefined ? { enabled: validated.enabled } : {}),
      ...(validated.order !== undefined ? { order: validated.order } : {}),
    };
  }

  /** Spec 34.5: reach the models endpoint through the route; never throws, reports the error. */
  async function testProvider(input: TestApiProviderInput): Promise<ProviderTestResult> {
    const validated = validateTestApiProviderInput(input);
    let apiKey = input.apiKey ?? null;
    if (apiKey === null && input.id) {
      apiKey = await deps.secretStore.get(providerApiKeySecretId(input.id));
    }
    const forwardKey = input.id ?? "__test__";
    // A test without `id` opens a temporary forward that must live until the
    // models fetch completes — closing it before the fetch made every via
    // tailnet/ssh test fail with "fetch failed" (spec 34 live-test fix).
    const closeForward = input.id === undefined;
    try {
      const baseUrl = await resolveEndpoint(validated, forwardKey);
      const models = await fetchModels(validated.protocol, baseUrl, apiKey);
      return { ok: true, models, error: null };
    } catch (error) {
      const providerError =
        error instanceof CustomProviderError
          ? error
          : new CustomProviderError(
              "endpoint_unreachable",
              error instanceof Error ? error.message : String(error),
            );
      logger.debug({ err: error }, "Custom provider test failed");
      return {
        ok: false,
        models: [],
        error: { code: providerError.code, message: providerError.message },
      };
    } finally {
      if (closeForward) forwarder.close(forwardKey);
    }
  }

  return {
    async list() {
      const entries = readEntries();
      const providers: ApiProviderRecord[] = [];
      const envProviders: EnvProviderSummary[] = [];
      for (const [id, entry] of Object.entries(entries)) {
        const api = apiBlockOf(entry);
        if (api) {
          const record = await toRecord(id, entry);
          if (record) providers.push(record);
          continue;
        }
        const source = entry as Record<string, unknown>;
        // Hand-written env-based custom providers stay read-only (spec 34.2).
        if (typeof source["extends"] === "string" && source["extends"] !== "acp") {
          envProviders.push({
            id,
            label: typeof source["label"] === "string" ? source["label"] : id,
            extends: source["extends"],
          });
        }
      }
      return { providers, envProviders };
    },

    async save(input: SaveApiProviderInput) {
      const validated = validateSaveApiProviderInput(input);
      const entries = readEntries();
      assertSaveAllowed(input.mode, validated, entries[validated.id]);

      const models =
        validated.models && validated.models.length > 0
          ? validated.models
          : await discoverModels(validated, input.apiKey);

      if (input.apiKey === "") {
        await deps.secretStore.delete(providerApiKeySecretId(validated.id));
      } else if (input.apiKey !== undefined) {
        await deps.secretStore.set(providerApiKeySecretId(validated.id), input.apiKey);
      }

      writeAgentProviderEntry(deps.jagentdeskHome, validated.id, entryToConfig(validated, models));
      // A changed baseUrl/via must not reuse the previous listener.
      forwarder.close(validated.id);

      const record = await toRecord(validated.id, readEntries()[validated.id]);
      if (!record) {
        throw new CustomProviderError("provider_not_found", `Provider "${validated.id}" vanished`);
      }
      await notifyChanged();
      return record;
    },

    async delete(id: string) {
      const entries = readEntries();
      const existing = entries[id];
      if (existing === undefined) {
        throw new CustomProviderError("provider_not_found", `Unknown provider "${id}"`);
      }
      if (!apiBlockOf(existing)) {
        throw new CustomProviderError(
          "provider_not_managed",
          `Provider "${id}" is not managed by JAgentDesk`,
        );
      }
      writeAgentProviderEntry(deps.jagentdeskHome, id, null);
      await deps.secretStore.delete(providerApiKeySecretId(id));
      forwarder.close(id);
      await notifyChanged([id]);
    },

    async test(input: TestApiProviderInput): Promise<ProviderTestResult> {
      return testProvider(input);
    },

    onChanged(listener: () => void) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },

    async materializeOpenCodeProvider(providerId) {
      const entry = readEntries()[providerId];
      const api = apiBlockOf(entry);
      if (!api || api.protocol !== "openai") return null;
      const baseUrl = await resolveEndpoint(api, providerId);
      const apiKey = await deps.secretStore.get(providerApiKeySecretId(providerId));
      return {
        id: providerId,
        config: buildOpenCodeProviderConfig(
          {
            label:
              typeof (entry as Record<string, unknown>)["label"] === "string"
                ? ((entry as Record<string, unknown>)["label"] as string)
                : providerId,
            protocol: api.protocol,
            models: modelsOf(entry),
          },
          { baseUrl, apiKey },
        ),
      };
    },

    async materializeClaudeEnv(providerId) {
      const entry = readEntries()[providerId];
      const api = apiBlockOf(entry);
      if (!api || api.protocol !== "anthropic") return null;
      const baseUrl = await resolveEndpoint(api, providerId);
      const apiKey = await deps.secretStore.get(providerApiKeySecretId(providerId));
      return buildClaudeSpawnEnv({ baseUrl, apiKey });
    },

    closeAll() {
      forwarder.closeAll();
    },
  };
}
