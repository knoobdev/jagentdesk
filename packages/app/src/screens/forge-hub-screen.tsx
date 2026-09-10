import { useCallback, useEffect, useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  ArrowLeft,
  CircleAlert,
  ExternalLink,
  GitPullRequest,
  Plus,
  Search,
  Trash2,
} from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ForgeChangeRequestFileSchema,
  ForgeChangeRequestSummarySchema,
  ForgeRepoSchema,
  type ForgeChangeRequestFile,
  type ForgeChangeRequestSummary,
  type ForgeConnection,
  type ForgeRepo,
} from "@jagentdesk/protocol/messages";
import { getForgeDefinitionOrNeutral } from "@jagentdesk/protocol/forge-manifest";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRouteServerId } from "@/navigation/host-route-context";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { DiffViewer } from "@/components/diff-viewer";
import { parseUnifiedDiff } from "@/utils/tool-call-parsers";
import { highlightDiffLines } from "@/utils/diff-highlight";
import type { Theme } from "@/styles/theme";

// ---------------------------------------------------------------------------
// Forge Hub — Milestone A (spec 19 / ADR-0015): connections, repositories, and
// PR/MR list + detail + Files-changed (read only). Review/merge actions are
// Milestone B and intentionally absent here. All data flows through the daemon
// via the committed forge.* RPCs on the DaemonClient.
// ---------------------------------------------------------------------------

type SubNav = "connections" | "repositories" | "pulls";

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

function PullRequestDetail({
  repo,
  cr,
  files,
  filesLoading,
  filesError,
  onBack,
  onLoadFiles,
}: {
  repo: ForgeRepo;
  cr: ForgeChangeRequestSummary;
  files: ForgeChangeRequestFile[] | null;
  filesLoading: boolean;
  filesError: string | null;
  onBack: () => void;
  onLoadFiles: () => void;
}) {
  const { theme } = useUnistyles();
  const [tab, setTab] = useState<DetailTab>("conversation");
  const def = getForgeDefinitionOrNeutral(repo.forge);

  useEffect(() => {
    if (tab === "files" && files === null && !filesLoading) {
      onLoadFiles();
    }
  }, [tab, files, filesLoading, onLoadFiles]);

  const handleOpenExternal = useCallback(() => {
    void Linking.openURL(cr.url);
  }, [cr.url]);

  const setConversation = useCallback(() => setTab("conversation"), []);
  const setCommits = useCallback(() => setTab("commits"), []);
  const setFiles = useCallback(() => setTab("files"), []);
  const setChecks = useCallback(() => setTab("checks"), []);

  const filesCount = files?.length ?? null;

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
        <TabButton label="Commits" active={tab === "commits"} onPress={setCommits} />
        <TabButton
          label="Files changed"
          count={filesCount}
          active={tab === "files"}
          onPress={setFiles}
        />
        <TabButton label="Checks" active={tab === "checks"} onPress={setChecks} />
      </View>

      {tab === "conversation" ? (
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
      ) : null}

      {tab === "commits" ? (
        <Text style={styles.emptyText}>Commit history is available in a later milestone.</Text>
      ) : null}

      {tab === "checks" ? (
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
      ) : null}

      {tab === "files" ? (
        <View style={styles.filesPane}>
          {filesError ? (
            <View style={styles.errorBanner}>
              <CircleAlert size={16} color={theme.colors.statusDanger} />
              <Text style={styles.errorText}>{filesError}</Text>
              <Pressable style={[styles.btn, styles.btnGhost]} onPress={onLoadFiles}>
                <Text style={styles.btnGhostText}>Retry</Text>
              </Pressable>
            </View>
          ) : filesLoading || files === null ? (
            <Text style={styles.emptyText}>Loading files…</Text>
          ) : files.length === 0 ? (
            <Text style={styles.emptyText}>No files changed.</Text>
          ) : (
            files.map((file) => <FileDiffCard key={file.path} file={file} />)
          )}
        </View>
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
        <SubNavButton
          label="Pull requests"
          value="pulls"
          active={tab === "pulls"}
          onSelect={setTab}
        />
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
          ) : selectedCr ? (
            <PullRequestDetail
              repo={selectedRepo}
              cr={selectedCr}
              files={files}
              filesLoading={filesLoading}
              filesError={filesError}
              onBack={handleBackToList}
              onLoadFiles={loadFiles}
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
}));
