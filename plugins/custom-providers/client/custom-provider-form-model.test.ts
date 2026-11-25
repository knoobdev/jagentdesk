import { describe, expect, it } from "vitest";
import type { ApiProviderRecord } from "./types";
import {
  mergeDiscoveredModels,
  openCustomProviderForm,
  slugifyProviderId,
} from "./custom-provider-form-model";

function makeRecord(overrides: Partial<ApiProviderRecord> = {}): ApiProviderRecord {
  return {
    id: "my-server",
    label: "My Server",
    protocol: "openai",
    baseUrl: "http://127.0.0.1:11434/v1",
    via: "ssh",
    sshServerId: "srv-1",
    hasApiKey: true,
    models: [
      {
        id: "m1",
        label: "Model One",
        isDefault: true,
        thinkingOptions: [{ id: "low", label: "Low", isDefault: true }],
      },
      { id: "m2", label: "Model Two" },
    ],
    enabled: true,
    ...overrides,
  };
}

describe("slugifyProviderId", () => {
  it("lowercases, collapses separators and strips leading non-letters", () => {
    expect(slugifyProviderId("My Server!")).toBe("my-server");
    expect(slugifyProviderId("  Local LLM  ")).toBe("local-llm");
    expect(slugifyProviderId("123abc")).toBe("abc");
    expect(slugifyProviderId("---")).toBe("");
  });
});

describe("custom provider form model — create", () => {
  it("derives the ID from the name until the user edits it", () => {
    const model = openCustomProviderForm({ mode: "create", record: null, sshServers: [] });
    model.setName("My Server");
    expect(model.getState().id).toBe("my-server");
    model.setId("custom-id");
    model.setName("Other Name");
    expect(model.getState().id).toBe("custom-id");
  });

  it("builds a create payload without apiKey when the draft is empty", () => {
    const model = openCustomProviderForm({ mode: "create", record: null, sshServers: [] });
    model.setName("My Server");
    model.setBaseUrl("https://api.example.com/v1");
    expect(model.getState().canSubmit).toBe(true);
    const payload = model.buildSavePayload();
    expect(payload.mode).toBe("create");
    expect(payload.provider).toMatchObject({
      id: "my-server",
      label: "My Server",
      protocol: "openai",
      baseUrl: "https://api.example.com/v1",
      via: "direct",
    });
    expect(payload.provider.sshServerId).toBeUndefined();
    expect(payload.apiKey).toBeUndefined();
  });

  it("sends the typed draft as apiKey on create", () => {
    const model = openCustomProviderForm({ mode: "create", record: null, sshServers: [] });
    model.setName("My Server");
    model.setBaseUrl("https://api.example.com/v1");
    model.setApiKeyDraft("  sk-test  ");
    expect(model.buildSavePayload().apiKey).toBe("sk-test");
  });

  it("requires an SSH server only for the ssh route", () => {
    const model = openCustomProviderForm({ mode: "create", record: null, sshServers: [] });
    model.setName("My Server");
    model.setBaseUrl("https://api.example.com/v1");
    model.setVia("ssh");
    expect(model.getState().errors.sshServerId).toBe("required");
    expect(model.getState().canSubmit).toBe(false);
    model.setSshServerId("srv-1");
    expect(model.getState().errors.sshServerId).toBeNull();
    expect(model.getState().canSubmit).toBe(true);
    const payload = model.buildSavePayload();
    expect(payload.provider.via).toBe("ssh");
    expect(payload.provider.sshServerId).toBe("srv-1");
    const testInput = model.buildTestInput();
    expect(testInput.sshServerId).toBe("srv-1");
    expect(testInput.id).toBeUndefined();
  });

  it("rejects an invalid ID and an empty base URL", () => {
    const model = openCustomProviderForm({ mode: "create", record: null, sshServers: [] });
    model.setName("My Server");
    model.setId("Bad ID");
    model.setBaseUrl("not-a-url");
    expect(model.getState().errors.id).toBe("invalid");
    expect(model.getState().errors.baseUrl).toBe("invalid");
    expect(model.getState().canSubmit).toBe(false);
  });
});

