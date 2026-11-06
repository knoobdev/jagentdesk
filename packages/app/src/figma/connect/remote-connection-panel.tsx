import { default as React, useCallback, useEffect, useRef, useState } from "react";
import type { FigmaRemoteStatus } from "@jagentdesk/protocol/figma/rpc-schemas";
import { Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { useHostFeature } from "@/runtime/host-features";
import { errorMessage, useFigmaCall } from "@/figma/api";
import { useFigmaRemoteStatus } from "@/figma/queries";
import {
  AuthDot,
  CopyButton,
  ErrorBanner,
  SectionHeading,
  Spinner,
  type AuthDotTone,
} from "@/figma/ui/primitives";
import { figmaStyles } from "@/figma/ui/styles";
import { openExternalUrl } from "@/utils/open-external-url";

// Figma editing (Remote MCP) connection — ADR-0040 / spec 32.7+32.9. The daemon owns a single
// connector built on the real Codex app-server MCP client; this panel only reads and steers it
// through `figma.remote.*`. It is gated ONCE on the optional `figmaRemoteWrites` capability: an
// old host shows the update request and runs no data path. Canvas and player never depend on it.
//
// The rules that shape this UI:
// - OAuth starts on an explicit button press only. Mount, query, and agent tool calls must never
//   open a sign-in on the user's behalf (the host's Codex owns the loopback callback, so a phone
//   can't complete it itself).
// - Identity text comes from the connector's `whoami` (via the daemon's status), never from the
//   REST account; a missing identity stays missing — no placeholder.
// - "Connected" means the MCP connection is up. Edit rights per file are verified when a write
//   runs, so nothing here claims "Saved".
// - Status polls only while the connector is mid-transition (connecting / needs_auth); every
//   other state is static and re-read on demand through Retry.
// - connecting/needs_auth offer Cancel sign-in: the same `figma.remote.disconnect.request` that
//   stops a connected connector — always JAgentDesk's own connector, never an OAuth logout.
// - A host switch (serverId change) or unmount invalidates in-flight begin/disconnect settles via
//   a generation ref; the new host starts with no URL, error, or busy state of the old one's.
// - A missing/unsupported Codex executable arrives as `unavailable` with the daemon's own update
//   message: dependency info, never a push to switch the chat provider or model.

const STATUS_POLL_MS = 2_000;

/**
 * The sign-in page must be a plain HTTPS Figma URL on the official hosts: credentials in the
 * URL or an explicit non-443 port mean the daemon handed back something that did not come from
 * Figma's documented OAuth endpoints, and is not worth opening in a browser.
 */
const AUTH_HOSTS = new Set(["figma.com", "www.figma.com", "api.figma.com"]);
export function figmaHttpsAuthUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    if (!AUTH_HOSTS.has(parsed.hostname.toLowerCase())) return null;
    if (parsed.username || parsed.password) return null;
    // `new URL` normalizes an explicit 443 away; any other port is nonstandard for OAuth here.
    if (parsed.port && parsed.port !== "443") return null;
    return url;
  } catch {
    return null;
  }
}

function dotTone(state: FigmaRemoteStatus["state"] | null): AuthDotTone {
  switch (state) {
    case "connected":
      return "ok";
    case "connecting":
    case "needs_auth":
      return "needs-auth";
    case "unavailable":
    case "error":
      return "expired";
    default:
      return "offline";
  }
}

function isTransitionalState(state: FigmaRemoteStatus["state"] | null): boolean {
  return state === "connecting" || state === "needs_auth";
}

function stateLine(state: FigmaRemoteStatus["state"] | null): string {
  switch (state) {
    case "connected":
      return "Connected for editing on this host";
    case "connecting":
      return "Starting the editing connector on the host…";
    case "needs_auth":
      return "Waiting for sign-in — complete it on the host computer.";
    case "unavailable":
      return "Editing connector unavailable on this host";
    case "error":
      return "Editing connector error";
    default:
      return "Not connected for editing";
  }
}

export function RemoteConnectionPanel({ serverId }: { serverId: string }) {
  // The capability gate reads server_info ONCE; nothing below re-checks it and no RPC fires when
  // an old host lacks the connector (mirrors the ADR-0039 file-screen shape: the data-path hooks
  // live in the inner component so no hook runs conditionally).
  const supported = useHostFeature(serverId, "figmaRemoteWrites");
  if (!supported) {
    return (
      <View style={figmaStyles.card} testID="figma-remote-update-host">
        <SectionHeading
          title="Figma editing"
          hint="This host predates Remote MCP writes — update the app running the daemon to edit files from your phone."
        />
      </View>
    );
  }
  return <RemoteConnectionPanelInner serverId={serverId} />;
}

