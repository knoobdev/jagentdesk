import { ActivityIndicator, Image, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

interface BrowserPaneProps {
  browserId: string;
  serverId: string;
  workspaceId: string;
  cwd: string | null;
  isInteractive?: boolean;
  onFocusPane?: () => void;
}

// View-only screencast poll rate (~3 fps). Each tick is a full PNG round-trip via the daemon
// browser-tools broker, so the next tick is scheduled only after the previous one resolves.
const POLL_INTERVAL_MS = 350;

interface ScreencastFrame {
  uri: string;
  width: number;
  height: number;
}

/**
 * Mobile browser pane: the browser itself is hosted by the desktop (Electron resident webview);
 * mobile can't run it. The workspace tab layout is client-local and the browser store is
 * desktop-local, so the mobile can't know the desktop's browserIds directly — it first asks the
 * daemon to list the host's live browser tabs, picks one (preferring this workspace / the passed
 * browserId), then renders a live **screencast** by polling that tab's PNG frame.
 */
export function BrowserPane({ browserId, serverId, workspaceId, isInteractive }: BrowserPaneProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const [frame, setFrame] = useState<ScreencastFrame | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef(true);
  const targetRef = useRef<string | null>(null);

  const paused = isInteractive === false;

  useEffect(() => {
    if (paused || !client || !workspaceId) {
      return;
    }
    activeRef.current = true;
    targetRef.current = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      if (!activeRef.current) {
        return;
      }
      try {
        // Resolve a desktop-hosted browser tab to screencast if we don't have one yet.
        if (!targetRef.current) {
          const listed = await client.requestBrowserList({ workspaceId });
          if (!activeRef.current) {
            return;
          }
          if (listed.ok) {
            const match =
              listed.tabs.find((tab) => tab.browserId === browserId) ??
              listed.tabs.find((tab) => tab.workspaceId === workspaceId) ??
              listed.tabs[0];
            targetRef.current = match?.browserId ?? null;
            setLabel(match ? match.title || match.url : null);
            setError(null);
          } else {
            setError(listed.error.message);
          }
        }

        const target = targetRef.current;
        if (target) {
          const payload = await client.requestBrowserScreenshot({ browserId: target, workspaceId });
          if (!activeRef.current) {
            return;
          }
          if (payload.ok) {
            setFrame({
              uri: `data:${payload.mimeType};base64,${payload.dataBase64}`,
              width: payload.width,
              height: payload.height,
            });
            setError(null);
          } else {
            // Tab likely closed / not found — re-resolve on the next tick.
            targetRef.current = null;
            setFrame(null);
            setError(payload.error.message);
          }
        } else {
          setFrame(null);
        }
      } catch (caught) {
        if (activeRef.current) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }
      if (activeRef.current) {
        timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
      }
    };

    void tick();
    return () => {
      activeRef.current = false;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [client, browserId, workspaceId, paused]);

  if (!frame) {
    return (
      <View style={styles.container}>
        <ActivityIndicator color={theme.colors.foregroundMuted} />
        <Text style={styles.title}>{t("workspace.browser.unavailable.title")}</Text>
        <Text style={styles.subtitle}>
          {error ?? label ?? t("workspace.browser.session", { browserId })}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.frameContainer}>
      <Image
        source={{ uri: frame.uri }}
        style={styles.frame}
        resizeMode="contain"
        fadeDuration={0}
        accessibilityLabel={label ?? t("workspace.browser.session", { browserId })}
      />
      {label ? (
        <View style={styles.urlBar}>
          <Text style={styles.urlText} numberOfLines={1}>
            {label}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 16,
    backgroundColor: theme.colors.surface0,
  },
  title: {
    fontSize: 16,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  subtitle: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  frameContainer: {
    flex: 1,
    backgroundColor: "#000000",
  },
  frame: {
    flex: 1,
    width: "100%",
  },
  urlBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
    opacity: 0.92,
  },
  urlText: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
}));
