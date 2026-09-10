import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  ArrowLeft,
  Ban,
  Check,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  GitBranch,
  GitCompare,
  GitPullRequest,
  MessageSquare,
  Play,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ForgeBranchSchema,
  ForgeChangeRequestFileSchema,
  ForgeChangeRequestSummarySchema,
  ForgeCommitSchema,
  ForgePipelineDetailSchema,
  ForgePipelineRunSchema,
  ForgeRepoSchema,
  type ForgeBranch,
  type ForgeChangeRequestFile,
  type ForgeChangeRequestSummary,
  type ForgeCommit,
  type ForgeConnection,
  type ForgePipelineDetail,
  type ForgePipelineJob,
  type ForgePipelineRun,
  type ForgeRepo,
  type ForgeRepoRef,
  type ForgeReviewAction,
  type ForgeMergeMethod,
} from "@jagentdesk/protocol/messages";
import { getForgeDefinitionOrNeutral } from "@jagentdesk/protocol/forge-manifest";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRouteServerId } from "@/navigation/host-route-context";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { DiffViewer } from "@/components/diff-viewer";
import { parseUnifiedDiff } from "@/utils/tool-call-parsers";
import { highlightDiffLines } from "@/utils/diff-highlight";
import type { Theme } from "@/styles/theme";

// ---------------------------------------------------------------------------
// Forge Hub (spec 19 / ADR-0015). Milestone A: connections, repositories, and
// PR/MR list + detail + Files-changed (read only). Milestone B (this file also):
// Code (branches/commits/diff), PR review + merge actions, and CI pipelines
// (run → stage → job → log, rerun/cancel). Each Milestone-B section is gated by
// the matching host feature flag (§19.12): forgeHubCode / forgeHubReview /
// forgeHubPipelines. All data flows through the daemon via the committed forge.*
// RPCs on the DaemonClient — this screen only renders UI.
// ---------------------------------------------------------------------------

type SubNav = "connections" | "repositories" | "code" | "pulls" | "pipelines";

/** A repo coordinate for every repo-scoped Forge Hub RPC. */
function repoRef(repo: ForgeRepo): ForgeRepoRef {
  return { forge: repo.forge, owner: repo.owner, name: repo.name };
}

