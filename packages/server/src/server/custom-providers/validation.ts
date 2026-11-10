import type { ApiProviderModel, ApiProtocol, ApiRoute, SaveApiProviderInput } from "./types.js";
import { CustomProviderError } from "./types.js";

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const API_PROTOCOLS = new Set<string>(["openai", "anthropic"]);
const API_ROUTES = new Set<string>(["direct", "tailnet", "ssh"]);

function invalid(message: string): CustomProviderError {
  return new CustomProviderError("invalid_provider", message);
}

export function validateProviderId(id: string): string {
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw invalid(`Provider id "${id}" must match ${PROVIDER_ID_PATTERN}`);
  }
  return id;
}

function validateBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw invalid(`Base URL "${baseUrl}" is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalid(`Base URL "${baseUrl}" must use http or https`);
  }
  if (!parsed.hostname) {
    throw invalid(`Base URL "${baseUrl}" has no host`);
  }
  return trimmed;
}

function validateModels(models: ApiProviderModel[] | undefined): ApiProviderModel[] | undefined {
  if (models === undefined) return undefined;
  if (!Array.isArray(models)) throw invalid("models must be an array");
  for (const model of models) {
    if (!model || typeof model !== "object") throw invalid("Each model must be an object");
    if (typeof model.id !== "string" || model.id.length === 0) {
      throw invalid("Each model needs a non-empty id");
    }
    if (typeof model.label !== "string" || model.label.length === 0) {
      throw invalid(`Model "${model.id}" needs a non-empty label`);
    }
    for (const option of model.thinkingOptions ?? []) {
      if (typeof option.id !== "string" || option.id.length === 0) {
        throw invalid(`Model "${model.id}" has a thinking option without id`);
      }
      if (typeof option.label !== "string" || option.label.length === 0) {
        throw invalid(`Model "${model.id}" has a thinking option without label`);
      }
    }
  }
  return models;
}

export interface ValidatedApiProvider {
  id: string;
  label: string;
  description?: string;
  protocol: ApiProtocol;
  baseUrl: string;
  via: ApiRoute;
  sshServerId?: string;
  models?: ApiProviderModel[];
  enabled?: boolean;
  order?: number;
}

/** Shape validation for a save input (spec 34.2). Collisions are checked by the service. */
export function validateSaveApiProviderInput(input: SaveApiProviderInput): ValidatedApiProvider {
  const provider = input.provider;
  if (!provider || typeof provider !== "object") throw invalid("provider is required");
  validateProviderId(provider.id);
  if (typeof provider.label !== "string" || provider.label.trim().length === 0) {
    throw invalid(`Provider "${provider.id}" needs a non-empty label`);
  }
  if (!API_PROTOCOLS.has(provider.protocol)) {
    throw invalid(`Provider "${provider.id}" protocol must be "openai" or "anthropic"`);
  }
  const baseUrl = validateBaseUrl(provider.baseUrl);
  const via = provider.via ?? "direct";
  if (!API_ROUTES.has(via)) {
    throw invalid(`Provider "${provider.id}" via must be "direct", "tailnet" or "ssh"`);
  }
  if (via === "ssh") {
    if (typeof provider.sshServerId !== "string" || provider.sshServerId.length === 0) {
      throw invalid(`Provider "${provider.id}" with via "ssh" requires sshServerId`);
    }
  } else if (provider.sshServerId !== undefined) {
    throw invalid(`Provider "${provider.id}" may only set sshServerId when via is "ssh"`);
  }
  const models = validateModels(provider.models);
  return {
    id: provider.id,
    label: provider.label.trim(),
    ...(provider.description !== undefined ? { description: provider.description } : {}),
    protocol: provider.protocol,
    baseUrl,
    via,
    ...(via === "ssh" ? { sshServerId: provider.sshServerId } : {}),
    ...(models !== undefined ? { models } : {}),
    ...(provider.enabled !== undefined ? { enabled: provider.enabled } : {}),
    ...(provider.order !== undefined ? { order: provider.order } : {}),
  };
}

/** Shape validation for a test input (spec 34.5). */
export function validateTestApiProviderInput(input: {
  protocol: ApiProtocol;
  baseUrl: string;
  via?: ApiRoute;
  sshServerId?: string;
}): {
  protocol: ApiProtocol;
  baseUrl: string;
  via: ApiRoute;
  sshServerId?: string;
} {
  if (!API_PROTOCOLS.has(input.protocol)) {
    throw invalid(`protocol must be "openai" or "anthropic"`);
  }
  const baseUrl = validateBaseUrl(input.baseUrl);
  const via = input.via ?? "direct";
  if (!API_ROUTES.has(via)) {
    throw invalid(`via must be "direct", "tailnet" or "ssh"`);
  }
  if (via === "ssh" && (typeof input.sshServerId !== "string" || input.sshServerId.length === 0)) {
    throw invalid(`via "ssh" requires sshServerId`);
  }
  return {
    protocol: input.protocol,
    baseUrl,
    via,
    ...(via === "ssh" ? { sshServerId: input.sshServerId } : {}),
  };
}
