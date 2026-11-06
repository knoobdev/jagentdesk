// Browse the selected account's tracked files inside JAgentDesk. No website picker or second sign-in.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Folder, Loader2 } from "lucide-react-native";
import { useQueryClient } from "@tanstack/react-query";
import type { Theme } from "@/styles/theme";
import type { FigmaRpcError } from "./api";
import { callFigma } from "./api";
import { figmaKeys } from "./queries";
import { openFigmaFiles } from "./file-browser-model";
import { useFigmaGlobalNav } from "./nav";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

// Theme-reactive icons, the same `withUnistyles` pattern as the sidebar rows
// (colors follow light/dark, never a hardcoded hex).
const ThemedFolder = withUnistyles(Folder, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedSpinner = withUnistyles(Loader2, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));

/**
 * A Figma 403 has several possible causes — the app's API access, the file's
 * sharing settings, org policy — and the renderer cannot tell them apart, so
 * it invents no explanation of its own (no "check sharing" claim): the
 * daemon's neutral, authoritative diagnostic is surfaced verbatim for
 * `forbidden`. Anything else keeps the daemon message too. Never rethrows
 * here: the caller is already in the error branch and needs text.
 */
export function describeFigmaApiError(cause: unknown): string {
  const rpc = cause as Partial<FigmaRpcError> | null | undefined;
  if (rpc?.code === "forbidden") {
    const detail = typeof rpc.message === "string" && rpc.message.trim() ? rpc.message : null;
    return (
      detail ??
      "JAgentDesk could not read this file with your connected Figma account — the app's API access was denied."
    );
  }
  if (rpc?.message) return rpc.message;
  if (cause instanceof Error) return cause.message;
  return "Could not load Figma files.";
}

export function BrowseFilesRow({
  serverId,
  connectionId,
  testID = "figma-nav-browse",
}: {
  serverId: string;
  connectionId: string | null;
  testID?: string;
}) {
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const { go } = useFigmaGlobalNav();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped on unmount and whenever the server/connection context changes; a
  // refresh whose generation is stale cannot change the current error/busy state.
  const generation = useRef(0);
  // The generation that currently OWNS the busy state — a synchronous gate (a
  // second click in the same tick cannot start a second refresh before React has
  // re-rendered the disabled state) and an ownership record: only the owner
  // may release busy, and a context switch clears ownership up front.
  const busyOwner = useRef<number | null>(null);

  useEffect(() => {
    // A refresh still in flight belongs to the previous context (its promise
    // captured the old client/connection). Release the gate so a fresh Browse
    // is immediately usable; the late result is dropped by the generation
    // check and must not touch the current context's state.
    if (busyOwner.current !== null && busyOwner.current !== generation.current) {
      busyOwner.current = null;
      setBusy(false);
    }
    return () => {
      generation.current += 1;
    };
  }, [serverId, connectionId]);

  const browse = useCallback(async () => {
    const started = generation.current;
    if (!connectionId || busyOwner.current !== null) return;
    busyOwner.current = started;
    setBusy(true);
    setError(null);
    try {
      await openFigmaFiles(
        {
          go,
          refresh: (selectedConnectionId) =>
            queryClient.fetchQuery({
              queryKey: figmaKeys.files(serverId, selectedConnectionId),
              queryFn: async () =>
                (
                  await callFigma(client, "figma.files.list.request", {
                    connectionId: selectedConnectionId,
                  })
                ).files,
              staleTime: 0,
            }),
        },
        connectionId,
      );
    } catch (cause) {
      if (generation.current === started) setError(describeFigmaApiError(cause));
    } finally {
      // Only the context that started this refresh may clear its busy state; an
      // old completion must not unlock a request the current context owns.
      if (busyOwner.current === started) {
        busyOwner.current = null;
        setBusy(false);
      }
    }
  }, [client, connectionId, go, queryClient, serverId]);

  const onPress = useCallback(() => {
    void browse();
  }, [browse]);

  if (!connectionId) return null;
  return (
    <View testID={testID}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        disabled={busy}
        testID={`${testID}-button`}
        style={styles.row}
      >
        {busy ? <ThemedSpinner size={13} /> : <ThemedFolder size={13} />}
        <Text style={styles.label}>{busy ? "Loading files…" : "Browse files"}</Text>
      </Pressable>
      {error ? (
        <Text style={styles.error} testID={`${testID}-error`}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const row = (theme: Theme) =>
  ({
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    marginHorizontal: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  }) as const;

const styles = StyleSheet.create((theme: Theme) => ({
  row: row(theme),
  label: { flexShrink: 1, fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  error: {
    paddingHorizontal: theme.spacing[3] + theme.spacing[6],
    paddingTop: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.palette.red[500],
  },
}));