/** Short SHA (7 chars) for mono display, matching §19.5.2. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

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
  onRemove: (id: string) => void;
}) {
  const { theme } = useUnistyles();
  const def = getForgeDefinitionOrNeutral(connection.forge);
  const status = connectionStatus(connection, theme);
  const handleRemove = useCallback(() => onRemove(connection.id), [connection.id, onRemove]);
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
        accessibilityRole="button"
        accessibilityLabel="Remove connection"
        testID={`forge-connection-remove-${connection.id}`}
      >
        <Trash2 size={15} color={theme.colors.foregroundMuted} />
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
  const handlePress = useCallback(() => onSelect(option.choice), [option.choice, onSelect]);
  return (
    <Pressable
      style={[styles.providerChip, active && styles.providerChipActive]}
      onPress={handlePress}
      testID={`forge-provider-${option.choice}`}
    >
      <Text style={[styles.providerChipText, active && styles.providerChipTextActive]}>
        {option.label}
      </Text>
    </Pressable>
  );
}

function ConnectionsView({
  connections,
  onRemove,
  onAdd,
  adding,
  onToggleAdd,
}: {
  connections: ForgeConnection[];
  onRemove: (id: string) => void;
  onAdd: (input: { forge: string; host?: string; method: "cli" | "token"; token?: string }) => void;
  adding: boolean;
  onToggleAdd: () => void;
}) {
  const { theme } = useUnistyles();
  const [choice, setChoice] = useState<ProviderChoice>("github");
  const [host, setHost] = useState("");
  const [token, setToken] = useState("");
  const [selfHostedForge, setSelfHostedForge] = useState("gitlab");

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
          <Text style={styles.formTitle}>Add a connection</Text>

          <Text style={styles.fieldLabel}>Provider</Text>
          <View style={styles.chipRow}>
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

          {option.method === "cli" ? (
            <View style={styles.hintBox}>
              <Text style={styles.hintTitle}>OAuth device flow (recommended)</Text>
              <Text style={styles.hintBody}>
                Sign in on the daemon host by running the command below, then paste the one-time
                code at the provider. No callback server is needed.
              </Text>
              <Text style={styles.hintMono}>{def.signIn?.command ?? "auth login"}</Text>
            </View>
          ) : (
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Personal access token / API token</Text>
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

          <View style={styles.formActions}>
            <Pressable
              style={[styles.btn, styles.btnPrimary]}
              onPress={handleSubmit}
              testID="forge-connection-submit"
            >
              <Text style={styles.btnPrimaryText}>Add connection</Text>
            </Pressable>
            <Pressable style={[styles.btn, styles.btnGhost]} onPress={onToggleAdd}>
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
  onOpen,
  onRetry,
}: {
  repos: ForgeRepo[];
  loading: boolean;
  error: string | null;
  onOpen: (repo: ForgeRepo) => void;
  onRetry: () => void;
}) {
  const { theme } = useUnistyles();
  const [query, setQuery] = useState("");
  const [disabledForges, setDisabledForges] = useState<Set<string>>(() => new Set());

  const forgesPresent = useMemo(() => {
    const set = new Set<string>();
    for (const repo of repos) set.add(repo.forge);
    return [...set];
  }, [repos]);

  const toggleForge = useCallback((forge: string) => {
    setDisabledForges((prev) => {
      const next = new Set(prev);
      if (next.has(forge)) next.delete(forge);
      else next.add(forge);
      return next;
    });
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return repos.filter((repo) => {
      if (disabledForges.has(repo.forge)) return false;
      if (!q) return true;
      return `${repo.owner}/${repo.name}`.toLowerCase().includes(q);
    });
  }, [repos, query, disabledForges]);

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
          {forgesPresent.map((forge) => {
            const active = !disabledForges.has(forge);
            return (
              <ForgeFilterChip key={forge} forge={forge} active={active} onToggle={toggleForge} />
            );
          })}
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
        <Text style={styles.emptyText}>Loading repositories…</Text>
      ) : filtered.length === 0 ? (
        <Text style={styles.emptyText}>No repositories match the current filters.</Text>
      ) : (
        <View style={styles.card}>
          {filtered.map((repo) => (
            <RepoRow key={`${repo.forge}:${repo.owner}/${repo.name}`} repo={repo} onOpen={onOpen} />
          ))}
        </View>
      )}
    </View>
  );
}

function ForgeFilterChip({
  forge,
  active,
  onToggle,
}: {
  forge: string;
  active: boolean;
  onToggle: (forge: string) => void;
}) {
  const handlePress = useCallback(() => onToggle(forge), [forge, onToggle]);
  const def = getForgeDefinitionOrNeutral(forge);
  return (
    <Pressable
      style={[styles.providerChip, active && styles.providerChipActive]}
      onPress={handlePress}
      testID={`forge-filter-${forge}`}
    >
      <Text style={[styles.providerChipText, active && styles.providerChipTextActive]}>
        {def.displayName}
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

// ===== pull request detail =================================================

type DetailTab = "conversation" | "commits" | "files" | "checks";

function FileDiffCard({ file }: { file: ForgeChangeRequestFile }) {
  const diffLines = useMemo(() => {
    if (!file.patch) return null;
    return highlightDiffLines(parseUnifiedDiff(file.patch), file.path);
  }, [file.patch, file.path]);

  return (
    <View style={styles.fileCard}>
      <View style={styles.fileHeader}>
        <Text style={styles.fileName} numberOfLines={1}>
          {file.previousPath && file.status === "renamed"
            ? `${file.previousPath} → ${file.path}`
            : file.path}
        </Text>
        <View style={styles.grow} />
        <Text style={styles.diffAdd}>+{file.additions}</Text>
        <Text style={styles.diffDel}>−{file.deletions}</Text>
      </View>
      {diffLines ? (
        <DiffViewer diffLines={diffLines} maxHeight={420} />
      ) : (
        <Text style={styles.fileEmpty}>No diff available for this file.</Text>
      )}
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
      {files.map((file) => (
        <FileDiffCard key={file.path} file={file} />
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
// PR is open per the summary. Auto-merge is Milestone C and intentionally absent.
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
  const def = getForgeDefinitionOrNeutral(repo.forge);
  const [method, setMethod] = useState<ForgeMergeMethod>("merge");
  const [status, setStatus] = useState<"idle" | "running" | "done">("idle");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mergeable = cr.state === "open";
  const running = status === "running";

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
    void Linking.openURL(cr.url);
  }, [cr.url]);

  const setConversation = useCallback(() => setTab("conversation"), []);
  const setCommitsTab = useCallback(() => setTab("commits"), []);
  const setFiles = useCallback(() => setTab("files"), []);
  const setChecks = useCallback(() => setTab("checks"), []);

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
          <Text style={styles.emptyText}>Loading commits…</Text>
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

// ===== code (branches · commits · diff) — Milestone B, gate forgeHubCode =====

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
              <Text style={styles.emptyText}>Loading branches…</Text>
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

function CodeView({ client, repo }: { client: DaemonClient; repo: ForgeRepo }) {
  const { theme } = useUnistyles();

  const [branches, setBranches] = useState<ForgeBranch[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branch, setBranch] = useState<string | null>(repo.defaultBranch ?? null);

  const [commits, setCommits] = useState<ForgeCommit[] | null>(null);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [commitsError, setCommitsError] = useState<string | null>(null);

  // Commit / compare diff (null = list mode).
  const [diffTitle, setDiffTitle] = useState<string | null>(null);
  const [diffFiles, setDiffFiles] = useState<ForgeChangeRequestFile[] | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  // Compare mode (§19.5.2 "Compare ⇄").
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareBase, setCompareBase] = useState<string | null>(repo.defaultBranch ?? null);
  const [compareHead, setCompareHead] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBranchesLoading(true);
    void (async () => {
      try {
        const res = await client.forgeListBranches({ repo: repoRef(repo) });
        const parsed = ForgeBranchSchema.array().safeParse(res.branches);
        if (cancelled) return;
        const list = parsed.success ? parsed.data : [];
        setBranches(list);
        setBranch((prev) => prev ?? list.find((b) => b.isDefault)?.name ?? list[0]?.name ?? null);
      } catch {
        // Branch picker shows an empty state; commits still load from default ref.
      } finally {
        if (!cancelled) setBranchesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, repo]);

  const loadCommits = useCallback(async () => {
    if (!branch) return;
    setCommitsLoading(true);
    setCommitsError(null);
    try {
      const res = await client.forgeListCommits({ repo: repoRef(repo), ref: branch });
      const parsed = ForgeCommitSchema.array().safeParse(res.commits);
      setCommits(parsed.success ? parsed.data : []);
      if (!parsed.success) setCommitsError("Unable to load commits.");
    } catch (e: unknown) {
      setCommitsError(e instanceof Error ? e.message : "Unable to load commits.");
    } finally {
      setCommitsLoading(false);
    }
  }, [client, repo, branch]);

  useEffect(() => {
    if (branch) void loadCommits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch]);

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
          <Pressable style={[styles.btn, styles.btnGhost]} onPress={loadCommits}>
            <Text style={styles.btnGhostText}>Retry</Text>
          </Pressable>
        </View>
      ) : commitsLoading || commits === null ? (
        <Text style={styles.emptyText}>Loading commits…</Text>
      ) : commits.length === 0 ? (
        <Text style={styles.emptyText}>No commits on this branch.</Text>
      ) : (
        <View style={styles.card}>
          {commits.map((commit) => (
            <CommitRow key={commit.sha} commit={commit} onOpen={openCommitDiff} />
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
  onBack,
}: {
  client: DaemonClient;
  repo: ForgeRepo;
  run: ForgePipelineRun;
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
    </View>
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

function PipelinesView({ client, repo }: { client: DaemonClient; repo: ForgeRepo }) {
  const { theme } = useUnistyles();
  const [runs, setRuns] = useState<ForgePipelineRun[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<ForgePipelineRun | null>(null);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.forgeListPipelines({ repo: repoRef(repo) });
      const parsed = ForgePipelineRunSchema.array().safeParse(res.runs);
      setRuns(parsed.success ? parsed.data : []);
      if (!parsed.success) setError("Unable to load pipelines.");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unable to load pipelines.");
    } finally {
      setLoading(false);
    }
  }, [client, repo]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const backToRuns = useCallback(() => setSelectedRun(null), []);

  if (selectedRun) {
    return <PipelineRunDetail client={client} repo={repo} run={selectedRun} onBack={backToRuns} />;
  }

  return (
    <View style={styles.pane}>
      <View style={styles.toolbarRow}>
        <Text style={styles.rowTitleMono} numberOfLines={1}>
          {repo.owner}/{repo.name}
        </Text>
      </View>
      {error ? (
        <View style={styles.errorBanner}>
          <CircleAlert size={16} color={theme.colors.statusDanger} />
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={[styles.btn, styles.btnGhost]} onPress={loadRuns}>
            <Text style={styles.btnGhostText}>Retry</Text>
          </Pressable>
        </View>
      ) : loading || runs === null ? (
        <Text style={styles.emptyText}>Loading pipelines…</Text>
      ) : runs.length === 0 ? (
        <Text style={styles.emptyText}>No pipeline runs yet.</Text>
      ) : (
        <View style={styles.card}>
          {runs.map((run) => (
            <PipelineRunRow key={run.id} run={run} onOpen={setSelectedRun} />
          ))}
        </View>
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
}: {
  label: string;
  value: SubNav;
  active: boolean;
  onSelect: (value: SubNav) => void;
}) {
  const handlePress = useCallback(() => onSelect(value), [value, onSelect]);
  return (
    <Pressable
      style={[styles.subNavBtn, active && styles.subNavBtnActive]}
      onPress={handlePress}
      testID={`forge-subnav-${value}`}
    >
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

  const [tab, setTab] = useState<SubNav>("connections");
  const [connections, setConnections] = useState<ForgeConnection[]>([]);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const [repos, setRepos] = useState<ForgeRepo[]>([]);
  const [reposLoaded, setReposLoaded] = useState(false);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);

  const [selectedRepo, setSelectedRepo] = useState<ForgeRepo | null>(null);
  const [crState, setCrState] = useState<CrState>("open");
  const [changeRequests, setChangeRequests] = useState<ForgeChangeRequestSummary[]>([]);
  const [crLoading, setCrLoading] = useState(false);
  const [crError, setCrError] = useState<string | null>(null);

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

  const loadRepos = useCallback(async () => {
    if (!client) return;
    setReposLoading(true);
    setReposError(null);
    try {
      const res = await client.forgeListRepos({ limit: 100 });
      const parsed = ForgeRepoSchema.array().safeParse(res.repos);
      setRepos(parsed.success ? parsed.data : []);
      if (!parsed.success) setReposError("Unable to load repositories.");
      setReposLoaded(true);
    } catch (e: unknown) {
      setReposError(e instanceof Error ? e.message : "Unable to load repositories.");
    } finally {
      setReposLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (tab === "repositories" && !reposLoaded && !reposLoading) {
      void loadRepos();
    }
  }, [tab, reposLoaded, reposLoading, loadRepos]);

  const loadChangeRequests = useCallback(
    async (repo: ForgeRepo, state: CrState) => {
      if (!client) return;
      setCrLoading(true);
      setCrError(null);
      try {
        const res = await client.forgeListChangeRequests({
          repo: { forge: repo.forge, owner: repo.owner, name: repo.name },
          state,
        });
        const parsed = ForgeChangeRequestSummarySchema.array().safeParse(res.changeRequests);
        setChangeRequests(parsed.success ? parsed.data : []);
        if (!parsed.success) {
          setCrError(
            `Unable to load ${getForgeDefinitionOrNeutral(repo.forge).changeRequestNoun} list.`,
          );
        }
      } catch (e: unknown) {
        setCrError(
          e instanceof Error
            ? e.message
            : `Unable to load ${getForgeDefinitionOrNeutral(repo.forge).changeRequestNoun} list.`,
        );
      } finally {
        setCrLoading(false);
      }
    },
    [client],
  );

  const handleOpenRepo = useCallback(
    (repo: ForgeRepo) => {
      setSelectedRepo(repo);
      setSelectedCr(null);
      setCrState("open");
      setTab("pulls");
      void loadChangeRequests(repo, "open");
    },
    [loadChangeRequests],
  );

  const handleChangeState = useCallback(
    (state: CrState) => {
      setCrState(state);
      if (selectedRepo) void loadChangeRequests(selectedRepo, state);
    },
    [selectedRepo, loadChangeRequests],
  );

  const handleOpenCr = useCallback((cr: ForgeChangeRequestSummary) => {
    setSelectedCr(cr);
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
      void client
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

      <View style={styles.subNavRow}>
        <SubNavButton
          label="Connections"
          value="connections"
          active={tab === "connections"}
          onSelect={setTab}
        />
        <SubNavButton
          label="Repositories"
          value="repositories"
          active={tab === "repositories"}
          onSelect={setTab}
        />
        {codeEnabled ? (
          <SubNavButton label="Code" value="code" active={tab === "code"} onSelect={setTab} />
        ) : null}
        <SubNavButton
          label="Pull requests"
          value="pulls"
          active={tab === "pulls"}
          onSelect={setTab}
        />
        {pipelinesEnabled ? (
          <SubNavButton
            label="Pipelines"
            value="pipelines"
            active={tab === "pipelines"}
            onSelect={setTab}
          />
        ) : null}
      </View>

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
              </View>
              <StateFilter state={crState} onChange={handleChangeState} />
              {crError ? (
                <View style={styles.errorBanner}>
                  <CircleAlert size={16} color={theme.colors.statusDanger} />
                  <Text style={styles.errorText}>{crError}</Text>
                </View>
              ) : null}
              {crLoading ? (
                <Text style={styles.emptyText}>Loading…</Text>
              ) : changeRequests.length === 0 ? (
                <Text style={styles.emptyText}>Nothing here yet.</Text>
              ) : (
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

        {tab === "pipelines" && pipelinesEnabled ? (
          !hasConnections ? (
            <Text style={styles.emptyText}>{CONNECTION_EMPTY_STATE}</Text>
          ) : !selectedRepo || !client ? (
            <Text style={styles.emptyText}>
              Pick a repository from the Repositories tab to view its pipelines.
            </Text>
          ) : (
            <PipelinesView client={client} repo={selectedRepo} />
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
    flexDirection: "row",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  subNavBtn: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  subNavBtnActive: {
    borderBottomColor: theme.colors.accent,
  },
  subNavText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  subNavTextActive: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
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
  // form
  formCard: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  },
  formTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
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
    gap: theme.spacing[2],
  },
  // search
  searchField: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    maxWidth: 360,
    height: 34,
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
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
    width: 280,
    maxWidth: "90%",
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[2],
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
  logSurface: {
    maxHeight: 480,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  logContent: {
    padding: theme.spacing[3],
  },
  logText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: theme.fontSize.code * 1.5,
    color: theme.colors.foreground,
  },
  logTruncated: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusWarning,
    marginBottom: theme.spacing[2],
  },
}));
