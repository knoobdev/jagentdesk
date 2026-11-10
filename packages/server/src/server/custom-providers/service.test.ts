import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { MemorySecretStore } from "../database/secret-store.js";
import { createCustomProviderService } from "./service.js";
import { writeAgentProviderEntry } from "./config-storage.js";

function createHome(): string {
  return mkdtempSync(path.join(tmpdir(), "jagentdesk-cp-service-"));
}

type HttpHandler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

async function withHttpServer(
  handler: HttpHandler,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => handler(req, res, raw));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function makeService(home: string, overrides: Record<string, unknown> = {}) {
  const secretStore = new MemorySecretStore();
  const reloadRegistry = vi.fn<(removeProviders: readonly string[]) => Promise<void>>(
    async () => {},
  );
  const service = createCustomProviderService({
    jagentdeskHome: home,
    logger: createTestLogger(),
    secretStore,
    getTailnetSocks: () => null,
    reloadRegistry,
    ...overrides,
  });
  return { service, secretStore, reloadRegistry };
}

const OPENAI_PROVIDER = {
  id: "my-models",
  label: "My models",
  protocol: "openai" as const,
  baseUrl: "http://placeholder",
  models: [{ id: "m1", label: "M1" }],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createCustomProviderService — save/list", () => {
  test("save writes the config entry (derived extends, no key) and list reports it", async () => {
    const home = createHome();
    const { service, secretStore, reloadRegistry } = await makeService(home);
    const record = await service.save({
      mode: "create",
      provider: { ...OPENAI_PROVIDER, baseUrl: "http://127.0.0.1:1/v1" },
      apiKey: "sk-secret",
    });
    expect(record.hasApiKey).toBe(true);
    expect(await secretStore.get("provider.apikey.my-models")).toBe("sk-secret");

    const configEntry = (
      JSON.parse(readFileSync(path.join(home, "config.json"), "utf-8")) as {
        agents: { providers: Record<string, Record<string, unknown>> };
      }
    ).agents.providers["my-models"];
    // The key never lands in config.json.
    expect(JSON.stringify(configEntry)).not.toContain("sk-secret");
    expect(configEntry).toMatchObject({
      extends: "opencode",
      label: "My models",
      api: { protocol: "openai", baseUrl: "http://127.0.0.1:1/v1", via: "direct" },
    });

    const { providers, envProviders } = await service.list();
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      id: "my-models",
      protocol: "openai",
      baseUrl: "http://127.0.0.1:1/v1",
      via: "direct",
      hasApiKey: true,
    });
    expect(JSON.stringify(providers)).not.toContain("sk-secret");
    expect(envProviders).toEqual([]);
    expect(reloadRegistry).toHaveBeenCalledWith([]);
  });

  test("anthropic saves derive extends claude with WebSearch disallowed", async () => {
    const home = createHome();
    const { service } = await makeService(home);
    await service.save({
      mode: "create",
      provider: {
        id: "remote-anthropic",
        label: "Remote Anthropic",
        protocol: "anthropic",
        baseUrl: "http://127.0.0.1:1",
        models: [{ id: "m1", label: "M1" }],
      },
    });
    const configEntry = (
      JSON.parse(readFileSync(path.join(home, "config.json"), "utf-8")) as {
        agents: { providers: Record<string, Record<string, unknown>> };
      }
    ).agents.providers["remote-anthropic"];
    expect(configEntry["extends"]).toBe("claude");
    expect(configEntry["disallowedTools"]).toEqual(["WebSearch"]);
  });

  test("hand-written env providers are listed as read-only env providers", async () => {
    const home = createHome();
    writeAgentProviderEntry(home, "hand", {
      extends: "claude",
      label: "Hand written",
      env: { KEY: "value" },
    });
    const { service } = await makeService(home);
    const { providers, envProviders } = await service.list();
    expect(providers).toEqual([]);
    expect(envProviders).toEqual([{ id: "hand", label: "Hand written", extends: "claude" }]);
  });

  test("create on an existing id fails with duplicate_id", async () => {
    const home = createHome();
    const { service } = await makeService(home);
    await service.save({
      mode: "create",
      provider: { ...OPENAI_PROVIDER, baseUrl: "http://127.0.0.1:1/v1" },
    });
    await expect(
      service.save({
        mode: "create",
        provider: { ...OPENAI_PROVIDER, baseUrl: "http://127.0.0.1:2/v1" },
      }),
    ).rejects.toMatchObject({ code: "duplicate_id" });
  });

  test("update of an unknown provider fails with provider_not_found, env provider with provider_not_managed", async () => {
    const home = createHome();
    writeAgentProviderEntry(home, "hand", { extends: "claude", label: "Hand" });
    const { service } = await makeService(home);
    await expect(
      service.save({ mode: "update", provider: { ...OPENAI_PROVIDER, baseUrl: "http://x/v1" } }),
    ).rejects.toMatchObject({ code: "provider_not_found" });
    await expect(
      service.save({
        mode: "update",
        provider: { ...OPENAI_PROVIDER, id: "hand", baseUrl: "http://x/v1" },
      }),
    ).rejects.toMatchObject({ code: "provider_not_managed" });
    await expect(service.delete("hand")).rejects.toMatchObject({ code: "provider_not_managed" });
    await expect(service.delete("nope")).rejects.toMatchObject({ code: "provider_not_found" });
  });

  test("apiKey '' deletes the stored key, undefined keeps it", async () => {
    const home = createHome();
    const { service, secretStore } = await makeService(home);
    const provider = { ...OPENAI_PROVIDER, baseUrl: "http://127.0.0.1:1/v1" };
    await service.save({ mode: "create", provider, apiKey: "sk-one" });
    expect(await secretStore.get("provider.apikey.my-models")).toBe("sk-one");
    await service.save({ mode: "update", provider });
    expect(await secretStore.get("provider.apikey.my-models")).toBe("sk-one");
    await service.save({ mode: "update", provider, apiKey: "" });
    expect(await secretStore.get("provider.apikey.my-models")).toBeNull();
    const { providers } = await service.list();
    expect(providers[0]?.hasApiKey).toBe(false);
  });

  test("via ssh requires an existing SSH server when sshServerExists is provided", async () => {
    const home = createHome();
    const { service } = await makeService(home, {
      sshServerExists: (serverId: string) => serverId === "srv-1",
    });
    await expect(
      service.save({
        mode: "create",
        provider: {
          ...OPENAI_PROVIDER,
          baseUrl: "http://127.0.0.1:1/v1",
          via: "ssh",
          sshServerId: "nope",
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_provider" });
  });
});

describe("createCustomProviderService — save without models discovers them", () => {
  test("discovers models via the models endpoint and stores them", async () => {
    const home = createHome();
    await withHttpServer(
      (req, res) => {
        expect(req.url).toBe("/models");
        expect(req.headers["authorization"]).toBe("Bearer sk-disc");
        res.end(JSON.stringify({ data: [{ id: "llama3" }, { id: "qwen" }] }));
      },
      async (baseUrl) => {
        const { service } = await makeService(home);
        const record = await service.save({
          mode: "create",
          provider: {
            id: "disc",
            label: "Disc",
            protocol: "openai",
            baseUrl,
          },
          apiKey: "sk-disc",
        });
        expect(record.models).toEqual([
          { id: "llama3", label: "llama3" },
          { id: "qwen", label: "qwen" },
        ]);
      },
    );
  });

  test("failed discovery rejects the save with models_unavailable", async () => {
    const home = createHome();
    await withHttpServer(
      (_req, res) => {
        res.statusCode = 500;
        res.end("boom");
      },
      async (baseUrl) => {
        const { service } = await makeService(home);
        await expect(
          service.save({
            mode: "create",
            provider: { id: "disc", label: "Disc", protocol: "openai", baseUrl },
          }),
        ).rejects.toMatchObject({ code: "models_unavailable" });
        const { providers } = await service.list();
        expect(providers).toEqual([]);
      },
    );
  });
});

describe("createCustomProviderService — test", () => {
  test("openai: GET {baseUrl}/models with Bearer auth", async () => {
    const home = createHome();
    await withHttpServer(
      (req, res) => {
        expect(req.url).toBe("/models");
        expect(req.headers["authorization"]).toBe("Bearer sk-test");
        res.end(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }));
      },
      async (baseUrl) => {
        const { service } = await makeService(home);
        const result = await service.test({
          protocol: "openai",
          baseUrl,
          apiKey: "sk-test",
        });
        expect(result).toEqual({
          ok: true,
          models: [{ id: "a" }, { id: "b" }],
          error: null,
        });
      },
    );
  });

  test("anthropic: GET {baseUrl}/v1/models with x-api-key + anthropic-version", async () => {
    const home = createHome();
    await withHttpServer(
      (req, res) => {
        expect(req.url).toBe("/v1/models");
        expect(req.headers["x-api-key"]).toBe("sk-a");
        expect(req.headers["anthropic-version"]).toBe("2023-06-01");
        res.end(JSON.stringify({ data: [{ id: "claude-x" }] }));
      },
      async (baseUrl) => {
        const { service } = await makeService(home);
        const result = await service.test({
          protocol: "anthropic",
          baseUrl,
          apiKey: "sk-a",
        });
        expect(result.ok).toBe(true);
        expect(result.models).toEqual([{ id: "claude-x" }]);
      },
    );
  });

  test("a non-OK answer reports ok:false with an error code", async () => {
    const home = createHome();
    await withHttpServer(
      (_req, res) => {
        res.statusCode = 401;
        res.end("{}");
      },
      async (baseUrl) => {
        const { service } = await makeService(home);
        const result = await service.test({ protocol: "openai", baseUrl });
        expect(result.ok).toBe(false);
        expect(result.models).toEqual([]);
        expect(result.error?.code).toBe("endpoint_unreachable");
      },
    );
  });

  test("uses the stored key of `id` when no explicit key is given", async () => {
    const home = createHome();
    await withHttpServer(
      (req, res) => {
        expect(req.headers["authorization"]).toBe("Bearer sk-stored");
        res.end(JSON.stringify({ data: [] }));
      },
      async (baseUrl) => {
        const { service, secretStore } = await makeService(home);
        await secretStore.set("provider.apikey.stored", "sk-stored");
        const result = await service.test({ protocol: "openai", baseUrl, id: "stored" });
        expect(result.ok).toBe(true);
      },
    );
  });
});

