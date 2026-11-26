import { useCallback, useMemo, useState } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";

export interface PageScroll {
  /** Pass to `PageHeader` so it draws its divider once the body has left its top. */
  scrolled: boolean;
  /** Spread onto the page's main ScrollView / FlatList. */
  scrollProps: {
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    scrollEventThrottle: number;
  };
}

/**
 * Tracks whether a page's main scroll view has left its top, for the `PageHeader` divider
 * (spec 38 §4.4c). Web finds the page's scroller on its own; native cannot, so a page with one
 * main scroll view wires it here.
 */
export function usePageScroll(): PageScroll {
  const [scrolled, setScrolled] = useState(false);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = event.nativeEvent.contentOffset.y > 0;
    setScrolled((current) => (current === next ? current : next));
  }, []);
  return useMemo(
    () => ({ scrolled, scrollProps: { onScroll, scrollEventThrottle: 16 } }),
    [onScroll, scrolled],
  );
}