describe("custom provider form model — update", () => {
  it("seeds every field from the record and locks the ID", () => {
    const model = openCustomProviderForm({
      mode: "update",
      record: makeRecord(),
      sshServers: [],
    });
    const state = model.getState();
    expect(state.name).toBe("My Server");
    expect(state.id).toBe("my-server");
    expect(state.via).toBe("ssh");
    expect(state.sshServerId).toBe("srv-1");
    expect(state.hasStoredKey).toBe(true);
    expect(state.models.map((row) => row.id)).toEqual(["m1", "m2"]);
    model.setId("changed");
    expect(model.getState().id).toBe("my-server");
  });

  it('omits apiKey when nothing changed, sends "" after clear, and the draft when typed', () => {
    const model = openCustomProviderForm({
      mode: "update",
      record: makeRecord(),
      sshServers: [],
    });
    expect(model.buildSavePayload().apiKey).toBeUndefined();
    model.clearApiKey();
    expect(model.buildSavePayload().apiKey).toBe("");
    model.setApiKeyDraft("sk-new");
    expect(model.buildSavePayload().apiKey).toBe("sk-new");
  });

  it("uses the stored key for the test call by omitting apiKey", () => {
    const model = openCustomProviderForm({
      mode: "update",
      record: makeRecord(),
      sshServers: [],
    });
    const testInput = model.buildTestInput();
    expect(testInput.id).toBe("my-server");
    expect(testInput.apiKey).toBeUndefined();
    expect(testInput.baseUrl).toBe("http://127.0.0.1:11434/v1");
  });

  it("keeps the models payload when the record already has models", () => {
    const model = openCustomProviderForm({
      mode: "update",
      record: makeRecord(),
      sshServers: [],
    });
    const payload = model.buildSavePayload();
    expect(payload.provider.models).toHaveLength(2);
    expect(payload.provider.models?.[0]).toMatchObject({
      id: "m1",
      label: "Model One",
      isDefault: true,
      thinkingOptions: [{ id: "low", label: "Low", isDefault: true }],
    });
  });
});

describe("custom provider form model — model rows", () => {
  it("keeps exactly one default row", () => {
    const model = openCustomProviderForm({ mode: "create", record: null, sshServers: [] });
    model.addModelRow();
    model.updateModelRow(0, { id: "m1", label: "One" });
    model.addModelRow();
    model.updateModelRow(1, { id: "m2", label: "Two" });
    expect(model.getState().models[0]?.isDefault).toBe(true);
    model.setDefaultModel(1);
    expect(model.getState().models.map((row) => row.isDefault)).toEqual([false, true]);
  });

  it("adds thinking options without duplicates and supports default + remove", () => {
    const model = openCustomProviderForm({
      mode: "update",
      record: makeRecord(),
      sshServers: [],
    });
    model.addThinkingOption(0, "high");
    model.addThinkingOption(0, "high");
    const options = model.getState().models[0]?.thinkingOptions ?? [];
    expect(options.map((option) => option.id)).toEqual(["low", "high"]);
    model.setDefaultThinkingOption(0, "high");
    expect(
      model.getState().models[0]?.thinkingOptions.find((option) => option.id === "high")?.isDefault,
    ).toBe(true);
    expect(
      model.getState().models[0]?.thinkingOptions.find((option) => option.id === "low")?.isDefault,
    ).toBe(false);
    model.removeThinkingOption(0, "low");
    expect(model.getState().models[0]?.thinkingOptions.map((option) => option.id)).toEqual([
      "high",
    ]);
  });
});

describe("mergeDiscoveredModels", () => {
  it("keeps existing rows intact and appends unknown discovered ids", () => {
    const existing = [
      {
        rowKey: "r1",
        id: "m1",
        label: "Custom label",
        isDefault: true,
        thinkingOptions: [{ id: "low", label: "Low", isDefault: true }],
      },
      { rowKey: "r2", id: "manual", label: "Manual row", isDefault: false, thinkingOptions: [] },
    ];
    const merged = mergeDiscoveredModels(existing, ["m2", "m1", ""]);
    expect(merged.map((row) => row.id)).toEqual(["m1", "manual", "m2"]);
    expect(merged[0]).toMatchObject({
      id: "m1",
      label: "Custom label",
      isDefault: true,
      thinkingOptions: [{ id: "low", label: "Low", isDefault: true }],
    });
    expect(merged[2]).toMatchObject({ id: "m2", label: "m2", isDefault: false });
  });

  it("restores a default when the remaining rows have none", () => {
    const merged = mergeDiscoveredModels(
      [{ rowKey: "r1", id: "a", label: "A", isDefault: false, thinkingOptions: [] }],
      [],
    );
    expect(merged[0]?.isDefault).toBe(true);
  });
});

describe("applyDiscoverResult", () => {
  it("fills model rows on success and records the error text on failure", () => {
    const model = openCustomProviderForm({ mode: "create", record: null, sshServers: [] });
    model.setName("My Server");
    model.setBaseUrl("https://api.example.com/v1");
    model.beginDiscover();
    expect(model.getState().discoverStatus).toBe("pending");
    model.applyDiscoverResult({ ok: true, modelIds: ["m1", "m2"], errorMessage: null });
    expect(model.getState().discoverStatus).toBe("done");
    expect(model.getState().models.map((row) => row.id)).toEqual(["m1", "m2"]);
    model.applyDiscoverResult({ ok: false, modelIds: [], errorMessage: "boom" });
    expect(model.getState().discoverStatus).toBe("error");
    expect(model.getState().discoverError).toBe("boom");
    expect(model.getState().models.map((row) => row.id)).toEqual(["m1", "m2"]);
  });
});
