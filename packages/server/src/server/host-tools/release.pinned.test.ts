import { describe, expect, it } from "vitest";
import { getToolDefinition } from "./registry.js";
import { ToolInstallError, resolveRelease } from "./release.js";

const noNetwork = async () => {
  throw new Error("pinned releases must not call a release API");
};

describe("pinned sideload helpers", () => {
  it("resolves zsign for macOS arm64 to the reviewed asset and digest", async () => {
    const release = await resolveRelease({
      fetch: noNetwork,
      tool: getToolDefinition("zsign")!,
      target: { os: "darwin", arch: "arm64" },
    });
    expect(release).toMatchObject({
      version: "1.1.3",
      url: "https://github.com/zhlynn/zsign/releases/download/v1.1.3/zsign-macos-arm64.tar.gz",
      sha256: "2790ec58a55db5f4282843d0cdbb0b587d19b972331b5285aee2de67f4ab705e",
    });
  });

  it("installs the static zsign on Linux amd64 under the name zsign", async () => {
    const release = await resolveRelease({
      fetch: noNetwork,
      tool: getToolDefinition("zsign")!,
      target: { os: "linux", arch: "amd64" },
    });
    expect(release.asset).toEqual({
      asset: "zsign-linux-musl-static.tar.gz",
      kind: "tar.gz",
      binaryName: "zsign-musl",
      installAs: "zsign",
    });
  });

  it("resolves go-ios per OS and reports hosts with no zsign build", async () => {
    const linux = await resolveRelease({
      fetch: noNetwork,
      tool: getToolDefinition("go-ios")!,
      target: { os: "linux", arch: "arm64" },
    });
    expect(linux.asset).toMatchObject({ binaryName: "ios-arm64", installAs: "ios" });
    expect(linux.sha256).toBe("a55fdb4c507391c0548252e01d1deb6ae3c7fd99cfbce842c6f80569cc125604");
    await expect(
      resolveRelease({
        fetch: noNetwork,
        tool: getToolDefinition("zsign")!,
        target: { os: "darwin", arch: "amd64" },
      }),
    ).rejects.toBeInstanceOf(ToolInstallError);
  });
});
