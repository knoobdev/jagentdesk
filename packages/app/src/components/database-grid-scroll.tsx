import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  ScrollView,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

/**
 * Two-axis grid scroller shared by the data editor and the SQL result table.
 *
 * Web (desktop): a SINGLE `overflow:auto` container with a `position:sticky` header.
 * Both scrollbars therefore pin to the viewport edges (the vertical bar is always
 * visible at the right, not hidden out past the last column) and the header stays
 * pinned while rows scroll under it — the DataGrip behaviour. Realised with `dataSet`
 * data-attributes + one injected stylesheet, because react-native-web owns the
 * element's `className`/`style` and would clobber inline overrides.
 *
 * Native (mobile): the classic nested ScrollViews (horizontal outer, vertical inner
 * bounded to the measured viewport height) — touch scrolling, overlay scrollbars.
 *
 * The caller supplies `header` and the row children, and must give both the header
 * row and every data row the SAME explicit width (sum of column widths) so columns
 * line up and the content is wider than the viewport for horizontal scroll.
 */
export function GridScroll(props: {
  header: ReactNode;
  children: ReactNode;
  /** Web only: receive the scroll DOM node (to attach keydown/focus/click-outside). */
  webNodeRef?: (el: HTMLElement | null) => void;
  style?: StyleProp<ViewStyle>;
}) {
  return isWeb ? <GridScrollWeb {...props} /> : <GridScrollNative {...props} />;
}

const DB_GRID_STYLE_ID = "jad-db-grid-scroll-style";
let gridStyleInjected = false;
function ensureGridScrollStyle(): void {
  if (!isWeb || gridStyleInjected || typeof document === "undefined") return;
  gridStyleInjected = true;
  const style = document.createElement("style");
  style.id = DB_GRID_STYLE_ID;
  // The header row lives in its OWN horizontal viewport (overflow hidden, no scrollbar)
  // whose scrollLeft is driven to match the body — so header and rows always share the
  // exact horizontal offset and columns can never drift (a position:sticky header did
  // NOT track horizontal scroll and misaligned the values). The body is the single
  // two-axis scroller, so both scrollbars pin to the viewport edges. `outline:none`
  // removes the focus ring on the focusable grid wrapper.
  style.textContent = `
[data-jad-gridwrap]{outline:none;}
[data-jad-gridheadervp]{overflow:hidden;flex-shrink:0;}
[data-jad-gridbody]{overflow:auto;outline:none;}
[data-jad-gridbody]::-webkit-scrollbar{width:12px;height:12px;}
[data-jad-gridbody]::-webkit-scrollbar-thumb{background-color:rgba(140,140,150,0.55);border-radius:6px;border:3px solid transparent;background-clip:padding-box;}
[data-jad-gridbody]::-webkit-scrollbar-thumb:hover{background-color:rgba(140,140,150,0.85);}
[data-jad-gridbody]::-webkit-scrollbar-track{background:transparent;}
[data-jad-gridbody]::-webkit-scrollbar-corner{background:transparent;}
[data-jad-gridinner]{width:max-content;min-width:100%;}`;
  document.head.appendChild(style);
}

function GridScrollWeb({
  header,
  children,
  webNodeRef,
  style,
}: {
  header: ReactNode;
  children: ReactNode;
  webNodeRef?: (el: HTMLElement | null) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const headerElRef = useRef<HTMLElement | null>(null);
  const bodyElRef = useRef<HTMLElement | null>(null);
  const syncHeaderScroll = useCallback(() => {
    if (headerElRef.current && bodyElRef.current) {
      headerElRef.current.scrollLeft = bodyElRef.current.scrollLeft;
    }
  }, []);
  const headerRef = useCallback((node: View | null) => {
    headerElRef.current = node as unknown as HTMLElement | null;
  }, []);
  const bodyRef = useCallback(
    (node: View | null) => {
      const el = node as unknown as HTMLElement | null;
      if (bodyElRef.current) bodyElRef.current.removeEventListener("scroll", syncHeaderScroll);
      bodyElRef.current = el;
      if (el) {
        ensureGridScrollStyle();
        el.addEventListener("scroll", syncHeaderScroll, { passive: true });
      }
    },
    [syncHeaderScroll],
  );
  const wrapRef = useCallback(
    (node: View | null) => webNodeRef?.(node as unknown as HTMLElement | null),
    [webNodeRef],
  );
  return (
    <View ref={wrapRef} style={[styles.webWrap, style]} dataSet={WRAP_DS}>
      <View ref={headerRef} style={styles.webHeaderVp} dataSet={HEADER_DS}>
        {header}
      </View>
      <View ref={bodyRef} style={styles.webBody} dataSet={BODY_DS}>
        <View style={styles.webInner} dataSet={INNER_DS}>
          {children}
        </View>
      </View>
    </View>
  );
}
const WRAP_DS = { jadGridwrap: "1" } as const;
const HEADER_DS = { jadGridheadervp: "1" } as const;
const BODY_DS = { jadGridbody: "1" } as const;
const INNER_DS = { jadGridinner: "1" } as const;

function GridScrollNative({
  header,
  children,
  style,
}: {
  header: ReactNode;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const [gridH, setGridH] = useState(0);
  const [headerH, setHeaderH] = useState(0);
  const onGridLayout = useCallback(
    (e: LayoutChangeEvent) => setGridH(e.nativeEvent.layout.height),
    [],
  );
  const onHeaderLayout = useCallback(
    (e: LayoutChangeEvent) => setHeaderH(e.nativeEvent.layout.height),
    [],
  );
  const bodyH = gridH > 0 ? Math.max(0, gridH - headerH) : undefined;
  return (
    <View style={[styles.gridWrap, style]} onLayout={onGridLayout}>
      <ScrollView horizontal style={styles.hScroll} contentContainerStyle={styles.hContent}>
        <View style={styles.grid}>
          <View onLayout={onHeaderLayout}>{header}</View>
          <ScrollView
            nestedScrollEnabled
            style={[styles.bodyScroll, bodyH !== undefined ? { height: bodyH } : null]}
          >
            {children}
          </ScrollView>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((_theme: Theme) => ({
  // Web: header viewport (fixed height, hidden overflow, scroll-synced) above the
  // single two-axis body scroller.
  webWrap: { flex: 1, minHeight: 0, flexDirection: "column" },
  webHeaderVp: { flexShrink: 0, overflow: "hidden" },
  webBody: { flex: 1, minHeight: 0 },
  webInner: { flexDirection: "column" },
  // Native: nested scrollers.
  gridWrap: { flex: 1, minHeight: 0 },
  hScroll: { flex: 1 },
  hContent: { flexGrow: 1, flexDirection: "column" },
  grid: { flexGrow: 1, minHeight: 0 },
  bodyScroll: { flexGrow: 1, minHeight: 0 },
}));
