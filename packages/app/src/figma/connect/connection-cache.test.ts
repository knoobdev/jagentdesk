import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { FigmaConnection } from "@jagentdesk/protocol/figma/rpc-schemas";
import { commitFigmaConnection, removeFigmaConnection } from "./connection-cache";

const connection: FigmaConnection = {
  id: "fgc_a1b2c3",
  account: { figmaUserId: "1", handle: "<account-handle>", email: "<account-email>" },
  authState: "connected",
  tokenExpiresAt_ms: 1_800_000_000_000,
  createdAt_ms: 1_700_000_000_000,
};
const key = ["figma", "host_a1", "connections"];
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
afterEach(() => queryClient.clear());

describe("Figma account mutations on a mounted query", () => {
  it("publishes OAuth success to the existing observer before completion returns", async () => {
    queryClient.setQueryData(key, []);
    const observer = new QueryObserver<FigmaConnection[]>(queryClient, { queryKey: key });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await commitFigmaConnection(queryClient, "host_a1", async () => ({ connection }));
      expect(observer.getCurrentResult().data).toEqual([connection]);
    } finally {
      unsubscribe();
    }
  });

  it("does not append a second row when Test or reauth returns the existing account", async () => {
    queryClient.setQueryData(key, [{ ...connection, authState: "needs_reauth" }]);
    await commitFigmaConnection(queryClient, "host_a1", async () => ({ connection }));
    expect(queryClient.getQueryData(key)).toEqual([connection]);
  });

  it("successful Remove updates the mounted account observer without remounting", async () => {
    queryClient.setQueryData(key, [connection]);
    const observer = new QueryObserver<FigmaConnection[]>(queryClient, { queryKey: key });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await removeFigmaConnection(queryClient, "host_a1", connection.id, async () => ({}));
      expect(observer.getCurrentResult().data).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("a list response started before Remove cannot restore the deleted account", async () => {
    queryClient.setQueryData(key, [connection]);
    let finishRead: (value: FigmaConnection[]) => void = () => {};
    const reading = queryClient
      .fetchQuery({
        queryKey: key,
        queryFn: () =>
          new Promise<FigmaConnection[]>((resolve) => {
            finishRead = resolve;
          }),
      })
      .catch(() => undefined);
    await removeFigmaConnection(queryClient, "host_a1", connection.id, async () => ({}));
    finishRead([connection]);
    await reading;
    expect(queryClient.getQueryData(key)).toEqual([]);
  });

  it("an empty read started before OAuth cannot hide the newly connected account", async () => {
    let finishRead: (value: FigmaConnection[]) => void = () => {};
    const reading = queryClient
      .fetchQuery({
        queryKey: key,
        queryFn: () =>
          new Promise<FigmaConnection[]>((resolve) => {
            finishRead = resolve;
          }),
      })
      .catch(() => undefined);
    await commitFigmaConnection(queryClient, "host_a1", async () => ({ connection }));
    finishRead([]);
    await reading;
    expect(queryClient.getQueryData(key)).toEqual([connection]);
  });

  it("failed Remove retains the connected account and propagates the error to the caller", async () => {
    queryClient.setQueryData(key, [connection]);
    const error = new Error("The host is offline.");
    await expect(
      removeFigmaConnection(queryClient, "host_a1", connection.id, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(queryClient.getQueryData(key)).toEqual([connection]);
  });

  it("failed or rejected OAuth leaves the current accounts intact", async () => {
    queryClient.setQueryData(key, [connection]);
    await commitFigmaConnection(queryClient, "host_a1", async () => ({ connection: null }));
    await expect(
      commitFigmaConnection(queryClient, "host_a1", async () => {
        throw new Error("Sign-in failed.");
      }),
    ).rejects.toThrow("Sign-in failed.");
    expect(queryClient.getQueryData(key)).toEqual([connection]);
  });

  it("Remove clears its files/teams while preserving another account and another host", async () => {
    const other = { ...connection, id: "fgc_d4e5f6" };
    queryClient.setQueryData(key, [connection, other]);
    queryClient.setQueryData(["figma", "host_b2", "connections"], [connection]);
    const allFiles = ["figma", "host_a1", "files", "*"];
    const ownFile = { fileKey: "file_a1", connectionId: connection.id };
    const otherFile = { fileKey: "file_b2", connectionId: other.id };
    queryClient.setQueryData(allFiles, [ownFile, otherFile]);
    queryClient.setQueryData(["figma", "host_a1", "files", connection.id], [ownFile]);
    queryClient.setQueryData(["figma", "host_a1", "teams", connection.id], [{ teamId: "1" }]);
    await removeFigmaConnection(queryClient, "host_a1", connection.id, async () => ({}));
    expect(queryClient.getQueryData(key)).toEqual([other]);
    expect(queryClient.getQueryData(["figma", "host_b2", "connections"])).toEqual([connection]);
    expect(queryClient.getQueryData(allFiles)).toEqual([otherFile]);
    expect(queryClient.getQueryData(["figma", "host_a1", "files", connection.id])).toEqual([]);
    expect(queryClient.getQueryData(["figma", "host_a1", "teams", connection.id])).toBeUndefined();
  });

  // ADR-0043: per-file reads outlive their screen — page snapshots in particular are shared
  // cache entries. A removed account's snapshots (cached or in flight) must retire with it,
  // while another account's file reads stay untouched.
  it("Remove retires the removed account's per-file reads and keeps other accounts' reads", async () => {
    const other = { ...connection, id: "fgc_d4e5f6" };
    queryClient.setQueryData(key, [connection, other]);
    const allFiles = ["figma", "host_a1", "files", "*"];
    const ownFile = { fileKey: "file_a1", connectionId: connection.id, name: "Own" };
    const otherFile = { fileKey: "file_b2", connectionId: other.id, name: "Other" };
    queryClient.setQueryData(allFiles, [ownFile, otherFile]);
    const ownPageKey = ["figma", "host_a1", "file_a1", "page-outline", "v1", "0:1"];
    const ownIndexKey = ["figma", "host_a1", "file_a1", "page-index", "live"];
    const ownOutlineKey = ["figma", "host_a1", "outline", "file_a1", "latest"];
    const ownNodesKey = ["figma", "host_a1", "nodes", "file_a1", "latest", "0:1"];
    const otherPageKey = ["figma", "host_a1", "file_b2", "page-outline", "v1", "0:1"];
    queryClient.setQueryData(ownPageKey, { fileKey: "file_a1" });
    queryClient.setQueryData(ownIndexKey, { pages: [] });
    queryClient.setQueryData(ownOutlineKey, { fileKey: "file_a1" });
    queryClient.setQueryData(ownNodesKey, { frames: {} });
    queryClient.setQueryData(otherPageKey, { fileKey: "file_b2" });
    // An in-flight page read for the removed account's file must not land after removal.
    let finishPageRead: (value: unknown) => void = () => {};
    const inflightKey = ["figma", "host_a1", "file_a1", "page-outline", "v2", "0:1"];
    const inflight = queryClient
      .fetchQuery({
        queryKey: inflightKey,
        queryFn: () =>
          new Promise((resolve) => {
            finishPageRead = resolve;
          }),
      })
      .catch(() => undefined);
    await removeFigmaConnection(queryClient, "host_a1", connection.id, async () => ({}));
    finishPageRead({ fileKey: "file_a1" });
    await inflight;
    expect(queryClient.getQueryData(ownPageKey)).toBeUndefined();
    expect(queryClient.getQueryData(ownIndexKey)).toBeUndefined();
    expect(queryClient.getQueryData(ownOutlineKey)).toBeUndefined();
    expect(queryClient.getQueryData(ownNodesKey)).toBeUndefined();
    expect(queryClient.getQueryData(inflightKey)).toBeUndefined();
    expect(queryClient.getQueryData(otherPageKey)).toEqual({ fileKey: "file_b2" });
  });
});
