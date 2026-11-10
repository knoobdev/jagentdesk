import { describe, expect, it } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages.js";
import {
  ApiProviderRecordSchema,
  CustomProvidersSaveResponseSchema,
  type ApiProviderRecord,
} from "./custom-providers/rpc-schemas.js";

// Spec 34 / ADR-0047: providers.custom.* RPCs. Additive protocol change: old clients ignore the
// new message types, old daemons never send them. The API key never appears in a response
// payload — records carry `hasApiKey` only.

function recordFixture(overrides: Partial<ApiProviderRecord> = {}): ApiProviderRecord {
  return {
    id: "local-llama",
    label: "Local Llama",
    protocol: "openai",
    baseUrl: "http://100.67.63.108:11434/v1",
    via: "tailnet",
    hasApiKey: false,
    models: [
      { id: "llama3", label: "Llama 3", isDefault: true },
      {
        id: "qwen3-thinking",
        label: "Qwen 3 (thinking)",
        thinkingOptions: [{ id: "medium", label: "Medium", isDefault: true }],
      },
    ],
    enabled: true,
    ...overrides,
  };
}

describe("providers.custom.* requests", () => {
  it("parses list with no parameters", () => {
    const message = { type: "providers.custom.list.request", requestId: "req_1" };
    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
  });

  it("parses save with mode, provider and an optional key", () => {
    const message = {
      type: "providers.custom.save.request",
      requestId: "req_2",
      mode: "create",
      provider: {
        id: "local-llama",
        label: "Local Llama",
        protocol: "openai",
        baseUrl: "http://127.0.0.1:11434/v1",
        via: "ssh",
        sshServerId: "srv_1a2b3c4d5e6f",
      },
      apiKey: "sk-secret",
    };
    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
  });

  it("rejects a save whose id is not a slug", () => {
    const message = {
      type: "providers.custom.save.request",
      requestId: "req_3",
      mode: "create",
      provider: {
        id: "Bad Id",
        label: "Bad",
        protocol: "openai",
        baseUrl: "http://127.0.0.1:11434/v1",
      },
    };
    expect(() => SessionInboundMessageSchema.parse(message)).toThrow();
  });

  it("rejects a save whose baseUrl is not http(s)", () => {
    const message = {
      type: "providers.custom.save.request",
      requestId: "req_4",
      mode: "create",
      provider: {
        id: "local-llama",
        label: "Local Llama",
        protocol: "openai",
        baseUrl: "ftp://127.0.0.1:11434/v1",
      },
    };
    expect(() => SessionInboundMessageSchema.parse(message)).toThrow();
  });

  it("parses delete", () => {
    const message = { type: "providers.custom.delete.request", requestId: "req_5", id: "p" };
    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
  });

  it("parses test with an explicit key or a stored provider id", () => {
    const explicit = {
      type: "providers.custom.test.request",
      requestId: "req_6",
      protocol: "anthropic",
      baseUrl: "http://127.0.0.1:8080",
      via: "ssh",
      sshServerId: "srv_1a2b3c4d5e6f",
      apiKey: "sk-secret",
    };
    expect(SessionInboundMessageSchema.parse(explicit)).toEqual(explicit);
    const stored = {
      type: "providers.custom.test.request",
      requestId: "req_7",
      protocol: "openai",
      baseUrl: "http://127.0.0.1:11434/v1",
      id: "local-llama",
    };
    expect(SessionInboundMessageSchema.parse(stored)).toEqual(stored);
  });
});

describe("providers.custom.* responses", () => {
  it("round-trips a full list response", () => {
    const message = {
      type: "providers.custom.list.response",
      payload: {
        requestId: "req_1",
        error: null,
        providers: [recordFixture()],
        envProviders: [{ id: "my-env-provider", label: "My env provider", extends: "claude" }],
      },
    };
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });

  it("strips a stray apiKey from a provider record (the key never reaches the wire)", () => {
    const record = ApiProviderRecordSchema.parse({ ...recordFixture(), apiKey: "sk-secret" });
    expect(record).not.toHaveProperty("apiKey");
  });

  it("strips a stray apiKey from a save response payload", () => {
    const message = CustomProvidersSaveResponseSchema.parse({
      type: "providers.custom.save.response",
      payload: { requestId: "req_2", error: null, provider: recordFixture(), apiKey: "sk-secret" },
    });
    expect(message.payload.provider).not.toHaveProperty("apiKey");
    expect(message.payload).not.toHaveProperty("apiKey");
  });

  it("parses save, delete and test responses on the error path with neutral payloads", () => {
    expect(
      SessionOutboundMessageSchema.parse({
        type: "providers.custom.save.response",
        payload: { requestId: "req_2", error: "duplicate_id: already exists", provider: null },
      }),
    ).toEqual({
      type: "providers.custom.save.response",
      payload: { requestId: "req_2", error: "duplicate_id: already exists", provider: null },
    });
    expect(
      SessionOutboundMessageSchema.parse({
        type: "providers.custom.delete.response",
        payload: { requestId: "req_5", error: "provider_not_found: no provider p" },
      }),
    ).toEqual({
      type: "providers.custom.delete.response",
      payload: { requestId: "req_5", error: "provider_not_found: no provider p" },
    });
    expect(
      SessionOutboundMessageSchema.parse({
        type: "providers.custom.test.response",
        payload: {
          requestId: "req_6",
          error: null,
          result: {
            ok: false,
            models: [],
            error: { code: "endpoint_unreachable", message: "connect ECONNREFUSED" },
          },
        },
      }),
    ).toEqual({
      type: "providers.custom.test.response",
      payload: {
        requestId: "req_6",
        error: null,
        result: {
          ok: false,
          models: [],
          error: { code: "endpoint_unreachable", message: "connect ECONNREFUSED" },
        },
      },
    });
  });
});
