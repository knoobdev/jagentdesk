import { describe, expect, test } from "vitest";

import {
  applyClaudeSpawnEnvOverlay,
  buildClaudeSpawnEnv,
  buildOpenCodeProviderConfig,
  mergeOpenCodeConfigContent,
} from "./materialization.js";

describe("buildOpenCodeProviderConfig", () => {
  test("produces an @ai-sdk/openai-compatible provider with baseURL and apiKey", () => {
    const config = buildOpenCodeProviderConfig(
      {
        label: "My models",
        protocol: "openai",
        models: [{ id: "m1", label: "M1" }],
      },
      { baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-test" },
    );
    expect(config).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "My models",
      options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "sk-test" },
      models: { m1: { name: "M1" } },
    });
  });

  test("maps thinking options to reasoningEffort variants", () => {
    const config = buildOpenCodeProviderConfig(
      {
        label: "My models",
        protocol: "openai",
        models: [
          {
            id: "m1",
            label: "M1",
            thinkingOptions: [
              { id: "low", label: "Low" },
              { id: "high", label: "High", isDefault: true },
            ],
          },
        ],
      },
      { baseUrl: "http://127.0.0.1:9/v1", apiKey: null },
    );
    expect((config.models as Record<string, unknown>)["m1"]).toEqual({
      name: "M1",
      variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } },
    });
    expect((config.options as Record<string, unknown>).apiKey).toBeUndefined();
  });
});

describe("buildClaudeSpawnEnv", () => {
  test("sets ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN", () => {
    expect(buildClaudeSpawnEnv({ baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-a" })).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9/v1",
      ANTHROPIC_AUTH_TOKEN: "sk-a",
    });
  });

  test("always sets the token: the literal no-key when there is no key", () => {
    expect(buildClaudeSpawnEnv({ baseUrl: "http://127.0.0.1:9/v1", apiKey: null })).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9/v1",
      ANTHROPIC_AUTH_TOKEN: "no-key",
    });
  });
});

describe("applyClaudeSpawnEnvOverlay", () => {
  test("a parent env with ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN does not reach the spawn env", () => {
    const env = applyClaudeSpawnEnvOverlay(
      {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "sk-user-own",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-user",
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      },
      { ANTHROPIC_BASE_URL: "http://127.0.0.1:9/v1", ANTHROPIC_AUTH_TOKEN: "sk-provider" },
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9/v1",
      ANTHROPIC_AUTH_TOKEN: "sk-provider",
    });
  });

  test("without an overlay the parent env is kept untouched", () => {
    const base = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-user-own" };
    expect(applyClaudeSpawnEnvOverlay(base, {})).toEqual(base);
  });
});

describe("mergeOpenCodeConfigContent", () => {
  test("adds the provider to an inherited config and keeps the rest", () => {
    const inherited = JSON.stringify({
      model: "x",
      provider: { existing: { npm: "@ai-sdk/anthropic" } },
    });
    const merged = mergeOpenCodeConfigContent(inherited, {
      id: "my-models",
      config: { npm: "@ai-sdk/openai-compatible" },
    });
    const parsed = JSON.parse(merged) as Record<string, unknown>;
    expect(parsed["model"]).toBe("x");
    expect((parsed["provider"] as Record<string, unknown>)["existing"]).toEqual({
      npm: "@ai-sdk/anthropic",
    });
    expect((parsed["provider"] as Record<string, unknown>)["my-models"]).toEqual({
      npm: "@ai-sdk/openai-compatible",
    });
  });

  test("starts from an empty object for missing or invalid inherited config", () => {
    const merged = mergeOpenCodeConfigContent(undefined, {
      id: "p",
      config: { npm: "x" },
    });
    expect(JSON.parse(merged)).toEqual({ provider: { p: { npm: "x" } } });
    const mergedInvalid = mergeOpenCodeConfigContent("{oops", { id: "p", config: { npm: "x" } });
    expect(JSON.parse(mergedInvalid)).toEqual({ provider: { p: { npm: "x" } } });
  });
});
