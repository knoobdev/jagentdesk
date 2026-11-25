// agent-tools.test.ts — the five provider_* agent tools against an in-test fake implementing
// CustomProviderService. Proves: list/test auto-run while add/update/remove raise the permission
// card, the card shows id/label/protocol/baseUrl/via/model count/hasApiKey (and the SSH server
// label for via:"ssh") and NEVER the key, no tool output contains the key, via:"ssh" without
// sshServerId fails fast, and a denial maps to exactly "The user declined".
import { describe, expect, it, vi } from "vitest";

import type { AgentPermissionResponse } from "../../../packages/server/src/server/agent/agent-sdk-types.js";
import type { JAgentDeskToolResult } from "../../../packages/server/src/server/agent/tools/types.js";
import {
  createCustomProviderAgentTools,
  type CustomProviderAgentToolDependencies,
  type CustomProviderPermissionRequest,
} from "./agent-tools.js";
import {
  CustomProviderError,
  type CustomProviderService,
} from "../../../packages/server/src/server/custom-providers/types.js";

const record = {
  id: "local-llama",
  label: "Local Llama",
  protocol: "openai" as const,
  baseUrl: "http://127.0.0.1:11434/v1",
  via: "ssh" as const,
  sshServerId: "srv_a",
  hasApiKey: true,
  models: [{ id: "llama3", label: "Llama 3" }],
  enabled: true,
};

function createFakeService(overrides: Partial<CustomProviderService> = {}): CustomProviderService {
  return {
    list: vi.fn(async () => ({ providers: [record], envProviders: [] })),
    save: vi.fn(async () => record),
    delete: vi.fn(async () => undefined),
    test: vi.fn(async () => ({ ok: true, models: [{ id: "llama3" }], error: null })),
    onChanged: vi.fn(() => () => {}),
    ...overrides,
  };
}

interface Harness {
  deps: CustomProviderAgentToolDependencies;
  service: CustomProviderService;
  asked: CustomProviderPermissionRequest[];
}

function createHarness(
  overrides: {
    service?: Partial<CustomProviderService>;
    callerAgentId?: string | null;
    decisions?: AgentPermissionResponse[];
    deps?: Partial<CustomProviderAgentToolDependencies>;
  } = {},
): Harness {
  const service = createFakeService(overrides.service);
  const asked: CustomProviderPermissionRequest[] = [];
  const decisions = overrides.decisions ?? [{ behavior: "allow" }];
  let decisionIndex = 0;
  const deps: CustomProviderAgentToolDependencies = {
    service,
    callerAgentId: overrides.callerAgentId === undefined ? "agt_1" : overrides.callerAgentId,
    requestPermission: async (_agentId, request) => {
      asked.push(request);
      const decision = decisions[Math.min(decisionIndex, decisions.length - 1)];
      decisionIndex += 1;
      return decision;
    },
    sshServerLabel: (serverId) => (serverId === "srv_a" ? "build box" : null),
    ...overrides.deps,
  };
  return { deps, service, asked };
}

