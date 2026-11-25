import { describe, expect, it } from "vitest";
import { formatBytes, hostCrumbs, joinHostPath } from "./host-browse";

describe("Browse host… path helpers (26.9)", () => {
  it("splits a POSIX daemon path into crumbs from the root", () => {
    expect(hostCrumbs("/home/builder/Build")).toEqual([
      { label: "/", path: "/" },
      { label: "home", path: "/home" },
      { label: "builder", path: "/home/builder" },
      { label: "Build", path: "/home/builder/Build" },
    ]);
    expect(hostCrumbs("/")).toEqual([{ label: "/", path: "/" }]);
  });

  it("splits a Windows daemon path into crumbs from the drive", () => {
    expect(hostCrumbs("C:\\Users\\builder")).toEqual([
      { label: "C:\\", path: "C:\\" },
      { label: "Users", path: "C:\\Users" },
      { label: "builder", path: "C:\\Users\\builder" },
    ]);
    expect(hostCrumbs("D:\\")).toEqual([{ label: "D:\\", path: "D:\\" }]);
  });

  it("joins with the daemon host's separator", () => {
    expect(joinHostPath("/home/builder", "App.ipa")).toBe("/home/builder/App.ipa");
    expect(joinHostPath("/", "tmp")).toBe("/tmp");
    expect(joinHostPath("C:\\Users", "builder")).toBe("C:\\Users\\builder");
    expect(joinHostPath("C:\\", "Users")).toBe("C:\\Users");
  });

  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(52_428_800)).toBe("50.0 MB");
  });
});
