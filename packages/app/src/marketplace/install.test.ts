import { describe, expect, it, vi } from "vitest";
import { installMarketplacePlugin } from "@/marketplace/install";

const url = "https://github.com/owner/plugins/tree/main/browser";

describe("installMarketplacePlugin", () => {
  it("installs the npm release when the entry has one", async () => {
    const installSourcePlugin = vi.fn(async () => undefined);
    await installMarketplacePlugin(
      { installSourcePlugin },
      { url, npm: { package: "@owner/browser", version: "1.0.2" } },
    );
    expect(installSourcePlugin).toHaveBeenCalledTimes(1);
    expect(installSourcePlugin).toHaveBeenCalledWith("npm:@owner/browser@1.0.2", {});
  });

  it("falls back to the Git source when the npm install fails", async () => {
    const installSourcePlugin = vi
      .fn()
      .mockRejectedValueOnce(new Error("Could not resolve helper"))
      .mockResolvedValueOnce(undefined);
    await installMarketplacePlugin(
      { installSourcePlugin },
      { url, npm: { package: "@owner/browser", version: "1.0.2" } },
    );
    expect(installSourcePlugin).toHaveBeenLastCalledWith("https://github.com/owner/plugins", {
      ref: "main",
      pluginPath: "browser",
    });
  });

  it("reports both errors when npm and Git fail", async () => {
    const installSourcePlugin = vi
      .fn()
      .mockRejectedValueOnce(new Error("npm failed"))
      .mockRejectedValueOnce(new Error("git failed"));
    await expect(
      installMarketplacePlugin(
        { installSourcePlugin },
        { url, npm: { package: "@owner/browser", version: "1.0.2" } },
      ),
    ).rejects.toThrow("npm: npm failed\nGit: git failed");
  });

  it("uses the Git source when there is no npm release", async () => {
    const installSourcePlugin = vi.fn(async () => undefined);
    await installMarketplacePlugin({ installSourcePlugin }, { url });
    expect(installSourcePlugin).toHaveBeenCalledWith("https://github.com/owner/plugins", {
      ref: "main",
      pluginPath: "browser",
    });
  });
});