function tool(deps: CustomProviderAgentToolDependencies, name: string) {
  const found = createCustomProviderAgentTools(deps).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool ${name} not offered`);
  return found;
}

function text(result: JAgentDeskToolResult): string {
  return result.content[0].text ?? "";
}

async function run(deps: CustomProviderAgentToolDependencies, name: string, input?: unknown) {
  return tool(deps, name).handler(input ?? {});
}

describe("createCustomProviderAgentTools", () => {
  it("offers exactly the five spec 34.7 tools", () => {
    const { deps } = createHarness();
    expect(createCustomProviderAgentTools(deps).map((candidate) => candidate.name)).toEqual([
      "provider_list",
      "provider_test",
      "provider_add",
      "provider_update",
      "provider_remove",
    ]);
  });

  it("flags exactly provider_add, provider_update and provider_remove as needing permission", () => {
    const { deps } = createHarness();
    const needs = createCustomProviderAgentTools(deps)
      .filter((candidate) => candidate.requiresPermission)
      .map((candidate) => candidate.name);
    expect(needs).toEqual(["provider_add", "provider_update", "provider_remove"]);
  });
});

describe("provider_list", () => {
  it("returns providers and env providers without asking and without any key", async () => {
    const { deps, asked } = createHarness();
    const result = await run(deps, "provider_list");
    expect(asked).toEqual([]);
    expect(JSON.parse(text(result))).toEqual({
      providers: [record],
      envProviders: [],
    });
    expect(text(result)).not.toContain("sk-secret");
  });
});

describe("provider_test", () => {
  it("runs without a permission card and returns the test result", async () => {
    const { deps, service, asked } = createHarness();
    const result = await run(deps, "provider_test", {
      protocol: "openai",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "sk-secret",
    });
    expect(asked).toEqual([]);
    expect(service.test).toHaveBeenCalledWith({
      protocol: "openai",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "sk-secret",
    });
    expect(JSON.parse(text(result))).toEqual({ ok: true, models: [{ id: "llama3" }], error: null });
    expect(text(result)).not.toContain("sk-secret");
  });

  it("rejects via ssh without sshServerId", async () => {
    const { deps, service } = createHarness();
    const result = await run(deps, "provider_test", {
      protocol: "openai",
      baseUrl: "http://127.0.0.1:11434/v1",
      via: "ssh",
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('via "ssh" needs sshServerId: the SSH server to tunnel through.');
    expect(service.test).not.toHaveBeenCalled();
  });

  it("rejects sshServerId without via ssh", async () => {
    const { deps, service } = createHarness();
    const result = await run(deps, "provider_test", {
      protocol: "openai",
      baseUrl: "http://127.0.0.1:11434/v1",
      sshServerId: "srv_a",
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('sshServerId is only valid when via is "ssh".');
    expect(service.test).not.toHaveBeenCalled();
  });
});

describe("provider_add", () => {
  const input = {
    id: "local-llama",
    label: "Local Llama",
    protocol: "openai",
    baseUrl: "http://127.0.0.1:11434/v1",
    via: "ssh",
    sshServerId: "srv_a",
    apiKey: "sk-secret",
    models: [{ id: "llama3", label: "Llama 3" }],
  };

  it("asks with the card summary and saves on approval", async () => {
    const { deps, service, asked } = createHarness();
    const result = await run(deps, "provider_add", input);
    expect(asked).toEqual([
      {
        kind: "tool",
        name: "provider_add",
        title: "Add provider Local Llama",
        description: "openai endpoint http://127.0.0.1:11434/v1",
        input: {
          id: "local-llama",
          label: "Local Llama",
          protocol: "openai",
          baseUrl: "http://127.0.0.1:11434/v1",
          via: "ssh",
          server: "build box",
          models: 1,
          hasApiKey: true,
        },
      },
    ]);
    expect(service.save).toHaveBeenCalledWith({
      mode: "create",
      provider: {
        id: "local-llama",
        label: "Local Llama",
        protocol: "openai",
        baseUrl: "http://127.0.0.1:11434/v1",
        via: "ssh",
        sshServerId: "srv_a",
        models: [{ id: "llama3", label: "Llama 3" }],
      },
      apiKey: "sk-secret",
    });
    expect(text(result)).not.toContain("sk-secret");
  });

  it("never puts the key on the card", async () => {
    const { deps, asked } = createHarness();
    await run(deps, "provider_add", input);
    expect(JSON.stringify(asked)).not.toContain("sk-secret");
  });

  it("maps a denial to exactly 'The user declined' and saves nothing", async () => {
    const { deps, service } = createHarness({ decisions: [{ behavior: "deny" }] });
    const result = await run(deps, "provider_add", input);
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("The user declined");
    expect(service.save).not.toHaveBeenCalled();
  });

  it("fails fast when via is ssh without sshServerId, before the card", async () => {
    const { deps, asked, service } = createHarness();
    const result = await run(deps, "provider_add", { ...input, sshServerId: undefined });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('via "ssh" needs sshServerId: the SSH server to tunnel through.');
    expect(asked).toEqual([]);
    expect(service.save).not.toHaveBeenCalled();
  });
});

describe("provider_update", () => {
  it("asks with the changed fields and saves an update that keeps untouched values", async () => {
    const { deps, service, asked } = createHarness();
    const result = await run(deps, "provider_update", {
      id: "local-llama",
      label: "Renamed",
      apiKey: "",
    });
    expect(asked[0]?.name).toBe("provider_update");
    expect(asked[0]?.input).toMatchObject({
      id: "local-llama",
      label: "Renamed",
      protocol: "openai",
      baseUrl: "http://127.0.0.1:11434/v1",
      via: "ssh",
      server: "build box",
      hasApiKey: false,
      changed: ["label", "apiKey"],
    });
    expect(JSON.stringify(asked)).not.toContain("sk-secret");
    expect(service.save).toHaveBeenCalledWith({
      mode: "update",
      provider: {
        id: "local-llama",
        label: "Renamed",
        protocol: "openai",
        baseUrl: "http://127.0.0.1:11434/v1",
        via: "ssh",
        sshServerId: "srv_a",
      },
      apiKey: "",
    });
    expect(text(result)).not.toContain("sk-secret");
  });

  it("surfaces provider_not_managed for a hand-written env provider", async () => {
    const { deps } = createHarness({
      service: {
        save: vi.fn(async () => {
          throw new CustomProviderError("provider_not_managed", "my-env-provider is env-based");
        }),
      },
    });
    const result = await run(deps, "provider_update", { id: "my-env-provider", label: "X" });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("provider_not_managed: my-env-provider is env-based");
  });
});

describe("provider_remove", () => {
  it("asks with the provider summary (no key) and deletes on approval", async () => {
    const { deps, service, asked } = createHarness();
    const result = await run(deps, "provider_remove", { id: "local-llama" });
    expect(asked).toEqual([
      {
        kind: "tool",
        name: "provider_remove",
        title: "Remove provider Local Llama",
        description: "openai endpoint http://127.0.0.1:11434/v1",
        input: {
          id: "local-llama",
          label: "Local Llama",
          protocol: "openai",
          baseUrl: "http://127.0.0.1:11434/v1",
          via: "ssh",
          server: "build box",
          models: 1,
          hasApiKey: true,
        },
      },
    ]);
    expect(service.delete).toHaveBeenCalledWith("local-llama");
    expect(JSON.parse(text(result))).toEqual({ id: "local-llama", removed: true });
    expect(JSON.stringify(asked) + text(result)).not.toContain("sk-secret");
  });

  it("still asks when the provider is unknown", async () => {
    const { deps, asked, service } = createHarness();
    const result = await run(deps, "provider_remove", { id: "gone" });
    expect(asked[0]?.title).toBe("Remove provider gone");
    expect(asked[0]?.input).toEqual({ id: "gone" });
    expect(service.delete).toHaveBeenCalledWith("gone");
    expect(JSON.parse(text(result))).toEqual({ id: "gone", removed: true });
  });
});
