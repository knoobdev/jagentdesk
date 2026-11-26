import { Settings, type LucideIcon } from "lucide-react-native";
import { useMemo, type ReactNode } from "react";
import { Platform, ScrollView, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { AppearanceText as Text } from "@/appearance/text";
import { GUMLOOP_PAGE_GUTTER } from "@/components/gumloop-shell/list-styles";
import { useGumloopDesktopShell } from "@/components/gumloop-shell/use-gumloop-chrome";
import { BackHeader } from "@/components/headers/back-header";
import { PageHeader } from "@/components/headers/page-header";
import { withContentDrag } from "@/components/ui/content-drag";
import { useIsCompactFormFactor } from "@/constants/layout";
import { SPACING } from "@/styles/theme";

// Rows on a page drag to reorder, so the page stops scrolling while a drag holds the touch.
const PageScrollView =
  Platform.OS === "android"
    ? withContentDrag(KeyboardAwareScrollView)
    : withContentDrag(ScrollView);

interface PageLayoutProps {
  title?: string;
  /** The line under the title (spec 38 §4.1); on compact it opens the page body. */
  description?: string;
  /** The section's icon in the desktop header. Settings pages use the Settings glyph. */
  icon?: LucideIcon;
  /** Compact back button. Defaults to navigating back. */
  onBack?: () => void;
  testID?: string;
  titleTestID?: string;
  /** Controls for the whole page: in the page header on desktop, in the back header on compact. */
  actions?: ReactNode;
  /** `wide` for pages that lay content out in a grid or table. Defaults to a reading column. */
  width?: "default" | "wide";
  children: ReactNode;
}

/**
 * A full page that owns its header and scroll body, for pages that lay out their own panes (such
 * as Agent profiles with its inspector drawer). Desktop uses the shared `PageHeader`, so the page
 * matches every other Settings page in the Gumloop shell; compact uses a back header.
 */
export function PageLayout({
  title,
  description,
  icon = Settings,
  onBack,
  testID,
  titleTestID,
  actions,
  width = "default",
  children,
}: PageLayoutProps) {
  const isCompact = useIsCompactFormFactor();
  const gumloop = useGumloopDesktopShell(true);
  const insets = useSafeAreaInsets();
  const scrollContentStyle = useMemo(() => ({ paddingBottom: insets.bottom }), [insets.bottom]);
  const columnStyle = width === "wide" ? styles.contentWide : styles.content;
  const contentStyle = gumloop ? styles.gumloopContent : columnStyle;

  return (
    <View style={styles.container}>
      {isCompact ? (
        <BackHeader title={title} onBack={onBack} rightContent={actions} />
      ) : (
        <View testID={titleTestID}>
          <PageHeader icon={icon} title={title ?? ""} description={description} actions={actions} />
        </View>
      )}
      <PageScrollView
        // Leave room for field borders and padding around the focused native input.
        {...(Platform.OS === "android" ? { bottomOffset: SPACING[4] } : {})}
        style={styles.scroll}
        contentContainerStyle={scrollContentStyle}
        testID={testID}
      >
        <View style={contentStyle}>
          {isCompact && description ? (
            <Text style={styles.compactDescription}>{description}</Text>
          ) : null}
          {children}
        </View>
      </PageScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scroll: {
    flex: 1,
    backgroundColor: theme.chrome.pageCanvas,
  },
  content: {
    padding: theme.spacing[4],
    paddingTop: theme.spacing[6],
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
  },
  contentWide: {
    padding: theme.spacing[4],
    paddingTop: theme.spacing[6],
    width: "100%",
    maxWidth: 1080,
    alignSelf: "center",
  },
  // Full width on the shared page gutter, like every Gumloop page (spec 38 §4.1). The 8 px top
  // padding keeps the first row off the header's divider (spec 38 §4.4c).
  gumloopContent: {
    width: "100%",
    paddingHorizontal: GUMLOOP_PAGE_GUTTER,
    paddingTop: 8,
    paddingBottom: theme.spacing[4],
  },
  compactDescription: {
    fontSize: 14,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
    marginBottom: theme.spacing[4],
  },
}));
