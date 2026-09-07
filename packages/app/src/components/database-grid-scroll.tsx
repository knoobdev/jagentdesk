import { useCallback, useState, type ReactNode } from "react";
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
  style.textContent = `
[data-jad-gridscroll]{overflow:auto;scrollbar-gutter:stable;}
[data-jad-gridscroll]::-webkit-scrollbar{width:12px;height:12px;}
[data-jad-gridscroll]::-webkit-scrollbar-thumb{background-color:rgba(140,140,150,0.55);border-radius:6px;border:3px solid transparent;background-clip:padding-box;}
[data-jad-gridscroll]::-webkit-scrollbar-thumb:hover{background-color:rgba(140,140,150,0.85);}
[data-jad-gridscroll]::-webkit-scrollbar-track{background:transparent;}
[data-jad-gridscroll]::-webkit-scrollbar-corner{background:transparent;}
[data-jad-gridinner]{width:max-content;min-width:100%;}
[data-jad-gridheader]{position:sticky;top:0;z-index:3;}`;
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
  const scrollRef = useCallback(
    (node: View | null) => {
      const el = node as unknown as HTMLElement | null;
      if (el) ensureGridScrollStyle();
      webNodeRef?.(el);
    },
    [webNodeRef],
  );
  return (
    <View ref={scrollRef} style={[styles.webScroll, style]} dataSet={WEB_SCROLL_DATASET}>
      <View style={styles.webInner} dataSet={WEB_INNER_DATASET}>
        <View dataSet={WEB_HEADER_DATASET}>{header}</View>
        {children}
      </View>
    </View>
  );
}
const WEB_SCROLL_DATASET = { jadGridscroll: "1" } as const;
const WEB_INNER_DATASET = { jadGridinner: "1" } as const;
const WEB_HEADER_DATASET = { jadGridheader: "1" } as const;

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
  webScroll: { flex: 1, minHeight: 0 },
  webInner: { flexDirection: "column" },
  gridWrap: { flex: 1, minHeight: 0 },
  hScroll: { flex: 1 },
  hContent: { flexGrow: 1, flexDirection: "column" },
  grid: { flexGrow: 1, minHeight: 0 },
  bodyScroll: { flexGrow: 1, minHeight: 0 },
}));
