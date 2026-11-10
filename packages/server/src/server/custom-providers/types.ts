// packages/server/src/server/custom-providers/types.ts — shared CONTRACT for spec 34 / ADR-0047.
// Copied verbatim by several coders; do NOT edit. Propose changes in your report.
export type ApiProtocol = "openai" | "anthropic";
export type ApiRoute = "direct" | "tailnet" | "ssh";

export interface ApiProviderThinkingOption {
  id: string;
  label: string;
  isDefault?: boolean;
}
export interface ApiProviderModel {
  id: string;
  label: string;
  isDefault?: boolean;
  contextWindow?: number;
  thinkingOptions?: ApiProviderThinkingOption[];
}

/** A daemon-managed custom API provider (spec 34.2). Never carries the API key. */
export interface ApiProviderRecord {
  id: string;
  label: string;
  description?: string;
  protocol: ApiProtocol;
  baseUrl: string;
  via: ApiRoute;
  /** Required when via is "ssh": the SSH server (spec 25) to tunnel through. */
  sshServerId?: string;
  hasApiKey: boolean;
  models: ApiProviderModel[];
  enabled: boolean;
  order?: number;
}

/** A hand-written env-based custom provider from config.json: read-only in UI/tools. */
export interface EnvProviderSummary {
  id: string;
  label: string;
  extends: string;
}

export interface ProviderTestResult {
  ok: boolean;
  models: Array<{ id: string }>;
  error: { code: string; message: string } | null;
}

export type CustomProviderErrorCode =
  | "invalid_provider"
  | "duplicate_id"
  | "provider_not_found"
  | "provider_not_managed"
  | "models_unavailable"
  | "tailnet_unavailable"
  | "endpoint_unreachable";

export class CustomProviderError extends Error {
  constructor(
    readonly code: CustomProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CustomProviderError";
  }
}

export interface SaveApiProviderInput {
  mode: "create" | "update";
  provider: {
    id: string;
    label: string;
    description?: string;
    protocol: ApiProtocol;
    baseUrl: string;
    via?: ApiRoute;
    sshServerId?: string;
    models?: ApiProviderModel[];
    enabled?: boolean;
    order?: number;
  };
  /** undefined = keep the stored key; "" = delete the key; otherwise replace it. */
  apiKey?: string;
}

export interface TestApiProviderInput {
  protocol: ApiProtocol;
  baseUrl: string;
  via?: ApiRoute;
  sshServerId?: string;
  /** Explicit key for an unsaved provider; otherwise the stored key of `id` is used. */
  apiKey?: string;
  id?: string;
}

export interface CustomProviderService {
  list(): Promise<{ providers: ApiProviderRecord[]; envProviders: EnvProviderSummary[] }>;
  save(input: SaveApiProviderInput): Promise<ApiProviderRecord>;
  delete(id: string): Promise<void>;
  test(input: TestApiProviderInput): Promise<ProviderTestResult>;
  /** Fires after every successful save/delete (after the provider registry reloaded). */
  onChanged(listener: () => void): () => void;
}
