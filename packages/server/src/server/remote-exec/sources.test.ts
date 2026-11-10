import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSourceSelection } from "./sources.js";

// Source resolution (spec 33.4 / ADR-0045): source selects directories inside the cwd; every
// error case throws RemoteExecError and never reaches the permission card or a job record.

let root: string;
let cwd: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "jad-remote-exec-src-"));
  cwd = path.join(root, "ws");
  await fs.mkdir(cwd);
  await fs.mkdir(path.join(cwd, "A"));
  await fs.mkdir(path.join(cwd, "B"));
  await fs.mkdir(path.join(cwd, "nested", "A"), { recursive: true });
  await fs.mkdir(path.join(root, "outside"));
  await fs.writeFile(path.join(cwd, "file.txt"), "not a directory\n");
  await fs.symlink(path.join(cwd, "A"), path.join(cwd, "link-inside"));
  await fs.symlink(root, path.join(cwd, "link-outside"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function selection(source?: string | string[], noCode?: boolean) {
  return resolveSourceSelection({ cwd, source, noCode });
}

describe("resolveSourceSelection", () => {
  it("returns the default selection when no source is given", async () => {
    expect(await selection()).toEqual({ kind: "default" });
  });

  it("returns noCode when sendCode is false and no source is given", async () => {
    expect(await selection(undefined, true)).toEqual({ kind: "noCode" });
  });

  it("resolves a relative and an absolute source with the resolved basename", async () => {
    const explicit = await selection("A");
    expect(explicit).toEqual({
      kind: "explicit",
      sources: [{ name: "A", absolutePath: await fs.realpath(path.join(cwd, "A")) }],
    });
    const absolute = await selection(path.join(cwd, "B"));
    expect(absolute).toEqual({
      kind: "explicit",
      sources: [{ name: "B", absolutePath: await fs.realpath(path.join(cwd, "B")) }],
    });
  });

  it("uses the basename of the resolved path for a symlink source", async () => {
    const explicit = await selection("link-inside");
    expect(explicit).toEqual({
      kind: "explicit",
      sources: [{ name: "A", absolutePath: await fs.realpath(path.join(cwd, "A")) }],
    });
  });

  it("accepts the cwd itself as a source", async () => {
    const explicit = await selection(".");
    expect(explicit).toEqual({
      kind: "explicit",
      sources: [{ name: "ws", absolutePath: await fs.realpath(cwd) }],
    });
  });

  it("throws invalid_source when sendCode: false is combined with source", async () => {
    await expect(selection("A", true)).rejects.toMatchObject({ code: "invalid_source" });
  });

  it("throws invalid_source for an empty array or empty entries", async () => {
    await expect(selection([])).rejects.toMatchObject({ code: "invalid_source" });
    await expect(selection([""])).rejects.toMatchObject({ code: "invalid_source" });
  });

  it("throws source_not_found for a missing path and for a file", async () => {
    await expect(selection("missing")).rejects.toMatchObject({ code: "source_not_found" });
    await expect(selection("file.txt")).rejects.toMatchObject({ code: "source_not_found" });
  });

  it("throws source_outside_workspace for a path outside cwd, including via a symlink", async () => {
    await expect(selection("../ws/A")).resolves.toMatchObject({ kind: "explicit" });
    await expect(selection("../outside")).rejects.toMatchObject({
      code: "source_outside_workspace",
    });
    await expect(selection("link-outside")).rejects.toMatchObject({
      code: "source_outside_workspace",
    });
  });

  it("merges duplicates of the same path", async () => {
    const explicit = await selection(["A", "./A", "link-inside"]);
    expect(explicit).toEqual({
      kind: "explicit",
      sources: [{ name: "A", absolutePath: await fs.realpath(path.join(cwd, "A")) }],
    });
  });

  it("throws source_name_conflict for two different paths with the same basename", async () => {
    await expect(selection(["A", path.join("nested", "A")])).rejects.toMatchObject({
      code: "source_name_conflict",
    });
  });

  it("accepts 8 sources and throws too_many_sources for 9", async () => {
    for (let i = 0; i < 8; i += 1) {
      await fs.mkdir(path.join(cwd, `d${i}`));
    }
    const eight = await selection(["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"]);
    expect(eight).toMatchObject({ kind: "explicit" });
    await expect(
      selection(["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "A"]),
    ).rejects.toMatchObject({ code: "too_many_sources" });
  });

  it("does not count merged duplicates against the cap", async () => {
    // Several spellings of the same directories; dedupe keeps the distinct count at 4.
    const explicit = await selection([
      "A",
      "./A",
      "link-inside",
      "B",
      "nested",
      "../ws/nested",
      "nested/./",
      "A/..",
      ".",
      "./",
    ]);
    expect(explicit).toMatchObject({ kind: "explicit" });
  });
});