describe("createCustomProviderService — delete", () => {
  test("removes the entry and the key, and hot-reloads with the removed id", async () => {
    const home = createHome();
    const { service, secretStore, reloadRegistry } = await makeService(home);
    await service.save({
      mode: "create",
      provider: { ...OPENAI_PROVIDER, baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-x" },
    });
    await service.delete("my-models");
    expect(readAgentProviderEntriesSafe(home)).toEqual({});
    expect(await secretStore.get("provider.apikey.my-models")).toBeNull();
    expect(reloadRegistry).toHaveBeenLastCalledWith(["my-models"]);
    const { providers } = await service.list();
    expect(providers).toEqual([]);
  });

  test("onChanged listeners fire after save and delete", async () => {
    const home = createHome();
    const { service } = await makeService(home);
    const listener = vi.fn();
    const unsubscribe = service.onChanged(listener);
    await service.save({
      mode: "create",
      provider: { ...OPENAI_PROVIDER, baseUrl: "http://127.0.0.1:1/v1" },
    });
    await service.delete("my-models");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    await service.save({
      mode: "create",
      provider: { ...OPENAI_PROVIDER, baseUrl: "http://127.0.0.1:1/v1" },
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

function readAgentProviderEntriesSafe(home: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path.join(home, "config.json"), "utf-8")) as {
      agents?: { providers?: Record<string, unknown> };
    };
    return parsed.agents?.providers ?? {};
  } catch {
    return {};
  }
}
