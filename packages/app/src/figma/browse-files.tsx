// "Browse files" — the primary add action in the Figma DESIGN sidebar (spec
// 32-figma §4, ADR-0038). Electron opens the NATIVE system pick (never a
// renderer <input type=file>), reads the selected file with the user's Figma
// session, and hands back the captured canonical URL. The renderer then walks
// the REAL flow: figma.files.add.request on the selected connection →
// invalidate → open the actual returned file.
//
// There is no cancel RPC on the bridge, so we deliberately offer no Cancel
// button: closing the native picker IS the cancel (the pick resolves
// { kind: "cancelled" }). A late result that lands after the row unmounted or
// the server/connection changed is dropped by the generation counter so it
// never adds or navigates using a stale context.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import type { FigmaRpcError } from "./api";
import { callFigma } from "./api";
import { invalidateFigmaFiles } from "./queries";
import { parseFigmaFileUrl } from "./url-parse";
import { useFigmaGlobalNav } from "./nav";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { getDesktopHost } from "@/desktop/host";
import { Folder, Loader2 } from "lucide-react-native";

type PickResult = { kind: "file"; url: string } | { kind: "cancelled" };

const pickFigmaFile = (): (() => Promise<PickResult>) | null => {
  const pick = getDesktopHost()?.figma?.pickFile;
  return pick ? () => pick() : null;
};

/** Browse is a desktop-only affordance; the availability check is the actual
 * capability, not Platform.OS (website/OAuth and mobile sessions never see a
 * native picker). */
export function canBrowseFigmaFiles(): boolean {
  return pickFigmaFile() !== null;
}

/**
 * A Figma 403 is an app-API-access failure on the connected Figma account,
 * not a sharing/link-permission problem — so for `forbidden` we surface the
 * daemon's own account/app diagnostic and do not suggest checking sharing.
 * Anything else keeps the daemon message. Never rethrows here: the caller is
 * already in the error branch and needs text.
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
  // Synchronous busy gate — a second click during the same tick cannot start a
  // second pick before React has re-rendered the disabled state.
  const busyRef = useRef(false);

  useEffect(() => {
    generation.current += 1;
    return () => {
      generation.current += 1;
    };
  }, [serverId, connectionId]);

  const browse = useCallback(async () => {
    const pick = pickFigmaFile();
    if (!pick || !connectionId || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const started = generation.current;
    try {
      const result = await pick();
      // Cancel by the user (picker closed) and any late result after the row
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
      await invalidateFigmaFiles(queryClient, serverId);
      onAdded?.();
      // Open the ACTUAL file the add response returned (the captured URL's
      // node-id is the caller's selection, so the node survives the round-trip).
      const fileKey = response.file?.fileKey ?? target.fileKey;
      go({ fileKey, pageId: null, nodeId: target.nodeId, version: null });
    } catch (cause) {
      if (generation.current === started) setError(describeFigmaApiError(cause));
    } finally {
      busyRef.current = false;
      if (generation.current === started) setBusy(false);
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
        style={browseRow}
      >
        {busy ? <Loader2 size={13} color="#d4d4d4" /> : <Folder size={13} color="#d4d4d4" />}
        <Text style={rowLabel}>{busy ? "Opening Figma…" : "Browse files"}</Text>
      </Pressable>
      {error ? (
        <Text style={errorText} testID={`${testID}-error`}>
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
    <Text style={guidanceText} testID={testID}>
      Browse for files in the JAgentDesk desktop app — on mobile you can still open files already
      added there, or paste a Figma URL under Advanced.
    </Text>
  );
}

const browseRow = {
  alignItems: "center",
  borderRadius: 8,
  flexDirection: "row",
  gap: 8,
  paddingHorizontal: 10,
  paddingVertical: 7,
} as const;
const rowLabel = { color: "#d4d4d4", fontSize: 13 } as const;
const errorText = { color: "#ef4444", fontSize: 11, paddingHorizontal: 10, paddingTop: 2 } as const;
const guidanceText = {
  color: "#737373",
  fontSize: 11,
  lineHeight: 16,
  paddingHorizontal: 12,
  paddingVertical: 6,
} as const;