function RemoteConnectionPanelInner({ serverId }: { serverId: string }) {
  const call = useFigmaCall(serverId);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Polling follows the OBSERVED connector state: mid-transition (connecting / needs_auth) is the
  // only time status polls. Disconnected/connected/unavailable/error views are static and re-read
  // on demand through Retry, so an unattended sign-in never becomes an autoload loop.
  const [transitional, setTransitional] = useState(false);
  // Bumped on unmount AND on a host switch: a settle from an in-flight begin/disconnect must not
  // stamp URL/error state onto a dead component or onto a different server's panel.
  const generation = useRef(0);
  // Synchronous in-flight latch for begin/disconnect: setBusy alone cannot stop a double click
  // that lands in the same event loop (React has not committed the state yet).
  const inFlight = useRef(false);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  // A serverId swap is a new host: drop everything the previous host owned (URL, error, busy,
  // polling) synchronously in render, and invalidate its in-flight RPCs via the generation bump.
  // The lastServerId render guard beats any effect window between the swap and its cleanup.
  const lastServerId = useRef(serverId);
  if (lastServerId.current !== serverId) {
    lastServerId.current = serverId;
    generation.current += 1;
    inFlight.current = false;
    setAuthUrl(null);
    setActionError(null);
    setBusy(false);
    setTransitional(false);
  }

  const statusQuery = useFigmaRemoteStatus(serverId, {
    refetchIntervalMs: transitional ? STATUS_POLL_MS : undefined,
  });
  const state = statusQuery.data?.state ?? null;
  const message = statusQuery.data?.message ?? null;
  const rawIdentity = statusQuery.data?.identityText?.trim();
  // Older hosts may return a truncated whoami document instead of a human identity.
  const identityText =
    rawIdentity && !rawIdentity.startsWith("{") && !rawIdentity.startsWith("[")
      ? rawIdentity
      : null;
  useEffect(() => {
    setTransitional(isTransitionalState(state));
    // Once the connector settles on either side, the stored sign-in link is history: an Open
    // sign-in button for an OAuth round that already finished (or was abandoned) is just stale.
    if (state === "connected" || state === "disconnected") setAuthUrl(null);
  }, [state]);

  const refresh = useCallback(() => {
    // Fire-and-forget: React Query owns the retry surface; the banner below is the failure echo.
    void statusQuery.refetch();
  }, [statusQuery]);

  const begin = useCallback(async () => {
    // Double-clicks land in the same event loop before setBusy commits, so the synchronous ref
    // — not the busy state — is what actually prevents a second begin/disconnect RPC.
    if (inFlight.current) return;
    inFlight.current = true;
    const gen = generation.current;
    setBusy(true);
    setActionError(null);
    try {
      const response = await call("figma.remote.auth.begin.request", {});
      if (generation.current !== gen) return; // unmounted or host switched mid-flight
      setAuthUrl(figmaHttpsAuthUrl(response.authorizationUrl));
      refresh();
    } catch (cause) {
      if (generation.current !== gen) return;
      setActionError(errorMessage(cause));
    } finally {
      // Only the owning generation releases the shared latch: a host switch (or unmount) already
      // handed it to the reset branch or to a newer action, and must not be unlocked by a stale
      // settle clearing someone else's in-flight claim.
      if (generation.current === gen) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }, [call, refresh]);

  const disconnect = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const gen = generation.current;
    setBusy(true);
    setActionError(null);
    try {
      // Stops JAgentDesk's own connector and any pending sign-in — NOT an OAuth logout/revoke:
      // other Codex sessions keep their Figma sign-in in the native vault on the host.
      await call("figma.remote.disconnect.request", {});
      if (generation.current !== gen) return;
      setAuthUrl(null);
      refresh();
    } catch (cause) {
      if (generation.current !== gen) return;
      setActionError(errorMessage(cause));
    } finally {
      if (generation.current === gen) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }, [call, refresh]);

  const openSignIn = useCallback(() => {
    // The user gesture lives here: only this press may hand the URL to the system browser.
    if (authUrl) void openExternalUrl(authUrl);
  }, [authUrl]);

  const queryError = statusQuery.isError ? errorMessage(statusQuery.error) : null;
  const banner =
    queryError ?? actionError ?? (state === "error" || state === "unavailable" ? message : null);

  return (
    <View style={figmaStyles.card} testID="figma-remote-panel">
      <SectionHeading
        title="Figma editing"
        hint="Writes go through the host's Remote MCP connector. Viewing and playback never depend on it."
      />
      <StatusSection state={state} identityText={identityText} transitional={transitional} />
      {banner ? <ErrorBanner message={banner} /> : null}
      <ActionSection
        state={state}
        busy={busy}
        authUrl={authUrl}
        showRetry={queryError !== null || state === "error" || state === "unavailable"}
        onBegin={begin}
        onDisconnect={disconnect}
        onRetry={refresh}
        onOpenSignIn={openSignIn}
      />
    </View>
  );
}

