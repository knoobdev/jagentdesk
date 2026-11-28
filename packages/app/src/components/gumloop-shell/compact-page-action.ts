import { useEffect } from "react";
import type { LucideIcon } from "lucide-react-native";
import { create } from "zustand";

/** A page's primary action ("Add memory", …): the phone top bar's right button (spec 38 §5). */
export interface CompactPageAction {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}

interface CompactPageActionState {
  /** Keyed by the pathname of the page that published it, so a page left mounted elsewhere never leaks its action. */
  entry: { pathname: string; action: CompactPageAction } | null;
}

const useCompactPageActionStore = create<CompactPageActionState>(() => ({ entry: null }));

/** Publishes the page's primary action to the phone top bar while the page is mounted on `pathname`. */
export function usePublishCompactPageAction(
  pathname: string,
  action: CompactPageAction | null,
): void {
  useEffect(() => {
    if (!action) return undefined;
    const entry = { pathname, action };
    useCompactPageActionStore.setState({ entry });
    return () => {
      if (useCompactPageActionStore.getState().entry === entry) {
        useCompactPageActionStore.setState({ entry: null });
      }
    };
  }, [action, pathname]);
}

/** The primary action the page on `pathname` published, if any. */
export function useCompactPageAction(pathname: string): CompactPageAction | null {
  return useCompactPageActionStore((state) =>
    state.entry && state.entry.pathname === pathname ? state.entry.action : null,
  );
}
