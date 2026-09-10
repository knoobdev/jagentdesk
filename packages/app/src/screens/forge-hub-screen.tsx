import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type MutableRefObject,
} from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type TextStyle,
} from "react-native";
import {
  ArrowLeft,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleDot,
  Code,
  Copy,
  Download,
  ExternalLink,
  File,
  Folder,
  FolderGit2,
  GitBranch,
  GitCommit,
  GitCompare,
  GitPullRequest,
  KeyRound,
  LogIn,
  MessageSquare,
  Play,
  Plug,
  Plus,
  RotateCcw,
  Search,
  Server,
  Tag,
  Trash2,
  X,
} from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ForgeArtifactSchema,
  ForgeBranchSchema,
  ForgeChangeRequestFileSchema,
  ForgeChangeRequestSummarySchema,
  ForgeCommitSchema,
  ForgeIssueSchema,
  ForgePipelineDetailSchema,
  ForgePipelineRunSchema,
  ForgeReleaseSchema,
  ForgeRepoSchema,
  ForgeTagSchema,
  ForgeTreeEntrySchema,
  type ForgeArtifact,
  type ForgeBranch,
  type ForgeChangeRequestFile,
  type ForgeChangeRequestSummary,
  type ForgeCommit,
  type ForgeConnection,
  type ForgeIssue,
  type ForgePipelineDetail,
  type ForgePipelineJob,
  type ForgePipelineRun,
  type ForgeRelease,
  type ForgeRepo,
  type ForgeRepoRef,
  type ForgeReviewAction,
  type ForgeMergeMethod,
  type ForgeTag,
  type ForgeTreeEntry,
  type ForgeCliInstallProgress,
  type ForgeCliStatusResponse,
  type ForgeCliInstallResponse,
  type ForgeConnectionLoginProgress,
} from "@jagentdesk/protocol/messages";
import { getForgeDefinitionOrNeutral } from "@jagentdesk/protocol/forge-manifest";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { useHostRouteServerId } from "@/navigation/host-route-context";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { DiffViewer } from "@/components/diff-viewer";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { parseUnifiedDiff } from "@/utils/tool-call-parsers";
import { openExternalUrl } from "@/utils/open-external-url";
import { highlightDiffLines } from "@/utils/diff-highlight";
import type { Theme } from "@/styles/theme";

// HighlightedCodeBlock keeps all box chrome (bg/border/padding) on its own
// wrapper via `textStyle`; nothing is inherited from an outer markdown context
// here, so a single stable empty object satisfies the required prop.
const CODE_BLOCK_INHERITED: TextStyle = {};

// File extension used both to pick a HighlightedCodeBlock language and to detect
// markdown. Returns null for dotfiles / files without an extension.
function fileExtension(filePath: string): string | null {
  const name = filePath.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// Forge Hub (spec 19 / ADR-0015). Milestone A: connections, repositories, and
// PR/MR list + detail + Files-changed (read only). Milestone B (this file also):
// Code (branches/commits/diff), PR review + merge actions, and CI pipelines
// (run → stage → job → log, rerun/cancel). Each Milestone-B section is gated by
// the matching host feature flag (§19.12): forgeHubCode / forgeHubReview /
// forgeHubPipelines. All data flows through the daemon via the committed forge.*
// RPCs on the DaemonClient — this screen only renders UI.
// ---------------------------------------------------------------------------

type SubNav =
  | "connections"
  | "repositories"
  | "code"
  | "commits"
  | "pulls"
  | "pipelines"
  | "releases"
  | "issues";

/** A repo coordinate for every repo-scoped Forge Hub RPC. */
function repoRef(repo: ForgeRepo): ForgeRepoRef {
  return { forge: repo.forge, owner: repo.owner, name: repo.name };
}

/** Short SHA (7 chars) for mono display, matching §19.5.2. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

// ---------------------------------------------------------------------------
// Session cache. In-memory only (cleared on app reload) so revisiting a tab or
// repo shows instantly instead of refetching on every remount. Keys are stable
// strings built from the forge coordinate + list parameters; each load* helper
// seeds state from the cache before fetching and writes back on success. A
// Refresh control on each list busts its key and refetches. Never persisted.
// ---------------------------------------------------------------------------
const forgeCache = new Map<string, unknown>();

function cacheGet<T>(key: string): T | undefined {
  return forgeCache.get(key) as T | undefined;
}

function cacheSet(key: string, val: unknown): void {
  forgeCache.set(key, val);
}

function cacheDelete(key: string): void {
  forgeCache.delete(key);
}

function cacheDeletePrefix(prefix: string): void {
  for (const key of [...forgeCache.keys()]) {
    if (key.startsWith(prefix)) forgeCache.delete(key);
  }
}

/** Stable per-repo key fragment shared by every repo-scoped cache key. */
function repoCacheKey(repo: ForgeRepo): string {
  return `${repo.forge}:${repo.owner}/${repo.name}`;
}

// Every Forge Hub list starts at this many rows and grows by the same step when
// the user taps "Load more". The list RPCs are limit-only (no cursor), so a
// load-more re-fetches the whole list at the larger limit and overwrites the
// cache — simple and good enough for the row counts these lists reach.
const PAGE_SIZE = 30;

// Remembers the Code tab's last directory/file per repo so switching away from
// Code and back restores navigation instead of resetting to the repo root. Keyed
// by repoCacheKey(repo). In-memory only (like forgeCache) — not persisted across
// an app reload.
const codeNavState = new Map<string, { path: string; file: string | null }>();

type ProviderChoice = "github" | "gitlab" | "bitbucket" | "selfhosted";

const CR_STATES = ["open", "draft", "merged", "closed", "all"] as const;
type CrState = (typeof CR_STATES)[number];

const CONNECTION_EMPTY_STATE = "Connect a GitHub, GitLab, or Bitbucket account to get started.";

interface ProviderOption {
  choice: ProviderChoice;
  label: string;
  /** Forge registry id sent to the daemon (self-hosted picks a base forge). */
  forge: string;
  method: "cli" | "token";
  needsHost: boolean;
  needsToken: boolean;
}

const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    choice: "github",
    label: "GitHub",
    forge: "github",
    method: "cli",
    needsHost: false,
    needsToken: false,
  },
  {
    choice: "gitlab",
    label: "GitLab",
    forge: "gitlab",
    method: "cli",
    needsHost: false,
    needsToken: false,
  },
  {
    choice: "bitbucket",
    label: "Bitbucket",
    forge: "bitbucket",
    method: "token",
    needsHost: false,
    needsToken: true,
  },
  {
    choice: "selfhosted",
    label: "Self-hosted / Enterprise",
    forge: "gitlab",
    method: "token",
    needsHost: true,
    needsToken: true,
  },
];

function forgeBadge(forge: string): string {
  switch (forge) {
    case "github":
      return "GH";
    case "gitlab":
      return "GL";
    case "bitbucket":
      return "BB";
    case "gitea":
      return "GT";
    default:
      return forge.slice(0, 2).toUpperCase();
  }
}

function formatRelativeMs(ms: number | null | undefined): string {
  if (ms == null) return "";
  const delta = Date.now() - ms;
  if (delta < 0) return "just now";
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function daysUntil(ms: number | null | undefined): number {
  if (ms == null) return 0;
  return Math.max(0, Math.ceil((ms - Date.now()) / 86400000));
}

function useDotColor() {
  const { theme } = useUnistyles();
  return useCallback(
    (status: "success" | "failure" | "pending" | "none" | undefined): string | null => {
      switch (status) {
        case "success":
          return theme.colors.statusSuccess;
        case "failure":
          return theme.colors.statusDanger;
        case "pending":
          return theme.colors.statusWarning;
        default:
          return null;
      }
    },
    [theme],
  );
}

// Pipeline / job status → color per §19.7.4. `running` uses #3b82f6 (blue-500),
// reserved for "in progress" and never used for pending (§19.6.6).
function usePipelineStatusColor() {
  const { theme } = useUnistyles();
  return useCallback(
    (status: ForgePipelineRun["status"]): string => {
      switch (status) {
        case "success":
          return theme.colors.statusSuccess;
        case "failed":
          return theme.colors.statusDanger;
        case "running":
          return theme.colors.palette.blue[500];
        case "pending":
        case "created":
          return theme.colors.statusWarning;
        case "canceled":
        case "skipped":
          return theme.colors.foregroundExtraMuted;
        case "manual":
          return theme.colors.foregroundMuted;
        default:
          return theme.colors.foregroundMuted;
      }
    },
    [theme],
  );
}

function pipelineStatusLabel(status: ForgePipelineRun["status"]): string {
  switch (status) {
    case "success":
      return "Passed";
    case "failed":
      return "Failed";
    case "running":
      return "Running";
    case "pending":
      return "Pending";
    case "created":
      return "Created";
    case "canceled":
      return "Canceled";
    case "skipped":
      return "Skipped";
    case "manual":
      return "Manual";
    default:
      return "Unknown";
  }
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || seconds <= 0) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 1) return `${s}s`;
  if (m < 60) return `${m}m ${s.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m % 60).toString().padStart(2, "0")}m`;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

// ===== small presentational pieces =========================================

function StatusDot({ color }: { color: string }) {
  const dotStyle = useMemo(() => [styles.dot, { backgroundColor: color }], [color]);
  return <View style={dotStyle} />;
}

function Chip({ label, color }: { label: string; color: string }) {
  const dotStyle = useMemo(() => [styles.chipDot, { backgroundColor: color }], [color]);
  const textStyle = useMemo(() => [styles.chipText, { color }], [color]);
  return (
    <View style={styles.chip}>
      <View style={dotStyle} />
      <Text style={textStyle}>{label}</Text>
    </View>
  );
}

function ProviderBadge({ forge }: { forge: string }) {
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{forgeBadge(forge)}</Text>
    </View>
  );
}

// Placeholder loading rows shown while a list is fetching for the first time
// (no cached data). Each row is a couple of muted bars of varied widths with a
// gentle opacity pulse; the loop is native-driven and stops on unmount. The
// `compact` variant renders a single narrow bar for tight surfaces (e.g. the
// branch picker sheet).
const SKELETON_TITLE_WIDTHS = ["68%", "52%", "74%", "46%", "60%", "57%"] as const;

function SkeletonRows({
  rows = 5,
  variant = "full",
}: {
  rows?: number;
  variant?: "full" | "compact";
}) {
  const pulse = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.4,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const items = useMemo(() => Array.from({ length: Math.max(1, rows) }, (_, i) => i), [rows]);

  return (
    <View style={styles.card} accessibilityLabel="Loading" testID="forge-skeleton">
      {items.map((i) => (
        <View
          key={i}
          style={variant === "compact" ? styles.skeletonRowCompact : styles.skeletonRow}
        >
          <Animated.View
            style={[
              styles.skeletonBarTitle,
              { width: SKELETON_TITLE_WIDTHS[i % SKELETON_TITLE_WIDTHS.length], opacity: pulse },
            ]}
          />
          {variant === "full" ? (
            <Animated.View style={[styles.skeletonBarSub, { opacity: pulse }]} />
          ) : null}
        </View>
      ))}
    </View>
  );
}

// Full-width "Load more" control shown beneath a list whose last fetch returned
// at least `limit` rows (so there may be more). Pressing it grows the limit and
// re-fetches; while that follow-up load runs it shows a small spinner in place
// of the label. Shared by every paginated Forge Hub list.
function LoadMoreButton({
  loading,
  onPress,
  testID,
}: {
  loading: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      style={[styles.btn, styles.btnGhost, styles.loadMoreBtn, loading && styles.btnDisabled]}
      onPress={onPress}
      disabled={loading}
      accessibilityRole="button"
      accessibilityLabel="Load more"
      testID={testID}
    >
      {loading ? (
        <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
      ) : (
        <Text style={styles.btnGhostText}>Load more</Text>
      )}
    </Pressable>
  );
}

// ===== connections view ====================================================

function connectionStatus(
  connection: ForgeConnection,
  theme: Theme,
): { label: string; color: string } {
  const cli = getForgeDefinitionOrNeutral(connection.forge).signIn?.cli ?? "CLI";
  switch (connection.authState) {
    case "authenticated":
      return { label: "Active", color: theme.colors.statusSuccess };
    case "token_expiring":
      return {
        label: `Exp. ${daysUntil(connection.tokenExpiresAt_ms)}d`,
        color: theme.colors.statusWarning,
      };
    case "unauthenticated":
      return { label: "Sign in", color: theme.colors.foregroundMuted };
    case "cli_missing":
      return { label: `Install ${cli}`, color: theme.colors.foregroundMuted };
    case "error":
    default:
      return { label: "Token expired", color: theme.colors.statusDanger };
  }
}

function ConnectionRow({
  connection,
  onRemove,
}: {
  connection: ForgeConnection;
  onRemove: (id: string) => void | Promise<void>;
}) {
  const { theme } = useUnistyles();
  const def = getForgeDefinitionOrNeutral(connection.forge);
  const status = connectionStatus(connection, theme);
  const [removing, setRemoving] = useState(false);
  // Blocks a setState after the row unmounts (removal drops it from the list).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const handleRemove = useCallback(async () => {
    if (removing) return;
    setRemoving(true);
    try {
      await onRemove(connection.id);
    } finally {
      if (mountedRef.current) setRemoving(false);
    }
  }, [connection.id, onRemove, removing]);
  const methodLabel = connection.method === "cli" ? `via ${def.signIn?.cli ?? "CLI"}` : "API token";
  return (
    <View style={styles.row}>
      <ProviderBadge forge={connection.forge} />
      <View style={styles.rowInfo}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {def.displayName}
          {connection.account ? ` · ${connection.account}` : ""}
        </Text>
        <Text style={styles.rowSubMono} numberOfLines={1}>
          {connection.host} · {methodLabel}
        </Text>
      </View>
      <Chip label={status.label} color={status.color} />
      <Pressable
        style={styles.iconBtn}
        onPress={handleRemove}
        disabled={removing}
        accessibilityRole="button"
        accessibilityLabel="Remove connection"
        testID={`forge-connection-remove-${connection.id}`}
      >
        {removing ? (
          <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
        ) : (
          <Trash2 size={15} color={theme.colors.foregroundMuted} />
        )}
      </Pressable>
    </View>
  );
}

function ProviderChip({
  option,
  active,
  onSelect,
}: {
  option: ProviderOption;
  active: boolean;
  onSelect: (choice: ProviderChoice) => void;
}) {
  const { theme } = useUnistyles();
  const handlePress = useCallback(() => onSelect(option.choice), [option.choice, onSelect]);
  return (
    <Pressable
      style={[styles.providerCard, active && styles.providerCardActive]}
      onPress={handlePress}
      testID={`forge-provider-${option.choice}`}
    >
      {option.choice === "selfhosted" ? (
        <View style={styles.providerGlyph}>
          <Server size={24} color={theme.colors.foreground} />
        </View>
      ) : (
        <ProviderBadge forge={option.forge} />
      )}
      <Text style={[styles.providerCardLabel, active && styles.providerCardLabelActive]}>
        {option.label}
      </Text>
    </Pressable>
  );
}

// ===== CLI detect + guided auto-install (§19.3.5, ADR-0016) ================
// Payload shapes come from the committed forge.cli.* responses; the client
// exposes the same objects (see daemon-client.forgeCliStatus/forgeCliInstall).
type ForgeCliStatus = ForgeCliStatusResponse["payload"];
type ForgeCliInstallResult = ForgeCliInstallResponse["payload"];

const CLI_PHASE_LABEL: Record<ForgeCliInstallProgress["phase"], string> = {
  resolving: "Resolving…",
  downloading: "Downloading…",
  installing: "Installing…",
  verifying: "Verifying…",
  done: "Done",
  failed: "Failed",
};

function clampPercent(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

// In-app device-flow sign-in (§19.3.7). Progress arrives as unsolicited events
// over `client.forgeConnectionLogin(..., onProgress)`; the local UI mirrors the
// same login state the CliInstallSection probe already owns.
type LoginProgress = {
  phase: ForgeConnectionLoginProgress["phase"];
  userCode: string | null;
  verificationUri: string | null;
  line: string | null;
};

// Map the daemon's short error codes to readable copy; fall back to the raw
// error/pty line so we never swallow an unexpected failure.
const LOGIN_ERROR_LABEL: Record<string, string> = {
  "cli-missing": "The CLI isn't installed on the daemon host.",
  "no-device-flow": "This provider doesn't support device-flow sign-in.",
  "unsupported-provider": "Sign-in isn't supported for this provider.",
  "no-device-code": "Couldn't start the sign-in flow (no code from the CLI). Try again.",
  cancelled: "Sign-in cancelled.",
  timeout: "Sign-in timed out. Please try again.",
};

function describeLoginError(error: string | null | undefined, line: string | null): string {
  const code = error?.trim();
  if (code && LOGIN_ERROR_LABEL[code]) return LOGIN_ERROR_LABEL[code];
  return code || line?.trim() || "Sign-in failed.";
}

// Best-effort host label for the verification URL. RN's URL polyfill is partial,
// so parse the authority with a small regex rather than `new URL()`.
function verificationHostLabel(uri: string | null | undefined): string {
  if (!uri) return "the provider";
  const authority = uri.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/, 1)[0];
  return authority || uri;
}

/** True only for a real http(s) URL — guards the "Open" button so glab flows that
 * never emitted a verification URL don't render a button that opens nothing. */
function isHttpUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Detect the forge CLI on the daemon host and, when the daemon advertises the
 * capability, offer a one-tap guided install with a live progress bar. Rendered
 * only for cli-method providers; token providers (e.g. Bitbucket) show nothing.
 * The static sign-in command hint above this block is always the manual
 * fallback, so when `cliInstallEnabled` is false this degrades to today's UI.
 */
