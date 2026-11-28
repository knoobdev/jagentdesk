import { describe, expect, it } from "vitest";
import { isTabFaviconDataUrl, tabFaviconSource } from "./favicon-source";
import { createBrowserRecord, sanitizeBrowsersForPersist } from "./store/state";

describe("tab favicon source", () => {
  it("renders only data: images main fetched with the tab's identity", () => {
    const inline = "data:image/png;base64,iVBORw0KGgo=";
    expect(tabFaviconSource(inline)).toEqual({ uri: inline });
    // A site URL would load through the app window's session (Electron UA, host language).
    expect(tabFaviconSource("https://shop.test/favicon.ico")).toBeUndefined();
    expect(tabFaviconSource("http://127.0.0.1:6974/favicon.ico")).toBeUndefined();
    expect(tabFaviconSource("//shop.test/favicon.ico")).toBeUndefined();
    expect(tabFaviconSource("data:text/html,<b>x</b>")).toBeUndefined();
    expect(tabFaviconSource(null)).toBeUndefined();
    expect(isTabFaviconDataUrl(undefined)).toBe(false);
  });

  it("drops a stored site URL and large icons when persisting tabs", () => {
    const record = (faviconUrl: string) => ({
      ...createBrowserRecord({ browserId: "b1", initialUrl: "https://shop.test", now: 1 }),
      faviconUrl,
    });
    const small = "data:image/png;base64,iVBORw0KGgo=";
    const large = `data:image/png;base64,${"A".repeat(20_000)}`;
    const persisted = sanitizeBrowsersForPersist({
      browsersById: {
        site: record("https://shop.test/favicon.ico"),
        small: record(small),
        large: record(large),
      },
    });
    expect(persisted.browsersById.site?.faviconUrl).toBeNull();
    expect(persisted.browsersById.small?.faviconUrl).toBe(small);
    expect(persisted.browsersById.large?.faviconUrl).toBeNull();
  });
});
