import { expect, test, type Page } from "../support/fixtures";
import { installProviderUsageFixture } from "../support/helpers/provider-usage";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FooterGeometry {
  row: Box;
  card: Box;
  content: Box[];
  spaceAbove: number;
  spaceBelow: number;
}

const CASES = [
  { name: "desktop light", viewport: { width: 1440, height: 900 }, theme: "gumloop" },
  { name: "desktop dark", viewport: { width: 1440, height: 900 }, theme: "gumloopDark" },
  { name: "phone light", viewport: { width: 390, height: 844 }, theme: "gumloop" },
] as const;

async function showUsageInGumloopSidebar(page: Page, theme: string): Promise<void> {
  // Runs after the usage fixture's init script, which turns the sidebar summary off.
  await page.addInitScript((value) => {
    localStorage.setItem(
      "@jagentdesk:app-settings",
      JSON.stringify({ theme: value, usageInSidebar: true }),
    );
  }, theme);
}

/** The visible row's icon, meters and percents, the row, and the Connection card under it. */
async function readFooterGeometry(page: Page): Promise<FooterGeometry> {
  return page.getByTestId("gumloop-sidebar-footer").evaluate((footer) => {
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const row = footer.querySelector('[data-testid="sidebar-usage"]');
    const card = footer.querySelector('[data-testid="gumloop-connection"]');
    if (!row || !card) throw new Error("Usage row or Connection card missing");
    // The row also holds invisible copies that measure its layouts; skip them.
    const shown = (element: Element) => {
      for (let node: Element | null = element; node && node !== row; node = node.parentElement) {
        if (getComputedStyle(node).opacity === "0") return false;
      }
      return true;
    };
    const meters = Array.from(row.querySelectorAll("div")).filter(
      (element) =>
        element.firstElementChild !== null &&
        Math.round(element.getBoundingClientRect().height) === 6,
    );
    const content = [
      ...Array.from(row.querySelectorAll("svg")),
      ...meters,
      ...Array.from(row.querySelectorAll('[data-testid="sidebar-usage-pinned-window"]')),
    ]
      .filter(shown)
      .map(box);
    const top = Math.min(...content.map((item) => item.y));
    const bottom = Math.max(...content.map((item) => item.y + item.height));
    const footerTop =
      footer.getBoundingClientRect().y + parseFloat(getComputedStyle(footer).borderTopWidth);
    return {
      row: box(row),
      card: box(card),
      content,
      spaceAbove: top - footerTop,
      spaceBelow: card.getBoundingClientRect().y - bottom,
    };
  });
}

function isInside(inner: Box, outer: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

test.describe("Gumloop sidebar Usage row", () => {
  for (const testCase of CASES) {
    test(`shows the whole row clear of the Connection card (${testCase.name})`, async ({
      page,
    }) => {
      await page.setViewportSize(testCase.viewport);
      await installProviderUsageFixture(page, [
        {
          fetchedAt: "2026-11-27T00:00:00.000Z",
          providers: [
            {
              providerId: "claude",
              displayName: "Claude",
              status: "available",
              planLabel: null,
              windows: [
                { id: "five_hour", label: "Session", shortLabel: "5h", summary: true, usedPct: 12 },
                { id: "weekly", label: "Weekly", shortLabel: "wk", summary: true, usedPct: 33 },
              ],
            },
          ],
        },
      ]);
      await showUsageInGumloopSidebar(page, testCase.theme);
      await page.goto("/");
      if (testCase.viewport.width < 768) await page.getByTestId("menu-button").first().click();

      const row = page.getByTestId("gumloop-sidebar-footer").getByTestId("sidebar-usage");
      await expect(row.getByTestId("sidebar-usage-pinned-window").first()).toContainText("12%");

      const geometry = await readFooterGeometry(page);
      // Icon, two meters (slot and track each) and two percents.
      expect(geometry.content.length).toBeGreaterThanOrEqual(5);
      for (const item of geometry.content) {
        expect(isInside(item, geometry.row), JSON.stringify(item)).toBe(true);
      }
      expect(geometry.card.y - (geometry.row.y + geometry.row.height)).toBeGreaterThanOrEqual(4);
      expect(Math.abs(geometry.spaceAbove - geometry.spaceBelow)).toBeLessThanOrEqual(1);
    });
  }
});
