import { describe, expect, it } from "vitest";
import { readRemoteJobExtras } from "./remote-job-extras";

describe("readRemoteJobExtras", () => {
  it("returns empty extras for old-daemon records without the optional fields", () => {
    expect(readRemoteJobExtras({ id: "rjb_1", status: "running" })).toEqual({
      noCode: false,
      sources: [],
    });
  });

  it("returns empty extras for null or non-object jobs", () => {
    expect(readRemoteJobExtras(null)).toEqual({ noCode: false, sources: [] });
    expect(readRemoteJobExtras("rjb_1")).toEqual({ noCode: false, sources: [] });
  });

  it("reads noCode only when exactly true", () => {
    expect(readRemoteJobExtras({ noCode: true }).noCode).toBe(true);
    expect(readRemoteJobExtras({ noCode: false }).noCode).toBe(false);
    expect(readRemoteJobExtras({ noCode: "yes" }).noCode).toBe(false);
  });

  it("reads the source list", () => {
    const job = {
      sources: [
        { name: "A", path: "/ws/A", sync: { filesUploaded: 12, filesDeleted: 2 } },
        { name: "C", path: "/ws/C", sync: { filesUploaded: 0, filesDeleted: 0 } },
      ],
    };
    const extras = readRemoteJobExtras(job);
    expect(extras.sources.map((source) => source.name)).toEqual(["A", "C"]);
    expect(extras.sources[0]?.path).toBe("/ws/A");
    expect(extras.sources[0]?.sync).toEqual({ filesUploaded: 12, filesDeleted: 2 });
  });

  it("keeps a source without sync and drops malformed entries", () => {
    const extras = readRemoteJobExtras({
      sources: [
        { name: "A" },
        null,
        "A",
        { path: "/ws/B" },
        { name: "", path: "/ws/C" },
        { name: "D", sync: { filesUploaded: "many" } },
      ],
    });
    expect(extras.sources.map((source) => source.name)).toEqual(["A", "D"]);
    expect(extras.sources[0]?.sync).toBeUndefined();
    expect(extras.sources[1]?.sync).toBeUndefined();
  });

  it("ignores a non-array sources field", () => {
    expect(readRemoteJobExtras({ sources: "A" }).sources).toEqual([]);
  });
});
