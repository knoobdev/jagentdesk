import { useEffect, useState, type RefObject } from "react";
import type { View } from "react-native";

/**
 * Whether the page body under a header has scrolled away from its top. Pages own their scroll
 * views (lists, grids, plain scrolls), so rather than threading a handler through every one the
 * header listens for scroll events in the capture phase and keeps those from a vertical scroller
 * that is a sibling of the header inside the same page (spec 38 §4.4c).
 */
export function usePageScrolled(headerRef: RefObject<View | null>, enabled: boolean): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const header = headerRef.current as unknown as HTMLElement | null;
    const page = header?.parentElement;
    if (!header || !page) return;
    const onScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!page.contains(target) || header.contains(target)) return;
      // A horizontal strip (tabs, chips) reports scrollTop 0; only a vertical scroller counts.
      if (target.scrollHeight <= target.clientHeight + 1) return;
      setScrolled(target.scrollTop > 0);
    };
    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, [enabled, headerRef]);
  return enabled && scrolled;
}
