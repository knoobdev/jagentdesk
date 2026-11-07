import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { FigmaOutline } from "@jagentdesk/protocol/figma/rpc-schemas";
import { pageOutlineKeys, readOutlineSnapshot } from "./page-outline-cache";

const clients: QueryClient[] = [];
afterEach(() => {
  for (const queries of clients.splice(0)) queries.clear();
});
const makeClient = () => {
  const q = new QueryClient();
  clients.push(q);
  return q;
};
const snapshot = (): FigmaOutline => ({
  fileKey: "file_a1b2c3",
  name: "<file>",
  version: "v1",
  lastModified_ms: 1,
  editorType: "figma",
  source: "rest",
  pages: [{ id: "1:1", name: "<page>", frames: [], flowStartingPoints: [], childrenLoaded: true }],
});
const params = { fileKey: "file_a1b2c3", pageId: "1:1", version: "v1" };
const key = pageOutlineKeys.page("srv_a1b2c3", params.fileKey, "v1", "1:1");

describe("page outline snapshots", () => {
  it("reuses an immutable page when another consumer mounts, but honors invalidation", async () => {
    const queries = makeClient();
    let reads = 0;
    const load = async () => {
      reads++;
      return snapshot();
    };
    const first = await queries.fetchQuery({
      queryKey: key,
      queryFn: () => readOutlineSnapshot(queries, key, params, load),
    });
    expect(await readOutlineSnapshot(queries, key, params, load)).toBe(first);
    expect(reads).toBe(1);
    await queries.invalidateQueries({ queryKey: key, refetchType: "none" });
    await readOutlineSnapshot(queries, key, params, load);
    expect(reads).toBe(2);
  });
  it("does not reuse a live index beyond the polling window", async () => {
    const queries = makeClient();
    let reads = 0;
    const index = { ...snapshot(), pages: [] };
    const indexKey = pageOutlineKeys.index("srv_a1b2c3", params.fileKey, null);
    queries.setQueryData(indexKey, index, { updatedAt: 1 });
    const load = async () => {
      reads++;
      return index;
    };
    expect(
      await readOutlineSnapshot(
        queries,
        indexKey,
        { fileKey: params.fileKey, pagesOnly: true },
        load,
        59_000,
      ),
    ).toBe(index);
    expect(reads).toBe(0);
    await readOutlineSnapshot(
      queries,
      indexKey,
      { fileKey: params.fileKey, pagesOnly: true },
      load,
      60_001,
    );
    expect(reads).toBe(1);
  });
  it.each([
    ["other file", { ...snapshot(), fileKey: "file_d4e5f6" }],
    ["other version", { ...snapshot(), version: "v2" }],
    [
      "unloaded page",
      { ...snapshot(), pages: [{ ...snapshot().pages[0]!, childrenLoaded: false }] },
    ],
    ["other page", { ...snapshot(), pages: [{ ...snapshot().pages[0]!, id: "1:2" }] }],
  ])("rejects %s rather than showing a completed empty canvas", async (_case, result) => {
    await expect(
      readOutlineSnapshot(makeClient(), key, params, async () => result),
    ).rejects.toThrow();
  });
  it("does not hide a failed refresh behind a cached successful snapshot", async () => {
    const queries = makeClient();
    queries.setQueryData(key, snapshot());
    await expect(
      queries.fetchQuery({
        queryKey: key,
        retry: false,
        queryFn: async () => {
          throw new Error("Host disconnected");
        },
      }),
    ).rejects.toThrow("Host disconnected");
    let reads = 0;
    await readOutlineSnapshot(queries, key, params, async () => {
      reads++;
      return snapshot();
    });
    expect(reads).toBe(1);
  });

  it("isolates snapshots between hosts, files, versions and pages", () => {
    const queries = makeClient();
    queries.setQueryData(key, snapshot());
    expect(
      queries.getQueryData(pageOutlineKeys.page("srv_d4e5f6", params.fileKey, "v1", "1:1")),
    ).toBeUndefined();
    expect(
      queries.getQueryData(pageOutlineKeys.page("srv_a1b2c3", "file_d4e5f6", "v1", "1:1")),
    ).toBeUndefined();
    expect(
      queries.getQueryData(pageOutlineKeys.page("srv_a1b2c3", params.fileKey, "v2", "1:1")),
    ).toBeUndefined();
    expect(
      queries.getQueryData(pageOutlineKeys.page("srv_a1b2c3", params.fileKey, "v1", "1:2")),
    ).toBeUndefined();
  });
});