// The state rows are pure renderers of the observed connector state — kept apart from the inner
// component so the async handlers (and their generation guards) stay well under the lint budget.
function StatusSection({
  state,
  identityText,
  transitional,
}: {
  state: FigmaRemoteStatus["state"] | null;
  identityText: string | null;
  transitional: boolean;
}) {
  return (
    <>
      <View style={figmaStyles.row} testID="figma-remote-status">
        <AuthDot tone={dotTone(state)} />
        <View style={figmaStyles.flex1}>
          <Text style={figmaStyles.rowTitle}>{stateLine(state)}</Text>
          {/* Identity only when the connector's whoami produced it — never a REST-account guess. */}
          {state === "connected" && identityText ? (
            <Text style={figmaStyles.rowSubtle} testID="figma-remote-identity">
              {identityText}
            </Text>
          ) : null}
          {transitional ? <Spinner testID="figma-remote-busy" /> : null}
        </View>
      </View>

      {state === "connected" ? (
        // ADR-0040: connected ≠ seat/edit rights for every file, and nothing is "Saved" here.
        <Text style={figmaStyles.rowSubtle} testID="figma-remote-rights-hint">
          Edit rights are checked per file when a write runs — this connection is not proof of
          access to any particular file.
        </Text>
      ) : null}

      {state === "needs_auth" ? (
        <Text style={figmaStyles.rowSubtle} testID="figma-remote-host-hint">
          The sign-in opens on this device, but the callback lands on the host computer where the
          daemon runs — complete it there.
        </Text>
      ) : null}
    </>
  );
}

function ActionSection({
  state,
  busy,
  authUrl,
  showRetry,
  onBegin,
  onDisconnect,
  onRetry,
  onOpenSignIn,
}: {
  state: FigmaRemoteStatus["state"] | null;
  busy: boolean;
  authUrl: string | null;
  showRetry: boolean;
  onBegin: () => void;
  onDisconnect: () => void;
  onRetry: () => void;
  onOpenSignIn: () => void;
}) {
  // The own-connector stop is available in every live state, not just `connected`: a user who
  // started a sign-in must be able to cancel a stuck `connecting`/`needs_auth` round. It always
  // means "stop JAgentDesk's connector", never an OAuth logout on the host (ADR-0040).
  const canDisconnect = state === "connected" || isTransitionalState(state);
  return (
    <>
      <View style={figmaStyles.row}>
        {state !== "connected" ? (
          <Button
            size="sm"
            variant="default"
            loading={busy}
            disabled={busy || state === "connecting"}
            onPress={onBegin}
            testID="figma-remote-connect"
          >
            {state === "needs_auth" ? "Continue sign-in" : "Connect editing"}
          </Button>
        ) : null}
        {canDisconnect ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onPress={onDisconnect}
            testID="figma-remote-disconnect"
          >
            {state === "connected" ? "Disconnect editing" : "Cancel sign-in"}
          </Button>
        ) : null}
        {showRetry ? (
          <Button size="sm" variant="ghost" onPress={onRetry} testID="figma-remote-retry">
            Retry
          </Button>
        ) : null}
      </View>

      {authUrl ? (
        <View style={figmaStyles.row} testID="figma-remote-auth-url">
          <Button
            size="sm"
            variant="outline"
            onPress={onOpenSignIn}
            testID="figma-remote-open-auth"
          >
            Open sign-in
          </Button>
          <CopyButton value={authUrl} label="Copy sign-in link" testID="figma-remote-copy-auth" />
        </View>
      ) : null}
    </>
  );
}
