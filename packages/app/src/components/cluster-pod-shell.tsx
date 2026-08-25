import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import TerminalEmulator, { type TerminalEmulatorHandle } from "@/components/terminal-emulator";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";

interface ClusterPodShellProps {
  serverId: string;
  clusterId: string;
  namespace: string;
  pod: string;
  container?: string;
  containers?: string[];
  onSelectContainer?: (container: string) => void;
  onClose: () => void;
}

const encoder = new TextEncoder();

function ContainerChip({
  name,
  selected,
  onSelect,
}: {
  name: string;
  selected: boolean;
  onSelect: (name: string) => void;
}) {
  const handlePress = useCallback(() => onSelect(name), [name, onSelect]);
  return (
    <Pressable
      style={[styles.containerChip, selected && styles.containerChipActive]}
      onPress={handlePress}
    >
      <Text
        style={[styles.containerChipText, selected && styles.containerChipTextActive]}
        numberOfLines={1}
      >
        {name}
      </Text>
    </Pressable>
  );
}

/**
 * An interactive pod shell rendered with the app's real terminal emulator (same
 * one workspace terminals use) — a proper xterm-style grid with ANSI colors and
 * a live cursor, not a "type a line and press Send" box. The kubectl exec stream
 * is bidirectional: stdout bytes feed the emulator, keystrokes are written back.
 */
export function ClusterPodShell({
  serverId,
  clusterId,
  namespace,
  pod,
  container,
  containers = [],
  onSelectContainer,
  onClose,
}: ClusterPodShellProps) {
  const client = useHostRuntimeClient(serverId);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const emulatorRef = useRef<TerminalEmulatorHandle>(null);
  const execRef = useRef<{ write: (d: string) => void; close: () => Promise<void> } | null>(null);
  const cancelledRef = useRef(false);

  // A multi-container pod needs an explicit container or exec fails with HTTP 400
  // ("a container name must be specified"). Default to the first one so the shell
  // works out of the box; the selector below lets the user switch.
  const activeContainer = container ?? containers[0];

  useEffect(() => {
    if (!client) {
      setError("No client connection");
      return;
    }
    cancelledRef.current = false;
    setError(null);
    void client
      .clusterExecStart(
        {
          id: clusterId,
          namespace,
          pod,
          ...(activeContainer ? { container: activeContainer } : {}),
          command: ["/bin/sh"],
        },
        (data: string) => {
          if (cancelledRef.current) return;
          // The daemon signals an exec failure (no shell in the image, kubelet
          // unreachable, wrong container…) with a [shell-error] marker. Surface
          // it as a clean error card instead of dumping raw text into the grid.
          const markerAt = data.indexOf("[shell-error]");
          if (markerAt >= 0) {
            const msg = data
              .slice(markerAt + "[shell-error]".length)
              .replace(/\s+/g, " ")
              .trim();
            setError(msg || "Shell unavailable");
            return;
          }
          emulatorRef.current?.writeOutput(encoder.encode(data));
        },
      )
      .then((exec) => {
        if (cancelledRef.current) {
          void exec.close();
          return undefined;
        }
        execRef.current = exec;
        return undefined;
      })
      .catch((e: unknown) => {
        if (!cancelledRef.current) setError(e instanceof Error ? e.message : "Exec failed");
      });
    return () => {
      cancelledRef.current = true;
      void execRef.current?.close();
      execRef.current = null;
    };
  }, [client, clusterId, namespace, pod, activeContainer, retryKey]);

  const handleInput = useCallback((data: string) => {
    execRef.current?.write(data);
  }, []);

  const handleRetry = useCallback(() => {
    void execRef.current?.close();
    execRef.current = null;
    setError(null);
    setRetryKey((k) => k + 1);
  }, []);

  const handleClose = useCallback(() => {
    cancelledRef.current = true;
    void execRef.current?.close();
    execRef.current = null;
    onClose();
  }, [onClose]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerText}>Shell</Text>
        <Pressable style={styles.closeButton} onPress={handleClose}>
          <Text style={styles.closeButtonText}>Close</Text>
        </Pressable>
      </View>
      {containers.length > 1 && onSelectContainer ? (
        <View style={styles.containerBar}>
          {containers.map((c) => (
            <ContainerChip
              key={c}
              name={c}
              selected={c === activeContainer}
              onSelect={onSelectContainer}
            />
          ))}
        </View>
      ) : null}
      {error ? (
        <View style={styles.errorCard}>
          <Text style={styles.errorTitle}>Shell unavailable</Text>
          <Text style={styles.errorText}>{error}</Text>
          <Text style={styles.errorHint}>
            The container may have no shell (distroless), or the node’s kubelet is unreachable. Try
            another container above, or retry.
          </Text>
          <Pressable style={styles.retryButton} onPress={handleRetry}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.terminal}>
          <TerminalEmulator
            ref={emulatorRef}
            streamKey={`pod-exec:${clusterId}:${namespace}/${pod}/${activeContainer ?? ""}:${retryKey}`}
            supportsTerminalInputModeReplay={false}
            scrollbackLines={5000}
            fontSize={13}
            onInput={handleInput}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flex: 1,
    minHeight: 320,
    paddingTop: theme.spacing[3],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: theme.spacing[2],
  },
  headerText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundExtraMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  closeButton: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  closeButtonText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  containerBar: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
    marginBottom: theme.spacing[2],
  },
  containerChip: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  containerChipActive: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  containerChipText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  containerChipTextActive: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  errorCard: {
    alignSelf: "flex-start",
    maxWidth: 560,
    gap: theme.spacing[2],
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  errorTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.red[500],
  },
  errorHint: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    lineHeight: 18,
  },
  retryButton: {
    alignSelf: "flex-start",
    marginTop: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  retryButtonText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  terminal: {
    flex: 1,
    minHeight: 240,
    maxHeight: 520,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    overflow: "hidden",
    backgroundColor: theme.colors.surface1,
  },
}));
