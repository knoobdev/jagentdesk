/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiProviderRecord, EnvProviderSummary } from "./types";
import type { CustomProvidersClient } from "./client";
import {
  useCustomProvidersList,
  type UseCustomProvidersListResult,
} from "./use-custom-providers-list";

interface FakeListResult {
  providers: ApiProviderRecord[];
  envProviders: EnvProviderSummary[];
}

function makeProvider(id: string): ApiProviderRecord {
  return {
    id,
    label: id,
    protocol: "openai",
    baseUrl: "https://api.example.com/v1",
    via: "direct",
    hasApiKey: false,
    models: [],
    enabled: true,
  };
}

function makeFakeClient(list: () => Promise<FakeListResult>): CustomProvidersClient & {
  listCalls: number;
  deletedIds: string[];
} {
  const client = {
    listCalls: 0,
    deletedIds: [] as string[],
    customProvidersList: () => {
      client.listCalls += 1;
      return list();
    },
    customProvidersSave: async () => ({ provider: makeProvider("x") }),
    customProvidersDelete: async (input: { id: string }) => {
      client.deletedIds.push(input.id);
    },
    customProvidersTest: async () => ({ ok: true, models: [], error: null }),
  };
  return client;
}

let latest: UseCustomProvidersListResult | null = null;

describe("useCustomProvidersList", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    latest = null;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
  });

  function renderWith(client: CustomProvidersClient | null): void {
    function Probe() {
      latest = useCustomProvidersList(client, true);
      return null;
    }
    root = createRoot(container!);
    act(() => {
      root?.render(<Probe />);
    });
  }

  it("reports connecting without a client, then loads once connected", async () => {
    const fake = makeFakeClient(async () => ({
      providers: [makeProvider("p1")],
      envProviders: [{ id: "env-1", label: "Env One", extends: "claude" }],
    }));
    renderWith(null);
    expect(latest?.state.status).toBe("connecting");

    // Reconnect: render the probe again with a client.
    await act(async () => {
      root?.render(<ProbeClient client={fake} />);
    });
    expect(latest?.state).toMatchObject({
      status: "loaded",
      providers: [expect.objectContaining({ id: "p1" })],
      envProviders: [expect.objectContaining({ id: "env-1" })],
    });
  });

  it("enters the error state with the RPC error text when the list call throws", async () => {
    const fake = makeFakeClient(async () => {
      throw new Error("daemon offline");
    });
    renderWith(fake);
    await act(async () => {});
    expect(latest?.state).toMatchObject({ status: "error", message: "daemon offline" });
  });

  it("deletes a provider through the client and reloads the list", async () => {
    let providers = [makeProvider("p1"), makeProvider("p2")];
    const fake = makeFakeClient(async () => ({ providers, envProviders: [] }));
    renderWith(fake);
    await act(async () => {});
    expect(latest?.state.status).toBe("loaded");

    await act(async () => {
      await latest?.remove("p1");
    });
    expect(fake.deletedIds).toEqual(["p1"]);
    // The fake list still returns the original snapshot; the delete triggered a reload.
    expect(fake.listCalls).toBe(2);

    // A refreshed fake list without the deleted provider is picked up by refresh().
    providers = [makeProvider("p2")];
    await act(async () => {
      await latest?.refresh();
    });
    expect(latest?.state).toMatchObject({
      status: "loaded",
      providers: [expect.objectContaining({ id: "p2" })],
    });
  });
});

function ProbeClient({ client }: { client: CustomProvidersClient | null }) {
  latest = useCustomProvidersList(client, true);
  return null;
}
