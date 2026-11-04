import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { browseHost, HostBrowseError, isInstallableFile } from "./host-browse.js";

describe("browseHost (26.9 Browse host…, ADR-0032 §9)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "jad-host-browse-"));
    await mkdir(path.join(root, "Build"));
    await mkdir(path.join(root, "archive"));
    await mkdir(path.join(root, ".cache"));
    await writeFile(path.join(root, "App.ipa"), Buffer.alloc(2048));
    await writeFile(path.join(root, "Other.IPA"), Buffer.alloc(16));
    await writeFile(path.join(root, ".Hidden.ipa"), "x");
    await writeFile(path.join(root, "app-release.apk"), Buffer.alloc(64));
    await writeFile(path.join(root, "bundle.apks"), Buffer.alloc(32));
    await writeFile(path.join(root, "notes.txt"), "secret");
    await writeFile(path.join(root, "App.ipa.zip"), "x");
    await symlink(path.join(root, "Build"), path.join(root, "linked-build"));
    await symlink(path.join(root, "App.ipa"), path.join(root, "linked.ipa"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists sub-folders and only .ipa files with sizes for iOS", async () => {
    const result = await browseHost({ path: root, kind: "ios" });
    expect(result.path).toBe(root);
    expect(result.parent).toBe(path.dirname(root));
    expect(result.entries).toEqual([
      { name: "archive", kind: "directory" },
      { name: "Build", kind: "directory" },
      { name: "linked-build", kind: "directory" },
      { name: "App.ipa", kind: "file", size: 2048 },
      { name: "linked.ipa", kind: "file", size: 2048 },
      { name: "Other.IPA", kind: "file", size: 16 },
    ]);
  });

  it("lists only .apk and .apks files for Android", async () => {
    const result = await browseHost({ path: root, kind: "android" });
    expect(result.entries.filter((entry) => entry.kind === "file")).toEqual([
      { name: "app-release.apk", kind: "file", size: 64 },
      { name: "bundle.apks", kind: "file", size: 32 },
    ]);
  });

  it("opens the daemon home folder when no path is given", async () => {
    const result = await browseHost({ kind: "ios", homeDir: root });
    expect(result.path).toBe(root);
    expect(result.entries.map((entry) => entry.name)).toContain("App.ipa");
  });

  it("has no parent at the filesystem root", async () => {
    const result = await browseHost({ path: path.parse(root).root, kind: "ios" });
    expect(result.parent).toBeNull();
  });

  it("refuses relative paths, files and missing folders", async () => {
    await expect(browseHost({ path: "Build", kind: "ios" })).rejects.toMatchObject({
      code: "invalid_path",
    });
    await expect(
      browseHost({ path: path.join(root, "App.ipa"), kind: "ios" }),
    ).rejects.toMatchObject({ code: "not_a_directory" });
    await expect(
      browseHost({ path: path.join(root, "missing"), kind: "ios" }),
    ).rejects.toBeInstanceOf(HostBrowseError);
  });

  it("matches installable extensions case-insensitively", () => {
    expect(isInstallableFile("App.IPA", "ios")).toBe(true);
    expect(isInstallableFile("App.apk", "ios")).toBe(false);
    expect(isInstallableFile("split.APKS", "android")).toBe(true);
    expect(isInstallableFile("bundle.xapk", "android")).toBe(false);
  });
});
