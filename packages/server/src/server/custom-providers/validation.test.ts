import { describe, expect, test } from "vitest";

import { validateSaveApiProviderInput, validateTestApiProviderInput } from "./validation.js";
import { CustomProviderError } from "./types.js";

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CustomProviderError);
    expect((error as CustomProviderError).code).toBe(code);
    return;
  }
  throw new Error(`expected CustomProviderError ${code}`);
}

describe("validateSaveApiProviderInput", () => {
  const base = {
    id: "my-models",
    label: "My models",
    protocol: "openai" as const,
    baseUrl: "http://127.0.0.1:11434/v1",
  };

  test("accepts a minimal input and defaults via to direct", () => {
    const validated = validateSaveApiProviderInput({ mode: "create", provider: base });
    expect(validated).toMatchObject({ id: "my-models", via: "direct", baseUrl: base.baseUrl });
  });

  test("rejects ids that are not lowercase-with-hyphens", () => {
    expectCode(
      () => validateSaveApiProviderInput({ mode: "create", provider: { ...base, id: "Bad_Id" } }),
      "invalid_provider",
    );
  });

  test("rejects non-http base URLs", () => {
    expectCode(
      () =>
        validateSaveApiProviderInput({ mode: "create", provider: { ...base, baseUrl: "ftp://x" } }),
      "invalid_provider",
    );
    expectCode(
      () =>
        validateSaveApiProviderInput({
          mode: "create",
          provider: { ...base, baseUrl: "not a url" },
        }),
      "invalid_provider",
    );
  });

  test("rejects unknown protocols", () => {
    expectCode(
      () =>
        validateSaveApiProviderInput({
          mode: "create",
          provider: { ...base, protocol: "gemini" as never },
        }),
      "invalid_provider",
    );
  });

  test("via ssh requires sshServerId", () => {
    expectCode(
      () => validateSaveApiProviderInput({ mode: "create", provider: { ...base, via: "ssh" } }),
      "invalid_provider",
    );
    const validated = validateSaveApiProviderInput({
      mode: "create",
      provider: { ...base, via: "ssh", sshServerId: "srv-1" },
    });
    expect(validated.sshServerId).toBe("srv-1");
  });

  test("sshServerId is only allowed with via ssh", () => {
    expectCode(
      () =>
        validateSaveApiProviderInput({
          mode: "create",
          provider: { ...base, sshServerId: "srv-1" },
        }),
      "invalid_provider",
    );
  });

  test("rejects an empty label", () => {
    expectCode(
      () => validateSaveApiProviderInput({ mode: "create", provider: { ...base, label: "  " } }),
      "invalid_provider",
    );
  });
});

describe("validateTestApiProviderInput", () => {
  test("defaults via to direct and returns the protocol", () => {
    const validated = validateTestApiProviderInput({
      protocol: "anthropic",
      baseUrl: "http://127.0.0.1:8080",
    });
    expect(validated).toEqual({
      protocol: "anthropic",
      baseUrl: "http://127.0.0.1:8080",
      via: "direct",
    });
  });

  test("via ssh requires sshServerId", () => {
    expectCode(
      () =>
        validateTestApiProviderInput({
          protocol: "openai",
          baseUrl: "http://127.0.0.1:8080",
          via: "ssh",
        }),
      "invalid_provider",
    );
  });
});
