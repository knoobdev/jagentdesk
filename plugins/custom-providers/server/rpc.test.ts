// rpc.test.ts — the providers.custom.* session handlers against an in-test fake implementing
// CustomProviderService. Proves: every request gets a response (success and error paths),
// CustomProviderError maps to "<code>: <message>", anything else to "internal: <message>", a
// null service answers with the unavailable error instead of timing out, and save/delete/test
// pass their inputs through to the service unchanged.
import { describe, expect, it, vi } from "vitest";

import {
  CustomProvidersListResponseSchema,
  CustomProvidersSaveResponseSchema,
  CustomProvidersDeleteResponseSchema,
  CustomProvidersTestResponseSchema,
} from "@jagentdesk/protocol/custom-providers/rpc-schemas";
import { handleCustomProvidersMessage, formatCustomProviderError } from "./rpc.js";
import {
  CustomProviderError,
  type CustomProviderService,
} from "../../../packages/server/src/server/custom-providers/types.js";

const provider = {
  id: "local-llama",
  label: "Local Llama",
  protocol: "openai" as const,
  baseUrl: "http://127.0.0.1:11434/v1",
  via: "direct" as const,
  hasApiKey: true,
  models: [{ id: "llama3", label: "Llama 3" }],
  enabled: true,
};

function createFakeService(overrides: Partial<CustomProviderService> = {}): CustomProviderService {
  return {
    list: vi.fn(async () => ({ providers: [provider], envProviders: [] })),
    save: vi.fn(async () => provider),
    delete: vi.fn(async () => undefined),
    test: vi.fn(async () => ({ ok: true, models: [{ id: "llama3" }], error: null })),
    onChanged: vi.fn(() => () => {}),
    ...overrides,
  };
}

function collect() {
  const out: unknown[] = [];
  return { emit: (message: unknown) => out.push(message), out };
}