function CliInstallSection({
  client,
  cliInstallEnabled,
  loginEnabled,
  forge,
  host,
  cliName,
  onLoggedIn,
  onActivity,
  cancelRef,
}: {
  client: DaemonClient | null;
  cliInstallEnabled: boolean;
  loginEnabled: boolean;
  forge: string;
  host: string;
  cliName: string;
  onLoggedIn: () => void | Promise<void>;
  /** Report when a sign-in/install is in progress so the parent can hide its
   *  own form actions (avoids a second, confusing Cancel button). */
  onActivity?: (busy: boolean) => void;
  /** Parent-owned ref: while a sign-in is in progress this points at the
   *  cancel handler so the single bottom Cancel can abort it; null otherwise. */
  cancelRef?: MutableRefObject<(() => void) | null>;
}) {
  const { theme } = useUnistyles();
  const [probeLoading, setProbeLoading] = useState(false);
  const [status, setStatus] = useState<ForgeCliStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<ForgeCliInstallProgress | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installedMsg, setInstalledMsg] = useState<string | null>(null);
  const [trackWidth, setTrackWidth] = useState(0);

  // In-app device-flow sign-in state (§19.3.7).
  const [signingIn, setSigningIn] = useState(false);
  const [loginProgress, setLoginProgress] = useState<LoginProgress | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [copied, setCopied] = useState(false);

  // Tell the parent when a sign-in/install is running so it can hide its own
  // form Cancel — otherwise the card shows two "Cancel" buttons at once.
  useEffect(() => {
    onActivity?.(signingIn || installing);
  }, [signingIn, installing, onActivity]);

  // Guards: `mountedRef` blocks setState after unmount; `probeTokenRef` drops
  // stale probe responses when the forge/host selection changes mid-flight.
  const mountedRef = useRef(true);
  const probeTokenRef = useRef(0);
  const slide = useRef(new Animated.Value(0)).current;
  // Active login controller: identity-checked so a resolve/onProgress from a
  // superseded (aborted) login can't write state for the current selection.
  const loginControllerRef = useRef<AbortController | null>(null);
  const lastLoginLineRef = useRef<string | null>(null);
  // The code we've already auto-opened the browser for, so the auto-open effect
  // fires exactly once per one-time code (not on every re-render).
  const autoOpenedCodeRef = useRef<string | null>(null);

  const displayName = getForgeDefinitionOrNeutral(forge).displayName;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runProbe = useCallback(async () => {
    if (!client) return;
    probeTokenRef.current += 1;
    const token = probeTokenRef.current;
    setProbeLoading(true);
    try {
      const res = await client.forgeCliStatus({ forge, host: host.trim() || undefined });
      if (mountedRef.current && token === probeTokenRef.current) setStatus(res);
    } catch {
      if (mountedRef.current && token === probeTokenRef.current) setStatus(null);
    } finally {
      if (mountedRef.current && token === probeTokenRef.current) setProbeLoading(false);
    }
  }, [client, forge, host]);

  // Probe on mount and whenever the selected forge/host changes. Debounced so a
  // self-hosted host typed character-by-character doesn't spam the daemon; the
  // timer is cleared on selection change / unmount, and runProbe's token drops
  // any response that lands after the selection moved on.
  useEffect(() => {
    const timer = setTimeout(() => {
      void runProbe();
    }, 300);
    return () => clearTimeout(timer);
  }, [runProbe]);

  // Indeterminate bar: a fixed-width indicator sliding across the measured track
  // via translateX. Only runs when we have a track width and no real percent —
  // we never fabricate a percentage.
  const indeterminate = installing && (progress == null || progress.percent == null);
  const indicatorWidth = trackWidth > 0 ? Math.max(48, trackWidth * 0.35) : 48;
  useEffect(() => {
    if (!indeterminate || trackWidth === 0) return;
    slide.setValue(0);
    const loop = Animated.loop(
      Animated.timing(slide, {
        toValue: 1,
        duration: 1100,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [indeterminate, trackWidth, slide]);

  const handleInstall = useCallback(async () => {
    if (!client || installing) return;
    setInstalling(true);
    setInstallError(null);
    setInstalledMsg(null);
    setProgress({ type: "forge.cli.install.progress", requestId: "", phase: "resolving" });
    try {
      const res: ForgeCliInstallResult = await client.forgeCliInstall({
        forge,
        host: host.trim() || undefined,
        onProgress: (p) => {
          if (mountedRef.current) setProgress(p);
        },
      });
      if (!mountedRef.current) return;
      if (res.ok) {
        setInstalledMsg(`Installed ${res.binary}${res.version ? ` ${res.version}` : ""}`);
        setProgress(null);
        await runProbe();
      } else {
        setInstallError(res.error ?? `Failed to install ${res.binary}.`);
        setProgress(null);
      }
    } catch (e: unknown) {
      if (mountedRef.current) {
        setInstallError(e instanceof Error ? e.message : "Install failed.");
        setProgress(null);
      }
    } finally {
      if (mountedRef.current) setInstalling(false);
    }
  }, [client, installing, forge, host, runProbe]);

  const translateX = slide.interpolate({
    inputRange: [0, 1],
    outputRange: [-indicatorWidth, trackWidth],
  });

  const handleSignIn = useCallback(async () => {
    if (!client || signingIn) return;
    const controller = new AbortController();
    loginControllerRef.current = controller;
    lastLoginLineRef.current = null;
    autoOpenedCodeRef.current = null;
    setSigningIn(true);
    setLoginError(null);
    setLoggedIn(false);
    setCopied(false);
    setLoginProgress({ phase: "starting", userCode: null, verificationUri: null, line: null });
    try {
      const res = await client.forgeConnectionLogin({
        forge,
        host: host.trim() || undefined,
        signal: controller.signal,
        onProgress: (p: ForgeConnectionLoginProgress) => {
          if (!mountedRef.current || loginControllerRef.current !== controller) return;
          if (p.line) lastLoginLineRef.current = p.line;
          setLoginProgress({
            phase: p.phase,
            userCode: p.userCode ?? null,
            verificationUri: p.verificationUri ?? null,
            line: p.line ?? null,
          });
        },
      });
      if (!mountedRef.current || loginControllerRef.current !== controller) return;
      if (res.ok) {
        setLoginProgress(null);
        setLoggedIn(true);
        await onLoggedIn();
        await runProbe();
      } else {
        setLoginProgress(null);
        setLoginError(describeLoginError(res.error, lastLoginLineRef.current));
      }
    } catch (e: unknown) {
      if (!mountedRef.current || loginControllerRef.current !== controller) return;
      setLoginProgress(null);
      setLoginError(
        describeLoginError(e instanceof Error ? e.message : null, lastLoginLineRef.current),
      );
    } finally {
      if (loginControllerRef.current === controller) {
        loginControllerRef.current = null;
        if (mountedRef.current) setSigningIn(false);
      }
    }
  }, [client, signingIn, forge, host, onLoggedIn, runProbe]);

  const handleCancelLogin = useCallback(() => {
    loginControllerRef.current?.abort();
  }, []);

  // Expose the active cancel action to the parent's single bottom Cancel while a
  // sign-in is running (install has no trivial abort, so we leave it null and the
  // bottom Cancel just closes the form in that case).
  useEffect(() => {
    if (!cancelRef) return;
    cancelRef.current = signingIn ? handleCancelLogin : null;
    return () => {
      cancelRef.current = null;
    };
  }, [signingIn, handleCancelLogin, cancelRef]);

  const handleCopyCode = useCallback(() => {
    const code = loginProgress?.userCode;
    if (!code) return;
    void Clipboard.setStringAsync(code);
    setCopied(true);
  }, [loginProgress?.userCode]);

  const handleOpenVerification = useCallback(() => {
    const uri = loginProgress?.verificationUri;
    if (uri) void openExternalUrl(uri);
  }, [loginProgress?.verificationUri]);

  // As soon as the CLI hands us a one-time code, copy it and open the system
  // browser (where the user is already signed in) so they just paste + approve —
  // no hunting for a button. Fires once per code; the "Open again" button is the
  // manual fallback. Only opens when the verification URL is a real http(s) URL.
  useEffect(() => {
    const code = loginProgress?.userCode;
    const uri = loginProgress?.verificationUri;
    if (!code || autoOpenedCodeRef.current === code) return;
    autoOpenedCodeRef.current = code;
    void Clipboard.setStringAsync(code);
    if (mountedRef.current) setCopied(true);
    if (uri && isHttpUrl(uri)) void openExternalUrl(uri);
  }, [loginProgress?.userCode, loginProgress?.verificationUri]);

  // Abort a dangling login (and reset its UI) when the selected provider/host
  // changes mid-flight, and on unmount — so the daemon-side pty is always
  // cancelled. Resetting here also clears any stale code/error for the previous
  // selection; the identity guard above drops the superseded resolve.
  useEffect(() => {
    return () => {
      loginControllerRef.current?.abort();
      loginControllerRef.current = null;
      autoOpenedCodeRef.current = null;
      if (!mountedRef.current) return;
      setSigningIn(false);
      setLoginProgress(null);
      setLoginError(null);
      setLoggedIn(false);
      setCopied(false);
    };
  }, [forge, host]);

  const showAutoInstall = cliInstallEnabled && status?.canAutoInstall === true;
  const showSignIn = loginEnabled && status?.installed === true;
  const loginPhase = loginProgress?.phase;
  const loginStatusLabel =
    loginPhase === "verifying"
      ? "Completing sign-in…"
      : loginPhase === "awaiting_authorization"
        ? "Waiting for authorization…"
        : `Starting ${cliName}…`;
  const verificationHost = verificationHostLabel(loginProgress?.verificationUri);

  return (
    <View style={styles.cliSection}>
      {showSignIn ? (
        <View style={styles.loginBox}>
          {signingIn && loginPhase === "awaiting_authorization" && loginProgress?.userCode ? (
            <View style={styles.loginCodeWrap}>
              <Text style={styles.loginCardTitle}>Approve in your browser</Text>
              <Text style={styles.loginCodeInstruction}>
                We opened {verificationHost} in your browser and copied the code below. Paste it
                there and approve — then come back here.
              </Text>
              <View style={styles.loginCodeBox}>
                <Text style={styles.loginCode} selectable testID="forge-login-code">
                  {loginProgress.userCode}
                </Text>
                <Pressable
                  style={styles.loginCopyBtn}
                  onPress={handleCopyCode}
                  testID="forge-login-copy"
                >
                  <Copy size={13} color={theme.colors.foregroundMuted} />
                  <Text style={styles.loginCopyText}>{copied ? "Copied" : "Copy"}</Text>
                </Pressable>
              </View>
              <View style={styles.loginWaitRow}>
                <ActivityIndicator size="small" color={theme.colors.accent} />
                <Text style={styles.loginStatusText}>Waiting for you to approve…</Text>
              </View>
              <View style={styles.loginActionRow}>
                {isHttpUrl(loginProgress.verificationUri) ? (
                  <Pressable
                    style={[styles.btn, styles.btnPrimary, styles.loginActionBtn]}
                    onPress={handleOpenVerification}
                    testID="forge-login-open"
                  >
                    <ExternalLink size={14} color={theme.colors.accentForeground} />
                    <Text style={styles.btnPrimaryText}>Open {verificationHost} again</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ) : signingIn ? (
            <View style={styles.loginStatusRow}>
              <ActivityIndicator size="small" color={theme.colors.accent} />
              <Text style={styles.loginStatusText}>{loginStatusLabel}</Text>
            </View>
          ) : (
            <Pressable
              style={[styles.btn, styles.btnPrimary]}
              onPress={handleSignIn}
              testID="forge-login-signin"
            >
              <LogIn size={14} color={theme.colors.accentForeground} />
              <Text style={styles.btnPrimaryText}>Sign in with {displayName}</Text>
            </Pressable>
          )}

          {loggedIn ? <Text style={styles.loginSuccess}>Signed in</Text> : null}
          {loginError ? <Text style={styles.loginError}>{loginError}</Text> : null}
        </View>
      ) : null}

      {status == null && probeLoading ? (
        <Text style={styles.cliChecking}>Checking for {cliName} on the daemon host…</Text>
      ) : null}

      {status && status.installed === false ? (
        <View style={styles.cliMissingBox}>
          <Text style={styles.cliMissingText}>
            {status.binary} isn't installed on the daemon host.
          </Text>

          {showAutoInstall ? (
            <Pressable
              style={[styles.btn, styles.btnPrimary, installing && styles.btnDisabled]}
              onPress={handleInstall}
              disabled={installing}
              testID="forge-cli-install"
            >
              <Download size={14} color={theme.colors.accentForeground} />
              <Text style={styles.btnPrimaryText}>Install {status.binary} automatically</Text>
            </Pressable>
          ) : null}

          {installing || progress ? (
            <View style={styles.cliProgressWrap}>
              <View
                style={styles.cliProgressTrack}
                onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
              >
                {progress && progress.percent != null ? (
                  <View
                    style={[
                      styles.cliProgressFill,
                      { width: `${clampPercent(progress.percent)}%` },
                    ]}
                  />
                ) : (
                  <Animated.View
                    style={[
                      styles.cliProgressFill,
                      styles.cliProgressIndicator,
                      { width: indicatorWidth, transform: [{ translateX }] },
                    ]}
                  />
                )}
              </View>
              {progress ? (
                <Text style={styles.cliProgressPhase}>{CLI_PHASE_LABEL[progress.phase]}</Text>
              ) : null}
              {progress?.line ? (
                <Text style={styles.cliProgressLog} numberOfLines={1}>
                  {progress.line}
                </Text>
              ) : null}
            </View>
          ) : null}

          {installError ? <Text style={styles.cliInstallError}>{installError}</Text> : null}

          <Text style={styles.cliManualHint}>
            Or install manually with the command above, then sign in.
          </Text>
        </View>
      ) : null}

      {installedMsg ? <Text style={styles.cliDetected}>{installedMsg}</Text> : null}
    </View>
  );
}

function ConnectionsView({
  connections,
  onRemove,
  onAdd,
  adding,
  onToggleAdd,
  client,
  cliInstallEnabled,
  loginEnabled,
  onLoggedIn,
}: {
  connections: ForgeConnection[];
  onRemove: (id: string) => void | Promise<void>;
  onAdd: (input: { forge: string; host?: string; method: "cli" | "token"; token?: string }) => void;
  adding: boolean;
  onToggleAdd: () => void;
  client: DaemonClient | null;
  cliInstallEnabled: boolean;
  loginEnabled: boolean;
  onLoggedIn: () => void | Promise<void>;
}) {
  const { theme } = useUnistyles();
  const [choice, setChoice] = useState<ProviderChoice>("github");
  const [host, setHost] = useState("");
  const [token, setToken] = useState("");
  const [selfHostedForge, setSelfHostedForge] = useState("gitlab");
  // True while the CliInstallSection is signing in / installing. The single
  // bottom-right Cancel uses this to decide whether to abort the in-progress
  // action (via cancelActiveRef) or just close the form.
  const [formBusy, setFormBusy] = useState(false);
  // Points at the CliInstallSection's cancel handler while a sign-in is running.
  const cancelActiveRef = useRef<(() => void) | null>(null);

  const handleCancel = useCallback(() => {
    if (formBusy && cancelActiveRef.current) {
      cancelActiveRef.current();
    } else {
      onToggleAdd();
    }
  }, [formBusy, onToggleAdd]);

  const option = useMemo(
    () => PROVIDER_OPTIONS.find((o) => o.choice === choice) ?? PROVIDER_OPTIONS[0],
    [choice],
  );
  const def = getForgeDefinitionOrNeutral(choice === "selfhosted" ? selfHostedForge : option.forge);

  const handleSubmit = useCallback(() => {
    const forge = choice === "selfhosted" ? selfHostedForge : option.forge;
    onAdd({
      forge,
      host: option.needsHost ? host.trim() || undefined : undefined,
      method: option.method,
      token: option.needsToken ? token.trim() || undefined : undefined,
    });
    setHost("");
    setToken("");
  }, [choice, selfHostedForge, option, host, token, onAdd]);

  // In-app sign-in succeeded: refresh the account list, then collapse the add
  // form so the freshly-connected account is what the user sees (not a stale
  // form). onToggleAdd closes it because the form is open here.
  const handleLoggedIn = useCallback(async () => {
    await onLoggedIn();
    onToggleAdd();
  }, [onLoggedIn, onToggleAdd]);

  // The manual "Add connection" submit is only meaningful for token providers,
  // or a cli provider on a host that can't drive in-app sign-in. Otherwise the
  // CliInstallSection sign-in button is the single action.
  const showManualAdd = option.method === "token" || !loginEnabled;

  const setForgeGithub = useCallback(() => setSelfHostedForge("github"), []);
  const setForgeGitlab = useCallback(() => setSelfHostedForge("gitlab"), []);
  const setForgeGitea = useCallback(() => setSelfHostedForge("gitea"), []);

  return (
    <View style={styles.pane}>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>Connected accounts</Text>
        <View style={styles.grow} />
        <Pressable
          style={[styles.btn, styles.btnPrimary]}
          onPress={onToggleAdd}
          testID="forge-add-connection"
        >
          <Plus size={14} color={theme.colors.accentForeground} />
          <Text style={styles.btnPrimaryText}>Add connection</Text>
        </Pressable>
      </View>

      {connections.length === 0 && !adding ? (
        <Text style={styles.emptyText}>{CONNECTION_EMPTY_STATE}</Text>
      ) : (
        <View style={styles.card}>
          {connections.map((connection) => (
            <ConnectionRow key={connection.id} connection={connection} onRemove={onRemove} />
          ))}
        </View>
      )}

      {adding ? (
        <View style={styles.formCard}>
          <View style={styles.formHeader}>
            <View style={styles.formTitleRow}>
              <Plug size={16} color={theme.colors.foreground} />
              <Text style={styles.formTitle}>Add a connection</Text>
            </View>
            <Text style={styles.formSubtitle}>
              Connect a GitHub, GitLab, or Bitbucket account to browse and manage it here.
            </Text>
          </View>

          <Text style={styles.fieldLabel}>Provider</Text>
          <View style={styles.providerGrid}>
            {PROVIDER_OPTIONS.map((o) => (
              <ProviderChip
                key={o.choice}
                option={o}
                active={choice === o.choice}
                onSelect={setChoice}
              />
            ))}
          </View>

          {choice === "selfhosted" ? (
            <>
              <Text style={styles.fieldLabel}>Forge type</Text>
              <View style={styles.chipRow}>
                <Pressable
                  style={[
                    styles.providerChip,
                    selfHostedForge === "github" && styles.providerChipActive,
                  ]}
                  onPress={setForgeGithub}
                >
                  <Text
                    style={[
                      styles.providerChipText,
                      selfHostedForge === "github" && styles.providerChipTextActive,
                    ]}
                  >
                    GitHub Enterprise
                  </Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.providerChip,
                    selfHostedForge === "gitlab" && styles.providerChipActive,
                  ]}
                  onPress={setForgeGitlab}
                >
                  <Text
                    style={[
                      styles.providerChipText,
                      selfHostedForge === "gitlab" && styles.providerChipTextActive,
                    ]}
                  >
                    GitLab self-managed
                  </Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.providerChip,
                    selfHostedForge === "gitea" && styles.providerChipActive,
                  ]}
                  onPress={setForgeGitea}
                >
                  <Text
                    style={[
                      styles.providerChipText,
                      selfHostedForge === "gitea" && styles.providerChipTextActive,
                    ]}
                  >
                    Gitea
                  </Text>
                </Pressable>
              </View>
            </>
          ) : null}

          {option.needsHost ? (
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Host</Text>
              <TextInput
                style={styles.input}
                value={host}
                onChangeText={setHost}
                placeholder="git.example.com"
                placeholderTextColor={theme.colors.foregroundExtraMuted}
                autoCapitalize="none"
                autoCorrect={false}
                testID="forge-host-input"
              />
            </View>
          ) : null}

          <View style={styles.formDivider} />

          {option.method === "cli" ? (
            <>
              <Text style={styles.fieldLabel}>Sign in</Text>
              {/* When the daemon can drive sign-in in-app, the CliInstallSection
                  button is the whole flow — the static "run this on the host"
                  hint is only shown as a fallback for hosts that can't. */}
              {!loginEnabled ? (
                <View style={styles.hintBox}>
                  <Text style={styles.hintTitle}>Sign in on the daemon host</Text>
                  <Text style={styles.hintBody}>
                    Run the command below on the machine running the daemon, then click Add
                    connection.
                  </Text>
                  <Text style={styles.hintMono}>{def.signIn?.command ?? "auth login"}</Text>
                </View>
              ) : null}
              <CliInstallSection
                client={client}
                cliInstallEnabled={cliInstallEnabled}
                loginEnabled={loginEnabled}
                forge={choice === "selfhosted" ? selfHostedForge : option.forge}
                host={option.needsHost ? host : ""}
                cliName={def.signIn?.cli ?? "the CLI"}
                onLoggedIn={handleLoggedIn}
                onActivity={setFormBusy}
                cancelRef={cancelActiveRef}
              />
            </>
          ) : (
            <View style={styles.field}>
              <View style={styles.fieldLabelRow}>
                <KeyRound size={13} color={theme.colors.foregroundMuted} />
                <Text style={styles.fieldLabel}>Personal access token / API token</Text>
              </View>
              <TextInput
                style={styles.input}
                value={token}
                onChangeText={setToken}
                placeholder="Paste token"
                placeholderTextColor={theme.colors.foregroundExtraMuted}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                testID="forge-token-input"
              />
              <Text style={styles.hintBody}>
                Stored encrypted (AES-256-GCM) in the daemon secret store. The token never leaves
                the daemon.
              </Text>
            </View>
          )}

          {/* Exactly one Cancel, pinned bottom-right. While a sign-in is running
              it aborts that (via cancelActiveRef); otherwise it closes the form. */}
          <View style={styles.formActions}>
            {/* The bottom "Add connection" submit is only for the manual paths:
                token providers, or a cli host without in-app sign-in. When the
                in-app sign-in button is present it does the whole thing, so we
                show only Cancel here to avoid a confusing second action. */}
            {showManualAdd ? (
              <Pressable
                style={[styles.btn, styles.btnPrimary]}
                onPress={handleSubmit}
                testID="forge-connection-submit"
              >
                <Text style={styles.btnPrimaryText}>Add connection</Text>
              </Pressable>
            ) : null}
            <Pressable style={[styles.btn, styles.btnGhost]} onPress={handleCancel}>
              <Text style={styles.btnGhostText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

// ===== repositories view ===================================================

function RepoRow({ repo, onOpen }: { repo: ForgeRepo; onOpen: (repo: ForgeRepo) => void }) {
  const dotColor = useDotColor();
  const def = getForgeDefinitionOrNeutral(repo.forge);
  const handlePress = useCallback(() => onOpen(repo), [repo, onOpen]);
  const ciColor = dotColor(repo.checksStatus);
  return (
    <Pressable
      style={styles.row}
      onPress={handlePress}
      testID={`forge-repo-${repo.forge}-${repo.owner}-${repo.name}`}
    >
      <ProviderBadge forge={repo.forge} />
      <View style={styles.rowInfo}>
        <Text style={styles.rowTitleMono} numberOfLines={1}>
          {repo.owner}/{repo.name}
        </Text>
        {repo.description ? (
          <Text style={styles.rowSub} numberOfLines={1}>
            {repo.description}
          </Text>
        ) : null}
      </View>
      <Text style={styles.metaMono}>{repo.defaultBranch ?? "—"}</Text>
      {repo.visibility && repo.visibility !== "unknown" ? (
        <View style={styles.plainChip}>
          <Text style={styles.plainChipText}>{repo.visibility}</Text>
        </View>
      ) : null}
      <View style={styles.repoTrailing}>
        <Text style={styles.metaMuted}>
          {repo.openChangeRequests ?? 0} {def.changeRequestAbbrev}
        </Text>
        {ciColor ? <StatusDot color={ciColor} /> : null}
      </View>
      <Text style={styles.metaWhen}>{formatRelativeMs(repo.updatedAt_ms)}</Text>
    </Pressable>
  );
}

function RepositoriesView({
  repos,
  loading,
  error,
  limit,
  loadingMore,
  onLoadMore,
  onOpen,
  onRetry,
}: {
  repos: ForgeRepo[];
  loading: boolean;
  error: string | null;
  limit: number;
  loadingMore: boolean;
  onLoadMore: () => void;
  onOpen: (repo: ForgeRepo) => void;
  onRetry: () => void;
}) {
  const { theme } = useUnistyles();
  const [query, setQuery] = useState("");
  // Single-select provider filter: "all" or one forge id. Pure client-side view
  // over the already-fetched repos — never triggers a fetch (pagination is about
  // the fetch, this filter is a view over it).
  const [repoFilter, setRepoFilter] = useState<string>("all");

  const forgesPresent = useMemo(() => {
    const set = new Set<string>();
    for (const repo of repos) set.add(repo.forge);
    return [...set];
  }, [repos]);

  // If the active provider filter is no longer present (e.g. a connection was
  // removed), fall back to "all" so the list doesn't silently show nothing.
  useEffect(() => {
    if (repoFilter !== "all" && !forgesPresent.includes(repoFilter)) setRepoFilter("all");
  }, [repoFilter, forgesPresent]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return repos.filter((repo) => {
      if (repoFilter !== "all" && repo.forge !== repoFilter) return false;
      if (!q) return true;
      return `${repo.owner}/${repo.name}`.toLowerCase().includes(q);
    });
  }, [repos, query, repoFilter]);

  // "Load more" is about the fetch, so gate it on the UNFILTERED fetched length:
  // the last page returned at least `limit` rows ⇒ there may be more to fetch.
  const canLoadMore = !loading && repos.length >= limit;

  const emptyLabel =
    repoFilter !== "all" && !query.trim()
      ? `No ${getForgeDefinitionOrNeutral(repoFilter).displayName} repositories.`
      : "No repositories match the current filters.";

  return (
    <View style={styles.pane}>
      <View style={styles.toolbarRow}>
        <View style={styles.searchField}>
          <Search size={14} color={theme.colors.foregroundMuted} />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Search repositories…"
            placeholderTextColor={theme.colors.foregroundExtraMuted}
            autoCapitalize="none"
            autoCorrect={false}
            testID="forge-repo-search"
          />
        </View>
      </View>

      {forgesPresent.length > 1 ? (
        <View style={styles.chipRow}>
          <ForgeFilterChip
            id="all"
            label="All"
            active={repoFilter === "all"}
            onSelect={setRepoFilter}
          />
          {forgesPresent.map((forge) => (
            <ForgeFilterChip
              key={forge}
              id={forge}
              label={getForgeDefinitionOrNeutral(forge).displayName}
              active={repoFilter === forge}
              onSelect={setRepoFilter}
            />
          ))}
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorBanner}>
          <CircleAlert size={16} color={theme.colors.statusDanger} />
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={[styles.btn, styles.btnGhost]} onPress={onRetry}>
            <Text style={styles.btnGhostText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      {loading ? (
        <SkeletonRows rows={6} />
      ) : filtered.length === 0 ? (
        <Text style={styles.emptyText}>{emptyLabel}</Text>
      ) : (
        <View style={styles.card}>
          {filtered.map((repo) => (
            <RepoRow key={`${repo.forge}:${repo.owner}/${repo.name}`} repo={repo} onOpen={onOpen} />
          ))}
        </View>
      )}

      {canLoadMore ? (
        <LoadMoreButton loading={loadingMore} onPress={onLoadMore} testID="forge-repos-load-more" />
      ) : null}
    </View>
  );
}

function ForgeFilterChip({
  id,
  label,
  active,
  onSelect,
}: {
  id: string;
  label: string;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const handlePress = useCallback(() => onSelect(id), [id, onSelect]);
  return (
    <Pressable
      style={[styles.providerChip, active && styles.providerChipActive]}
      onPress={handlePress}
      testID={`forge-filter-${id}`}
    >
      <Text style={[styles.providerChipText, active && styles.providerChipTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

// ===== pull requests list ==================================================

function crStateColor(state: ForgeChangeRequestSummary["state"], theme: Theme): string {
  switch (state) {
    case "open":
      return theme.colors.statusSuccess;
    case "merged":
      return theme.colors.statusMerged;
    case "closed":
      return theme.colors.statusDanger;
    case "draft":
    default:
      return theme.colors.foregroundMuted;
  }
}

function crStateLabel(state: ForgeChangeRequestSummary["state"]): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function reviewDotColor(
  decision: ForgeChangeRequestSummary["reviewDecision"],
  theme: Theme,
): string | null {
  switch (decision) {
    case "approved":
      return theme.colors.statusSuccess;
    case "changes_requested":
      return theme.colors.statusDanger;
    case "pending":
      return theme.colors.statusWarning;
    default:
      return null;
  }
}

function PullRequestRow({
  cr,
  forge,
  onOpen,
}: {
  cr: ForgeChangeRequestSummary;
  forge: string;
  onOpen: (cr: ForgeChangeRequestSummary) => void;
}) {
  const { theme } = useUnistyles();
  const dotColor = useDotColor();
  const def = getForgeDefinitionOrNeutral(forge);
  const handlePress = useCallback(() => onOpen(cr), [cr, onOpen]);
  const ciColor = dotColor(cr.checksStatus);
  const reviewColor = reviewDotColor(cr.reviewDecision, theme);
  return (
    <Pressable style={styles.row} onPress={handlePress} testID={`forge-cr-${cr.number}`}>
      <View style={styles.rowInfo}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {cr.title}
        </Text>
        <View style={styles.crMetaRow}>
          <Text style={styles.metaMono}>
            {def.changeRequestNumberPrefix}
            {cr.number}
          </Text>
          {cr.authorLogin ? <Text style={styles.metaMuted}>@{cr.authorLogin}</Text> : null}
          {cr.labels?.slice(0, 3).map((label) => (
            <View key={label} style={styles.plainChip}>
              <Text style={styles.plainChipText}>{label}</Text>
            </View>
          ))}
        </View>
      </View>
      {reviewColor ? <StatusDot color={reviewColor} /> : null}
      {ciColor ? <StatusDot color={ciColor} /> : null}
      <Chip label={crStateLabel(cr.state)} color={crStateColor(cr.state, theme)} />
      <Text style={styles.metaWhen}>{formatRelativeMs(cr.updatedAt_ms)}</Text>
    </Pressable>
  );
}

function StateFilter({ state, onChange }: { state: CrState; onChange: (state: CrState) => void }) {
  return (
    <View style={styles.segmented}>
      {CR_STATES.map((s) => (
        <StateFilterButton key={s} value={s} active={state === s} onChange={onChange} />
      ))}
    </View>
  );
}

function StateFilterButton({
  value,
  active,
  onChange,
}: {
  value: CrState;
  active: boolean;
  onChange: (state: CrState) => void;
}) {
  const handlePress = useCallback(() => onChange(value), [value, onChange]);
  return (
    <Pressable
      style={[styles.segmentBtn, active && styles.segmentBtnActive]}
      onPress={handlePress}
      testID={`forge-cr-state-${value}`}
    >
      <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
        {value === "all" ? "All" : crStateLabel(value)}
      </Text>
    </Pressable>
  );
}

// New change-request form (§19.6). Base + head branch pickers (branches load
// lazily when the form opens, seeded from the same per-repo cache the Code/Commits
// tabs use), a required Title, an optional Description, and a Draft toggle. On a
// successful create the parent busts the CR list cache, reloads, closes the form,
// and opens the created URL when the daemon returned one.
function NewChangeRequestForm({
  client,
  repo,
  onCreated,
  onCancel,
}: {
  client: DaemonClient;
  repo: ForgeRepo;
  onCreated: (url: string | null) => void;
  onCancel: () => void;
}) {
  const { theme } = useUnistyles();
  const def = getForgeDefinitionOrNeutral(repo.forge);
  const [branches, setBranches] = useState<ForgeBranch[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [base, setBase] = useState<string | null>(repo.defaultBranch ?? null);
  const [head, setHead] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const key = `code:branches:${repoCacheKey(repo)}`;
    const cached = cacheGet<ForgeBranch[]>(key);
    if (cached) {
      setBranches(cached);
      return;
    }
    setBranchesLoading(true);
    void (async () => {
      try {
        const res = await client.forgeListBranches({ repo: repoRef(repo) });
        const parsed = ForgeBranchSchema.array().safeParse(res.branches);
        const list = parsed.success ? parsed.data : [];
        if (!cancelled) {
          setBranches(list);
          if (parsed.success) cacheSet(key, list);
        }
      } catch {
        // The pickers fall back to an empty state; the user can retry by reopening.
      } finally {
        if (!cancelled) setBranchesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, repo]);

  const toggleDraft = useCallback(() => setDraft((v) => !v), []);
  const canSubmit = title.trim().length > 0 && !!base && !!head && !busy;

  const submit = useCallback(async () => {
    if (!base || !head || title.trim().length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await client.forgeCreateChangeRequest({
        repo: repoRef(repo),
        base,
        head,
        title: title.trim(),
        body: body.trim() || undefined,
        draft,
      });
      if (res.number != null) {
        onCreated(res.url ?? null);
      } else {
        setError(res.error ?? `Unable to create ${def.changeRequestAbbrev}.`);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : `Unable to create ${def.changeRequestAbbrev}.`);
    } finally {
      setBusy(false);
    }
  }, [base, head, title, body, draft, busy, client, repo, def.changeRequestAbbrev, onCreated]);

  return (
    <View style={styles.formCard}>
      <View style={styles.formHeader}>
        <View style={styles.formTitleRow}>
          <GitPullRequest size={16} color={theme.colors.foreground} />
          <Text style={styles.formTitle}>New {def.changeRequestNoun}</Text>
        </View>
        <Text style={styles.formSubtitle}>
          Open a new {def.changeRequestAbbrev} from a head branch into a base branch.
        </Text>
      </View>

      <View style={styles.crBranchRow}>
        <View style={styles.crBranchField}>
          <Text style={styles.fieldLabel}>Base</Text>
          <BranchPickerButton
            branches={branches}
            value={base}
            loading={branchesLoading}
            onChange={setBase}
            testID="forge-new-cr-base"
          />
        </View>
        <View style={styles.crBranchField}>
          <Text style={styles.fieldLabel}>Head</Text>
          <BranchPickerButton
            branches={branches}
            value={head}
            loading={branchesLoading}
            onChange={setHead}
            testID="forge-new-cr-head"
          />
        </View>
      </View>

      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Title</Text>
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          placeholder={`${def.changeRequestNoun} title`}
          placeholderTextColor={theme.colors.foregroundExtraMuted}
          editable={!busy}
          testID="forge-new-cr-title"
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Description</Text>
        <TextInput
          style={styles.textArea}
          value={body}
          onChangeText={setBody}
          placeholder="Describe the change (optional)"
          placeholderTextColor={theme.colors.foregroundExtraMuted}
          multiline
          editable={!busy}
          testID="forge-new-cr-body"
        />
      </View>

      <Pressable
        style={styles.autoMergeRow}
        onPress={toggleDraft}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: draft, disabled: busy }}
        disabled={busy}
        testID="forge-new-cr-draft"
      >
        <View style={[styles.checkbox, draft && styles.checkboxChecked]}>
          {draft ? <Check size={11} color={theme.colors.accentForeground} /> : null}
        </View>
        <Text style={styles.autoMergeLabel}>Create as draft</Text>
      </Pressable>

      {error ? <Text style={styles.reviewError}>{error}</Text> : null}

      <View style={styles.formActions}>
        <Pressable
          style={[styles.btn, styles.btnPrimary, !canSubmit && styles.btnDisabled]}
          onPress={submit}
          disabled={!canSubmit}
          testID="forge-new-cr-submit"
        >
          {busy ? (
            <ActivityIndicator size="small" color={theme.colors.accentForeground} />
          ) : (
            <Plus size={14} color={theme.colors.accentForeground} />
          )}
          <Text style={styles.btnPrimaryText}>
            {busy ? "Creating…" : `Create ${def.changeRequestAbbrev}`}
          </Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.btnGhost]} onPress={onCancel} disabled={busy}>
          <Text style={styles.btnGhostText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ===== pull request detail =================================================

type DetailTab = "conversation" | "commits" | "files" | "checks";

// A changed file: a clickable header (path + +/-) that expands its diff. Collapsed
// by default so a many-file commit/PR reads as a tidy file list instead of one
// endless scroll — tap a file to view its diff.
function FileDiffCard({
  file,
  defaultOpen = false,
}: {
  file: ForgeChangeRequestFile;
  defaultOpen?: boolean;
}) {
  const { theme } = useUnistyles();
  const [open, setOpen] = useState(defaultOpen);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const diffLines = useMemo(() => {
    if (!open || !file.patch) return null;
    return highlightDiffLines(parseUnifiedDiff(file.patch), file.path);
  }, [open, file.patch, file.path]);

  return (
    <View style={styles.fileCard}>
      <Pressable style={styles.fileHeader} onPress={toggle} testID={`forge-file-${file.path}`}>
        {open ? (
          <ChevronDown size={14} color={theme.colors.foregroundMuted} />
        ) : (
          <ChevronRight size={14} color={theme.colors.foregroundMuted} />
        )}
        <Text style={styles.fileName} numberOfLines={1}>
          {file.previousPath && file.status === "renamed"
            ? `${file.previousPath} → ${file.path}`
            : file.path}
        </Text>
        <View style={styles.grow} />
        <Text style={styles.diffAdd}>+{file.additions}</Text>
        <Text style={styles.diffDel}>−{file.deletions}</Text>
      </Pressable>
      {open ? (
        diffLines ? (
          <DiffViewer diffLines={diffLines} maxHeight={420} />
        ) : (
          <Text style={styles.fileEmpty}>No diff available for this file.</Text>
        )
      ) : null}
    </View>
  );
}

// Shared commit row (§19.5.2): subject, SHA (mono 7), author, CI dot, time.
function CommitRow({
  commit,
  onOpen,
}: {
  commit: ForgeCommit;
  onOpen?: (commit: ForgeCommit) => void;
}) {
  const dotColor = useDotColor();
  const ciColor = dotColor(commit.checksStatus);
  const handlePress = useCallback(() => onOpen?.(commit), [commit, onOpen]);
  const author = commit.authorLogin ? `@${commit.authorLogin}` : (commit.authorName ?? "");
  return (
    <Pressable
      style={styles.row}
      onPress={handlePress}
      disabled={!onOpen}
      testID={`forge-commit-${commit.sha}`}
    >
      <View style={styles.rowInfo}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {commit.subject}
        </Text>
        <View style={styles.crMetaRow}>
          <Text style={styles.metaMono}>{shortSha(commit.sha)}</Text>
          {author ? <Text style={styles.metaMuted}>{author}</Text> : null}
        </View>
      </View>
      {ciColor ? <StatusDot color={ciColor} /> : null}
      <Text style={styles.metaWhen}>{formatRelativeMs(commit.committedAt_ms)}</Text>
    </Pressable>
  );
}

// Diff for a single compare/commit result: a list of file cards (§19.5.3).
function DiffFileList({
  files,
  loading,
  error,
  onRetry,
}: {
  files: ForgeChangeRequestFile[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const { theme } = useUnistyles();
  if (error) {
    return (
      <View style={styles.errorBanner}>
        <CircleAlert size={16} color={theme.colors.statusDanger} />
        <Text style={styles.errorText}>{error}</Text>
        <Pressable style={[styles.btn, styles.btnGhost]} onPress={onRetry}>
          <Text style={styles.btnGhostText}>Retry</Text>
        </Pressable>
      </View>
    );
  }
  if (loading || files === null) {
    return <Text style={styles.emptyText}>Loading diff…</Text>;
  }
  if (files.length === 0) {
    return <Text style={styles.emptyText}>No files changed.</Text>;
  }
  return (
    <View style={styles.filesPane}>
      {files.length > 1 ? (
        <Text style={styles.sectionTitle}>
          {files.length} files changed — tap a file to view its diff
        </Text>
      ) : null}
      {files.map((file, index) => (
        <FileDiffCard key={file.path} file={file} defaultOpen={files.length === 1 || index === 0} />
      ))}
    </View>
  );
}

const REVIEW_LABELS: Record<ForgeReviewAction, { idle: string; running: string; done: string }> = {
  approve: { idle: "Approve", running: "Approving…", done: "Approved" },
  request_changes: {
    idle: "Request changes",
    running: "Requesting…",
    done: "Changes requested",
  },
  comment: { idle: "Comment", running: "Commenting…", done: "Commented" },
};

const MERGE_METHODS: ForgeMergeMethod[] = ["merge", "squash", "rebase"];
const MERGE_METHOD_LABELS: Record<ForgeMergeMethod, string> = {
  merge: "Merge commit",
  squash: "Squash",
  rebase: "Rebase",
};

// Review box (§19.6.4). Three actions, each opening an inline body sheet; the
// Approve body is optional, the others require a comment body. Refreshes the PR
// summary via onReviewed after a successful review.
function ReviewBox({
  client,
  repo,
  cr,
  onReviewed,
}: {
  client: DaemonClient;
  repo: ForgeRepo;
  cr: ForgeChangeRequestSummary;
  onReviewed: () => void;
}) {
  const { theme } = useUnistyles();
  const [action, setAction] = useState<ForgeReviewAction | null>(null);
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const openApprove = useCallback(() => {
    setAction("approve");
    setBody("");
    setStatus("idle");
    setError(null);
  }, []);
  const openRequest = useCallback(() => {
    setAction("request_changes");
    setBody("");
    setStatus("idle");
    setError(null);
  }, []);
  const openComment = useCallback(() => {
    setAction("comment");
    setBody("");
    setStatus("idle");
    setError(null);
  }, []);
  const closeSheet = useCallback(() => {
    setAction(null);
    setStatus("idle");
    setError(null);
  }, []);

  const bodyRequired = action != null && action !== "approve";
  const canSubmit = action != null && (!bodyRequired || body.trim().length > 0);

  const submit = useCallback(async () => {
    if (!action) return;
    setStatus("running");
    setError(null);
    try {
      const res = await client.forgeReviewChangeRequest({
        repo: repoRef(repo),
        number: cr.number,
        action,
        body: body.trim() || undefined,
      });
      if (res.ok) {
        setStatus("done");
        onReviewed();
        setAction(null);
      } else {
        setStatus("idle");
        setError("The review could not be submitted.");
      }
    } catch (e: unknown) {
      setStatus("idle");
      setError(e instanceof Error ? e.message : "The review could not be submitted.");
    }
  }, [action, body, client, cr.number, repo, onReviewed]);

  const running = status === "running";

  return (
    <View style={styles.mergebox}>
      <View style={styles.mergeboxHeader}>
        <Text style={styles.mergeboxTitle}>Review</Text>
        <View style={styles.grow} />
        <ReviewSummary decision={cr.reviewDecision} />
      </View>
      <View style={styles.mergeboxBody}>
        <View style={styles.reviewActionsRow}>
          <Pressable
            style={[styles.btn, styles.btnGhost]}
            onPress={openApprove}
            disabled={running}
            testID="forge-review-approve"
          >
            <Check size={13} color={theme.colors.statusSuccess} />
            <Text style={styles.btnGhostText}>{REVIEW_LABELS.approve.idle}</Text>
          </Pressable>
          <Pressable
            style={[styles.btn, styles.btnGhost]}
            onPress={openRequest}
            disabled={running}
            testID="forge-review-request-changes"
          >
            <X size={13} color={theme.colors.statusDanger} />
            <Text style={styles.btnGhostText}>{REVIEW_LABELS.request_changes.idle}</Text>
          </Pressable>
          <Pressable
            style={[styles.btn, styles.btnGhost]}
            onPress={openComment}
            disabled={running}
            testID="forge-review-comment"
          >
            <MessageSquare size={13} color={theme.colors.foreground} />
            <Text style={styles.btnGhostText}>{REVIEW_LABELS.comment.idle}</Text>
          </Pressable>
        </View>

        {action ? (
          <View style={styles.reviewSheet}>
            <Text style={styles.fieldLabel}>
              {REVIEW_LABELS[action].idle}
              {action === "approve" ? " (comment optional)" : ""}
            </Text>
            <TextInput
              style={styles.textArea}
              value={body}
              onChangeText={setBody}
              placeholder={action === "approve" ? "Leave a comment (optional)" : "Leave a comment"}
              placeholderTextColor={theme.colors.foregroundExtraMuted}
              multiline
              editable={!running}
              testID="forge-review-body"
            />
            {error ? <Text style={styles.reviewError}>{error}</Text> : null}
            <View style={styles.formActions}>
              <Pressable
                style={[styles.btn, styles.btnPrimary, !canSubmit && styles.btnDisabled]}
                onPress={submit}
                disabled={!canSubmit || running}
                testID="forge-review-submit"
              >
                <Text style={styles.btnPrimaryText}>
                  {running ? REVIEW_LABELS[action].running : REVIEW_LABELS[action].idle}
                </Text>
              </Pressable>
              <Pressable
                style={[styles.btn, styles.btnGhost]}
                onPress={closeSheet}
                disabled={running}
              >
                <Text style={styles.btnGhostText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}

// Merge box (§19.6.5). Segmented method + "Merge {{abbrev}}". Disabled unless the
// PR is open per the summary. Milestone C adds an auto-merge toggle below the button
// (§19.12 forgeHubReview): the box only renders inside the review-gated block, so the
// toggle inherits that gate. Some forges (e.g. Bitbucket) have no auto-merge API and
// report enabled:false even when the user asked to enable — surfaced as a note.
function MergeBox({
  client,
  repo,
  cr,
  onMerged,
}: {
  client: DaemonClient;
  repo: ForgeRepo;
  cr: ForgeChangeRequestSummary;
  onMerged: () => void;
}) {
  const { theme } = useUnistyles();
  const def = getForgeDefinitionOrNeutral(repo.forge);
  const [method, setMethod] = useState<ForgeMergeMethod>("merge");
  const [status, setStatus] = useState<"idle" | "running" | "done">("idle");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Auto-merge (Milestone C). `autoMerge` mirrors the enabled state the daemon
  // reports back; `autoNote` surfaces a provider caveat when the request to enable
  // came back disabled.
  const [autoMerge, setAutoMerge] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoNote, setAutoNote] = useState<string | null>(null);

  const mergeable = cr.state === "open";
  const running = status === "running";

  const toggleAutoMerge = useCallback(async () => {
    const next = !autoMerge;
    setAutoBusy(true);
    setAutoNote(null);
    try {
      const res = await client.forgeSetAutoMerge({
        repo: repoRef(repo),
        number: cr.number,
        enabled: next,
        method,
      });
      setAutoMerge(res.enabled);
      if (next && !res.enabled) {
        setAutoNote(`Auto-merge isn't available for ${def.displayName}.`);
      }
    } catch (e: unknown) {
      setAutoNote(e instanceof Error ? e.message : "Couldn't update auto-merge.");
    } finally {
      setAutoBusy(false);
    }
  }, [autoMerge, client, repo, cr.number, method, def.displayName]);

  const submit = useCallback(async () => {
    setStatus("running");
    setError(null);
    setResult(null);
    try {
      const res = await client.forgeMergeChangeRequest({
        repo: repoRef(repo),
        number: cr.number,
        method,
      });
      if (res.merged) {
        setStatus("done");
        setResult(`${def.changeRequestAbbrev} merged.`);
        onMerged();
      } else {
        setStatus("idle");
        setError("The merge did not complete. Check required reviews and status checks.");
      }
    } catch (e: unknown) {
      setStatus("idle");
      setError(e instanceof Error ? e.message : "The merge did not complete.");
    }
  }, [client, repo, cr.number, method, def.changeRequestAbbrev, onMerged]);

  const disabledReason = mergeable
    ? null
    : cr.state === "merged"
      ? `This ${def.changeRequestNoun} is already merged.`
      : cr.state === "closed"
        ? `This ${def.changeRequestNoun} is closed.`
        : `Draft ${def.changeRequestNoun}s can't be merged.`;

  return (
    <View style={styles.mergebox}>
      <View style={styles.mergeboxHeader}>
        <Text style={styles.mergeboxTitle}>Merge</Text>
        <View style={styles.grow} />
        <ChecksSummary status={cr.checksStatus} />
      </View>
      <View style={styles.mergeboxBody}>
        <View style={styles.segmented}>
          {MERGE_METHODS.map((m) => (
            <MergeMethodButton key={m} value={m} active={method === m} onSelect={setMethod} />
          ))}
        </View>
        <Pressable
          style={[
            styles.btn,
            styles.btnPrimary,
            styles.mergeBtn,
            (!mergeable || running) && styles.btnDisabled,
          ]}
          onPress={submit}
          disabled={!mergeable || running}
          testID="forge-merge-submit"
        >
          <Text style={styles.btnPrimaryText}>
            {running ? "Merging…" : `Merge ${def.changeRequestAbbrev}`}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.autoMergeRow, (!mergeable || autoBusy) && styles.btnDisabled]}
          onPress={toggleAutoMerge}
          disabled={!mergeable || autoBusy}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: autoMerge, disabled: !mergeable || autoBusy }}
          testID="forge-auto-merge-toggle"
        >
          <View style={[styles.checkbox, autoMerge && styles.checkboxChecked]}>
            {autoMerge ? <Check size={11} color={theme.colors.accentForeground} /> : null}
          </View>
          <Text style={styles.autoMergeLabel}>Enable auto-merge (merge when checks pass)</Text>
        </Pressable>
        {autoNote ? <Text style={styles.mergeReason}>{autoNote}</Text> : null}
        {result ? <Text style={styles.mergeResultOk}>{result}</Text> : null}
        {error ? <Text style={styles.reviewError}>{error}</Text> : null}
        {disabledReason && !result ? (
          <Text style={styles.mergeReason}>{disabledReason}</Text>
        ) : null}
      </View>
    </View>
  );
}

function MergeMethodButton({
  value,
  active,
  onSelect,
}: {
  value: ForgeMergeMethod;
  active: boolean;
  onSelect: (method: ForgeMergeMethod) => void;
}) {
  const handlePress = useCallback(() => onSelect(value), [value, onSelect]);
  return (
    <Pressable
      style={[styles.segmentBtn, active && styles.segmentBtnActive]}
      onPress={handlePress}
      testID={`forge-merge-method-${value}`}
    >
      <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
        {MERGE_METHOD_LABELS[value]}
      </Text>
    </Pressable>
  );
}

// Checks tab body: if the PR head has a pipeline run, render its stage→job tree;
// otherwise keep the summary aggregate (§19.6.3 Checks).
function ChecksTab({
  client,
  repo,
  cr,
  pipelinesEnabled,
}: {
  client: DaemonClient;
  repo: ForgeRepo;
  cr: ForgeChangeRequestSummary;
  pipelinesEnabled: boolean;
}) {
  const [pipeline, setPipeline] = useState<ForgePipelineDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!pipelinesEnabled || loaded || loading) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const runs = await client.forgeListPipelines({
          repo: repoRef(repo),
          ref: cr.headRef,
          limit: 1,
        });
        const parsedRuns = ForgePipelineRunSchema.array().safeParse(runs.runs);
        const newest = parsedRuns.success ? parsedRuns.data[0] : undefined;
        if (newest) {
          const detail = await client.forgeGetPipeline({
            repo: repoRef(repo),
            runId: newest.id,
          });
          const parsed = ForgePipelineDetailSchema.safeParse(detail.pipeline);
          if (!cancelled && parsed.success) setPipeline(parsed.data);
        }
      } catch {
        // Fall back to the summary aggregate below.
      } finally {
        if (!cancelled) {
          setLoading(false);
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, repo, cr.headRef, pipelinesEnabled, loaded, loading]);

  if (pipeline) {
    return (
      <View style={styles.card}>
        {pipeline.stages.map((stage) => (
          <View key={stage.name}>
            {stage.jobs.map((job) => (
              <JobCheckRow key={job.id} job={job} />
            ))}
          </View>
        ))}
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.checkRow}>
        <Text style={styles.rowSub}>Checks</Text>
        <View style={styles.grow} />
        <ChecksSummary status={cr.checksStatus} />
      </View>
      <View style={styles.checkRow}>
        <Text style={styles.rowSub}>Review</Text>
        <View style={styles.grow} />
        <ReviewSummary decision={cr.reviewDecision} />
      </View>
    </View>
  );
}

function JobCheckRow({ job }: { job: ForgePipelineJob }) {
  const statusColor = usePipelineStatusColor();
  const color = statusColor(job.status);
  const duration = formatDuration(job.durationSeconds);
  return (
    <View style={styles.checkRow}>
      <StatusDot color={color} />
      <Text style={styles.rowSub} numberOfLines={1}>
        {job.name}
      </Text>
      <View style={styles.grow} />
      {duration ? <Text style={styles.metaMono}>{duration}</Text> : null}
      <Text style={[styles.metaMuted, { color }]}>{pipelineStatusLabel(job.status)}</Text>
    </View>
  );
}

// Close an open change request (§19.6). Rendered alongside the review/merge boxes
// and only for an open CR; on success the parent refreshes the summary and returns
// to the list. The existing merge/review UI is untouched.
function CloseChangeRequestBox({
  client,
  repo,
  cr,
  onClosed,
}: {
  client: DaemonClient;
  repo: ForgeRepo;
  cr: ForgeChangeRequestSummary;
  onClosed: () => void;
}) {
  const { theme } = useUnistyles();
  const def = getForgeDefinitionOrNeutral(repo.forge);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(async () => {
    if (closing) return;
    setClosing(true);
    setError(null);
    try {
      const res = await client.forgeCloseChangeRequest({ repo: repoRef(repo), number: cr.number });
      if (res.ok) {
        onClosed();
      } else {
        setError(`This ${def.changeRequestNoun} could not be closed.`);
        setClosing(false);
      }
    } catch (e: unknown) {
      setError(
        e instanceof Error ? e.message : `This ${def.changeRequestNoun} could not be closed.`,
      );
      setClosing(false);
    }
  }, [closing, client, repo, cr.number, def.changeRequestNoun, onClosed]);

  return (
    <View style={styles.mergebox}>
      <View style={styles.mergeboxBody}>
        <Pressable
          style={[styles.btn, styles.btnDanger, closing && styles.btnDisabled]}
          onPress={close}
          disabled={closing}
          testID="forge-cr-close"
        >
          {closing ? (
            <ActivityIndicator size="small" color={theme.colors.statusDanger} />
          ) : (
            <Ban size={13} color={theme.colors.statusDanger} />
          )}
          <Text style={styles.btnDangerText}>
            {closing ? "Closing…" : `Close ${def.changeRequestAbbrev}`}
          </Text>
        </Pressable>
        {error ? <Text style={styles.reviewError}>{error}</Text> : null}
      </View>
    </View>
  );
}

function PullRequestDetail({
  client,
  repo,
  cr,
  files,
  filesLoading,
  filesError,
  reviewEnabled,
  pipelinesEnabled,
  onBack,
  onLoadFiles,
  onReviewed,
}: {
  client: DaemonClient;
  repo: ForgeRepo;
  cr: ForgeChangeRequestSummary;
  files: ForgeChangeRequestFile[] | null;
  filesLoading: boolean;
  filesError: string | null;
  reviewEnabled: boolean;
  pipelinesEnabled: boolean;
  onBack: () => void;
  onLoadFiles: () => void;
  onReviewed: () => void;
}) {
  const { theme } = useUnistyles();
  const [tab, setTab] = useState<DetailTab>("conversation");
  const def = getForgeDefinitionOrNeutral(repo.forge);

  const [commits, setCommits] = useState<ForgeCommit[] | null>(null);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [commitsError, setCommitsError] = useState<string | null>(null);

  useEffect(() => {
    if (tab === "files" && files === null && !filesLoading) {
      onLoadFiles();
    }
  }, [tab, files, filesLoading, onLoadFiles]);

  const loadCommits = useCallback(async () => {
    setCommitsLoading(true);
    setCommitsError(null);
    try {
      let list: ForgeCommit[] = [];
      if (cr.baseRef && cr.headRef) {
        const res = await client.forgeCompareCommits({
          repo: repoRef(repo),
          base: cr.baseRef,
          head: cr.headRef,
        });
        const parsed = ForgeCommitSchema.array().safeParse(res.commits);
        if (parsed.success) list = parsed.data;
      }
      if (list.length === 0 && cr.headRef) {
        const res = await client.forgeListCommits({ repo: repoRef(repo), ref: cr.headRef });
        const parsed = ForgeCommitSchema.array().safeParse(res.commits);
        if (parsed.success) list = parsed.data;
      }
      setCommits(list);
    } catch (e: unknown) {
      setCommitsError(e instanceof Error ? e.message : "Unable to load commits.");
    } finally {
      setCommitsLoading(false);
    }
  }, [client, repo, cr.baseRef, cr.headRef]);

  useEffect(() => {
    if (tab === "commits" && commits === null && !commitsLoading && !commitsError) {
      void loadCommits();
    }
  }, [tab, commits, commitsLoading, commitsError, loadCommits]);

  const handleOpenExternal = useCallback(() => {
    void openExternalUrl(cr.url);
  }, [cr.url]);

  const setConversation = useCallback(() => setTab("conversation"), []);
  const setCommitsTab = useCallback(() => setTab("commits"), []);
  const setFiles = useCallback(() => setTab("files"), []);
  const setChecks = useCallback(() => setTab("checks"), []);

  const handleClosed = useCallback(() => {
    onReviewed();
    onBack();
  }, [onReviewed, onBack]);

  const filesCount = files?.length ?? null;
  const commitsCount = commits?.length ?? null;

  return (
    <View style={styles.pane}>
      <View style={styles.detailHeader}>
        <Pressable
          style={styles.iconBtn}
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back to list"
          testID="forge-cr-back"
        >
          <ArrowLeft size={18} color={theme.colors.foregroundMuted} />
        </Pressable>
        <ProviderBadge forge={repo.forge} />
        <View style={styles.rowInfo}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {cr.title}
          </Text>
          <Text style={styles.rowSubMono} numberOfLines={1}>
            {repo.owner}/{repo.name} · {def.changeRequestNumberPrefix}
            {cr.number}
          </Text>
        </View>
        <Chip label={crStateLabel(cr.state)} color={crStateColor(cr.state, theme)} />
        <Pressable
          style={[styles.btn, styles.btnGhost]}
          onPress={handleOpenExternal}
          testID="forge-cr-open-external"
        >
          <ExternalLink size={13} color={theme.colors.foreground} />
          <Text style={styles.btnGhostText}>Open on {def.displayName}</Text>
        </Pressable>
      </View>

      <View
        style={styles.tabsRow}
        accessibilityLabel={`${def.changeRequestNoun} ${def.changeRequestNumberPrefix}${cr.number}`}
      >
        <TabButton label="Conversation" active={tab === "conversation"} onPress={setConversation} />
        <TabButton
          label="Commits"
          count={commitsCount}
          active={tab === "commits"}
          onPress={setCommitsTab}
        />
        <TabButton
          label="Files changed"
          count={filesCount}
          active={tab === "files"}
          onPress={setFiles}
        />
        <TabButton label="Checks" active={tab === "checks"} onPress={setChecks} />
      </View>

      {tab === "conversation" ? (
        <>
          <View style={styles.card}>
            <View style={styles.metaGrid}>
              <MetaRow k="Branches" v={`${cr.headRef ?? "?"} → ${cr.baseRef ?? "?"}`} mono />
              <MetaRow k="Author" v={cr.authorLogin ? `@${cr.authorLogin}` : "—"} />
              <MetaRow k="Updated" v={formatRelativeMs(cr.updatedAt_ms) || "—"} />
              {cr.labels && cr.labels.length > 0 ? (
                <MetaRow k="Labels" v={cr.labels.join(", ")} />
              ) : null}
            </View>
          </View>
          {reviewEnabled ? (
            <>
              <ReviewBox client={client} repo={repo} cr={cr} onReviewed={onReviewed} />
              <MergeBox client={client} repo={repo} cr={cr} onMerged={onReviewed} />
              {cr.state === "open" ? (
                <CloseChangeRequestBox
                  client={client}
                  repo={repo}
                  cr={cr}
                  onClosed={handleClosed}
                />
              ) : null}
            </>
          ) : null}
        </>
      ) : null}

      {tab === "commits" ? (
        commitsError ? (
          <View style={styles.errorBanner}>
            <CircleAlert size={16} color={theme.colors.statusDanger} />
            <Text style={styles.errorText}>{commitsError}</Text>
            <Pressable style={[styles.btn, styles.btnGhost]} onPress={loadCommits}>
              <Text style={styles.btnGhostText}>Retry</Text>
            </Pressable>
          </View>
        ) : commitsLoading || commits === null ? (
          <SkeletonRows />
        ) : commits.length === 0 ? (
          <Text style={styles.emptyText}>No commits in this range.</Text>
        ) : (
          <View style={styles.card}>
            {commits.map((commit) => (
              <CommitRow key={commit.sha} commit={commit} />
            ))}
          </View>
        )
      ) : null}

      {tab === "checks" ? (
        <ChecksTab client={client} repo={repo} cr={cr} pipelinesEnabled={pipelinesEnabled} />
      ) : null}

      {tab === "files" ? (
        <DiffFileList
          files={files}
          loading={filesLoading}
          error={filesError}
          onRetry={onLoadFiles}
        />
      ) : null}
    </View>
  );
}

function ChecksSummary({ status }: { status: ForgeChangeRequestSummary["checksStatus"] }) {
  const { theme } = useUnistyles();
  const dotColor = useDotColor();
  const color = dotColor(status);
  const label =
    status === "success"
      ? "Passing"
      : status === "failure"
        ? "Failing"
        : status === "pending"
          ? "Pending"
          : "No checks";
  return (
    <View style={styles.summaryInline}>
      {color ? <StatusDot color={color} /> : null}
      <Text style={[styles.rowSub, color ? { color } : { color: theme.colors.foregroundMuted }]}>
        {label}
      </Text>
    </View>
  );
}

function ReviewSummary({ decision }: { decision: ForgeChangeRequestSummary["reviewDecision"] }) {
  const { theme } = useUnistyles();
  const color = reviewDotColor(decision, theme);
  const label =
    decision === "approved"
      ? "Approved"
      : decision === "changes_requested"
        ? "Changes requested"
        : decision === "pending"
          ? "Review pending"
          : "No review";
  return (
    <View style={styles.summaryInline}>
      {color ? <StatusDot color={color} /> : null}
      <Text style={[styles.rowSub, color ? { color } : { color: theme.colors.foregroundMuted }]}>
        {label}
      </Text>
    </View>
  );
}

function MetaRow({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaKey}>{k}</Text>
      <Text style={mono ? styles.metaValMono : styles.metaVal} numberOfLines={2}>
        {v}
      </Text>
    </View>
  );
}

function TabButton({
  label,
  count,
  active,
  onPress,
}: {
  label: string;
  count?: number | null;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={[styles.tab, active && styles.tabActive]} onPress={onPress}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
      {count != null ? <Text style={styles.tabCount}>{count}</Text> : null}
    </Pressable>
  );
}

// ===== code (file tree) + commits (branches · commits · diff) — Milestone B,
//        gate forgeHubCode =====

// Branch picker (§19.5.1): trigger shows the current branch, an inline sheet with
// a filter and a default-first list. Universal (no platform Modal).
function BranchPickerButton({
  branches,
  value,
  loading,
  onChange,
  testID,
}: {
  branches: ForgeBranch[];
  value: string | null;
  loading: boolean;
  onChange: (branch: string) => void;
  testID?: string;
}) {
  const { theme } = useUnistyles();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const toggle = useCallback(() => setOpen((v) => !v), []);

  const ordered = useMemo(() => {
    const copy = [...branches];
    copy.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
    return copy;
  }, [branches]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter((b) => b.name.toLowerCase().includes(q));
  }, [ordered, filter]);

  const handleSelect = useCallback(
    (name: string) => {
      onChange(name);
      setOpen(false);
      setFilter("");
    },
    [onChange],
  );

  return (
    <View style={styles.branchPicker}>
      <Pressable
        style={[styles.btn, styles.btnGhost]}
        onPress={toggle}
        testID={testID ?? "forge-branch-picker"}
      >
        <GitBranch size={13} color={theme.colors.foreground} />
        <Text style={styles.btnGhostText} numberOfLines={1}>
          {value ?? "Select branch"}
        </Text>
        <ChevronDown size={13} color={theme.colors.foregroundMuted} />
      </Pressable>
      {open ? (
        <View style={styles.branchSheet}>
          <View style={styles.searchField}>
            <Search size={14} color={theme.colors.foregroundMuted} />
            <TextInput
              style={styles.searchInput}
              value={filter}
              onChangeText={setFilter}
              placeholder="Filter branches…"
              placeholderTextColor={theme.colors.foregroundExtraMuted}
              autoCapitalize="none"
              autoCorrect={false}
              testID="forge-branch-filter"
            />
          </View>
          <ScrollView style={styles.branchList} nestedScrollEnabled>
            {loading ? (
              <SkeletonRows rows={5} variant="compact" />
            ) : filtered.length === 0 ? (
              <Text style={styles.emptyText}>No branches found.</Text>
            ) : (
              filtered.map((b) => (
                <BranchRow
                  key={b.name}
                  branch={b}
                  active={b.name === value}
                  onSelect={handleSelect}
                />
              ))
            )}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

function BranchRow({
  branch,
  active,
  onSelect,
}: {
  branch: ForgeBranch;
  active: boolean;
  onSelect: (name: string) => void;
}) {
  const handlePress = useCallback(() => onSelect(branch.name), [branch.name, onSelect]);
  return (
    <Pressable
      style={[styles.branchRow, active && styles.branchRowActive]}
      onPress={handlePress}
      testID={`forge-branch-${branch.name}`}
    >
      <Text style={styles.branchName} numberOfLines={1}>
        {branch.name}
      </Text>
      {branch.isDefault ? (
        <View style={styles.plainChip}>
          <Text style={styles.plainChipText}>default</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

// CommitsView (§19.5.2): branch picker + commit list; tapping a commit shows its
// changed files, and Compare (base/head) shows a range diff. This is the commit
// history that used to live under the Code tab — it now has its own sub-nav tab
// so the Code tab can be a file-tree browser (like GitHub's Code tab).
function CommitsView({ client, repo }: { client: DaemonClient; repo: ForgeRepo }) {
  const { theme } = useUnistyles();

  const [branches, setBranches] = useState<ForgeBranch[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branch, setBranch] = useState<string | null>(repo.defaultBranch ?? null);

  const [commits, setCommits] = useState<ForgeCommit[] | null>(null);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [commitsError, setCommitsError] = useState<string | null>(null);
  const [commitsLimit, setCommitsLimit] = useState(PAGE_SIZE);
  const [commitsLoadingMore, setCommitsLoadingMore] = useState(false);
  // Read inside loadCommits so a load-more that bumps the limit and immediately
  // re-fetches uses the new value without waiting for a re-render.
  const commitsLimitRef = useRef(commitsLimit);
  commitsLimitRef.current = commitsLimit;

  // Commit / compare diff (null = list mode).
  const [diffTitle, setDiffTitle] = useState<string | null>(null);
  const [diffFiles, setDiffFiles] = useState<ForgeChangeRequestFile[] | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  // Compare mode (§19.5.2 "Compare ⇄").
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareBase, setCompareBase] = useState<string | null>(repo.defaultBranch ?? null);
  const [compareHead, setCompareHead] = useState<string | null>(null);

  const loadBranches = useCallback(
    async (force = false) => {
      const key = `code:branches:${repoCacheKey(repo)}`;
      if (force) cacheDelete(key);
      else {
        const cached = cacheGet<ForgeBranch[]>(key);
        if (cached) {
          setBranches(cached);
          setBranch(
            (prev) => prev ?? cached.find((b) => b.isDefault)?.name ?? cached[0]?.name ?? null,
          );
          return;
        }
      }
      setBranchesLoading(true);
      try {
        const res = await client.forgeListBranches({ repo: repoRef(repo) });
        const parsed = ForgeBranchSchema.array().safeParse(res.branches);
        const list = parsed.success ? parsed.data : [];
        setBranches(list);
        setBranch((prev) => prev ?? list.find((b) => b.isDefault)?.name ?? list[0]?.name ?? null);
        if (parsed.success) cacheSet(key, list);
      } catch {
        // Branch picker shows an empty state; commits still load from default ref.
      } finally {
        setBranchesLoading(false);
      }
    },
    [client, repo],
  );

  useEffect(() => {
    void loadBranches();
  }, [loadBranches]);

  const loadCommits = useCallback(
    // `silent` keeps the current list on screen (no skeleton) so a load-more can
    // show its spinner on the button instead of blanking the list.
    async (force = false, silent = false) => {
      if (!branch) return;
      const key = `code:commits:${repoCacheKey(repo)}:${branch}`;
      if (force) cacheDelete(key);
      else {
        const cached = cacheGet<ForgeCommit[]>(key);
        if (cached) {
          setCommits(cached);
          setCommitsError(null);
          return;
        }
      }
      if (!silent) setCommitsLoading(true);
      setCommitsError(null);
      try {
        const res = await client.forgeListCommits({
          repo: repoRef(repo),
          ref: branch,
          limit: commitsLimitRef.current,
        });
        const parsed = ForgeCommitSchema.array().safeParse(res.commits);
        setCommits(parsed.success ? parsed.data : []);
        if (!parsed.success) setCommitsError("Unable to load commits.");
        else cacheSet(key, parsed.data);
      } catch (e: unknown) {
        setCommitsError(e instanceof Error ? e.message : "Unable to load commits.");
      } finally {
        if (!silent) setCommitsLoading(false);
      }
    },
    [client, repo, branch],
  );

  // Switching branch starts pagination fresh, mirroring the reload on branch change.
  useEffect(() => {
    if (!branch) return;
    commitsLimitRef.current = PAGE_SIZE;
    setCommitsLimit(PAGE_SIZE);
    void loadCommits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch]);

  const retryCommits = useCallback(() => void loadCommits(true), [loadCommits]);
  const refreshCommits = useCallback(() => {
    void loadBranches(true);
    void loadCommits(true);
  }, [loadBranches, loadCommits]);
  const loadMoreCommits = useCallback(async () => {
    setCommitsLoadingMore(true);
    const next = commitsLimitRef.current + PAGE_SIZE;
    commitsLimitRef.current = next;
    setCommitsLimit(next);
    try {
      await loadCommits(true, true);
    } finally {
      setCommitsLoadingMore(false);
    }
  }, [loadCommits]);

  const runCompare = useCallback(
    async (base: string, head: string, title: string) => {
      setDiffTitle(title);
      setDiffFiles(null);
      setDiffLoading(true);
      setDiffError(null);
      try {
        const res = await client.forgeCompareCommits({ repo: repoRef(repo), base, head });
        const parsed = ForgeChangeRequestFileSchema.array().safeParse(res.files);
        setDiffFiles(parsed.success ? parsed.data : []);
        if (!parsed.success) setDiffError("Unable to load diff.");
      } catch (e: unknown) {
        setDiffError(e instanceof Error ? e.message : "Unable to load diff.");
      } finally {
        setDiffLoading(false);
      }
    },
    [client, repo],
  );

  const openCommitDiff = useCallback(
    (commit: ForgeCommit) => {
      void runCompare(`${commit.sha}^`, commit.sha, `${shortSha(commit.sha)} · ${commit.subject}`);
    },
    [runCompare],
  );

  const closeDiff = useCallback(() => {
    setDiffTitle(null);
    setDiffFiles(null);
    setDiffError(null);
  }, []);

  const toggleCompare = useCallback(() => setCompareOpen((v) => !v), []);
  const submitCompare = useCallback(() => {
    if (compareBase && compareHead) {
      void runCompare(compareBase, compareHead, `${compareBase} … ${compareHead}`);
    }
  }, [compareBase, compareHead, runCompare]);

  const retryDiff = useCallback(() => {
    // Re-run the last comparison by re-opening; title carries no refs, so simply reload commits.
    void loadCommits();
  }, [loadCommits]);

  if (diffTitle !== null) {
    return (
      <View style={styles.pane}>
        <View style={styles.detailHeader}>
          <Pressable
            style={styles.iconBtn}
            onPress={closeDiff}
            accessibilityRole="button"
            accessibilityLabel="Back to commits"
            testID="forge-code-diff-back"
          >
            <ArrowLeft size={18} color={theme.colors.foregroundMuted} />
          </Pressable>
          <View style={styles.rowInfo}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {diffTitle}
            </Text>
          </View>
        </View>
        <DiffFileList
          files={diffFiles}
          loading={diffLoading}
          error={diffError}
          onRetry={retryDiff}
        />
      </View>
    );
  }

  return (
    <View style={styles.pane}>
      <View style={styles.toolbarRow}>
        <BranchPickerButton
          branches={branches}
          value={branch}
          loading={branchesLoading}
          onChange={setBranch}
        />
        <Text style={styles.rowTitleMono} numberOfLines={1}>
          {repo.owner}/{repo.name}
        </Text>
        <View style={styles.grow} />
        <Pressable
          style={[styles.btn, styles.btnGhost]}
          onPress={refreshCommits}
          testID="forge-commits-refresh"
        >
          <RotateCcw size={13} color={theme.colors.foreground} />
          <Text style={styles.btnGhostText}>Refresh</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnGhost]}
          onPress={toggleCompare}
          testID="forge-code-compare-toggle"
        >
          <GitCompare size={13} color={theme.colors.foreground} />
          <Text style={styles.btnGhostText}>Compare</Text>
        </Pressable>
      </View>

      {compareOpen ? (
        <View style={styles.formCard}>
          <Text style={styles.fieldLabel}>Base</Text>
          <BranchPickerButton
            branches={branches}
            value={compareBase}
            loading={branchesLoading}
            onChange={setCompareBase}
            testID="forge-compare-base"
          />
          <Text style={styles.fieldLabel}>Compare</Text>
          <BranchPickerButton
            branches={branches}
            value={compareHead}
            loading={branchesLoading}
            onChange={setCompareHead}
            testID="forge-compare-head"
          />
          <View style={styles.formActions}>
            <Pressable
              style={[
                styles.btn,
                styles.btnPrimary,
                (!compareBase || !compareHead) && styles.btnDisabled,
              ]}
              onPress={submitCompare}
              disabled={!compareBase || !compareHead}
              testID="forge-compare-submit"
            >
              <Text style={styles.btnPrimaryText}>Compare</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {commitsError ? (
        <View style={styles.errorBanner}>
          <CircleAlert size={16} color={theme.colors.statusDanger} />
          <Text style={styles.errorText}>{commitsError}</Text>
          <Pressable style={[styles.btn, styles.btnGhost]} onPress={retryCommits}>
            <Text style={styles.btnGhostText}>Retry</Text>
          </Pressable>
        </View>
      ) : commitsLoading || commits === null ? (
        <SkeletonRows />
      ) : commits.length === 0 ? (
        <Text style={styles.emptyText}>No commits on this branch.</Text>
      ) : (
        <>
          <View style={styles.card}>
            {commits.map((commit) => (
              <CommitRow key={commit.sha} commit={commit} onOpen={openCommitDiff} />
            ))}
          </View>
          {commits.length >= commitsLimit ? (
            <LoadMoreButton
              loading={commitsLoadingMore}
              onPress={loadMoreCommits}
              testID="forge-commits-load-more"
            />
          ) : null}
        </>
      )}
    </View>
  );
}

// A cached forge.file.get payload (subset the viewer renders).
type CodeFile = {
  path: string;
  content: string | null;
  isBinary: boolean;
  size?: number | null;
  truncated: boolean;
};

/** Dir of a repo-relative path ("" for a top-level file). */
function pathDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

// Directory listing sort (§ GitHub Code tab): dirs first, then files, each
// alphabetical by name (case-insensitive, stable via localeCompare).
function sortTreeEntries(entries: ForgeTreeEntry[]): ForgeTreeEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

// A single breadcrumb segment. The final (current) segment is inert; earlier
// segments navigate to their directory.
function CrumbSegment({
  label,
  path,
  isLast,
  onNavigate,
}: {
  label: string;
  path: string;
  isLast: boolean;
  onNavigate: (path: string) => void;
}) {
  const { theme } = useUnistyles();
  const handlePress = useCallback(() => onNavigate(path), [path, onNavigate]);
  return (
    <View style={styles.crumbWrap}>
      <Pressable
        onPress={handlePress}
        disabled={isLast}
        testID={`forge-crumb-${path === "" ? "root" : path}`}
      >
        <Text style={[styles.crumb, isLast && styles.crumbActive]} numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
      {isLast ? null : (
        <ChevronRight size={12} color={theme.colors.foregroundExtraMuted} style={styles.crumbSep} />
      )}
    </View>
  );
}

function Breadcrumb({
  repo,
  path,
  onNavigate,
}: {
  repo: ForgeRepo;
  path: string;
  onNavigate: (path: string) => void;
}) {
  const crumbs = useMemo(() => {
    const segs = path ? path.split("/") : [];
    const list: { label: string; path: string }[] = [{ label: repo.name, path: "" }];
    segs.forEach((seg, i) => {
      list.push({ label: seg, path: segs.slice(0, i + 1).join("/") });
    });
    return list;
  }, [repo.name, path]);

  return (
    <View style={styles.breadcrumb}>
      {crumbs.map((c, i) => (
        <CrumbSegment
          key={c.path || "root"}
          label={c.label}
          path={c.path}
          isLast={i === crumbs.length - 1}
          onNavigate={onNavigate}
        />
      ))}
    </View>
  );
}

// One directory/file row in the tree. Tapping a dir navigates into it; tapping a
// file opens the read-only viewer.
function TreeEntryRow({
  entry,
  onOpenDir,
  onOpenFile,
}: {
  entry: ForgeTreeEntry;
  onOpenDir: (path: string) => void;
  onOpenFile: (entry: ForgeTreeEntry) => void;
}) {
  const { theme } = useUnistyles();
  const isDir = entry.type === "dir";
  const handlePress = useCallback(() => {
    if (isDir) onOpenDir(entry.path);
    else onOpenFile(entry);
  }, [isDir, entry, onOpenDir, onOpenFile]);
  return (
    <Pressable style={styles.treeRow} onPress={handlePress} testID={`forge-tree-${entry.path}`}>
      {isDir ? (
        <Folder size={15} color={theme.colors.accent} />
      ) : (
        <File size={15} color={theme.colors.foregroundMuted} />
      )}
      <Text style={styles.treeName} numberOfLines={1}>
        {entry.name}
      </Text>
    </Pressable>
  );
}

// Code tab = a file-tree browser of the repo at the selected branch (like the
// GitHub Code tab). Directory listing + breadcrumb navigation + a read-only file
// viewer. Commit history lives in the separate Commits tab (CommitsView).
function CodeView({ client, repo }: { client: DaemonClient; repo: ForgeRepo }) {
  const { theme } = useUnistyles();

  const [branches, setBranches] = useState<ForgeBranch[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branch, setBranch] = useState<string | null>(repo.defaultBranch ?? null);

  // Restore the last directory/file for this repo (in-memory) so returning to the
  // Code tab doesn't reset to the root. Only `.path` of selectedFile is ever read,
  // so a stored file path rehydrates into a minimal "file" tree entry.
  const navKey = repoCacheKey(repo);

  // Current directory ("" = repo root) and the file currently open (null = tree).
  const [path, setPath] = useState(() => codeNavState.get(navKey)?.path ?? "");
  const [selectedFile, setSelectedFile] = useState<ForgeTreeEntry | null>(() => {
    const filePath = codeNavState.get(navKey)?.file ?? null;
    if (!filePath) return null;
    return { name: filePath.split("/").pop() ?? filePath, path: filePath, type: "file" };
  });

  const [entries, setEntries] = useState<ForgeTreeEntry[] | null>(null);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [entriesError, setEntriesError] = useState<string | null>(null);

  const [fileData, setFileData] = useState<CodeFile | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  // Markdown files can toggle between rendered preview and raw source; every
  // newly opened file resets to "preview" (§19 file viewer).
  const [viewMode, setViewMode] = useState<"preview" | "source">("preview");

  // Selecting a different repo resets navigation to the new repo's root. Skip the
  // first mount so the restored path/file (from codeNavState) survives — this
  // effect only fires when `repo` actually changes on a live instance.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    setBranch(repo.defaultBranch ?? null);
    setPath("");
    setSelectedFile(null);
  }, [repo]);

  // Persist the current directory/file back to the in-memory map on every change
  // (including branch/repo resets above, which set them to root).
  useEffect(() => {
    codeNavState.set(navKey, { path, file: selectedFile?.path ?? null });
  }, [navKey, path, selectedFile]);

  const loadBranches = useCallback(
    async (force = false) => {
      const key = `code:branches:${repoCacheKey(repo)}`;
      if (force) cacheDelete(key);
      else {
        const cached = cacheGet<ForgeBranch[]>(key);
        if (cached) {
          setBranches(cached);
          setBranch(
            (prev) => prev ?? cached.find((b) => b.isDefault)?.name ?? cached[0]?.name ?? null,
          );
          return;
        }
      }
      setBranchesLoading(true);
      try {
        const res = await client.forgeListBranches({ repo: repoRef(repo) });
        const parsed = ForgeBranchSchema.array().safeParse(res.branches);
        const list = parsed.success ? parsed.data : [];
        setBranches(list);
        setBranch((prev) => prev ?? list.find((b) => b.isDefault)?.name ?? list[0]?.name ?? null);
        if (parsed.success) cacheSet(key, list);
      } catch {
        // Branch picker shows an empty state; the tree still loads from the default ref.
      } finally {
        setBranchesLoading(false);
      }
    },
    [client, repo],
  );

  useEffect(() => {
    void loadBranches();
  }, [loadBranches]);

  const loadTree = useCallback(
    async (force = false) => {
      if (!branch) return;
      const key = `code:tree:${repoCacheKey(repo)}:${branch}:${path}`;
      if (force) cacheDelete(key);
      else {
        const cached = cacheGet<ForgeTreeEntry[]>(key);
        if (cached) {
          setEntries(cached);
          setEntriesError(null);
          return;
        }
      }
      setEntriesLoading(true);
      setEntriesError(null);
      try {
        const res = await client.forgeListTree({ repo: repoRef(repo), ref: branch, path });
        const parsed = ForgeTreeEntrySchema.array().safeParse(res.entries);
        if (parsed.success) {
          const sorted = sortTreeEntries(parsed.data);
          setEntries(sorted);
          cacheSet(key, sorted);
        } else {
          setEntries([]);
          setEntriesError("Unable to load files.");
        }
      } catch (e: unknown) {
        setEntriesError(e instanceof Error ? e.message : "Unable to load files.");
      } finally {
        setEntriesLoading(false);
      }
    },
    [client, repo, branch, path],
  );

  useEffect(() => {
    if (branch) void loadTree();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch, path]);

  const loadFile = useCallback(
    async (force = false) => {
      if (!selectedFile || !branch) return;
      const key = `code:file:${repoCacheKey(repo)}:${branch}:${selectedFile.path}`;
      if (force) cacheDelete(key);
      else {
        const cached = cacheGet<CodeFile>(key);
        if (cached) {
          setFileData(cached);
          setFileError(null);
          return;
        }
      }
      setFileLoading(true);
      setFileError(null);
      try {
        const res = await client.forgeGetFile({
          repo: repoRef(repo),
          ref: branch,
          path: selectedFile.path,
        });
        const data: CodeFile = {
          path: res.path,
          content: res.content,
          isBinary: res.isBinary,
          size: res.size,
          truncated: res.truncated,
        };
        setFileData(data);
        cacheSet(key, data);
      } catch (e: unknown) {
        setFileError(e instanceof Error ? e.message : "Unable to load file.");
      } finally {
        setFileLoading(false);
      }
    },
    [client, repo, branch, selectedFile],
  );

  useEffect(() => {
    if (selectedFile) void loadFile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFile]);

  // Changing branch resets navigation to the branch root and closes any file.
  const handleBranchChange = useCallback((next: string) => {
    setBranch(next);
    setPath("");
    setSelectedFile(null);
  }, []);

  const navigateDir = useCallback((next: string) => {
    setSelectedFile(null);
    setPath(next);
  }, []);

  const openFile = useCallback((entry: ForgeTreeEntry) => {
    setFileData(null);
    setFileError(null);
    setViewMode("preview");
    setSelectedFile(entry);
  }, []);

  const backToTree = useCallback(() => {
    // Return to the tree at the file's directory (already the current path when
    // opened from the listing; setting it explicitly keeps that invariant).
    if (selectedFile) setPath(pathDir(selectedFile.path));
    setSelectedFile(null);
  }, [selectedFile]);

  const retryTree = useCallback(() => void loadTree(true), [loadTree]);
  const retryFile = useCallback(() => void loadFile(true), [loadFile]);

  // Refresh busts the tree/file cache for the current path and refetches.
  const refreshCode = useCallback(() => {
    if (selectedFile) void loadFile(true);
    else void loadTree(true);
  }, [selectedFile, loadFile, loadTree]);

  // ---- file viewer -------------------------------------------------------
  if (selectedFile) {
    const size = formatBytes(fileData?.size ?? null);
    const ext = fileExtension(selectedFile.path);
    const isMarkdown = ext === "md" || ext === "markdown";
    return (
      <View style={styles.pane}>
        <View style={styles.fileViewerHeader}>
          <Pressable
            style={styles.iconBtn}
            onPress={backToTree}
            accessibilityRole="button"
            accessibilityLabel="Back to files"
            testID="forge-code-file-back"
          >
            <ArrowLeft size={18} color={theme.colors.foregroundMuted} />
          </Pressable>
          <View style={styles.rowInfo}>
            <Text style={styles.rowTitleMono} numberOfLines={1}>
              {selectedFile.path}
            </Text>
          </View>
          {isMarkdown ? (
            <View style={styles.segmented}>
              <Pressable
                style={[styles.segmentBtn, viewMode === "preview" && styles.segmentBtnActive]}
                onPress={() => setViewMode("preview")}
                testID="forge-code-view-preview"
              >
                <Text
                  style={[styles.segmentText, viewMode === "preview" && styles.segmentTextActive]}
                >
                  Preview
                </Text>
              </Pressable>
              <Pressable
                style={[styles.segmentBtn, viewMode === "source" && styles.segmentBtnActive]}
                onPress={() => setViewMode("source")}
                testID="forge-code-view-source"
              >
                <Text
                  style={[styles.segmentText, viewMode === "source" && styles.segmentTextActive]}
                >
                  Source
                </Text>
              </Pressable>
            </View>
          ) : null}
          <Pressable
            style={[styles.btn, styles.btnGhost]}
            onPress={refreshCode}
            testID="forge-code-refresh"
          >
            <RotateCcw size={13} color={theme.colors.foreground} />
            <Text style={styles.btnGhostText}>Refresh</Text>
          </Pressable>
        </View>

        {fileError ? (
          <View style={styles.errorBanner}>
            <CircleAlert size={16} color={theme.colors.statusDanger} />
            <Text style={styles.errorText}>{fileError}</Text>
            <Pressable style={[styles.btn, styles.btnGhost]} onPress={retryFile}>
              <Text style={styles.btnGhostText}>Retry</Text>
            </Pressable>
          </View>
        ) : fileLoading || fileData === null ? (
          <Text style={styles.emptyText}>Loading file…</Text>
        ) : fileData.isBinary ? (
          <Text style={styles.emptyText}>
            Binary file — can't preview.{size ? ` (${size})` : ""}
          </Text>
        ) : fileData.truncated || fileData.content === null ? (
          <Text style={styles.emptyText}>File too large to preview.{size ? ` (${size})` : ""}</Text>
        ) : isMarkdown && viewMode === "preview" ? (
          // Render inline so the screen's outer ScrollView owns vertical scroll:
          // the viewer grows with the file instead of a fixed-height inner box.
          <MarkdownRenderer
            text={fileData.content}
            onLinkPress={(url) => {
              void openExternalUrl(url);
              return true;
            }}
          />
        ) : (
          <HighlightedCodeBlock
            code={fileData.content}
            language={ext}
            inheritedStyles={CODE_BLOCK_INHERITED}
            textStyle={styles.codeBlockText}
          />
        )}
      </View>
    );
  }

  // ---- directory listing -------------------------------------------------
  return (
    <View style={styles.pane}>
      <View style={styles.toolbarRow}>
        <BranchPickerButton
          branches={branches}
          value={branch}
          loading={branchesLoading}
          onChange={handleBranchChange}
        />
        <Text style={styles.rowTitleMono} numberOfLines={1}>
          {repo.owner}/{repo.name}
        </Text>
        <View style={styles.grow} />
        <Pressable
          style={[styles.btn, styles.btnGhost]}
          onPress={refreshCode}
          testID="forge-code-refresh"
        >
          <RotateCcw size={13} color={theme.colors.foreground} />
          <Text style={styles.btnGhostText}>Refresh</Text>
        </Pressable>
      </View>

      <Breadcrumb repo={repo} path={path} onNavigate={navigateDir} />

      {entriesError ? (
        <View style={styles.errorBanner}>
          <CircleAlert size={16} color={theme.colors.statusDanger} />
          <Text style={styles.errorText}>{entriesError}</Text>
          <Pressable style={[styles.btn, styles.btnGhost]} onPress={retryTree}>
            <Text style={styles.btnGhostText}>Retry</Text>
          </Pressable>
        </View>
      ) : entriesLoading || entries === null ? (
        <SkeletonRows />
      ) : entries.length === 0 ? (
        <Text style={styles.emptyText}>This folder is empty.</Text>
      ) : (
        <View style={styles.card}>
          {entries.map((entry) => (
            <TreeEntryRow
              key={entry.path}
              entry={entry}
              onOpenDir={navigateDir}
              onOpenFile={openFile}
            />
          ))}
        </View>
      )}
    </View>
  );
}

// ===== pipelines (run · stage → job · log) — Milestone B, gate forgeHubPipelines

function PipelineRunRow({
  run,
  onOpen,
}: {
  run: ForgePipelineRun;
  onOpen: (run: ForgePipelineRun) => void;
}) {
  const { theme } = useUnistyles();
  const statusColor = usePipelineStatusColor();
  const handlePress = useCallback(() => onOpen(run), [run, onOpen]);
  return (
    <Pressable style={styles.row} onPress={handlePress} testID={`forge-run-${run.id}`}>
      <View style={styles.rowInfo}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {run.name}
        </Text>
        <View style={styles.crMetaRow}>
          {run.trigger ? <Text style={styles.metaMuted}>{run.trigger}</Text> : null}
          {run.ref ? <Text style={styles.metaMono}>{run.ref}</Text> : null}
          {run.sha ? <Text style={styles.metaMono}>{shortSha(run.sha)}</Text> : null}
          {run.actor ? <Text style={styles.metaMuted}>@{run.actor}</Text> : null}
        </View>
      </View>
      {run.durationSeconds ? (
        <Text style={styles.metaMono}>{formatDuration(run.durationSeconds)}</Text>
      ) : null}
      <Chip label={pipelineStatusLabel(run.status)} color={statusColor(run.status)} />
      <Text style={styles.metaWhen}>{formatRelativeMs(run.createdAt_ms)}</Text>
    </Pressable>
  );
}

// Job log viewer (§19.7.2/§19.7.5): monospace on a dark surface; polls the log
// every 3000ms while the job is running, stopping on terminal state or unmount.
function JobLogViewer({
  client,
  repo,
  job,
}: {
  client: DaemonClient;
  repo: ForgeRepo;
  job: ForgePipelineJob;
}) {
  const { theme } = useUnistyles();
  const [log, setLog] = useState<string>("");
  const [truncated, setTruncated] = useState(false);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const jobId = job.id;
  const activeRef = useRef(true);

  const fetchLog = useCallback(async () => {
    try {
      const res = await client.forgeGetJobLog({ repo: repoRef(repo), jobId });
      if (!activeRef.current) return { running: false };
      setLog(res.log);
      setTruncated(res.truncated);
      setRunning(res.running);
      setError(null);
      return { running: res.running };
    } catch (e: unknown) {
      if (activeRef.current)
        setError(e instanceof Error ? e.message : "Could not load the job log.");
      return { running: false };
    } finally {
      if (activeRef.current) setLoading(false);
    }
  }, [client, repo, jobId]);

  useEffect(() => {
    activeRef.current = true;
    setLoading(true);
    setLog("");
    setError(null);
    let timer: ReturnType<typeof setInterval> | null = null;
    void (async () => {
      const { running: isRunning } = await fetchLog();
      if (activeRef.current && isRunning) {
        // §19.7.5: incremental poll at 3000ms while the job is running.
        timer = setInterval(() => {
          void fetchLog().then(({ running: stillRunning }) => {
            if (!stillRunning && timer) {
              clearInterval(timer);
              timer = null;
            }
          });
        }, 3000);
      }
    })();
    return () => {
      activeRef.current = false;
      if (timer) clearInterval(timer);
    };
  }, [fetchLog]);

  return (
    <View style={styles.logPane}>
      <View style={styles.logHeader}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {job.name}
        </Text>
        {running ? <Chip label="Running" color={theme.colors.palette.blue[500]} /> : null}
      </View>
      {loading ? (
        <Text style={styles.emptyText}>Loading log…</Text>
      ) : error ? (
        <View style={styles.errorBanner}>
          <CircleAlert size={16} color={theme.colors.statusDanger} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : (
        <ScrollView
          style={styles.logSurface}
          contentContainerStyle={styles.logContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          {truncated ? (
            <Text style={styles.logTruncated}>Log truncated — download the full log</Text>
          ) : null}
          <Text style={styles.logText}>{log || "(no output)"}</Text>
        </ScrollView>
      )}
    </View>
  );
}

function PipelineRunDetail({
  client,
  repo,
  run,
  releasesEnabled,
  onBack,
}: {
  client: DaemonClient;
  repo: ForgeRepo;
  run: ForgePipelineRun;
  releasesEnabled: boolean;
  onBack: () => void;
}) {
  const { theme } = useUnistyles();
  const statusColor = usePipelineStatusColor();
  const [pipeline, setPipeline] = useState<ForgePipelineDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<ForgePipelineJob | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);

  const loadPipeline = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.forgeGetPipeline({ repo: repoRef(repo), runId: run.id });
      const parsed = ForgePipelineDetailSchema.safeParse(res.pipeline);
      if (parsed.success) {
        setPipeline(parsed.data);
        setSelectedJob((prev) => prev ?? parsed.data.stages.flatMap((s) => s.jobs)[0] ?? null);
      } else {
        setPipeline(null);
        setError("Unable to load pipeline.");
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unable to load pipeline.");
    } finally {
      setLoading(false);
    }
  }, [client, repo, run.id]);

  useEffect(() => {
    void loadPipeline();
  }, [loadPipeline]);

  const runRerun = useCallback(
    async (onlyFailed: boolean) => {
      setActionNote(onlyFailed ? "Rerunning failed jobs…" : "Rerunning…");
      try {
        const res = await client.forgeRerunPipeline({
          repo: repoRef(repo),
          runId: run.id,
          onlyFailed,
        });
        setActionNote(res.ok ? "Rerun queued" : "Failed to rerun");
        if (res.ok) void loadPipeline();
      } catch {
        setActionNote("Failed to rerun");
      }
    },
    [client, repo, run.id, loadPipeline],
  );
  const rerunAll = useCallback(() => void runRerun(false), [runRerun]);
  const rerunFailed = useCallback(() => void runRerun(true), [runRerun]);

  const cancel = useCallback(async () => {
    setActionNote("Cancelling…");
    try {
      const res = await client.forgeCancelPipeline({ repo: repoRef(repo), runId: run.id });
      setActionNote(res.ok ? "Cancelled" : "Failed to cancel");
      if (res.ok) void loadPipeline();
    } catch {
      setActionNote("Failed to cancel");
    }
  }, [client, repo, run.id, loadPipeline]);

  // Per-job manual trigger (GitLab play / GitHub environment approval). May
  // return ok:false on forges that don't model it — surface it, don't hide it.
  const playJob = useCallback(
    async (job: ForgePipelineJob) => {
      setActionNote(`Running ${job.name}…`);
      try {
        const res = await client.forgePlayJob({ repo: repoRef(repo), jobId: job.id });
        setActionNote(res.ok ? "Job started" : "Job couldn't be started");
        if (res.ok) void loadPipeline();
      } catch {
        setActionNote("Job couldn't be started");
      }
    },
    [client, repo, loadPipeline],
  );

  return (
    <View style={styles.pane}>
      <View style={styles.detailHeader}>
        <Pressable
          style={styles.iconBtn}
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back to runs"
          testID="forge-run-back"
        >
          <ArrowLeft size={18} color={theme.colors.foregroundMuted} />
        </Pressable>
        <View style={styles.rowInfo}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {run.name}
          </Text>
          <Text style={styles.rowSubMono} numberOfLines={1}>
            {run.ref ?? ""} {run.sha ? `· ${shortSha(run.sha)}` : ""}
          </Text>
        </View>
        <Chip label={pipelineStatusLabel(run.status)} color={statusColor(run.status)} />
      </View>

      <View style={styles.toolbarRow}>
        <Pressable
          style={[styles.btn, styles.btnGhost]}
          onPress={rerunAll}
          testID="forge-run-rerun"
        >
          <RotateCcw size={13} color={theme.colors.foreground} />
          <Text style={styles.btnGhostText}>Rerun</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnGhost]}
          onPress={rerunFailed}
          testID="forge-run-rerun-failed"
        >
          <RotateCcw size={13} color={theme.colors.statusWarning} />
          <Text style={styles.btnGhostText}>Rerun failed</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnDanger]}
          onPress={cancel}
          testID="forge-run-cancel"
        >
          <Ban size={13} color={theme.colors.statusDanger} />
          <Text style={styles.btnDangerText}>Cancel</Text>
        </Pressable>
        {actionNote ? <Text style={styles.metaMuted}>{actionNote}</Text> : null}
      </View>

      {loading ? (
        <Text style={styles.emptyText}>Loading pipeline…</Text>
      ) : error ? (
        <View style={styles.errorBanner}>
          <CircleAlert size={16} color={theme.colors.statusDanger} />
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={[styles.btn, styles.btnGhost]} onPress={loadPipeline}>
            <Text style={styles.btnGhostText}>Retry</Text>
          </Pressable>
        </View>
      ) : pipeline ? (
        <View style={styles.runSplit}>
          <View style={styles.jobTree}>
            {pipeline.stages.map((stage) => (
              <View key={stage.name}>
                <Text style={styles.stageHeader}>{stage.name}</Text>
                {stage.jobs.map((job) => (
                  <JobTreeRow
                    key={job.id}
                    job={job}
                    active={selectedJob?.id === job.id}
                    onSelect={setSelectedJob}
                    onPlay={playJob}
                  />
                ))}
              </View>
            ))}
          </View>
          <View style={styles.logColumn}>
            {selectedJob ? (
              <JobLogViewer client={client} repo={repo} job={selectedJob} />
            ) : (
              <Text style={styles.emptyText}>Select a job to view its log.</Text>
            )}
          </View>
        </View>
      ) : null}

      {releasesEnabled ? <ArtifactsPanel client={client} repo={repo} runId={run.id} /> : null}
    </View>
  );
}

// Artifacts panel (§19 Milestone C, gate forgeHubReleases). Lists a run's build
// artifacts; tapping resolves a signed download URL via the daemon and opens it.
// Some forges (GitLab / Bitbucket) return a null URL — that row shows a note.
function ArtifactsPanel({
  client,
  repo,
  runId,
}: {
  client: DaemonClient;
  repo: ForgeRepo;
  runId: string;
}) {
  const { theme } = useUnistyles();
  const [artifacts, setArtifacts] = useState<ForgeArtifact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(
    async (force = false) => {
      const key = `artifacts:${repoCacheKey(repo)}:${runId}`;
      if (force) cacheDelete(key);
      else {
        const cached = cacheGet<ForgeArtifact[]>(key);
        if (cached) {
          setArtifacts(cached);
          setError(null);
          return;
        }
      }
      setError(null);
      try {
        const res = await client.forgeListArtifacts({ repo: repoRef(repo), runId });
        const parsed = ForgeArtifactSchema.array().safeParse(res.artifacts);
        setArtifacts(parsed.success ? parsed.data : []);
        if (!parsed.success) setError("Unable to load artifacts.");
        else cacheSet(key, parsed.data);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Unable to load artifacts.");
      }
    },
    [client, repo, runId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const reload = useCallback(() => void load(true), [load]);

  const download = useCallback(
    async (artifact: ForgeArtifact) => {
      setDownloadingId(artifact.id);
      setNote(null);
      try {
        const res = await client.forgeDownloadArtifact({
          repo: repoRef(repo),
          artifactId: artifact.id,
        });
        if (res.url) void openExternalUrl(res.url);
        else setNote(`No download URL for ${artifact.name}.`);
      } catch (e: unknown) {
        setNote(e instanceof Error ? e.message : "Couldn't download the artifact.");
      } finally {
        setDownloadingId(null);
      }
    },
    [client, repo],
  );

  return (
    <View style={styles.pane}>
      <View style={styles.toolbarRow}>
        <Text style={styles.sectionTitle}>Artifacts</Text>
        <View style={styles.grow} />
        <Pressable
          style={[styles.btn, styles.btnGhost]}
          onPress={reload}
          testID="forge-artifacts-refresh"
        >
          <RotateCcw size={13} color={theme.colors.foreground} />
          <Text style={styles.btnGhostText}>Refresh</Text>
        </Pressable>
      </View>
      {error ? (
        <View style={styles.errorBanner}>
          <CircleAlert size={16} color={theme.colors.statusDanger} />
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={[styles.btn, styles.btnGhost]} onPress={reload}>
            <Text style={styles.btnGhostText}>Retry</Text>
          </Pressable>
        </View>
      ) : artifacts === null ? (
        <SkeletonRows rows={3} />
      ) : artifacts.length === 0 ? (
        <Text style={styles.emptyText}>No artifacts for this run.</Text>
      ) : (
        <View style={styles.card}>
          {artifacts.map((artifact) => (
            <ArtifactRow
              key={artifact.id}
              artifact={artifact}
              busy={downloadingId === artifact.id}
              onDownload={download}
            />
          ))}
        </View>
      )}
      {note ? <Text style={styles.mergeReason}>{note}</Text> : null}
    </View>
  );
}

function ArtifactRow({
  artifact,
  busy,
  onDownload,
}: {
  artifact: ForgeArtifact;
  busy: boolean;
  onDownload: (artifact: ForgeArtifact) => void;
}) {
  const { theme } = useUnistyles();
  const handlePress = useCallback(() => onDownload(artifact), [artifact, onDownload]);
  const size = formatBytes(artifact.sizeBytes);
  const expiry = artifact.expiresAt_ms ? `expires ${formatRelativeMs(artifact.expiresAt_ms)}` : "";
  return (
    <Pressable
      style={[styles.row, busy && styles.btnDisabled]}
      onPress={handlePress}
      disabled={busy}
      testID={`forge-artifact-${artifact.id}`}
    >
      <View style={styles.rowInfo}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {artifact.name}
        </Text>
        <View style={styles.crMetaRow}>
          {size ? <Text style={styles.metaMono}>{size}</Text> : null}
          {expiry ? <Text style={styles.metaMuted}>{expiry}</Text> : null}
        </View>
      </View>
      <Download size={15} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
}

function JobTreeRow({
  job,
  active,
  onSelect,
  onPlay,
}: {
  job: ForgePipelineJob;
  active: boolean;
  onSelect: (job: ForgePipelineJob) => void;
  onPlay: (job: ForgePipelineJob) => void;
}) {
  const { theme } = useUnistyles();
  const statusColor = usePipelineStatusColor();
  const handlePress = useCallback(() => onSelect(job), [job, onSelect]);
  const handlePlay = useCallback(() => onPlay(job), [job, onPlay]);
  const canPlay = job.status === "manual";
  return (
    <Pressable
      style={[styles.jobRow, active && styles.jobRowActive]}
      onPress={handlePress}
      testID={`forge-job-${job.id}`}
    >
      <StatusDot color={statusColor(job.status)} />
      <Text style={styles.jobName} numberOfLines={1}>
        {job.name}
      </Text>
      <View style={styles.grow} />
      {canPlay ? (
        <Pressable
          style={styles.iconBtn}
          onPress={handlePlay}
          accessibilityRole="button"
          accessibilityLabel="Run job"
          testID={`forge-job-play-${job.id}`}
        >
          <Play size={12} color={theme.colors.foregroundMuted} />
        </Pressable>
      ) : null}
      {job.durationSeconds ? (
        <Text style={styles.metaMono}>{formatDuration(job.durationSeconds)}</Text>
      ) : null}
    </Pressable>
  );
}

function PipelinesView({
  client,
  repo,
  releasesEnabled,
}: {
  client: DaemonClient;
  repo: ForgeRepo;
  releasesEnabled: boolean;
}) {
  const { theme } = useUnistyles();
  const [runs, setRuns] = useState<ForgePipelineRun[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<ForgePipelineRun | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);
  const limitRef = useRef(limit);
  limitRef.current = limit;

  const loadRuns = useCallback(
    // `silent` keeps the list on screen for a load-more (spinner on the button).
    async (force = false, silent = false) => {
      const key = `pipelines:${repoCacheKey(repo)}`;
      if (force) cacheDelete(key);
      else {
        const cached = cacheGet<ForgePipelineRun[]>(key);
        if (cached) {
          setRuns(cached);
          setError(null);
          setLoading(false);
          return;
        }
      }
      if (!silent) setLoading(true);
      setError(null);
      try {
        const res = await client.forgeListPipelines({
          repo: repoRef(repo),
          limit: limitRef.current,
        });
        const parsed = ForgePipelineRunSchema.array().safeParse(res.runs);
        setRuns(parsed.success ? parsed.data : []);
        if (!parsed.success) setError("Unable to load pipelines.");
        else cacheSet(key, parsed.data);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Unable to load pipelines.");
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [client, repo],
  );

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const reloadRuns = useCallback(() => void loadRuns(true), [loadRuns]);
  const loadMoreRuns = useCallback(async () => {
    setLoadingMore(true);
    const next = limitRef.current + PAGE_SIZE;
    limitRef.current = next;
    setLimit(next);
    try {
      await loadRuns(true, true);
    } finally {
      setLoadingMore(false);
    }
  }, [loadRuns]);
  const backToRuns = useCallback(() => setSelectedRun(null), []);

  if (selectedRun) {
    return (
      <PipelineRunDetail
        client={client}
        repo={repo}
        run={selectedRun}
        releasesEnabled={releasesEnabled}
        onBack={backToRuns}
      />
    );
  }

  return (
    <View style={styles.pane}>
      <View style={styles.toolbarRow}>
        <Text style={styles.rowTitleMono} numberOfLines={1}>
          {repo.owner}/{repo.name}
        </Text>
        <View style={styles.grow} />
        <Pressable
          style={[styles.btn, styles.btnGhost]}
          onPress={reloadRuns}
          testID="forge-pipelines-refresh"
        >
          <RotateCcw size={13} color={theme.colors.foreground} />
          <Text style={styles.btnGhostText}>Refresh</Text>
        </Pressable>
      </View>
      {error ? (
        <View style={styles.errorBanner}>
          <CircleAlert size={16} color={theme.colors.statusDanger} />
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={[styles.btn, styles.btnGhost]} onPress={reloadRuns}>
            <Text style={styles.btnGhostText}>Retry</Text>
          </Pressable>
        </View>
      ) : loading || runs === null ? (
        <SkeletonRows />
      ) : runs.length === 0 ? (
        <Text style={styles.emptyText}>No pipeline runs yet.</Text>
      ) : (
        <>
          <View style={styles.card}>
            {runs.map((run) => (
              <PipelineRunRow key={run.id} run={run} onOpen={setSelectedRun} />
            ))}
          </View>
          {runs.length >= limit ? (
            <LoadMoreButton
              loading={loadingMore}
              onPress={loadMoreRuns}
              testID="forge-pipelines-load-more"
            />
          ) : null}
        </>
      )}
    </View>
  );
}

// ===== releases · tags — Milestone C, gate forgeHubReleases ==================

function ReleaseRow({
  release,
  onOpen,
}: {
  release: ForgeRelease;
  onOpen: (release: ForgeRelease) => void;
}) {
  const { theme } = useUnistyles();
  const handlePress = useCallback(() => onOpen(release), [release, onOpen]);
  const handleOpen = useCallback(() => void openExternalUrl(release.url), [release.url]);
  const published = formatRelativeMs(release.publishedAt_ms);
  return (
    <View style={styles.releaseCard}>
      <View style={styles.releaseHeader}>
        <Pressable
          style={styles.rowInfo}
          onPress={handlePress}
          testID={`forge-release-${release.id}`}
        >
          <Text style={styles.rowTitle} numberOfLines={1}>
            {release.name || release.tagName}
          </Text>
          <View style={styles.crMetaRow}>
            <Text style={styles.metaMono}>{release.tagName}</Text>
            {release.isDraft ? (
              <View style={styles.plainChip}>
                <Text style={styles.plainChipText}>Draft</Text>
              </View>
            ) : null}
            {release.isPrerelease ? (
              <View style={styles.plainChip}>
                <Text style={styles.plainChipText}>Prerelease</Text>
              </View>
            ) : null}
            {published ? <Text style={styles.metaMuted}>{published}</Text> : null}
          </View>
        </Pressable>
        <Pressable
          style={styles.iconBtn}
          onPress={handleOpen}
          accessibilityRole="button"
          accessibilityLabel="Open release"
          testID={`forge-release-open-${release.id}`}
        >
          <ExternalLink size={15} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
      {release.assets && release.assets.length > 0 ? (
        <View style={styles.assetList}>
          {release.assets.map((asset) => (
            <AssetRow
              key={asset.url}
              name={asset.name}
              url={asset.url}
              sizeBytes={asset.sizeBytes}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function AssetRow({
  name,
  url,
  sizeBytes,
}: {
  name: string;
  url: string;
  sizeBytes?: number | null;
}) {
  const { theme } = useUnistyles();
  const handleOpen = useCallback(() => void openExternalUrl(url), [url]);
  const size = formatBytes(sizeBytes);
  return (
    <Pressable style={styles.assetRow} onPress={handleOpen} testID={`forge-asset-${name}`}>
      <Download size={13} color={theme.colors.foregroundMuted} />
      <Text style={styles.assetName} numberOfLines={1}>
        {name}
      </Text>
      <View style={styles.grow} />
      {size ? <Text style={styles.metaMono}>{size}</Text> : null}
    </Pressable>
  );
}

function TagRow({ tag }: { tag: ForgeTag }) {
  const { theme } = useUnistyles();
  const handleOpen = useCallback(() => {
    if (tag.url) void openExternalUrl(tag.url);
  }, [tag.url]);
  return (
    <View style={styles.row}>
      <Tag size={14} color={theme.colors.foregroundMuted} />
      <View style={styles.rowInfo}>
        <Text style={styles.rowTitleMono} numberOfLines={1}>
          {tag.name}
        </Text>
        {tag.commitSha ? <Text style={styles.metaMono}>{shortSha(tag.commitSha)}</Text> : null}
      </View>
      {tag.url ? (
        <Pressable
          style={styles.iconBtn}
          onPress={handleOpen}
          accessibilityRole="button"
          accessibilityLabel="Open tag"
          testID={`forge-tag-open-${tag.name}`}
        >
          <ExternalLink size={15} color={theme.colors.foregroundMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

// New release form (§19.9). Tag (required), Title, Notes (markdown), an optional
// Target (branch or commit), and Draft + Pre-release toggles. On success the parent
// busts the releases cache and reloads. Some forges (e.g. Bitbucket) don't support
// releases and return an error string, surfaced inline.
function NewReleaseForm({
  client,
  repo,
  onCreated,
  onCancel,
}: {
  client: DaemonClient;
  repo: ForgeRepo;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const { theme } = useUnistyles();
  const [tagName, setTagName] = useState("");
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [target, setTarget] = useState("");
  const [draft, setDraft] = useState(false);
  const [prerelease, setPrerelease] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleDraft = useCallback(() => setDraft((v) => !v), []);
  const togglePrerelease = useCallback(() => setPrerelease((v) => !v), []);
  const canSubmit = tagName.trim().length > 0 && !busy;

  const submit = useCallback(async () => {
    if (tagName.trim().length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await client.forgeCreateRelease({
        repo: repoRef(repo),
        tagName: tagName.trim(),
        name: name.trim() || undefined,
        body: body.trim() || undefined,
        draft,
        prerelease,
        target: target.trim() || undefined,
      });
      const parsed = ForgeReleaseSchema.safeParse(res.release);
      if (res.release != null && parsed.success) {
        onCreated();
      } else {
        setError(res.error ?? "The release could not be created.");
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "The release could not be created.");
    } finally {
      setBusy(false);
    }
  }, [tagName, name, body, target, draft, prerelease, busy, client, repo, onCreated]);

  return (
    <View style={styles.formCard}>
      <View style={styles.formHeader}>
        <View style={styles.formTitleRow}>
          <Tag size={16} color={theme.colors.foreground} />
          <Text style={styles.formTitle}>New release</Text>
        </View>
      </View>

      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Tag</Text>
        <TextInput
          style={styles.input}
          value={tagName}
          onChangeText={setTagName}
          placeholder="v1.0.0"
          placeholderTextColor={theme.colors.foregroundExtraMuted}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
          testID="forge-new-release-tag"
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Title</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="Release title"
          placeholderTextColor={theme.colors.foregroundExtraMuted}
          editable={!busy}
          testID="forge-new-release-name"
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Notes</Text>
        <TextInput
          style={styles.textArea}
          value={body}
          onChangeText={setBody}
          placeholder="Release notes (markdown, optional)"
          placeholderTextColor={theme.colors.foregroundExtraMuted}
          multiline
          editable={!busy}
          testID="forge-new-release-body"
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Target</Text>
        <TextInput
          style={styles.input}
          value={target}
          onChangeText={setTarget}
          placeholder="branch or commit (optional)"
          placeholderTextColor={theme.colors.foregroundExtraMuted}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
          testID="forge-new-release-target"
        />
      </View>

      <Pressable
        style={styles.autoMergeRow}
        onPress={toggleDraft}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: draft, disabled: busy }}
        disabled={busy}
        testID="forge-new-release-draft"
      >
        <View style={[styles.checkbox, draft && styles.checkboxChecked]}>
          {draft ? <Check size={11} color={theme.colors.accentForeground} /> : null}
        </View>
        <Text style={styles.autoMergeLabel}>Draft</Text>
      </Pressable>

      <Pressable
        style={styles.autoMergeRow}
        onPress={togglePrerelease}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: prerelease, disabled: busy }}
        disabled={busy}
        testID="forge-new-release-prerelease"
      >
        <View style={[styles.checkbox, prerelease && styles.checkboxChecked]}>
          {prerelease ? <Check size={11} color={theme.colors.accentForeground} /> : null}
        </View>
        <Text style={styles.autoMergeLabel}>Pre-release</Text>
      </Pressable>

      {error ? <Text style={styles.reviewError}>{error}</Text> : null}

      <View style={styles.formActions}>
        <Pressable
          style={[styles.btn, styles.btnPrimary, !canSubmit && styles.btnDisabled]}
          onPress={submit}
          disabled={!canSubmit}
          testID="forge-new-release-submit"
        >
          {busy ? (
            <ActivityIndicator size="small" color={theme.colors.accentForeground} />
          ) : (
            <Plus size={14} color={theme.colors.accentForeground} />
          )}
          <Text style={styles.btnPrimaryText}>{busy ? "Creating…" : "Create release"}</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.btnGhost]} onPress={onCancel} disabled={busy}>
          <Text style={styles.btnGhostText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

// Release detail (§19.9). Fetches the full release (notes + assets) via
// forge.release.get and renders the markdown notes and downloadable assets. Seeds
// the header from the list summary so the title/chips paint before the fetch lands.
function ReleaseDetail({
  client,
  repo,
  release,
  onBack,
}: {
  client: DaemonClient;
  repo: ForgeRepo;
  release: ForgeRelease;
  onBack: () => void;
}) {
  const { theme } = useUnistyles();
  const def = getForgeDefinitionOrNeutral(repo.forge);
  const [detail, setDetail] = useState<ForgeRelease | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await client.forgeGetRelease({ repo: repoRef(repo), tagName: release.tagName });
        const parsed = ForgeReleaseSchema.safeParse(res.release);
        if (cancelled) return;
        if (parsed.success) setDetail(parsed.data);
        else setError("Unable to load this release.");
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unable to load this release.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, repo, release.tagName]);

  const shown = detail ?? release;
  const published = formatRelativeMs(shown.publishedAt_ms);
  const handleOpenExternal = useCallback(() => void openExternalUrl(shown.url), [shown.url]);
  const handleLinkPress = useCallback((u: string) => {
    void openExternalUrl(u);
    return true;
  }, []);

  return (
    <View style={styles.pane}>
      <View style={styles.detailHeader}>
        <Pressable
          style={styles.iconBtn}
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back to releases"
          testID="forge-release-back"
        >
          <ArrowLeft size={18} color={theme.colors.foregroundMuted} />
        </Pressable>
        <View style={styles.rowInfo}>
          <Text style={styles.rowTitle} numberOfLines={2}>
            {shown.name || shown.tagName}
          </Text>
          <View style={styles.crMetaRow}>
            <Text style={styles.metaMono}>{shown.tagName}</Text>
            {shown.isDraft ? (
              <View style={styles.plainChip}>
                <Text style={styles.plainChipText}>Draft</Text>
              </View>
            ) : null}
            {shown.isPrerelease ? (
              <View style={styles.plainChip}>
                <Text style={styles.plainChipText}>Prerelease</Text>
              </View>
            ) : null}
            {published ? <Text style={styles.metaMuted}>{published}</Text> : null}
          </View>
        </View>
        <Pressable
          style={[styles.btn, styles.btnGhost]}
          onPress={handleOpenExternal}
          testID="forge-release-detail-open"
        >
          <ExternalLink size={13} color={theme.colors.foreground} />
          <Text style={styles.btnGhostText}>Open on {def.displayName}</Text>
        </Pressable>
      </View>

      {loading && detail === null ? (
        <SkeletonRows rows={4} />
      ) : error && detail === null ? (
        <View style={styles.errorBanner}>
          <CircleAlert size={16} color={theme.colors.statusDanger} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : (
        <>
          <View style={styles.card}>
            <View style={styles.releaseNotes}>
              <MarkdownRenderer text={shown.body ?? ""} onLinkPress={handleLinkPress} />
            </View>
          </View>
          {shown.assets && shown.assets.length > 0 ? (
            <>
              <Text style={styles.sectionTitle}>Assets</Text>
              <View style={styles.card}>
                {shown.assets.map((asset) => (
                  <AssetRow
                    key={asset.url}
                    name={asset.name}
                    url={asset.url}
                    sizeBytes={asset.sizeBytes}
                  />
                ))}
              </View>
            </>
          ) : null}
        </>
      )}
    </View>
  );
}

function ReleasesView({ client, repo }: { client: DaemonClient; repo: ForgeRepo }) {
  const { theme } = useUnistyles();
  const [releases, setReleases] = useState<ForgeRelease[] | null>(null);
  const [tags, setTags] = useState<ForgeTag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<ForgeRelease | null>(null);
  // Load-more grows only the releases list; tags keep their own fixed page.
  const [releasesLimit, setReleasesLimit] = useState(PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);
  const releasesLimitRef = useRef(releasesLimit);
  releasesLimitRef.current = releasesLimit;

  const load = useCallback(
    // `silent` keeps releases/tags on screen (no skeleton) for a load-more.
    async (force = false, silent = false) => {
      const releasesKey = `releases:${repoCacheKey(repo)}`;
      const tagsKey = `tags:${repoCacheKey(repo)}`;
      if (force) {
        cacheDelete(releasesKey);
        cacheDelete(tagsKey);
      } else {
        const cachedReleases = cacheGet<ForgeRelease[]>(releasesKey);
        const cachedTags = cacheGet<ForgeTag[]>(tagsKey);
        if (cachedReleases && cachedTags) {
          setReleases(cachedReleases);
          setTags(cachedTags);
          setError(null);
          return;
        }
      }
      setError(null);
      if (!silent) {
        setReleases(null);
        setTags(null);
      }
      try {
        const [releaseRes, tagRes] = await Promise.all([
          client.forgeListReleases({ repo: repoRef(repo), limit: releasesLimitRef.current }),
          client.forgeListTags({ repo: repoRef(repo), limit: 50 }),
        ]);
        const parsedReleases = ForgeReleaseSchema.array().safeParse(releaseRes.releases);
        const parsedTags = ForgeTagSchema.array().safeParse(tagRes.tags);
        setReleases(parsedReleases.success ? parsedReleases.data : []);
        setTags(parsedTags.success ? parsedTags.data : []);
        if (parsedReleases.success) cacheSet(releasesKey, parsedReleases.data);
        if (parsedTags.success) cacheSet(tagsKey, parsedTags.data);
        if (!parsedReleases.success || !parsedTags.success) {
          setError("Unable to load releases.");
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Unable to load releases.");
      }
    },
    [client, repo],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const reload = useCallback(() => void load(true), [load]);
  const loadMoreReleases = useCallback(async () => {
    setLoadingMore(true);
    const next = releasesLimitRef.current + PAGE_SIZE;
    releasesLimitRef.current = next;
    setReleasesLimit(next);
    try {
      await load(true, true);
    } finally {
      setLoadingMore(false);
    }
  }, [load]);

  const openCreate = useCallback(() => setCreating(true), []);
  const closeCreate = useCallback(() => setCreating(false), []);
  const handleCreated = useCallback(() => {
    setCreating(false);
    void load(true);
  }, [load]);
  const openDetail = useCallback((release: ForgeRelease) => setSelected(release), []);
  const closeDetail = useCallback(() => setSelected(null), []);

  if (selected) {
    return <ReleaseDetail client={client} repo={repo} release={selected} onBack={closeDetail} />;
  }

  return (
    <View style={styles.pane}>
      <View style={styles.toolbarRow}>
        <Text style={styles.rowTitleMono} numberOfLines={1}>
          {repo.owner}/{repo.name}
        </Text>
        <View style={styles.grow} />
        <Pressable
          style={[styles.btn, styles.btnPrimary]}
          onPress={openCreate}
          testID="forge-new-release"
        >
          <Plus size={14} color={theme.colors.accentForeground} />
          <Text style={styles.btnPrimaryText}>New release</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnGhost]}
          onPress={reload}
          testID="forge-releases-refresh"
        >
          <RotateCcw size={13} color={theme.colors.foreground} />
          <Text style={styles.btnGhostText}>Refresh</Text>
        </Pressable>
      </View>

      {creating ? (
        <NewReleaseForm
          client={client}
          repo={repo}
          onCreated={handleCreated}
          onCancel={closeCreate}
        />
      ) : null}

      {error ? (
        <View style={styles.errorBanner}>
          <CircleAlert size={16} color={theme.colors.statusDanger} />
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={[styles.btn, styles.btnGhost]} onPress={reload}>
            <Text style={styles.btnGhostText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      <Text style={styles.sectionTitle}>Releases</Text>
      {releases === null ? (
        <SkeletonRows rows={4} />
      ) : releases.length === 0 ? (
        <Text style={styles.emptyText}>No releases yet.</Text>
      ) : (
        <>
          <View style={styles.filesPane}>
            {releases.map((release) => (
              <ReleaseRow key={release.id} release={release} onOpen={openDetail} />
            ))}
          </View>
          {releases.length >= releasesLimit ? (
            <LoadMoreButton
              loading={loadingMore}
              onPress={loadMoreReleases}
              testID="forge-releases-load-more"
            />
          ) : null}
        </>
      )}

      <Text style={styles.sectionTitle}>Tags</Text>
      {tags === null ? (
        <SkeletonRows rows={4} />
      ) : tags.length === 0 ? (
        <Text style={styles.emptyText}>No tags yet.</Text>
      ) : (
        <View style={styles.card}>
          {tags.map((tag) => (
            <TagRow key={tag.name} tag={tag} />
          ))}
        </View>
      )}
    </View>
  );
}

// ===== issues — Milestone C, gate forgeHubIssues =============================

const ISSUE_STATES = ["open", "closed", "all"] as const;
type IssueState = (typeof ISSUE_STATES)[number];

function issueStateColor(state: ForgeIssue["state"], theme: Theme): string {
  return state === "open" ? theme.colors.statusSuccess : theme.colors.statusMerged;
}

function IssueRow({ issue, onOpen }: { issue: ForgeIssue; onOpen: (issue: ForgeIssue) => void }) {
  const { theme } = useUnistyles();
  const handlePress = useCallback(() => onOpen(issue), [issue, onOpen]);
  return (
    <Pressable style={styles.row} onPress={handlePress} testID={`forge-issue-${issue.number}`}>
      <View style={styles.rowInfo}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {issue.title}
        </Text>
        <View style={styles.crMetaRow}>
          <Text style={styles.metaMono}>#{issue.number}</Text>
          {issue.authorLogin ? <Text style={styles.metaMuted}>@{issue.authorLogin}</Text> : null}
          {issue.commentCount != null ? (
            <Text style={styles.metaMuted}>{issue.commentCount} comments</Text>
          ) : null}
          {issue.labels?.slice(0, 3).map((label) => (
            <View key={label} style={styles.plainChip}>
              <Text style={styles.plainChipText}>{label}</Text>
            </View>
          ))}
        </View>
      </View>
      <Chip
        label={issue.state === "open" ? "Open" : "Closed"}
        color={issueStateColor(issue.state, theme)}
      />
      <Text style={styles.metaWhen}>{formatRelativeMs(issue.updatedAt_ms)}</Text>
    </Pressable>
  );
}

function IssueStateFilterButton({
  value,
  active,
  onChange,
}: {
  value: IssueState;
  active: boolean;
  onChange: (state: IssueState) => void;
}) {
  const handlePress = useCallback(() => onChange(value), [value, onChange]);
  const label = value === "all" ? "All" : value.charAt(0).toUpperCase() + value.slice(1);
  return (
    <Pressable
      style={[styles.segmentBtn, active && styles.segmentBtnActive]}
      onPress={handlePress}
      testID={`forge-issue-state-${value}`}
    >
      <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{label}</Text>
    </Pressable>
  );
}

function IssueDetail({
  client,
  repo,
  issue,
  onBack,
  onChanged,
}: {
  client: DaemonClient;
  repo: ForgeRepo;
  issue: ForgeIssue;
  onBack: () => void;
  onChanged: () => void;
}) {
  const { theme } = useUnistyles();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const handleOpenExternal = useCallback(() => void openExternalUrl(issue.url), [issue.url]);

  const submitComment = useCallback(async () => {
    const body = comment.trim();
    if (!body) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await client.forgeCommentIssue({
        repo: repoRef(repo),
        number: issue.number,
        body,
      });
      if (res.ok) {
        setComment("");
        setNote("Comment posted.");
        onChanged();
      } else {
        setNote("The comment could not be posted.");
      }
    } catch (e: unknown) {
      setNote(e instanceof Error ? e.message : "The comment could not be posted.");
    } finally {
      setBusy(false);
    }
  }, [comment, client, repo, issue.number, onChanged]);

  const closeIssue = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await client.forgeCloseIssue({ repo: repoRef(repo), number: issue.number });
      if (res.ok) {
        setNote("Issue closed.");
        onChanged();
      } else {
        setNote("The issue could not be closed.");
      }
    } catch (e: unknown) {
      setNote(e instanceof Error ? e.message : "The issue could not be closed.");
    } finally {
      setBusy(false);
    }
  }, [client, repo, issue.number, onChanged]);

  const canComment = comment.trim().length > 0 && !busy;

  return (
    <View style={styles.pane}>
      <View style={styles.detailHeader}>
        <Pressable
          style={styles.iconBtn}
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back to issues"
          testID="forge-issue-back"
        >
          <ArrowLeft size={18} color={theme.colors.foregroundMuted} />
        </Pressable>
        <View style={styles.rowInfo}>
          <Text style={styles.rowTitle} numberOfLines={2}>
            {issue.title}
          </Text>
          <Text style={styles.rowSubMono} numberOfLines={1}>
            {repo.owner}/{repo.name} · #{issue.number}
          </Text>
        </View>
        <Chip
          label={issue.state === "open" ? "Open" : "Closed"}
          color={issueStateColor(issue.state, theme)}
        />
        <Pressable
          style={[styles.btn, styles.btnGhost]}
          onPress={handleOpenExternal}
          testID="forge-issue-open-external"
        >
          <ExternalLink size={13} color={theme.colors.foreground} />
          <Text style={styles.btnGhostText}>Open</Text>
        </Pressable>
      </View>

      <View style={styles.mergebox}>
        <View style={styles.mergeboxBody}>
          <Text style={styles.fieldLabel}>Add a comment</Text>
          <TextInput
            style={styles.textArea}
            value={comment}
            onChangeText={setComment}
            placeholder="Leave a comment"
            placeholderTextColor={theme.colors.foregroundExtraMuted}
            multiline
            editable={!busy}
            testID="forge-issue-comment-body"
          />
          <View style={styles.formActions}>
            <Pressable
              style={[styles.btn, styles.btnPrimary, !canComment && styles.btnDisabled]}
              onPress={submitComment}
              disabled={!canComment}
              testID="forge-issue-comment-submit"
            >
              <Text style={styles.btnPrimaryText}>{busy ? "Posting…" : "Comment"}</Text>
            </Pressable>
            {issue.state === "open" ? (
              <Pressable
                style={[styles.btn, styles.btnDanger, busy && styles.btnDisabled]}
                onPress={closeIssue}
                disabled={busy}
                testID="forge-issue-close"
              >
                <Ban size={13} color={theme.colors.statusDanger} />
                <Text style={styles.btnDangerText}>Close issue</Text>
              </Pressable>
            ) : null}
          </View>
          {note ? <Text style={styles.mergeReason}>{note}</Text> : null}
        </View>
      </View>
    </View>
  );
}

function IssuesView({ client, repo }: { client: DaemonClient; repo: ForgeRepo }) {
  const { theme } = useUnistyles();
  const [state, setState] = useState<IssueState>("open");
  const [issues, setIssues] = useState<ForgeIssue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ForgeIssue | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);
  const limitRef = useRef(limit);
  limitRef.current = limit;

  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createNote, setCreateNote] = useState<string | null>(null);

  const load = useCallback(
    // `silent` keeps the list on screen for a load-more (spinner on the button).
    async (nextState: IssueState, force = false, silent = false) => {
      const key = `issues:${repoCacheKey(repo)}:${nextState}`;
      if (force) cacheDelete(key);
      else {
        const cached = cacheGet<ForgeIssue[]>(key);
        if (cached) {
          setIssues(cached);
          setError(null);
          return;
        }
      }
      setError(null);
      if (!silent) setIssues(null);
      try {
        const res = await client.forgeListIssues({
          repo: repoRef(repo),
          state: nextState,
          limit: limitRef.current,
        });
        const parsed = ForgeIssueSchema.array().safeParse(res.issues);
        setIssues(parsed.success ? parsed.data : []);
        if (!parsed.success) setError("Unable to load issues.");
        else cacheSet(key, parsed.data);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Unable to load issues.");
      }
    },
    [client, repo],
  );

  useEffect(() => {
    void load(state);
  }, [load, state]);

  // Switching state starts pagination fresh (reset before the load effect runs).
  const handleChangeState = useCallback((next: IssueState) => {
    limitRef.current = PAGE_SIZE;
    setLimit(PAGE_SIZE);
    setState(next);
  }, []);
  const loadMoreIssues = useCallback(async () => {
    setLoadingMore(true);
    const next = limitRef.current + PAGE_SIZE;
    limitRef.current = next;
    setLimit(next);
    try {
      await load(state, true, true);
    } finally {
      setLoadingMore(false);
    }
  }, [load, state]);
  const toggleCreating = useCallback(() => setCreating((v) => !v), []);
  const openIssue = useCallback((issue: ForgeIssue) => setSelected(issue), []);
  const backToList = useCallback(() => setSelected(null), []);
  const refreshList = useCallback(() => void load(state, true), [load, state]);
  // A write from the detail view invalidates the cached list, so force a refetch.
  const refresh = useCallback(() => {
    setSelected(null);
    void load(state, true);
  }, [load, state]);

  const submitCreate = useCallback(async () => {
    const t = title.trim();
    if (!t) return;
    setCreateBusy(true);
    setCreateNote(null);
    try {
      const res = await client.forgeCreateIssue({
        repo: repoRef(repo),
        title: t,
        body: body.trim() || undefined,
      });
      if (res.issue) {
        setTitle("");
        setBody("");
        setCreating(false);
        void load(state, true);
      } else {
        setCreateNote("The issue could not be created.");
      }
    } catch (e: unknown) {
      setCreateNote(e instanceof Error ? e.message : "The issue could not be created.");
    } finally {
      setCreateBusy(false);
    }
  }, [title, body, client, repo, state, load]);

  if (selected) {
    return (
      <IssueDetail
        client={client}
        repo={repo}
        issue={selected}
        onBack={backToList}
        onChanged={refresh}
      />
    );
  }

  const canCreate = title.trim().length > 0 && !createBusy;

  return (
    <View style={styles.pane}>
      <View style={styles.toolbarRow}>
        <Text style={styles.rowTitleMono} numberOfLines={1}>
          {repo.owner}/{repo.name}
        </Text>
        <View style={styles.grow} />
        <Pressable
          style={[styles.btn, styles.btnGhost]}
          onPress={refreshList}
          testID="forge-issues-refresh"
        >
          <RotateCcw size={13} color={theme.colors.foreground} />
          <Text style={styles.btnGhostText}>Refresh</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnPrimary]}
          onPress={toggleCreating}
          testID="forge-issue-new"
        >
          <Plus size={14} color={theme.colors.accentForeground} />
          <Text style={styles.btnPrimaryText}>New issue</Text>
        </Pressable>
      </View>

      {creating ? (
        <View style={styles.formCard}>
          <Text style={styles.formTitle}>New issue</Text>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Title</Text>
            <TextInput
              style={styles.input}
              value={title}
              onChangeText={setTitle}
              placeholder="Issue title"
              placeholderTextColor={theme.colors.foregroundExtraMuted}
              editable={!createBusy}
              testID="forge-issue-title-input"
            />
          </View>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Description (optional)</Text>
            <TextInput
              style={styles.textArea}
              value={body}
              onChangeText={setBody}
              placeholder="Describe the issue"
              placeholderTextColor={theme.colors.foregroundExtraMuted}
              multiline
              editable={!createBusy}
              testID="forge-issue-body-input"
            />
          </View>
          <View style={styles.formActions}>
            <Pressable
              style={[styles.btn, styles.btnPrimary, !canCreate && styles.btnDisabled]}
              onPress={submitCreate}
              disabled={!canCreate}
              testID="forge-issue-create-submit"
            >
              <Text style={styles.btnPrimaryText}>{createBusy ? "Creating…" : "Create issue"}</Text>
            </Pressable>
            <Pressable style={[styles.btn, styles.btnGhost]} onPress={toggleCreating}>
              <Text style={styles.btnGhostText}>Cancel</Text>
            </Pressable>
          </View>
          {createNote ? <Text style={styles.reviewError}>{createNote}</Text> : null}
        </View>
      ) : null}

      <View style={styles.segmented}>
        {ISSUE_STATES.map((s) => (
          <IssueStateFilterButton
            key={s}
            value={s}
            active={state === s}
            onChange={handleChangeState}
          />
        ))}
      </View>

      {error ? (
        <View style={styles.errorBanner}>
          <CircleAlert size={16} color={theme.colors.statusDanger} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {issues === null ? (
        <SkeletonRows />
      ) : issues.length === 0 ? (
        <Text style={styles.emptyText}>No issues here yet.</Text>
      ) : (
        <>
          <View style={styles.card}>
            {issues.map((issue) => (
              <IssueRow key={issue.number} issue={issue} onOpen={openIssue} />
            ))}
          </View>
          {issues.length >= limit ? (
            <LoadMoreButton
              loading={loadingMore}
              onPress={loadMoreIssues}
              testID="forge-issues-load-more"
            />
          ) : null}
        </>
      )}
    </View>
  );
}

// ===== sub-nav =============================================================

function SubNavButton({
  label,
  value,
  active,
  onSelect,
  Icon,
}: {
  label: string;
  value: SubNav;
  active: boolean;
  onSelect: (value: SubNav) => void;
  Icon: ComponentType<{ size?: number; color?: string }>;
}) {
  const { theme } = useUnistyles();
  const handlePress = useCallback(() => onSelect(value), [value, onSelect]);
  const tint = active ? theme.colors.accentForeground : theme.colors.foregroundMuted;
  return (
    <Pressable
      style={[styles.subNavPill, active && styles.subNavPillActive]}
      onPress={handlePress}
      testID={`forge-subnav-${value}`}
    >
      <Icon size={14} color={tint} />
      <Text style={[styles.subNavText, active && styles.subNavTextActive]}>{label}</Text>
    </Pressable>
  );
}

// ===== screen root =========================================================

export function ForgeHubScreen() {
  const { theme } = useUnistyles();
  const routeServerId = useHostRouteServerId();
  const hosts = useHosts();
  const serverId = routeServerId ?? hosts[0]?.serverId ?? "";
  const client = useHostRuntimeClient(serverId);
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();

  // Milestone-B feature gates (§19.12): only show/enable each section when its
  // host feature flag is advertised.
  const codeEnabled = useHostFeature(serverId, "forgeHubCode");
  const reviewEnabled = useHostFeature(serverId, "forgeHubReview");
  const pipelinesEnabled = useHostFeature(serverId, "forgeHubPipelines");
  const releasesEnabled = useHostFeature(serverId, "forgeHubReleases");
  const issuesEnabled = useHostFeature(serverId, "forgeHubIssues");
  // Milestone C (§19.3.5, ADR-0016): guided forge-CLI detect + auto-install.
  const cliInstallEnabled = useHostFeature(serverId, "forgeHubCliInstall");
  // §19.3.7: in-app device-flow sign-in for cli-method providers.
  const loginEnabled = useHostFeature(serverId, "forgeHubLogin");

  const [tab, setTab] = useState<SubNav>("connections");
  const [connections, setConnections] = useState<ForgeConnection[]>([]);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const [repos, setRepos] = useState<ForgeRepo[]>([]);
  const [reposLoaded, setReposLoaded] = useState(false);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  const [reposLimit, setReposLimit] = useState(PAGE_SIZE);
  const [reposLoadingMore, setReposLoadingMore] = useState(false);
  const reposLimitRef = useRef(reposLimit);
  reposLimitRef.current = reposLimit;

  const [selectedRepo, setSelectedRepo] = useState<ForgeRepo | null>(null);
  const [crState, setCrState] = useState<CrState>("open");
  const [changeRequests, setChangeRequests] = useState<ForgeChangeRequestSummary[]>([]);
  const [crLoading, setCrLoading] = useState(false);
  const [crError, setCrError] = useState<string | null>(null);
  const [newCrOpen, setNewCrOpen] = useState(false);
  const [crLimit, setCrLimit] = useState(PAGE_SIZE);
  const [crLoadingMore, setCrLoadingMore] = useState(false);
  const crLimitRef = useRef(crLimit);
  crLimitRef.current = crLimit;

  const [selectedCr, setSelectedCr] = useState<ForgeChangeRequestSummary | null>(null);
  const [files, setFiles] = useState<ForgeChangeRequestFile[] | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);

  const refreshConnections = useCallback(async () => {
    if (!client) return;
    setConnectionsError(null);
    try {
      const res = await client.forgeListConnections();
      setConnections(res.connections);
    } catch (e: unknown) {
      setConnectionsError(e instanceof Error ? e.message : "Failed to load connections.");
    }
  }, [client]);

  useEffect(() => {
    void refreshConnections();
  }, [refreshConnections]);

  const loadRepos = useCallback(
    async (silent = false) => {
      if (!client) return;
      if (!silent) setReposLoading(true);
      setReposError(null);
      try {
        const res = await client.forgeListRepos({ limit: reposLimitRef.current });
        const parsed = ForgeRepoSchema.array().safeParse(res.repos);
        setRepos(parsed.success ? parsed.data : []);
        if (!parsed.success) setReposError("Unable to load repositories.");
        setReposLoaded(true);
      } catch (e: unknown) {
        setReposError(e instanceof Error ? e.message : "Unable to load repositories.");
      } finally {
        if (!silent) setReposLoading(false);
      }
    },
    [client],
  );

  const loadMoreRepos = useCallback(async () => {
    setReposLoadingMore(true);
    const next = reposLimitRef.current + PAGE_SIZE;
    reposLimitRef.current = next;
    setReposLimit(next);
    try {
      await loadRepos(true);
    } finally {
      setReposLoadingMore(false);
    }
  }, [loadRepos]);

  useEffect(() => {
    if (tab === "repositories" && !reposLoaded && !reposLoading) {
      void loadRepos();
    }
  }, [tab, reposLoaded, reposLoading, loadRepos]);

  const loadChangeRequests = useCallback(
    // `silent` keeps the list on screen for a load-more (spinner on the button).
    async (repo: ForgeRepo, state: CrState, force = false, silent = false) => {
      if (!client) return;
      const key = `crlist:${repoCacheKey(repo)}:${state}`;
      if (force) cacheDelete(key);
      else {
        const cached = cacheGet<ForgeChangeRequestSummary[]>(key);
        if (cached) {
          setChangeRequests(cached);
          setCrError(null);
          setCrLoading(false);
          return;
        }
      }
      if (!silent) setCrLoading(true);
      setCrError(null);
      try {
        const res = await client.forgeListChangeRequests({
          repo: { forge: repo.forge, owner: repo.owner, name: repo.name },
          state,
          limit: crLimitRef.current,
        });
        const parsed = ForgeChangeRequestSummarySchema.array().safeParse(res.changeRequests);
        setChangeRequests(parsed.success ? parsed.data : []);
        if (!parsed.success) {
          setCrError(
            `Unable to load ${getForgeDefinitionOrNeutral(repo.forge).changeRequestNoun} list.`,
          );
        } else {
          cacheSet(key, parsed.data);
        }
      } catch (e: unknown) {
        setCrError(
          e instanceof Error
            ? e.message
            : `Unable to load ${getForgeDefinitionOrNeutral(repo.forge).changeRequestNoun} list.`,
        );
      } finally {
        if (!silent) setCrLoading(false);
      }
    },
    [client],
  );

  const loadMoreChangeRequests = useCallback(async () => {
    if (!selectedRepo) return;
    setCrLoadingMore(true);
    const next = crLimitRef.current + PAGE_SIZE;
    crLimitRef.current = next;
    setCrLimit(next);
    try {
      await loadChangeRequests(selectedRepo, crState, true, true);
    } finally {
      setCrLoadingMore(false);
    }
  }, [selectedRepo, crState, loadChangeRequests]);

  const handleOpenRepo = useCallback(
    (repo: ForgeRepo) => {
      setSelectedRepo(repo);
      setSelectedCr(null);
      setNewCrOpen(false);
      setCrState("open");
      // A different repo starts the PR/MR list fresh.
      crLimitRef.current = PAGE_SIZE;
      setCrLimit(PAGE_SIZE);
      setTab(codeEnabled ? "code" : "pulls");
      void loadChangeRequests(repo, "open");
    },
    [loadChangeRequests, codeEnabled],
  );

  const handleChangeState = useCallback(
    (state: CrState) => {
      setCrState(state);
      // A different state starts the PR/MR list fresh.
      crLimitRef.current = PAGE_SIZE;
      setCrLimit(PAGE_SIZE);
      if (selectedRepo) void loadChangeRequests(selectedRepo, state);
    },
    [selectedRepo, loadChangeRequests],
  );

  const handleOpenCr = useCallback((cr: ForgeChangeRequestSummary) => {
    setSelectedCr(cr);
    setNewCrOpen(false);
    setFiles(null);
    setFilesError(null);
  }, []);

  const loadFiles = useCallback(async () => {
    if (!client || !selectedRepo || !selectedCr) return;
    setFilesLoading(true);
    setFilesError(null);
    try {
      const res = await client.forgeGetChangeRequestFiles({
        repo: { forge: selectedRepo.forge, owner: selectedRepo.owner, name: selectedRepo.name },
        number: selectedCr.number,
      });
      const parsed = ForgeChangeRequestFileSchema.array().safeParse(res.files);
      setFiles(parsed.success ? parsed.data : []);
      if (!parsed.success) setFilesError("Unable to load changed files.");
    } catch (e: unknown) {
      setFilesError(e instanceof Error ? e.message : "Unable to load changed files.");
    } finally {
      setFilesLoading(false);
    }
  }, [client, selectedRepo, selectedCr]);

  // Refresh the open PR/MR summary after a write action (review/merge, §19.6.4).
  const refreshCrSummary = useCallback(async () => {
    if (!client || !selectedRepo || !selectedCr) return;
    try {
      const res = await client.forgeListChangeRequests({
        repo: repoRef(selectedRepo),
        state: "all",
      });
      const parsed = ForgeChangeRequestSummarySchema.array().safeParse(res.changeRequests);
      if (!parsed.success) return;
      // A review/merge changed the CR: drop every cached list state for this repo
      // so revisiting refetches fresh, then reflect the update in place.
      cacheDeletePrefix(`crlist:${repoCacheKey(selectedRepo)}:`);
      setChangeRequests(parsed.data);
      const match = parsed.data.find((c) => c.number === selectedCr.number);
      if (match) setSelectedCr(match);
    } catch {
      // Non-fatal: the action already succeeded; the summary just stays stale.
    }
  }, [client, selectedRepo, selectedCr]);

  const handleAddConnection = useCallback(
    async (input: { forge: string; host?: string; method: "cli" | "token"; token?: string }) => {
      if (!client) return;
      setConnectionsError(null);
      try {
        await client.forgeAddConnection(input);
        setAdding(false);
        await refreshConnections();
      } catch (e: unknown) {
        setConnectionsError(e instanceof Error ? e.message : "Failed to add connection.");
      }
    },
    [client, refreshConnections],
  );

  const handleRemoveConnection = useCallback(
    (id: string) => {
      if (!client) return;
      setConnectionsError(null);
      return client
        .forgeRemoveConnection(id)
        .then(() => refreshConnections())
        .catch((e: unknown) =>
          setConnectionsError(e instanceof Error ? e.message : "Failed to remove connection."),
        );
    },
    [client, refreshConnections],
  );

  const toggleAdding = useCallback(() => setAdding((v) => !v), []);
  const handleBackToList = useCallback(() => setSelectedCr(null), []);
  const handleRetryRepos = useCallback(() => void loadRepos(), [loadRepos]);
  const refreshCrList = useCallback(() => {
    if (selectedRepo) void loadChangeRequests(selectedRepo, crState, true);
  }, [selectedRepo, crState, loadChangeRequests]);

  const openNewCr = useCallback(() => setNewCrOpen(true), []);
  const closeNewCr = useCallback(() => setNewCrOpen(false), []);
  const handleCrCreated = useCallback(
    (url: string | null) => {
      if (selectedRepo) {
        // Drop every cached list state for this repo so revisiting refetches, then
        // reload the current state list in place.
        cacheDeletePrefix(`crlist:${repoCacheKey(selectedRepo)}`);
        void loadChangeRequests(selectedRepo, crState, true);
      }
      setNewCrOpen(false);
      if (url) void openExternalUrl(url);
    },
    [selectedRepo, crState, loadChangeRequests],
  );

  const contentContainerStyle = useMemo(
    () => [styles.contentContainer, isCompact ? { paddingTop: insets.top } : null],
    [isCompact, insets.top],
  );

  const hasConnections = connections.length > 0;

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <GitPullRequest size={20} color={theme.colors.foreground} />
        <Text style={styles.header}>Forge Hub</Text>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.subNavRow}
        contentContainerStyle={styles.subNavContent}
      >
        <SubNavButton
          label="Connections"
          value="connections"
          active={tab === "connections"}
          onSelect={setTab}
          Icon={Plug}
        />
        <SubNavButton
          label="Repositories"
          value="repositories"
          active={tab === "repositories"}
          onSelect={setTab}
          Icon={FolderGit2}
        />
        {codeEnabled ? (
          <SubNavButton
            label="Code"
            value="code"
            active={tab === "code"}
            onSelect={setTab}
            Icon={Code}
          />
        ) : null}
        {codeEnabled ? (
          <SubNavButton
            label="Commits"
            value="commits"
            active={tab === "commits"}
            onSelect={setTab}
            Icon={GitCommit}
          />
        ) : null}
        <SubNavButton
          label="Pull requests"
          value="pulls"
          active={tab === "pulls"}
          onSelect={setTab}
          Icon={GitPullRequest}
        />
        {pipelinesEnabled ? (
          <SubNavButton
            label="Pipelines"
            value="pipelines"
            active={tab === "pipelines"}
            onSelect={setTab}
            Icon={Play}
          />
        ) : null}
        {releasesEnabled ? (
          <SubNavButton
            label="Releases"
            value="releases"
            active={tab === "releases"}
            onSelect={setTab}
            Icon={Tag}
          />
        ) : null}
        {issuesEnabled ? (
          <SubNavButton
            label="Issues"
            value="issues"
            active={tab === "issues"}
            onSelect={setTab}
            Icon={CircleDot}
          />
        ) : null}
      </ScrollView>

      {connectionsError ? (
        <View style={styles.errorBanner}>
          <CircleAlert size={16} color={theme.colors.statusDanger} />
          <Text style={styles.errorText}>{connectionsError}</Text>
        </View>
      ) : null}

      <ScrollView style={styles.scroll} contentContainerStyle={contentContainerStyle}>
        {tab === "connections" ? (
          <ConnectionsView
            connections={connections}
            onRemove={handleRemoveConnection}
            onAdd={handleAddConnection}
            adding={adding}
            onToggleAdd={toggleAdding}
            client={client}
            cliInstallEnabled={cliInstallEnabled}
            loginEnabled={loginEnabled}
            onLoggedIn={refreshConnections}
          />
        ) : null}

        {tab === "repositories" ? (
          !hasConnections ? (
            <Text style={styles.emptyText}>{CONNECTION_EMPTY_STATE}</Text>
          ) : (
            <RepositoriesView
              repos={repos}
              loading={reposLoading}
              error={reposError}
              limit={reposLimit}
              loadingMore={reposLoadingMore}
              onLoadMore={loadMoreRepos}
              onOpen={handleOpenRepo}
              onRetry={handleRetryRepos}
            />
          )
        ) : null}

        {tab === "pulls" ? (
          !hasConnections ? (
            <Text style={styles.emptyText}>{CONNECTION_EMPTY_STATE}</Text>
          ) : !selectedRepo ? (
            <Text style={styles.emptyText}>
              Pick a repository from the Repositories tab to view its pull requests.
            </Text>
          ) : selectedCr && client ? (
            <PullRequestDetail
              client={client}
              repo={selectedRepo}
              cr={selectedCr}
              files={files}
              filesLoading={filesLoading}
              filesError={filesError}
              reviewEnabled={reviewEnabled}
              pipelinesEnabled={pipelinesEnabled}
              onBack={handleBackToList}
              onLoadFiles={loadFiles}
              onReviewed={refreshCrSummary}
            />
          ) : (
            <View style={styles.pane}>
              <View style={styles.toolbarRow}>
                <Text style={styles.rowTitleMono} numberOfLines={1}>
                  {selectedRepo.owner}/{selectedRepo.name}
                </Text>
                <View style={styles.grow} />
                {reviewEnabled ? (
                  <Pressable
                    style={[styles.btn, styles.btnPrimary]}
                    onPress={openNewCr}
                    testID="forge-new-cr"
                  >
                    <Plus size={14} color={theme.colors.accentForeground} />
                    <Text style={styles.btnPrimaryText}>
                      New {getForgeDefinitionOrNeutral(selectedRepo.forge).changeRequestAbbrev}
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable
                  style={[styles.btn, styles.btnGhost]}
                  onPress={refreshCrList}
                  testID="forge-cr-refresh"
                >
                  <RotateCcw size={13} color={theme.colors.foreground} />
                  <Text style={styles.btnGhostText}>Refresh</Text>
                </Pressable>
              </View>
              {reviewEnabled && newCrOpen && client ? (
                <NewChangeRequestForm
                  client={client}
                  repo={selectedRepo}
                  onCreated={handleCrCreated}
                  onCancel={closeNewCr}
                />
              ) : null}
              <StateFilter state={crState} onChange={handleChangeState} />
              {crError ? (
                <View style={styles.errorBanner}>
                  <CircleAlert size={16} color={theme.colors.statusDanger} />
                  <Text style={styles.errorText}>{crError}</Text>
                </View>
              ) : null}
              {crLoading ? (
                <SkeletonRows />
              ) : changeRequests.length === 0 ? (
                <Text style={styles.emptyText}>Nothing here yet.</Text>
              ) : (
                <>
                  <View style={styles.card}>
                    {changeRequests.map((cr) => (
                      <PullRequestRow
                        key={cr.number}
                        cr={cr}
                        forge={selectedRepo.forge}
                        onOpen={handleOpenCr}
                      />
                    ))}
                  </View>
                  {changeRequests.length >= crLimit ? (
                    <LoadMoreButton
                      loading={crLoadingMore}
                      onPress={loadMoreChangeRequests}
                      testID="forge-cr-load-more"
                    />
                  ) : null}
                </>
              )}
            </View>
          )
        ) : null}

        {tab === "code" && codeEnabled ? (
          !hasConnections ? (
            <Text style={styles.emptyText}>{CONNECTION_EMPTY_STATE}</Text>
          ) : !selectedRepo || !client ? (
            <Text style={styles.emptyText}>
              Pick a repository from the Repositories tab to browse its code.
            </Text>
          ) : (
            <CodeView client={client} repo={selectedRepo} />
          )
        ) : null}

        {tab === "commits" && codeEnabled ? (
          !hasConnections ? (
            <Text style={styles.emptyText}>{CONNECTION_EMPTY_STATE}</Text>
          ) : !selectedRepo || !client ? (
            <Text style={styles.emptyText}>
              Pick a repository from the Repositories tab to view its commits.
            </Text>
          ) : (
            <CommitsView client={client} repo={selectedRepo} />
          )
        ) : null}

        {tab === "pipelines" && pipelinesEnabled ? (
          !hasConnections ? (
            <Text style={styles.emptyText}>{CONNECTION_EMPTY_STATE}</Text>
          ) : !selectedRepo || !client ? (
            <Text style={styles.emptyText}>
              Pick a repository from the Repositories tab to view its pipelines.
            </Text>
          ) : (
            <PipelinesView client={client} repo={selectedRepo} releasesEnabled={releasesEnabled} />
          )
        ) : null}

        {tab === "releases" && releasesEnabled ? (
          !hasConnections ? (
            <Text style={styles.emptyText}>{CONNECTION_EMPTY_STATE}</Text>
          ) : !selectedRepo || !client ? (
            <Text style={styles.emptyText}>
              Pick a repository from the Repositories tab to view its releases.
            </Text>
          ) : (
            <ReleasesView client={client} repo={selectedRepo} />
          )
        ) : null}

        {tab === "issues" && issuesEnabled ? (
          !hasConnections ? (
            <Text style={styles.emptyText}>{CONNECTION_EMPTY_STATE}</Text>
          ) : !selectedRepo || !client ? (
            <Text style={styles.emptyText}>
              Pick a repository from the Repositories tab to view its issues.
            </Text>
          ) : (
            <IssuesView client={client} repo={selectedRepo} />
          )
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  contentContainer: {
    padding: theme.spacing[4],
    flexGrow: 1,
    gap: theme.spacing[3],
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
  },
  header: {
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  subNavRow: {
    flexGrow: 0,
    flexShrink: 0,
    paddingTop: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  subNavContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  subNavPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: "transparent",
  },
  subNavPillActive: {
    backgroundColor: theme.colors.accent,
  },
  subNavText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  subNavTextActive: {
    color: theme.colors.accentForeground,
    fontWeight: theme.fontWeight.semibold,
  },
  // skeleton loaders
  skeletonRow: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  skeletonRowCompact: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  skeletonBarTitle: {
    height: 10,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  skeletonBarSub: {
    height: 8,
    width: "34%",
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  pane: {
    gap: theme.spacing[3],
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  sectionTitle: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  toolbarRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexWrap: "wrap",
    // Establish a stacking context above the content that follows in the pane so
    // the branch picker's absolute dropdown isn't painted under the commit list.
    position: "relative",
    zIndex: 30,
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
  card: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  rowInfo: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  rowTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  rowTitleMono: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
  },
  rowSub: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  rowSubMono: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
  },
  crMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  metaMono: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
  },
  metaMuted: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  metaWhen: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
    width: 72,
    textAlign: "right",
  },
  repoTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  chipDot: {
    width: 7,
    height: 7,
    borderRadius: theme.borderRadius.full,
  },
  chipText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  plainChip: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 1,
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  plainChipText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  badge: {
    width: 26,
    height: 26,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    fontSize: 11,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  iconBtn: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginHorizontal: theme.spacing[4],
    marginTop: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.palette.red[100],
  },
  errorText: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.red[800],
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  btnPrimary: {
    backgroundColor: theme.colors.accent,
  },
  btnPrimaryText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.accentForeground,
  },
  btnGhost: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  btnGhostText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  // Full-width "Load more" beneath a list; taller tap target, centered content.
  loadMoreBtn: {
    alignSelf: "stretch",
    justifyContent: "center",
    paddingVertical: theme.spacing[2],
  },
  // form
  formCard: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[4],
    gap: theme.spacing[4],
  },
  formHeader: {
    gap: theme.spacing[1],
  },
  formTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  formTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  formSubtitle: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  formDivider: {
    height: 1,
    backgroundColor: theme.colors.border,
    marginVertical: theme.spacing[1],
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  providerGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  providerCard: {
    flexDirection: "column",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    minWidth: 104,
    flexGrow: 1,
    flexBasis: 0,
  },
  providerCardActive: {
    borderColor: theme.colors.accent,
    borderWidth: 2,
    // Compensate the +1 border so the card doesn't shift when selected.
    paddingVertical: theme.spacing[3] - 1,
    paddingHorizontal: theme.spacing[3] - 1,
    backgroundColor: theme.colors.surface2,
  },
  providerCardLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  providerCardLabelActive: {
    color: theme.colors.foreground,
  },
  providerGlyph: {
    width: 26,
    height: 26,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  providerChip: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  providerChipActive: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accent,
  },
  providerChipText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  providerChipTextActive: {
    color: theme.colors.accentForeground,
  },
  field: {
    gap: theme.spacing[1],
  },
  fieldLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  fieldLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  input: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  hintBox: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface0,
  },
  hintTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  hintBody: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  hintMono: {
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.accentBright,
    marginTop: theme.spacing[1],
  },
  formActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  // CLI detect + guided auto-install (§19.3.5)
  cliSection: {
    gap: theme.spacing[2],
  },
  cliDetected: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.statusSuccess,
  },
  cliChecking: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  cliMissingBox: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  cliMissingText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  cliProgressWrap: {
    gap: theme.spacing[1],
  },
  cliProgressTrack: {
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  cliProgressFill: {
    height: "100%",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
  },
  cliProgressIndicator: {
    position: "absolute",
    left: 0,
    top: 0,
  },
  cliProgressPhase: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  cliProgressLog: {
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundExtraMuted,
  },
  cliInstallError: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusDanger,
  },
  cliManualHint: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
  },
  // In-app device-flow sign-in (§19.3.7)
  loginBox: {
    gap: theme.spacing[2],
    alignItems: "flex-start",
  },
  loginStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  loginStatusText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  loginCodeWrap: {
    gap: theme.spacing[2],
    alignSelf: "stretch",
  },
  loginCodeInstruction: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  loginCardTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  loginCodeBox: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface0,
  },
  loginWaitRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  loginActionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  loginActionBtn: {
    flexGrow: 1,
    flexBasis: 0,
  },
  loginCode: {
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.semibold,
    fontFamily: theme.fontFamily.mono,
    letterSpacing: 2,
    color: theme.colors.foreground,
  },
  loginCopyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  loginCopyText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  loginSuccess: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.statusSuccess,
  },
  loginError: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusDanger,
  },
  // search
  searchField: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    maxWidth: 360,
    height: 36,
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    // Drop the browser's default focus ring; the searchField border is the
    // only affordance. RN native ignores these web-only properties.
    ...(isWeb
      ? ({
          outlineStyle: "none",
          outlineWidth: 0,
          outlineColor: "transparent",
        } as object)
      : {}),
  },
  // segmented state filter
  segmented: {
    flexDirection: "row",
    alignSelf: "flex-start",
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    overflow: "hidden",
  },
  segmentBtn: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRightWidth: theme.borderWidth[1],
    borderRightColor: theme.colors.borderAccent,
  },
  segmentBtnActive: {
    backgroundColor: theme.colors.surface3,
  },
  segmentText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  segmentTextActive: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  // detail
  detailHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  tabsRow: {
    flexDirection: "row",
    gap: theme.spacing[1],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: {
    borderBottomColor: theme.colors.accent,
  },
  tabText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  tabTextActive: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
  tabCount: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[1.5],
    borderRadius: theme.borderRadius.full,
    overflow: "hidden",
  },
  metaGrid: {
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  metaRow: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  metaKey: {
    width: 90,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
  },
  metaVal: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  metaValMono: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
  },
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  summaryInline: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  filesPane: {
    gap: theme.spacing[3],
  },
  fileCard: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  fileHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  fileName: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    flexShrink: 1,
  },
  fileEmpty: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    padding: theme.spacing[3],
    fontStyle: "italic",
  },
  diffAdd: {
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.diffAddition,
  },
  diffDel: {
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.diffDeletion,
  },
  // ===== Milestone B =====
  btnDisabled: {
    opacity: 0.5,
  },
  btnDanger: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface1,
  },
  btnDangerText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.statusDanger,
  },
  // review + merge boxes
  mergebox: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  mergeboxHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  mergeboxTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  mergeboxBody: {
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  reviewActionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  reviewSheet: {
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  textArea: {
    minHeight: 72,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    textAlignVertical: "top",
  },
  reviewError: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusDanger,
  },
  mergeBtn: {
    justifyContent: "center",
    paddingVertical: theme.spacing[2],
  },
  mergeResultOk: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusSuccess,
  },
  mergeReason: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  // branch picker
  branchPicker: {
    position: "relative",
    zIndex: 10,
  },
  branchSheet: {
    position: "absolute",
    top: 40,
    left: 0,
    // Fixed width: the old maxWidth:"90%" resolved against the narrow picker
    // button box, squeezing the sheet to ~100px and truncating branch names.
    width: 300,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    zIndex: 20,
  },
  branchList: {
    maxHeight: 260,
  },
  branchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  branchRowActive: {
    backgroundColor: theme.colors.surface2,
  },
  branchName: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
  },
  // pipeline run detail
  runSplit: {
    flexDirection: "row",
    gap: theme.spacing[3],
    minHeight: 0,
  },
  jobTree: {
    width: 260,
    flexShrink: 0,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[2],
  },
  stageHeader: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  jobRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  jobRowActive: {
    backgroundColor: theme.colors.surface2,
  },
  jobName: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  logColumn: {
    flex: 1,
    minWidth: 0,
  },
  logPane: {
    gap: theme.spacing[2],
  },
  logHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  // Pipeline job-log surface: a terminal-like panel. Logs are long streams, so
  // this stays scroll-capped (unlike the file viewer, which grows inline).
  logSurface: {
    maxHeight: 480,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  // Read-only file viewer (§19). Box chrome + font for HighlightedCodeBlock,
  // which paints these onto its own wrapper. No maxHeight: the block renders
  // inline and grows with the file so the outer ScrollView owns vertical scroll.
  codeBlockText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surfaceSidebar,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  logContent: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  logText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: Math.round(theme.fontSize.code * 1.6),
    color: theme.colors.foregroundMuted,
  },
  logTruncated: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusWarning,
    marginBottom: theme.spacing[2],
  },
  // ===== Milestone C =====
  // auto-merge toggle
  autoMergeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: theme.borderRadius.sm,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accent,
  },
  autoMergeLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  // releases + tags
  releaseCard: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  releaseHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  assetList: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  assetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  assetName: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
  },
  releaseNotes: {
    padding: theme.spacing[3],
  },
  // New change-request form: base/head pickers side by side. Each picker owns an
  // absolute dropdown, so the row keeps a stacking context above the fields below.
  crBranchRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    zIndex: 20,
  },
  crBranchField: {
    flex: 1,
    minWidth: 140,
    gap: theme.spacing[1],
    position: "relative",
  },
  // ===== code (file tree browser) =====
  breadcrumb: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
  },
  crumbWrap: {
    flexDirection: "row",
    alignItems: "center",
  },
  crumb: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.accent,
    fontFamily: theme.fontFamily.mono,
  },
  crumbActive: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
  crumbSep: {
    marginHorizontal: theme.spacing[1],
  },
  treeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  treeName: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
  },
  fileViewerHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
