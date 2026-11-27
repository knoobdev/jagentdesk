import { useEffect } from "react";
import { create } from "zustand";
import { getIsElectron } from "@/constants/platform";
import { getDesktopHost, type DesktopLiveBrowserTab } from "@/desktop/host";
import {
  listBrowserWebviewElements,
  subscribeBrowserWebviews,
  type BrowserWebviewElementInfo,
} from "@/desktop/browser/resident-webviews";

interface LiveBrowserTabsState {
  /** Main's live guests of this window, pushed on attach/close/crash/title/status changes. */
  liveTabs: readonly DesktopLiveBrowserTab[];
  /** This window's webview elements, parked or in a pane. */
  elements: readonly BrowserWebviewElementInfo[];
}

export const useLiveBrowserTabsStore = create<LiveBrowserTabsState>()(() => ({
  liveTabs: [],
  elements: [],
}));

function isLiveBrowserTabList(value: unknown): value is DesktopLiveBrowserTab[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as DesktopLiveBrowserTab).webContentsId === "number",
    )
  );
}

function applyLiveTabs(liveTabs: unknown): void {
  if (!isLiveBrowserTabList(liveTabs)) return;
  useLiveBrowserTabsStore.setState({ liveTabs, elements: listBrowserWebviewElements() });
}

function refreshElements(): void {
  useLiveBrowserTabsStore.setState({ elements: listBrowserWebviewElements() });
}

let subscribers = 0;
let teardown: (() => void) | null = null;

function startSync(): () => void {
  const host = getDesktopHost();
  let disposed = false;
  let unsubscribeEvents: (() => void) | null = null;
  const subscribeEvents = async () => {
    const unsubscribe = await host?.events?.on?.("browser-live-tabs", applyLiveTabs);
    if (disposed) unsubscribe?.();
    else unsubscribeEvents = unsubscribe ?? null;
  };
  void subscribeEvents();
  void host?.browser
    ?.listLiveTabs?.()
    .then(applyLiveTabs)
    .catch((error: unknown) => {
      console.error("[browser-live-tabs] list failed", error);
    });
  const unsubscribeElements = subscribeBrowserWebviews(refreshElements);
  return () => {
    disposed = true;
    unsubscribeEvents?.();
    unsubscribeElements();
  };
}

/** Keeps the live browser tab list current while any consumer is mounted. Electron only. */
export function useLiveBrowserTabsSync(): void {
  useEffect(() => {
    if (!getIsElectron()) return;
    subscribers += 1;
    if (subscribers === 1) teardown = startSync();
    return () => {
      subscribers -= 1;
      if (subscribers === 0) {
        teardown?.();
        teardown = null;
      }
    };
  }, []);
}