describe("handleCustomProvidersMessage", () => {
  it("answers list with the service's providers and env providers", async () => {
    const service = createFakeService();
    const { emit, out } = collect();
    const handled = await handleCustomProvidersMessage(
      service,
      { type: "providers.custom.list.request", requestId: "req_1" },
      emit,
    );
    expect(handled).toBe(true);
    const parsed = CustomProvidersListResponseSchema.parse(out[0]);
    expect(parsed.payload).toEqual({
      requestId: "req_1",
      error: null,
      providers: [provider],
      envProviders: [],
    });
  });

  it("passes mode, provider and key through to save", async () => {
    const service = createFakeService();
    const { emit, out } = collect();
    await handleCustomProvidersMessage(
      service,
      {
        type: "providers.custom.save.request",
        requestId: "req_2",
        mode: "update",
        // The wire schema strips record-only fields like hasApiKey (the key flag is request-only).
        provider: {
          id: provider.id,
          label: "Renamed",
          protocol: provider.protocol,
          baseUrl: provider.baseUrl,
          via: provider.via,
        },
        apiKey: "",
      },
      emit,
    );
    expect(service.save).toHaveBeenCalledWith({
      mode: "update",
      provider: {
        id: provider.id,
        label: "Renamed",
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        via: provider.via,
      },
      apiKey: "",
    });
    const parsed = CustomProvidersSaveResponseSchema.parse(out[0]);
    expect(parsed.payload).toEqual({ requestId: "req_2", error: null, provider });
  });

  it("passes delete through to the service", async () => {
    const service = createFakeService();
    const { emit, out } = collect();
    await handleCustomProvidersMessage(
      service,
      { type: "providers.custom.delete.request", requestId: "req_3", id: "local-llama" },
      emit,
    );
    expect(service.delete).toHaveBeenCalledWith("local-llama");
    const parsed = CustomProvidersDeleteResponseSchema.parse(out[0]);
    expect(parsed.payload).toEqual({ requestId: "req_3", error: null });
  });

  it("passes test input through to the service", async () => {
    const service = createFakeService();
    const { emit, out } = collect();
    await handleCustomProvidersMessage(
      service,
      {
        type: "providers.custom.test.request",
        requestId: "req_4",
        protocol: "anthropic",
        baseUrl: "http://127.0.0.1:8080",
        via: "ssh",
        sshServerId: "srv_a",
        apiKey: "sk-secret",
      },
      emit,
    );
    expect(service.test).toHaveBeenCalledWith({
      protocol: "anthropic",
      baseUrl: "http://127.0.0.1:8080",
      via: "ssh",
      sshServerId: "srv_a",
      apiKey: "sk-secret",
    });
    const parsed = CustomProvidersTestResponseSchema.parse(out[0]);
    expect(parsed.payload).toEqual({
      requestId: "req_4",
      error: null,
      result: { ok: true, models: [{ id: "llama3" }], error: null },
    });
  });

  it("maps a CustomProviderError to '<code>: <message>' with a neutral payload", async () => {
    const service = createFakeService({
      delete: vi.fn(async () => {
        throw new CustomProviderError("provider_not_found", "no provider local-llama");
      }),
    });
    const { emit, out } = collect();
    await handleCustomProvidersMessage(
      service,
      { type: "providers.custom.delete.request", requestId: "req_5", id: "local-llama" },
      emit,
    );
    const parsed = CustomProvidersDeleteResponseSchema.parse(out[0]);
    expect(parsed.payload).toEqual({
      requestId: "req_5",
      error: "provider_not_found: no provider local-llama",
    });
  });

  it("maps an unexpected error to 'internal: <message>'", async () => {
    const service = createFakeService({
      list: vi.fn(async () => {
        throw new Error("config.json is not valid JSON");
      }),
    });
    const { emit, out } = collect();
    await handleCustomProvidersMessage(
      service,
      { type: "providers.custom.list.request", requestId: "req_6" },
      emit,
    );
    const parsed = CustomProvidersListResponseSchema.parse(out[0]);
    expect(parsed.payload).toEqual({
      requestId: "req_6",
      error: "internal: config.json is not valid JSON",
      providers: [],
      envProviders: [],
    });
  });

  it("answers every request when the service is null", async () => {
    const { emit, out } = collect();
    const messages: Array<{ type: string; requestId: string } & Record<string, unknown>> = [
      { type: "providers.custom.list.request", requestId: "req_0" },
      {
        type: "providers.custom.save.request",
        requestId: "req_1",
        mode: "create",
        provider: {
          id: "local-llama",
          label: "Local Llama",
          protocol: "openai",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
      },
      { type: "providers.custom.delete.request", requestId: "req_2", id: "local-llama" },
      {
        type: "providers.custom.test.request",
        requestId: "req_3",
        protocol: "openai",
        baseUrl: "http://127.0.0.1:11434/v1",
      },
    ];
    for (const message of messages) {
      const handled = await handleCustomProvidersMessage(null, message, emit);
      expect(handled).toBe(true);
    }
    expect(out).toHaveLength(4);
    const errors = out.map((message) => {
      const payload = (message as { payload: { error: string | null } }).payload;
      return payload.error;
    });
    expect(errors).toEqual([
      "internal: custom providers are unavailable",
      "internal: custom providers are unavailable",
      "internal: custom providers are unavailable",
      "internal: custom providers are unavailable",
    ]);
  });

  it("claims nothing for other message types", async () => {
    const handled = await handleCustomProvidersMessage(
      createFakeService(),
      { type: "providers.list.request", requestId: "req_7" },
      () => {},
    );
    expect(handled).toBe(false);
  });
});

describe("formatCustomProviderError", () => {
  it("keeps the code prefix for CustomProviderError", () => {
    expect(
      formatCustomProviderError(new CustomProviderError("models_unavailable", "no models")),
    ).toBe("models_unavailable: no models");
  });
  it("falls back to internal for anything else", () => {
    expect(formatCustomProviderError("boom")).toBe("internal: boom");
  });
});
