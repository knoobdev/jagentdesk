// "Browse files" — the primary add action in the Figma DESIGN sidebar (spec
// 32-figma §4, ADR-0038). Electron opens an isolated Figma FILES WEBSITE
// selector window (BrowserWindow at figma.com/files on its own session
// partition — NOT the native system / local-file picker and never a renderer
// <input type=file>), and selecting a file there hands back the captured
// canonical URL. The renderer then walks the REAL flow:
// figma.files.add.request on the selected connection → invalidate → open the
// file the ADD RESPONSE actually returned.
//
// There is no cancel RPC on the bridge, so we deliberately offer no Cancel
// button: closing the selector window IS the cancel (the pick resolves
// { kind: "cancelled" }). A late result that lands after the row unmounted or
// the server/connection changed is dropped by the generation counter, and the
// busy state belongs to the generation that started it — so an old completion
// can never unlock (or overwrite) a request the current context owns.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Folder, Loader2 } from "lucide-react-native";
import { useQueryClient } from "@tanstack/react-query";
import type { Theme } from "@/styles/theme";
import type { FigmaRpcError } from "./api";
import { callFigma } from "./api";
import { invalidateFigmaFiles } from "./queries";
import { parseFigmaFileUrl } from "./url-parse";
import { useFigmaGlobalNav } from "./nav";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { getDesktopHost } from "@/desktop/host";

type PickResult = { kind: "file"; url: string } | { kind: "cancelled" };

// Theme-reactive icons, the same `withUnistyles` pattern as the sidebar rows
// (colors follow light/dark, never a hardcoded hex).
const ThemedFolder = withUnistyles(Folder, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedSpinner = withUnistyles(Loader2, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));

const pickFigmaFile = (): (() => Promise<PickResult>) | null => {
  const pick = getDesktopHost()?.figma?.pickFile;
  return pick ? () => pick() : null;
};

/** Browse is a desktop-only affordance; the availability check is the actual
 * capability, not Platform.OS (website/OAuth and mobile sessions never see the
 * isolated Figma Files selector window). */
export function canBrowseFigmaFiles(): boolean {
  return pickFigmaFile() !== null;
}

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
  onAdded,
  testID = "figma-nav-browse",
}: {
  serverId: string;
  connectionId: string | null;
  /** Optional extra invalidation the host nav wants after an add (e.g. teams). */
  onAdded?: () => void;
  testID?: string;
}) {
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const { go } = useFigmaGlobalNav();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped on unmount and whenever the server/connection context changes; a
  // pick result whose generation is stale is dropped, never added/navigated.
  const generation = useRef(0);
  // The generation that currently OWNS the busy state — a synchronous gate (a
  // second click in the same tick cannot start a second pick before React has
  // re-rendered the disabled state) and an ownership record: only the owner
  // may release busy, and a context switch clears ownership up front.
  const busyOwner = useRef<number | null>(null);

  useEffect(() => {
    // A pick still in flight belongs to the PREVIOUS context (its promise
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
    const pick = pickFigmaFile();
    const started = generation.current;
    if (!pick || !connectionId || busyOwner.current !== null) return;
    busyOwner.current = started;
    setBusy(true);
    setError(null);
    try {
      const result = await pick();
      // Cancel (selector window closed) and any late result after the row
      // unmounted or the connection changed: drop it, touch nothing.
      if (result.kind !== "file" || generation.current !== started) return;
      const target = parseFigmaFileUrl(result.url);
      if (!target) {
        setError("Figma did not return a file URL we could open.");
        return;
      }
      const response = await callFigma(client, "figma.files.add.request", {
        connectionId,
        url: result.url,
      });
      if (generation.current !== started) return;
      // No success fallback on a missing file: opening the URL we SENT as if
      // the add worked would hide a broken response contract.
      const added = response.file;
      if (!added?.fileKey) {
        setError("Could not add/open file: no file returned.");
        return;
      }
      await invalidateFigmaFiles(queryClient, serverId);
      // The invalidation awaited — an account switch during it retires this
      // generation, and a stale completion must neither navigate nor notify.
      if (generation.current !== started) return;
      onAdded?.();
      // Open the ACTUAL file the add response returned (the captured URL's
      // node-id is the caller's selection, so the node survives the round-trip).
      go({ fileKey: added.fileKey, pageId: null, nodeId: target.nodeId, version: null });
    } catch (cause) {
      if (generation.current === started) setError(describeFigmaApiError(cause));
    } finally {
      // Only the context that started this pick may clear its busy state; an
      // old completion must not unlock a request the current context owns.
      if (busyOwner.current === started) {
        busyOwner.current = null;
        setBusy(false);
      }
    }
  }, [client, connectionId, go, onAdded, queryClient, serverId]);

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
        <Text style={styles.label}>{busy ? "Opening file browser…" : "Browse files"}</Text>
      </Pressable>
      {error ? (
        <Text style={styles.error} testID={`${testID}-error`}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/** Mobile (and any non-desktop session): tracked files stay readable, adding
 * is guidance — a fake mobile picker would suggest a file dialog we do not
 * have (ADR-0038). */
export function BrowseGuidanceRow({ testID = "figma-nav-browse-guidance" }: { testID?: string }) {
  return (
    <Text style={styles.guidance} testID={testID}>
      Browse for files in the JAgentDesk desktop app — on mobile you can still open files already
      added there, or paste a Figma URL under Advanced.
    </Text>
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
  guidance: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs + 5,
    color: theme.colors.foregroundMuted,
  },
}));
