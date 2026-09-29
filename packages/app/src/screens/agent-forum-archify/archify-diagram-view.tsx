import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View, useWindowDimensions, type TextStyle } from "react-native";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { Theme } from "@/styles/theme";
import { buildArchifyDocument, type ArchifyColorScheme } from "./archify-document";
import { ArchifyFrame } from "./archify-frame";

// ARCH tab body for an archify diagram version (spec 23.4): fetch the daemon-rendered HTML
// (forum.diagram.html.request) and show it in the sandboxed frame, themed like the app.

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; html: string }
  | { kind: "not_found" }
  | { kind: "failed" }
  | { kind: "offline" };

// Versions are immutable, so a rendered HTML (~760 KB) is kept for the last few versions viewed.
const HTML_CACHE_LIMIT = 4;
const htmlCache = new Map<string, string>();

function cacheKey(topicId: string, diagramId: string): string {
  return `${topicId}\u0000${diagramId}`;
}

function remember(key: string, html: string): void {
  htmlCache.delete(key);
  htmlCache.set(key, html);
  while (htmlCache.size > HTML_CACHE_LIMIT) {
    const oldest = htmlCache.keys().next().value;
    if (oldest === undefined) break;
    htmlCache.delete(oldest);
  }
}

function initialState(client: DaemonClient | null, key: string): LoadState {
  const cached = htmlCache.get(key);
  if (cached !== undefined) return { kind: "ready", html: cached };
  return client ? { kind: "loading" } : { kind: "offline" };
}

function useArchifyHtml(
  client: DaemonClient | null,
  topicId: string,
  diagramId: string,
): { state: LoadState; retry: () => void } {
  const key = cacheKey(topicId, diagramId);
  const [state, setState] = useState<LoadState>(() => initialState(client, key));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const cached = htmlCache.get(key);
    if (cached !== undefined) {
      setState({ kind: "ready", html: cached });
      return undefined;
    }
    if (!client) {
      setState({ kind: "offline" });
      return undefined;
    }
    let alive = true;
    setState({ kind: "loading" });
    void (async () => {
      let next: LoadState;
      try {
        const html = await client.forumDiagramHtml({ topicId, diagramId });
        if (html !== null) remember(key, html);
        next = html === null ? { kind: "not_found" } : { kind: "ready", html };
      } catch {
        next = { kind: "failed" };
      }
      if (alive) setState(next);
    })();
    return () => {
      alive = false;
    };
  }, [client, topicId, diagramId, key, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}

const STATUS_MESSAGE_KEY = {
  not_found: "forumArch.notFound",
  offline: "forumArch.offline",
  failed: "forumArch.loadFailed",
} as const;

export interface ArchifyDiagramViewProps {
  client: DaemonClient | null;
  topicId: string;
  diagramId: string;
  replayToken: number;
  statusTextStyle: TextStyle;
  retryTextStyle: TextStyle;
}

function ArchifyDiagramViewImpl({
  client,
  topicId,
  diagramId,
  replayToken,
  statusTextStyle,
  retryTextStyle,
  colorScheme = "dark",
}: ArchifyDiagramViewProps & { colorScheme?: ArchifyColorScheme }): ReactElement | null {
  const { t } = useTranslation();
  const { height: windowHeight } = useWindowDimensions();
  const frameHeight = Math.round(Math.min(720, Math.max(320, windowHeight * 0.6)));
  const { state, retry } = useArchifyHtml(client, topicId, diagramId);
  const html = state.kind === "ready" ? state.html : null;
  const document = useMemo(
    () => (html === null ? null : buildArchifyDocument(html, colorScheme)),
    [html, colorScheme],
  );

  if (state.kind === "loading") {
    return <Text style={statusTextStyle}>{t("forumArch.loading")}</Text>;
  }
  if (state.kind === "ready" && document !== null) {
    return (
      <ArchifyFrame
        document={document}
        replayToken={replayToken}
        height={frameHeight}
        title={t("forumArch.title")}
        testID="forum-arch-archify-frame"
      />
    );
  }
  if (state.kind === "ready") return null;
  const message = t(STATUS_MESSAGE_KEY[state.kind]);
  return (
    <View testID="forum-arch-archify-status">
      <Text style={statusTextStyle}>{message}</Text>
      {state.kind === "failed" ? (
        <Pressable onPress={retry} accessibilityRole="button">
          <Text style={retryTextStyle}>{t("forumArch.retry")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const ThemedArchifyDiagramView = withUnistyles(ArchifyDiagramViewImpl);
const mapColorScheme = (theme: Theme) => ({ colorScheme: theme.colorScheme });

export function ArchifyDiagramView(props: ArchifyDiagramViewProps): ReactElement {
  return <ThemedArchifyDiagramView {...props} uniProps={mapColorScheme} />;
}
