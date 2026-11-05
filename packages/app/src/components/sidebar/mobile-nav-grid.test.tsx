/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
}));

const pushMock = vi.hoisted(() => vi.fn());
vi.mock("expo-router", () => ({
  router: { push: pushMock },
}));

// The package's published JS ships untranspiled, which fails to parse under Vite;
// only the native branch of the grid uses it, so any inert component is enough here.
vi.mock("react-native-draggable-flatlist", () => ({
  NestableScrollContainer: () => null,
}));

interface FixtureItem {
  key: string;
  label: string;
  shortLabel: string;
  route: string;
  isActive: boolean;
  testID: string;
}

const navState = vi.hoisted(() => ({
  items: [] as FixtureItem[],
}));

vi.mock("@/components/sidebar/use-app-nav", () => ({
  useAppNavItems: () =>
    navState.items.map((item) => ({ ...item, icon: () => null })) as unknown as ReturnType<
      () => readonly unknown[]
    >,
}));

import AsyncStorage from "@react-native-async-storage/async-storage";
import { MobileNavGrid, buildMobileNavTiles, mobileNavTileTestID } from "./mobile-nav-grid";
import type { AppNavItem } from "@/components/sidebar/use-app-nav";
import { useMobileNavGridStore } from "@/stores/mobile-nav-grid-store";

function fixtureItem(overrides: Partial<FixtureItem> & { key: string }): FixtureItem {
  return {
    label: `Label ${overrides.key}`,
    shortLabel: overrides.key,
    route: `/${overrides.key}`,
    isActive: false,
    testID: `rail-${overrides.key}`,
    ...overrides,
  };
}

const ITEMS: FixtureItem[] = [
  fixtureItem({ key: "sessions", shortLabel: "Sessions", isActive: true }),
  fixtureItem({ key: "jira", shortLabel: "Jira" }),
  // A destination added after the grid landed: no legacy row, keeps the rail testID.
  fixtureItem({ key: "figma", shortLabel: "Figma" }),
];

/** The mocked hook receives items without icons; the real hook always provides them. */
function asNavItems(items: FixtureItem[]): AppNavItem[] {
  return items.map((item) => ({ ...item, icon: () => null })) as unknown as AppNavItem[];
}

function openTile(container: HTMLElement, testID: string): HTMLElement | undefined {
  return container.querySelector<HTMLElement>(`[data-testid="${testID}"]`) ?? undefined;
}

function pressElement(element: HTMLElement) {
  act(() => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

let root: Root | null = null;
let container: HTMLElement | null = null;

async function renderGrid(onBeforeNavigate?: () => void) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<MobileNavGrid onBeforeNavigate={onBeforeNavigate} />);
  });
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  pushMock.mockReset();
  navState.items = ITEMS;
  act(() => {
    useMobileNavGridStore.setState({ collapsed: false });
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe("buildMobileNavTiles", () => {
  it("keeps the rail item order, labels and active flags", () => {
    const tiles = buildMobileNavTiles(asNavItems(ITEMS));

    expect(tiles.map((tile) => tile.shortLabel)).toEqual(["Sessions", "Jira", "Figma"]);
    expect(tiles.map((tile) => tile.route)).toEqual(["/sessions", "/jira", "/figma"]);
    expect(tiles.map((tile) => tile.isActive)).toEqual([true, false, false]);
  });

  it("maps drawer keys to their legacy row testIDs and falls back to the rail testID", () => {
    expect(mobileNavTileTestID("sessions", "rail-sessions")).toBe("sidebar-sessions");
    expect(mobileNavTileTestID("jira", "rail-jira")).toBe("sidebar-jira-nav");
    expect(mobileNavTileTestID("figma", "rail-figma")).toBe("rail-figma");

    const tiles = buildMobileNavTiles(asNavItems(ITEMS));
    expect(tiles.map((tile) => tile.testID)).toEqual([
      "sidebar-sessions",
      "sidebar-jira-nav",
      "rail-figma",
    ]);
  });
});

describe("MobileNavGrid", () => {
  it("renders one tile per nav item with its short label and drawer testID", async () => {
    await renderGrid();

    expect(openTile(container!, "sidebar-sessions")).toBeTruthy();
    expect(openTile(container!, "sidebar-jira-nav")).toBeTruthy();
    expect(openTile(container!, "rail-figma")).toBeTruthy();
    expect(container!.textContent).toContain("Sessions");
  });

  it("highlights the active tile and not the inactive ones", async () => {
    await renderGrid();

    const activeTile = openTile(container!, "sidebar-sessions")!;
    const inactiveTile = openTile(container!, "sidebar-jira-nav")!;
    // The stub unistyles theme pins surfaceSidebarHover to #e9e9ec and the highlighted
    // label colour to #111111, so the active tile is identifiable from its styles.
    expect(activeTile.style.backgroundColor).toBe("rgb(233, 233, 236)");
    expect(activeTile.textContent).not.toBe("");
    const activeLabel = activeTile.querySelector<HTMLElement>("[dir]")!;
    const inactiveLabel = inactiveTile.querySelector<HTMLElement>("[dir]")!;
    expect(activeLabel.style.color).toBe("rgb(17, 17, 17)");
    expect(activeLabel.style.fontWeight).toBe("600");
    expect(inactiveLabel.style.color).toBe("rgb(102, 102, 102)");
    expect(inactiveTile.style.backgroundColor).toBe("");
  });

  it("runs the close-drawer hook before navigating", async () => {
    const order: string[] = [];
    const closeSidebar = vi.fn(() => order.push("close"));
    pushMock.mockImplementation(() => order.push("push"));
    await renderGrid(closeSidebar);

    pressElement(openTile(container!, "sidebar-jira-nav")!);

    expect(closeSidebar).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith("/jira");
    expect(order).toEqual(["close", "push"]);
  });

  it("hides every tile when collapsed and restores them when expanded", async () => {
    await renderGrid();
    pressElement(container!.querySelector<HTMLElement>('[data-testid="sidebar-menu-toggle"]')!);

    expect(useMobileNavGridStore.getState().collapsed).toBe(true);
    expect(openTile(container!, "sidebar-sessions")).toBeUndefined();

    pressElement(container!.querySelector<HTMLElement>('[data-testid="sidebar-menu-toggle"]')!);
    expect(useMobileNavGridStore.getState().collapsed).toBe(false);
    expect(openTile(container!, "sidebar-sessions")).toBeTruthy();
  });

  it("persists the collapsed choice through the store's storage", async () => {
    await renderGrid();
    pressElement(container!.querySelector<HTMLElement>('[data-testid="sidebar-menu-toggle"]')!);

    const persisted = JSON.parse((await AsyncStorage.getItem("mobile-nav-grid")) ?? "{}") as {
      state?: { collapsed?: boolean };
    };
    expect(persisted.state?.collapsed).toBe(true);
  });

  it("picks up items added after the grid was written", async () => {
    await renderGrid();
    expect(openTile(container!, "rail-figma")).toBeTruthy();

    navState.items = [...ITEMS, fixtureItem({ key: "figma2", shortLabel: "Figma2" })];
    await act(async () => {
      root?.render(<MobileNavGrid />);
    });

    expect(openTile(container!, "rail-figma2")).toBeTruthy();
  });
});
