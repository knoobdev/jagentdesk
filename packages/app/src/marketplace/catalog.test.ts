import { describe, expect, it } from "vitest";
import { normalizePlugin } from "@/marketplace/catalog";

const base = { id: "shared-browser", url: "https://github.com/owner/plugins/tree/main/browser" };

describe("normalizePlugin", () => {
  it("joins caveats sent as a list", () => {
    const plugin = normalizePlugin({
      ...base,
      manifest: { id: "shared-browser" },
      caveats: ["Downloads Chromium", "Uploads are disabled"],
    });
    expect(plugin?.caveats).toBe("• Downloads Chromium\n• Uploads are disabled");
    expect(plugin?.installable).toBe(true);
  });

  it("keeps a caveat sent as one string", () => {
    expect(normalizePlugin({ ...base, caveats: "Needs Docker" })?.caveats).toBe("Needs Docker");
  });

  it("marks an entry without a manifest as not installable", () => {
    expect(normalizePlugin(base)?.installable).toBe(false);
  });
});
