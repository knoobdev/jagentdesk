import { useCallback, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import * as Linking from "expo-linking";
import {
  ChevronDown,
  ExternalLink,
  MessageSquare,
  Play,
  ZoomIn,
  ZoomOut,
} from "lucide-react-native";
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
import { isWeb } from "@/constants/platform";
import { openExternalUrl } from "@/utils/open-external-url";
import { figmaDeepLink, figmaDesignUrl } from "./node-url";
import {
  cameraAt100,
  cameraToFit,
  clampZoom,
  framesBoundingRect,
  type Camera,
  zoomAroundPoint,
} from "./viewport";

// File-screen top bar (spec 32.5): page picker, zoom controls, data-source badge, and the
// buttons that leave the canvas — Open in Figma (deep link first, web URL fallback), Ask AI
// and the prototype player.

export interface FigmaTopBarProps {
  fileKey: string;
  outline: FigmaOutline;
  version: string | null;
  page: FigmaPage | null;
  selectedNodeId: string | null;
  camera: Camera;
  size: { width: number; height: number };
  onCamera: (next: Camera) => void;
  onSelectPage: (pageId: string) => void;
  onOpenPrototype: () => void;
  onAskAi: () => void;
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: 8, paddingVertical: 6 },
  zoomLabel: { minWidth: 44, textAlign: "center" },
});

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
  onCamera,
  onSelectPage,
  onOpenPrototype,
  onAskAi,
}: FigmaTopBarProps) {
  const [pagesOpen, setPagesOpen] = useState(false);
  const content = framesBoundingRect(outline.pages.flatMap((candidate) => candidate.frames));
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
    <View style={[jiraStyles.row, styles.bar]} testID="figma-top-bar">
      <Text style={jiraStyles.textStrong} numberOfLines={1}>
        {outline.name}
      </Text>

      <DropdownMenu open={pagesOpen} onOpenChange={setPagesOpen}>
        <DropdownMenuTrigger
          accessibilityLabel="Choose page"
          style={jiraStyles.iconButton}
          hitSlop={6}
        >
          <Text style={jiraStyles.text} numberOfLines={1}>
            {page?.name ?? "No page"}
          </Text>
          <ChevronDown size={14} color="#71717a" />
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
        <Text style={[jiraStyles.textSmall, styles.zoomLabel]}>
          {`${Math.round(clampZoom(camera.zoom) * 100)}%`}
        </Text>
        <Button
          size="xs"
          variant="ghost"
          leftIcon={ZoomIn}
          onPress={zoomIn}
          accessibilityLabel="Zoom in"
        />
        <Button size="xs" variant="ghost" onPress={fit}>
          Fit
        </Button>
        <Button size="xs" variant="ghost" onPress={reset100}>
          100%
        </Button>
      </View>

      <SourceBadge version={version} outline={outline} />

      <Button
        size="sm"
        variant="ghost"
        leftIcon={ExternalLink}
        onPress={openFigma}
        testID="figma-open-in-figma"
      >
        Open in Figma
      </Button>
      <Button
        size="sm"
        variant="ghost"
        leftIcon={Play}
        onPress={onOpenPrototype}
        testID="figma-prototype"
      >
        Prototype
      </Button>
      <Button
        size="sm"
        variant="outline"
        leftIcon={MessageSquare}
        onPress={onAskAi}
        testID="figma-ask-ai"
      >
        Ask AI
      </Button>
    </View>
  );
}
