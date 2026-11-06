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
});
