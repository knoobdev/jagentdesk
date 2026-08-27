import { describe, expect, it } from "vitest";
import {
  parseTimingOutHosts,
  removeTimingOutHost,
  serializeTimingOutHosts,
  upsertTimingOutHost,
  type TimingOutHostEntry,
} from "./timing-out-hosts";

const tailnetEntry: TimingOutHostEntry = {
  serverId: "srv_tail",
  label: "Studio",
  kind: "tailnet",
  updatedAt: 1_724_800_000_000,
};
const localEntry: TimingOutHostEntry = {
  serverId: "srv_local",
  label: "Laptop",
  kind: "local",
  updatedAt: 1_724_800_100_000,
};

describe("timing-out hosts serialization", () => {
  it("round-trips through serialize/parse", () => {
    const raw = serializeTimingOutHosts([tailnetEntry, localEntry]);
    expect(parseTimingOutHosts(raw)).toEqual([tailnetEntry, localEntry]);
  });

  it("returns an empty list for null, invalid JSON, or a non-array", () => {
    expect(parseTimingOutHosts(null)).toEqual([]);
    expect(parseTimingOutHosts("not json")).toEqual([]);
    expect(parseTimingOutHosts('{"serverId":"x"}')).toEqual([]);
  });

  it("drops entries with a missing serverId or unknown kind, and de-dupes by serverId", () => {
    const raw = JSON.stringify([
      { serverId: "", kind: "local", updatedAt: 1 },
      { serverId: "srv_x", kind: "bogus", updatedAt: 1 },
      { serverId: "srv_ok", kind: "tailnet", updatedAt: 2 },
      { serverId: "srv_ok", kind: "local", updatedAt: 3 },
    ]);
    const parsed = parseTimingOutHosts(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ serverId: "srv_ok", kind: "tailnet", label: "srv_ok" });
  });
});

describe("upsertTimingOutHost / removeTimingOutHost", () => {
  it("adds a new host", () => {
    const next = upsertTimingOutHost([tailnetEntry], localEntry);
    expect(next).toHaveLength(2);
    expect(next).toContainEqual(localEntry);
  });

  it("keeps the same reference when the host is already present in the same state", () => {
    const entries = [tailnetEntry];
    const next = upsertTimingOutHost(entries, { ...tailnetEntry, updatedAt: 9_999 });
    expect(next).toBe(entries);
  });

  it("replaces the entry when the kind changes", () => {
    const next = upsertTimingOutHost([tailnetEntry], { ...tailnetEntry, kind: "local" });
    expect(next).toHaveLength(1);
    expect(next[0].kind).toBe("local");
  });

  it("removes a host, returning the same reference when absent", () => {
    const entries = [tailnetEntry, localEntry];
    expect(removeTimingOutHost(entries, "srv_local")).toEqual([tailnetEntry]);
    expect(removeTimingOutHost(entries, "srv_absent")).toBe(entries);
  });
});
