import { useCallback, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import * as Linking from "expo-linking";
import { ChevronDown, MoreHorizontal, ZoomIn, ZoomOut } from "lucide-react-native";
import type { FigmaOutline, FigmaPage } from "@jagentdesk/protocol/figma/rpc-schemas";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { jiraStyles } from "@/jira/ui/styles";
import type { Theme } from "@/styles/theme";
import { isWeb } from "@/constants/platform";
import { openExternalUrl } from "@/utils/open-external-url";
import { figmaDeepLink, figmaDesignUrl } from "./node-url";
import {
  cameraAt100,
  cameraToFit,
  formatZoomReadout,
  pageBoundingRect,
  type Camera,
  zoomAroundPoint,
} from "./viewport";

// File-screen top bar (spec 32.5): page picker, one zoom control cluster (readout doubles as
// reset-to-100%), the data-source badge, and an overflow menu holding the actions that leave
// the canvas — Open in Figma (deep link first, web URL fallback), the prototype player, and
// Ask AI. Overflowing keeps the title and page picker at natural width at desktop sizes.

export interface FigmaTopBarProps {
  fileKey: string;
  outline: FigmaOutline;
  version: string | null;
  page: FigmaPage | null;
  selectedNodeId: string | null;
  camera: Camera;
  size: { width: number; height: number };
  /** Phone layout (<600px): the bar wraps, the title truncates, the badge moves under it. */
  compact: boolean;
  onCamera: (next: Camera) => void;
  onSelectPage: (pageId: string) => void;
  onOpenPrototype: () => void;
  onAskAi: () => void;
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: 8, paddingVertical: 6 },
  barWrap: { flexWrap: "wrap", rowGap: 4 },
  title: { flexShrink: 1, minWidth: 0 },
  pageTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minHeight: 28,
    minWidth: 64,
    maxWidth: 240,
    flexShrink: 1,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  pageLabel: { flexShrink: 1, minWidth: 0 },
  moreTrigger: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 28,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  badgeLine: { maxWidth: "100%" },
});

// Theme-reactive chevron so the page trigger inherits the muted foreground on every theme
// (the second `withUnistyles` argument keeps the color off the DOM svg — no `uniProps` leak).
const ThemedChevronDown = withUnistyles(ChevronDown, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedMoreHorizontal = withUnistyles(MoreHorizontal, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));

function openInFigma(fileKey: string, nodeId: string | null): void {
  const web = figmaDesignUrl(fileKey, nodeId);
  if (isWeb) {
    void openExternalUrl(web);
    return;
  }
  const deep = figmaDeepLink(fileKey, nodeId);
  void Linking.canOpenURL(deep)
    .then((canOpen) => Linking.openURL(canOpen ? deep : web))
    .catch(() => undefined);
}

function PageItem({
  candidate,
  selected,
  onSelectPage,
  onDismiss,
}: {
  candidate: FigmaPage;
  selected: boolean;
  onSelectPage: (pageId: string) => void;
  onDismiss: () => void;
}) {
  const onSelect = useCallback(() => {
    onSelectPage(candidate.id);
    onDismiss();
  }, [onSelectPage, onDismiss, candidate.id]);
  return (
    <DropdownMenuItem key={candidate.id} selected={selected} showSelectedCheck onSelect={onSelect}>
      {candidate.name}
    </DropdownMenuItem>
  );
}

function SourceBadge({ version, outline }: { version: string | null; outline: FigmaOutline }) {
  if (version) return <StatusBadge label={`Snapshot · ${version}`} variant="muted" />;
  if (outline.source === "link") return <StatusBadge label="Live" variant="success" />;
  return <StatusBadge label={`Snapshot · v${outline.version}`} variant="muted" />;
}

export function FigmaTopBar({
  fileKey,
  outline,
  version,
  page,
  selectedNodeId,
  camera,
  size,
  compact,
  onCamera,
  onSelectPage,
  onOpenPrototype,
  onAskAi,
}: FigmaTopBarProps) {
  const [pagesOpen, setPagesOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // Fit / 100% are scoped to the CURRENT page's top-level frames (never other pages, which
  // pulled the fit out to 31% and left this page's frames off-screen).
  const content = pageBoundingRect(outline.pages, page?.id ?? null);
  const zoomOut = useCallback(() => {
    onCamera(zoomAroundPoint(camera, 1 / 1.25, { x: size.width / 2, y: size.height / 2 }));
  }, [onCamera, camera, size.width, size.height]);
  const zoomIn = useCallback(() => {
    onCamera(zoomAroundPoint(camera, 1.25, { x: size.width / 2, y: size.height / 2 }));
  }, [onCamera, camera, size.width, size.height]);
  const fit = useCallback(() => {
    onCamera(cameraToFit(content, size.width, size.height));
  }, [onCamera, content, size.width, size.height]);
  const reset100 = useCallback(() => {
    onCamera(cameraAt100(content, size.width, size.height));
  }, [onCamera, content, size.width, size.height]);
  const openFigma = useCallback(() => {
    openInFigma(fileKey, selectedNodeId);
  }, [fileKey, selectedNodeId]);
  const dismissPages = useCallback(() => setPagesOpen(false), []);

  return (
    <View style={[jiraStyles.row, styles.bar, compact && styles.barWrap]} testID="figma-top-bar">
      <Text style={[jiraStyles.textStrong, styles.title]} numberOfLines={1}>
        {outline.name}
      </Text>

      <DropdownMenu open={pagesOpen} onOpenChange={setPagesOpen}>
        <DropdownMenuTrigger accessibilityLabel="Choose page" style={styles.pageTrigger}>
          <Text style={[jiraStyles.text, styles.pageLabel]} numberOfLines={1}>
            {page?.name ?? "No page"}
          </Text>
          <ThemedChevronDown size={14} />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {outline.pages.map((candidate) => (
            <PageItem
              key={candidate.id}
              candidate={candidate}
              selected={candidate.id === page?.id}
              onSelectPage={onSelectPage}
              onDismiss={dismissPages}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <View style={jiraStyles.spacer} />

      <View style={jiraStyles.row}>
        <Button
          size="xs"
          variant="ghost"
          leftIcon={ZoomOut}
          onPress={zoomOut}
          accessibilityLabel="Zoom out"
        />
        {/* One zoom control: the readout doubles as the reset-to-100% button (the old bar
            showed "100%" twice — a readout Text and a separate 100% Button). */}
        <Button
          size="xs"
          variant="ghost"
          onPress={reset100}
          accessibilityLabel="Reset zoom to 100%"
          testID="figma-zoom-reset"
        >
          {formatZoomReadout(camera.zoom)}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          leftIcon={ZoomIn}
          onPress={zoomIn}
          accessibilityLabel="Zoom in"
        />
        <Button size="xs" variant="ghost" onPress={fit} testID="figma-fit">
          Fit
        </Button>
      </View>

      {/* Compact: shrink in place (the pill's text wraps) so the badge never runs off the edge. */}
      <View style={styles.badgeLine}>
        <SourceBadge version={version} outline={outline} />
      </View>

      {/* Secondary leave-the-canvas actions live in one overflow menu so the title and the
          page picker keep their natural width at desktop sizes. */}
      <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
        <DropdownMenuTrigger
          accessibilityLabel="More actions"
          style={styles.moreTrigger}
          testID="figma-top-bar-more"
        >
          <ThemedMoreHorizontal size={16} />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={openFigma} testID="figma-open-in-figma">
            Open in Figma
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpenPrototype} testID="figma-prototype">
            Prototype
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onAskAi} testID="figma-ask-ai">
            Ask AI
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}
