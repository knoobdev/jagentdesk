import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  ArrowLeft,
  Boxes,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Container as ContainerIcon,
  Copy,
  Download,
  HardDrive,
  Pause,
  Play,
  RotateCw,
  Search,
  Square,
  Trash2,
} from "lucide-react-native";
import type { ComponentType, ReactNode } from "react";
import * as Clipboard from "expo-clipboard";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useWorkspaceDirectory, useWorkspaceKeys } from "@/stores/session-store-hooks";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { Skeleton, useSkeletonPulse } from "@/components/ui/skeleton";
import { TerminalPane } from "@/components/terminal-pane";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { Theme } from "@/styles/theme";
import type {
  DockerAction,
  DockerContainer,
  DockerImage,
  DockerImageAction,
  DockerStats,
  DockerVolume,
  DockerVolumeAction,
} from "@jagentdesk/protocol/docker/rpc-schemas";

const RUNNING_STATES = new Set(["running", "restarting"]);
type DockerTab = "containers" | "images" | "volumes";
type DetailTab = "logs" | "inspect" | "stats" | "exec";

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`;
}

function StatusDot({ state }: { state: string }) {
  let style = styles.dotOff;
  if (RUNNING_STATES.has(state)) style = styles.dotOn;
  else if (state === "paused") style = styles.dotPaused;
  return <View style={[styles.dot, style]} />;
}

// ── themed icons ──
const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedBoxes = withUnistyles(Boxes);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedContainer = withUnistyles(ContainerIcon);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedCopy = withUnistyles(Copy);
const ThemedDownload = withUnistyles(Download);
const ThemedHardDrive = withUnistyles(HardDrive);
const ThemedPause = withUnistyles(Pause);
const ThemedPlay = withUnistyles(Play);
const ThemedRotate = withUnistyles(RotateCw);
const ThemedSearch = withUnistyles(Search);
const ThemedSquare = withUnistyles(Square);
const ThemedTrash = withUnistyles(Trash2);
const ThemedTextInput = withUnistyles(TextInput);

const fg = (theme: Theme) => ({ color: theme.colors.foreground });
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const accentFg = (theme: Theme) => ({ color: theme.colors.accentForeground });
const red = (theme: Theme) => ({ color: theme.colors.palette.red[500] });
const green = (theme: Theme) => ({ color: theme.colors.palette.green[600] });
const placeholderColor = (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundExtraMuted,
});

type IconComponent = ComponentType<{ size?: number; uniProps?: (theme: Theme) => object }>;

function IconBtn({
  icon: Icon,
  tint,
  label,
  onPress,
  disabled,
}: {
  icon: IconComponent;
  tint: (theme: Theme) => object;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={[styles.iconBtn, disabled ? styles.btnDisabled : null]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Icon size={15} uniProps={tint} />
    </Pressable>
  );
}

// ── one compact table row for a container ──
function ContainerRow({
  container,
  busy,
  nested,
  onAction,
  onOpen,
}: {
  container: DockerContainer;
  busy: boolean;
  nested: boolean;
  onAction: (id: string, action: DockerAction) => void;
  onOpen: (id: string) => void;
}) {
  const running = RUNNING_STATES.has(container.state);
  const paused = container.state === "paused";
  const stop = useCallback(() => onAction(container.id, "stop"), [onAction, container.id]);
  const start = useCallback(() => onAction(container.id, "start"), [onAction, container.id]);
  const restart = useCallback(() => onAction(container.id, "restart"), [onAction, container.id]);
  const pause = useCallback(() => onAction(container.id, "pause"), [onAction, container.id]);
  const unpause = useCallback(() => onAction(container.id, "unpause"), [onAction, container.id]);
  const remove = useCallback(() => onAction(container.id, "remove"), [onAction, container.id]);
  const open = useCallback(() => onOpen(container.id), [onOpen, container.id]);

  return (
    <Pressable style={[styles.trow, nested ? styles.trowNested : null]} onPress={open}>
      <View style={styles.colName}>
        <StatusDot state={container.state} />
        <Text style={styles.cellStrong} numberOfLines={1}>
          {nested
            ? container.service || container.name
            : container.name || container.id.slice(0, 12)}
        </Text>
      </View>
      <Text style={[styles.cell, styles.colImage]} numberOfLines={1}>
        {container.image}
      </Text>
      <Text
        style={[styles.cell, styles.colStatus, running ? styles.statusRunning : null]}
        numberOfLines={1}
      >
        {container.status}
      </Text>
      <Text style={[styles.cell, styles.colPorts]} numberOfLines={1}>
        {container.ports || "—"}
      </Text>
      <View style={styles.colActions}>
        {running ? (
          <IconBtn icon={ThemedSquare} tint={fg} label="Stop" onPress={stop} disabled={busy} />
        ) : (
          <IconBtn
            icon={ThemedPlay}
            tint={green}
            label={paused ? "Unpause" : "Start"}
            onPress={paused ? unpause : start}
            disabled={busy}
          />
        )}
        {running ? (
          <IconBtn icon={ThemedPause} tint={muted} label="Pause" onPress={pause} disabled={busy} />
        ) : null}
        <IconBtn
          icon={ThemedRotate}
          tint={muted}
          label="Restart"
          onPress={restart}
          disabled={busy}
        />
        <IconBtn icon={ThemedTrash} tint={red} label="Remove" onPress={remove} disabled={busy} />
      </View>
    </Pressable>
  );
}

function TableHead() {
  return (
    <View style={styles.thead}>
      <Text style={[styles.th, styles.colNameHead]}>NAME</Text>
      <Text style={[styles.th, styles.colImage]}>IMAGE</Text>
      <Text style={[styles.th, styles.colStatus]}>STATUS</Text>
      <Text style={[styles.th, styles.colPorts]}>PORTS</Text>
      <View style={styles.colActions} />
    </View>
  );
}

interface ContainerGroup {
  project: string;
  items: DockerContainer[];
}

function groupContainers(containers: DockerContainer[]): {
  groups: ContainerGroup[];
  standalone: DockerContainer[];
} {
  const byProject = new Map<string, DockerContainer[]>();
  const standalone: DockerContainer[] = [];
  for (const c of containers) {
    if (!c.project) {
      standalone.push(c);
      continue;
    }
    const list = byProject.get(c.project);
    if (list) list.push(c);
    else byProject.set(c.project, [c]);
  }
  const groups = [...byProject.entries()]
    .map(([project, items]) => ({
      project,
      items: [...items].sort((a, b) => (a.service || a.name).localeCompare(b.service || b.name)),
    }))
    .sort((a, b) => a.project.localeCompare(b.project));
  return { groups, standalone };
}

interface RowHandlers {
  busyId: string | null;
  onAction: (id: string, action: DockerAction) => void;
  onOpen: (id: string) => void;
}

function ProjectGroup({
  group,
  collapsed,
  busyGroup,
  onToggle,
  onGroupAction,
  rows,
}: {
  group: ContainerGroup;
  collapsed: boolean;
  busyGroup: string | null;
  onToggle: (project: string) => void;
  onGroupAction: (project: string, ids: string[], action: DockerAction) => void;
  rows: RowHandlers;
}) {
  const runningCount = group.items.filter((c) => RUNNING_STATES.has(c.state)).length;
  const anyRunning = runningCount > 0;
  const busy = busyGroup === group.project;
  const ids = useMemo(() => group.items.map((c) => c.id), [group.items]);
  const toggle = useCallback(() => onToggle(group.project), [onToggle, group.project]);
  const stopAll = useCallback(
    () => onGroupAction(group.project, ids, "stop"),
    [onGroupAction, group.project, ids],
  );
  const startAll = useCallback(
    () => onGroupAction(group.project, ids, "start"),
    [onGroupAction, group.project, ids],
  );
  const restartAll = useCallback(
    () => onGroupAction(group.project, ids, "restart"),
    [onGroupAction, group.project, ids],
  );

  return (
    <View style={styles.group}>
      <View style={styles.groupHeader}>
        <Pressable style={styles.groupTitleBtn} onPress={toggle}>
          {collapsed ? (
            <ThemedChevronRight size={15} uniProps={muted} />
          ) : (
            <ThemedChevronDown size={15} uniProps={muted} />
          )}
          <ThemedBoxes size={15} uniProps={fg} />
          <Text style={styles.groupTitle} numberOfLines={1}>
            {group.project}
          </Text>
          <Text style={styles.groupMeta}>
            {runningCount}/{group.items.length} running
          </Text>
        </Pressable>
        <View style={styles.colActions}>
          {anyRunning ? (
            <IconBtn
              icon={ThemedSquare}
              tint={fg}
              label="Stop all"
              onPress={stopAll}
              disabled={busy}
            />
          ) : (
            <IconBtn
              icon={ThemedPlay}
              tint={green}
              label="Start all"
              onPress={startAll}
              disabled={busy}
            />
          )}
          <IconBtn
            icon={ThemedRotate}
            tint={muted}
            label="Restart all"
            onPress={restartAll}
            disabled={busy}
          />
          <View style={styles.iconBtn} />
        </View>
      </View>
      {collapsed
        ? null
        : group.items.map((c) => (
            <ContainerRow
              key={c.id}
              container={c}
              busy={rows.busyId === c.id || busy}
              nested
              onAction={rows.onAction}
              onOpen={rows.onOpen}
            />
          ))}
    </View>
  );
}

function ContainersPanel({
  containers,
  collapsedProjects,
  busyGroup,
  onToggleProject,
  onGroupAction,
  rows,
}: {
  containers: DockerContainer[];
  collapsedProjects: ReadonlySet<string>;
  busyGroup: string | null;
  onToggleProject: (project: string) => void;
  onGroupAction: (project: string, ids: string[], action: DockerAction) => void;
  rows: RowHandlers;
}) {
  const { groups, standalone } = useMemo(() => groupContainers(containers), [containers]);
  if (containers.length === 0) {
    return <Text style={styles.emptyText}>No containers match.</Text>;
  }
  return (
    <View style={styles.sectionCard}>
      <TableHead />
      {groups.map((g) => (
        <ProjectGroup
          key={g.project}
          group={g}
          collapsed={collapsedProjects.has(g.project)}
          busyGroup={busyGroup}
          onToggle={onToggleProject}
          onGroupAction={onGroupAction}
          rows={rows}
        />
      ))}
      {standalone.map((c) => (
        <ContainerRow
          key={c.id}
          container={c}
          busy={rows.busyId === c.id}
          nested={false}
          onAction={rows.onAction}
          onOpen={rows.onOpen}
        />
      ))}
    </View>
  );
}

// ── images ──
function ImageRow({
  image,
  busy,
  onAction,
}: {
  image: DockerImage;
  busy: boolean;
  onAction: (ref: string, action: DockerImageAction) => void;
}) {
  const ref = image.repository === "<none>" ? image.id : `${image.repository}:${image.tag}`;
  const run = useCallback(() => onAction(ref, "run"), [onAction, ref]);
  const remove = useCallback(() => onAction(ref, "remove"), [onAction, ref]);
  return (
    <View style={styles.trow}>
      <View style={styles.colNameWide}>
        <Text style={styles.cellStrong} numberOfLines={1}>
          {image.repository}:{image.tag}
        </Text>
      </View>
      <Text style={[styles.cell, styles.colStatus]} numberOfLines={1}>
        {image.size}
      </Text>
      <Text style={[styles.cell, styles.colPorts]} numberOfLines={1}>
        {image.createdSince}
      </Text>
      <View style={styles.colActions}>
        <IconBtn icon={ThemedPlay} tint={green} label="Run" onPress={run} disabled={busy} />
        <IconBtn
          icon={ThemedTrash}
          tint={red}
          label="Remove image"
          onPress={remove}
          disabled={busy}
        />
      </View>
    </View>
  );
}

function ImagesPanel({
  images,
  busyImage,
  pullRef,
  onPullRefChange,
  onPull,
  onAction,
}: {
  images: DockerImage[];
  busyImage: string | null;
  pullRef: string;
  onPullRefChange: (v: string) => void;
  onPull: () => void;
  onAction: (ref: string, action: DockerImageAction) => void;
}) {
  return (
    <>
      <View style={styles.pullRow}>
        <ThemedTextInput
          style={styles.pullInput}
          value={pullRef}
          onChangeText={onPullRefChange}
          placeholder="Pull an image, e.g. nginx:alpine"
          autoCapitalize="none"
          autoCorrect={false}
          uniProps={placeholderColor}
        />
        <Pressable
          style={[
            styles.btn,
            styles.btnPrimary,
            (busyImage === "__pull__" || !pullRef) && styles.btnDisabled,
          ]}
          onPress={onPull}
          disabled={busyImage === "__pull__" || !pullRef}
        >
          <ThemedDownload size={13} uniProps={accentFg} />
          <Text style={styles.btnPrimaryText}>
            {busyImage === "__pull__" ? "Pulling…" : "Pull"}
          </Text>
        </Pressable>
      </View>
      {images.length === 0 ? (
        <Text style={styles.emptyText}>No images match.</Text>
      ) : (
        <View style={styles.sectionCard}>
          <View style={styles.thead}>
            <Text style={[styles.th, styles.colNameWide]}>REPOSITORY:TAG</Text>
            <Text style={[styles.th, styles.colStatus]}>SIZE</Text>
            <Text style={[styles.th, styles.colPorts]}>CREATED</Text>
            <View style={styles.colActions} />
          </View>
          {images.map((img) => (
            <ImageRow
              key={`${img.id}:${img.repository}:${img.tag}`}
              image={img}
              busy={busyImage === img.id}
              onAction={onAction}
            />
          ))}
        </View>
      )}
    </>
  );
}

// ── volumes ──
function VolumeRow({
  volume,
  busy,
  onRemove,
}: {
  volume: DockerVolume;
  busy: boolean;
  onRemove: (name: string) => void;
}) {
  const remove = useCallback(() => onRemove(volume.name), [onRemove, volume.name]);
  return (
    <View style={styles.trow}>
      <View style={styles.colNameWide}>
        <ThemedHardDrive size={15} uniProps={muted} />
        <Text style={styles.cellStrong} numberOfLines={1}>
          {volume.name}
        </Text>
      </View>
      <Text style={[styles.cell, styles.colStatus]} numberOfLines={1}>
        {volume.driver}
      </Text>
      <Text style={[styles.cell, styles.colPorts]} numberOfLines={1}>
        {volume.scope}
      </Text>
      <View style={styles.colActions}>
        <IconBtn
          icon={ThemedTrash}
          tint={red}
          label="Remove volume"
          onPress={remove}
          disabled={busy}
        />
      </View>
    </View>
  );
}

function VolumesPanel({
  volumes,
  busyVolume,
  onPrune,
  onRemove,
}: {
  volumes: DockerVolume[];
  busyVolume: string | null;
  onPrune: () => void;
  onRemove: (name: string) => void;
}) {
  return (
    <>
      <View style={styles.pullRow}>
        <View style={styles.headerSpacer} />
        <Pressable
          style={[styles.btn, styles.btnGhost, busyVolume === "__prune__" && styles.btnDisabled]}
          onPress={onPrune}
          disabled={busyVolume === "__prune__"}
        >
          <ThemedTrash size={13} uniProps={muted} />
          <Text style={styles.btnGhostText}>Prune unused</Text>
        </Pressable>
      </View>
      {volumes.length === 0 ? (
        <Text style={styles.emptyText}>No volumes.</Text>
      ) : (
        <View style={styles.sectionCard}>
          <View style={styles.thead}>
            <Text style={[styles.th, styles.colNameWide]}>NAME</Text>
            <Text style={[styles.th, styles.colStatus]}>DRIVER</Text>
            <Text style={[styles.th, styles.colPorts]}>SCOPE</Text>
            <View style={styles.colActions} />
          </View>
          {volumes.map((v) => (
            <VolumeRow key={v.name} volume={v} busy={busyVolume === v.name} onRemove={onRemove} />
          ))}
        </View>
      )}
    </>
  );
}

// ── container detail tabs ──
function LogsTab({
  client,
  container,
}: {
  client: DaemonClient | null;
  container: DockerContainer;
}) {
  const [text, setText] = useState("");
  const scrollRef = useRef<ScrollView>(null);
  // Stick to the bottom (live tail) until the reader scrolls up, then stop fighting them.
  const stick = useRef(true);
  useEffect(() => {
    if (!client) return;
    const subscriptionId = randomId("dlogs");
    setText("");
    stick.current = true;
    const off = client.onDockerLogChunk(subscriptionId, ({ chunk }) => {
      setText((prev) => (prev + chunk).slice(-400_000));
    });
    void client.dockerLogsSubscribe({ subscriptionId, container: container.id, tail: 500 });
    return () => {
      off();
      client.dockerLogsUnsubscribe({ subscriptionId });
    };
  }, [client, container.id]);
  const onContentSizeChange = useCallback(() => {
    if (stick.current) scrollRef.current?.scrollToEnd({ animated: false });
  }, []);
  const onScroll = useCallback(
    (e: {
      nativeEvent: {
        layoutMeasurement: { height: number };
        contentOffset: { y: number };
        contentSize: { height: number };
      };
    }) => {
      const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
      stick.current = layoutMeasurement.height + contentOffset.y >= contentSize.height - 48;
    },
    [],
  );
  return (
    <ScrollView
      ref={scrollRef}
      style={styles.console}
      contentContainerStyle={styles.consoleContent}
      onContentSizeChange={onContentSizeChange}
      onScroll={onScroll}
      scrollEventThrottle={80}
    >
      <Text style={styles.consoleText} selectable>
        {text || "Waiting for output…"}
      </Text>
    </ScrollView>
  );
}

// Lightweight JSON syntax highlighting for the Inspect tab — keys, strings, numbers,
// booleans/null get distinct colors so the config reads like an editor, not a dump.
const JSON_TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

function JsonHighlight({ text }: { text: string }) {
  const nodes = useMemo(() => {
    const out: ReactNode[] = [];
    let last = 0;
    let key = 0;
    let match: RegExpExecArray | null;
    JSON_TOKEN.lastIndex = 0;
    while ((match = JSON_TOKEN.exec(text)) !== null) {
      if (match.index > last) out.push(text.slice(last, match.index));
      const [whole, str, colon, keyword, num] = match;
      if (str !== undefined) {
        out.push(
          <Text key={key++} style={colon ? styles.jsonKey : styles.jsonStr}>
            {str}
          </Text>,
        );
        if (colon) out.push(colon);
      } else if (keyword !== undefined) {
        out.push(
          <Text key={key++} style={styles.jsonKeyword}>
            {keyword}
          </Text>,
        );
      } else if (num !== undefined) {
        out.push(
          <Text key={key++} style={styles.jsonNum}>
            {num}
          </Text>,
        );
      } else {
        out.push(whole);
      }
      last = match.index + whole.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }, [text]);
  return (
    <Text style={styles.consoleText} selectable>
      {nodes}
    </Text>
  );
}

function InspectTab({
  client,
  container,
}: {
  client: DaemonClient | null;
  container: DockerContainer;
}) {
  const [text, setText] = useState("Loading…");
  useEffect(() => {
    if (!client) return;
    let alive = true;
    void client
      .dockerInspect({ container: container.id })
      .then((res) => {
        if (alive) setText(res.error ? `Error: ${res.error}` : res.inspect);
        return undefined;
      })
      .catch((e: unknown) => {
        if (alive) setText(e instanceof Error ? e.message : "Failed to inspect");
      });
    return () => {
      alive = false;
    };
  }, [client, container.id]);
  return (
    <ScrollView style={styles.console} contentContainerStyle={styles.consoleContent}>
      <JsonHighlight text={text} />
    </ScrollView>
  );
}

function StatMetric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue} numberOfLines={1}>
        {value || "—"}
      </Text>
    </View>
  );
}

function StatsTab({
  client,
  container,
}: {
  client: DaemonClient | null;
  container: DockerContainer;
}) {
  const [stats, setStats] = useState<DockerStats | null>(null);
  useEffect(() => {
    if (!client) return;
    const subscriptionId = randomId("dstats");
    setStats(null);
    const off = client.onDockerStats(subscriptionId, ({ stats: s }) => setStats(s));
    void client.dockerStatsSubscribe({ subscriptionId, container: container.id });
    return () => {
      off();
      client.dockerStatsUnsubscribe({ subscriptionId });
    };
  }, [client, container.id]);
  if (!stats) {
    return <Text style={styles.consoleHint}>Waiting for live stats…</Text>;
  }
  return (
    <View style={styles.metricGrid}>
      <StatMetric label="CPU" value={stats.cpuPerc} />
      <StatMetric label="MEMORY" value={stats.memUsage} />
      <StatMetric label="MEM %" value={stats.memPerc} />
      <StatMetric label="NET I/O" value={stats.netIO} />
      <StatMetric label="BLOCK I/O" value={stats.blockIO} />
      <StatMetric label="PIDS" value={stats.pids} />
    </View>
  );
}

// A real interactive shell inside the container: spawn `docker exec -it <id> sh` as a daemon
// terminal (pty) and render the same TerminalPane the workspace uses. Full TTY, not an input box.
const noop = () => {};

function ExecTab({
  client,
  container,
  serverId,
  cwd,
  workspaceId,
}: {
  client: DaemonClient | null;
  container: DockerContainer;
  serverId: string;
  cwd: string;
  workspaceId: string | null;
}) {
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!client || !workspaceId) return;
    let disposed = false;
    let createdId: string | null = null;
    void client
      .createTerminal(cwd, `sh @ ${container.name}`, undefined, {
        command: "docker",
        args: ["exec", "-it", container.id, "sh"],
        workspaceId,
      })
      .then((payload) => {
        if (payload.error || !payload.terminal) {
          setError(payload.error ?? "Failed to open a shell");
          return;
        }
        createdId = payload.terminal.id;
        if (disposed) {
          void client.killTerminal(createdId);
          return undefined;
        }
        setTerminalId(createdId);
        return undefined;
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to open a shell"));
    return () => {
      disposed = true;
      if (createdId) void client.killTerminal(createdId);
    };
  }, [client, container.id, container.name, cwd, workspaceId]);

  if (!workspaceId) {
    return (
      <Text style={styles.consoleHint}>Open a workspace on this host to exec into containers.</Text>
    );
  }
  if (error) {
    return <Text style={styles.consoleHint}>{error}</Text>;
  }
  if (!terminalId) {
    return <Text style={styles.consoleHint}>Opening a shell in the container…</Text>;
  }
  return (
    <View style={styles.execWrap}>
      <TerminalPane
        serverId={serverId}
        cwd={cwd}
        terminalId={terminalId}
        isWorkspaceFocused
        isPaneFocused
        onOpenFileExplorer={noop}
        onOpenWorkspaceFile={noop}
      />
    </View>
  );
}

function MetaChip({
  label,
  value,
  copyValue,
}: {
  label: string;
  value: string;
  copyValue?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void Clipboard.setStringAsync(copyValue ?? value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [copyValue, value]);
  return (
    <View style={styles.metaChip}>
      <Text style={styles.metaLabel}>{label}</Text>
      <View style={styles.metaValueRow}>
        <Text style={styles.metaValue} numberOfLines={1}>
          {value}
        </Text>
        {copyValue ? (
          <Pressable
            onPress={copy}
            accessibilityLabel={`Copy ${label}`}
            hitSlop={6}
            style={styles.metaCopy}
          >
            <ThemedCopy size={12} uniProps={copied ? green : muted} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function ContainerDetail({
  container,
  client,
  serverId,
  cwd,
  workspaceId,
  busy,
  isCompact,
  insetsTop,
  onAction,
  onBack,
}: {
  container: DockerContainer;
  client: DaemonClient | null;
  serverId: string;
  cwd: string;
  workspaceId: string | null;
  busy: boolean;
  isCompact: boolean;
  insetsTop: number;
  onAction: (id: string, action: DockerAction) => void;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>("logs");
  const running = RUNNING_STATES.has(container.state);
  const paused = container.state === "paused";
  const showLogs = useCallback(() => setTab("logs"), []);
  const showInspect = useCallback(() => setTab("inspect"), []);
  const showStats = useCallback(() => setTab("stats"), []);
  const showExec = useCallback(() => setTab("exec"), []);
  const stop = useCallback(() => onAction(container.id, "stop"), [onAction, container.id]);
  const start = useCallback(() => onAction(container.id, "start"), [onAction, container.id]);
  const unpause = useCallback(() => onAction(container.id, "unpause"), [onAction, container.id]);
  const restart = useCallback(() => onAction(container.id, "restart"), [onAction, container.id]);
  const remove = useCallback(() => onAction(container.id, "remove"), [onAction, container.id]);

  let content = <LogsTab client={client} container={container} />;
  if (tab === "inspect") content = <InspectTab client={client} container={container} />;
  else if (tab === "stats") content = <StatsTab client={client} container={container} />;
  else if (tab === "exec")
    content = (
      <ExecTab
        client={client}
        container={container}
        serverId={serverId}
        cwd={cwd}
        workspaceId={workspaceId}
      />
    );

  return (
    <View style={[styles.detail, isCompact ? { paddingTop: insetsTop } : null]}>
      <View style={styles.detailHeader}>
        <Pressable style={styles.iconBtn} onPress={onBack} accessibilityLabel="Back to Docker">
          <ThemedArrowLeft size={20} uniProps={muted} />
        </Pressable>
        <StatusDot state={container.state} />
        <View style={styles.detailTitleWrap}>
          <Text style={styles.detailTitle} numberOfLines={1}>
            {container.name || container.id.slice(0, 12)}
          </Text>
          <Text style={styles.detailSubtitle} numberOfLines={1}>
            {container.image} · {container.status}
          </Text>
        </View>
        <View style={styles.colActionsWide}>
          {running ? (
            <IconBtn icon={ThemedSquare} tint={fg} label="Stop" onPress={stop} disabled={busy} />
          ) : (
            <IconBtn
              icon={ThemedPlay}
              tint={green}
              label={paused ? "Unpause" : "Start"}
              onPress={paused ? unpause : start}
              disabled={busy}
            />
          )}
          <IconBtn
            icon={ThemedRotate}
            tint={muted}
            label="Restart"
            onPress={restart}
            disabled={busy}
          />
          <IconBtn icon={ThemedTrash} tint={red} label="Remove" onPress={remove} disabled={busy} />
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.metaRow}
        contentContainerStyle={styles.metaRowContent}
      >
        <MetaChip label="ID" value={container.id.slice(0, 12)} copyValue={container.id} />
        <MetaChip label="STATE" value={container.state || "—"} />
        <MetaChip label="PORTS" value={container.ports || "—"} />
        {container.project ? <MetaChip label="COMPOSE" value={container.project} /> : null}
        <MetaChip label="CREATED" value={container.createdAt || "—"} />
      </ScrollView>

      <View style={styles.detailTabsWrap}>
        <View style={styles.tabRow}>
          <TabButton label="Logs" active={tab === "logs"} onPress={showLogs} />
          <TabButton label="Stats" active={tab === "stats"} onPress={showStats} />
          <TabButton label="Inspect" active={tab === "inspect"} onPress={showInspect} />
          <TabButton label="Exec" active={tab === "exec"} onPress={showExec} />
        </View>
      </View>

      {content}
    </View>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={active ? styles.tabActive : styles.tab} onPress={onPress}>
      <Text style={active ? styles.tabTextActive : styles.tabText}>{label}</Text>
    </Pressable>
  );
}

export function DockerScreen() {
  const hosts = useHosts();
  const serverId = hosts[0]?.serverId ?? "";
  const client = useHostRuntimeClient(serverId);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();
  // A workspace on this host backs the Exec terminal (the daemon scopes terminals to a workspace).
  const workspaceKeys = useWorkspaceKeys(serverId);
  const execWorkspaceId = workspaceKeys[0] ?? null;
  const execCwd = useWorkspaceDirectory(serverId, execWorkspaceId) ?? "/";

  const contentContainerStyle = useMemo(
    () => [styles.contentContainer, isCompact ? { paddingTop: insets.top } : null],
    [isCompact, insets.top],
  );

  const [tab, setTab] = useState<DockerTab>("containers");
  const [available, setAvailable] = useState(true);
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [images, setImages] = useState<DockerImage[]>([]);
  const [volumes, setVolumes] = useState<DockerVolume[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyGroup, setBusyGroup] = useState<string | null>(null);
  const [busyImage, setBusyImage] = useState<string | null>(null);
  const [busyVolume, setBusyVolume] = useState<string | null>(null);
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pullRef, setPullRef] = useState("");

  // Realtime: the daemon streams `docker events` and pushes a fresh snapshot on every change.
  useEffect(() => {
    if (!client) {
      setLoading(false);
      return;
    }
    const subscriptionId = randomId("docker");
    const off = client.onDockerSnapshot(subscriptionId, (snap) => {
      setAvailable(snap.available);
      setContainers(snap.containers);
      setImages(snap.images);
      setVolumes(snap.volumes);
      setError(null);
      setLoading(false);
    });
    void client.dockerSubscribe({ subscriptionId }).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : "Failed to connect to Docker");
      setLoading(false);
    });
    return () => {
      off();
      client.dockerUnsubscribe({ subscriptionId });
    };
  }, [client]);

  const handleAction = useCallback(
    async (id: string, action: DockerAction) => {
      if (!client) return;
      setBusyId(id);
      setError(null);
      try {
        const res = await client.dockerAction({ container: id, action });
        if (res.error) setError(res.error);
        if (action === "remove" && selectedId === id) setSelectedId(null);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Action failed");
      } finally {
        setBusyId(null);
      }
    },
    [client, selectedId],
  );

  const handleGroupAction = useCallback(
    async (project: string, ids: string[], action: DockerAction) => {
      if (!client) return;
      setBusyGroup(project);
      setError(null);
      try {
        for (const id of ids) {
          const res = await client.dockerAction({ container: id, action });
          if (res.error) setError(res.error);
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Group action failed");
      } finally {
        setBusyGroup(null);
      }
    },
    [client],
  );

  const handleImageAction = useCallback(
    async (ref: string, action: DockerImageAction) => {
      if (!client) return;
      setBusyImage(action === "pull" ? "__pull__" : ref);
      setError(null);
      try {
        const res = await client.dockerImageAction({ image: ref, action });
        if (res.error) setError(res.error);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Image action failed");
      } finally {
        setBusyImage(null);
      }
    },
    [client],
  );

  const handlePull = useCallback(() => {
    const ref = pullRef.trim();
    if (!ref) return;
    void handleImageAction(ref, "pull").then(() => setPullRef(""));
  }, [pullRef, handleImageAction]);

  const handleVolumeAction = useCallback(
    async (name: string, action: DockerVolumeAction) => {
      if (!client) return;
      setBusyVolume(action === "prune" ? "__prune__" : name);
      setError(null);
      try {
        const res = await client.dockerVolumeAction({ name, action });
        if (res.error) setError(res.error);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Volume action failed");
      } finally {
        setBusyVolume(null);
      }
    },
    [client],
  );

  const handleVolumeRemove = useCallback(
    (name: string) => void handleVolumeAction(name, "remove"),
    [handleVolumeAction],
  );
  const handleVolumePrune = useCallback(
    () => void handleVolumeAction("", "prune"),
    [handleVolumeAction],
  );

  const toggleProject = useCallback((project: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });
  }, []);

  const showBack = isCompact && router.canGoBack();
  const handleBack = useCallback(() => router.back(), [router]);
  const showContainers = useCallback(() => setTab("containers"), []);
  const showImages = useCallback(() => setTab("images"), []);
  const showVolumes = useCallback(() => setTab("volumes"), []);
  const handleOpen = useCallback((id: string) => setSelectedId(id), []);
  const clearSelected = useCallback(() => setSelectedId(null), []);

  const rows = useMemo<RowHandlers>(
    () => ({ busyId, onAction: handleAction, onOpen: handleOpen }),
    [busyId, handleAction, handleOpen],
  );

  const q = query.trim().toLowerCase();
  const filteredContainers = useMemo(() => {
    if (!q) return containers;
    return containers.filter((c) =>
      `${c.name} ${c.image} ${c.service} ${c.project}`.toLowerCase().includes(q),
    );
  }, [containers, q]);
  const filteredImages = useMemo(() => {
    if (!q) return images;
    return images.filter((i) => `${i.repository}:${i.tag}`.toLowerCase().includes(q));
  }, [images, q]);
  const filteredVolumes = useMemo(() => {
    if (!q) return volumes;
    return volumes.filter((v) => v.name.toLowerCase().includes(q));
  }, [volumes, q]);

  const selected = selectedId ? containers.find((c) => c.id === selectedId) : undefined;

  if (loading) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={contentContainerStyle}>
        <View style={styles.headerRow}>
          <ThemedContainer size={20} uniProps={fg} />
          <Text style={styles.header}>Docker</Text>
        </View>
        <DockerSkeleton />
      </ScrollView>
    );
  }

  if (selected) {
    return (
      <ContainerDetail
        container={selected}
        client={client}
        serverId={serverId}
        cwd={execCwd}
        workspaceId={execWorkspaceId}
        busy={busyId === selected.id}
        isCompact={isCompact}
        insetsTop={insets.top}
        onAction={handleAction}
        onBack={clearSelected}
      />
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={contentContainerStyle}>
      <View style={styles.headerRow}>
        {showBack ? (
          <Pressable style={styles.iconBtn} onPress={handleBack} accessibilityLabel="Back">
            <ThemedArrowLeft size={20} uniProps={muted} />
          </Pressable>
        ) : null}
        <ThemedContainer size={20} uniProps={fg} />
        <Text style={styles.header}>Docker</Text>
        <View style={styles.headerSpacer} />
        <View style={styles.livePill}>
          <View style={[styles.dot, styles.dotOn]} />
          <Text style={styles.liveText}>Live</Text>
        </View>
      </View>

      {error ? (
        <View style={styles.errorBanner}>
          <ThemedCircleAlert size={16} uniProps={red} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {!available ? (
        <View style={styles.noticeCard}>
          <Text style={styles.noticeTitle}>Docker not detected on this host</Text>
          <Text style={styles.noticeBody}>
            Install Docker and start the engine. Once it is running, the containers, images, and
            volumes the team creates appear here and update live.
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.toolbar}>
            <View style={styles.tabRow}>
              <TabButton
                label={`Containers · ${containers.length}`}
                active={tab === "containers"}
                onPress={showContainers}
              />
              <TabButton
                label={`Images · ${images.length}`}
                active={tab === "images"}
                onPress={showImages}
              />
              <TabButton
                label={`Volumes · ${volumes.length}`}
                active={tab === "volumes"}
                onPress={showVolumes}
              />
            </View>
            <View style={styles.searchBox}>
              <ThemedSearch size={14} uniProps={muted} />
              <ThemedTextInput
                style={styles.searchInput}
                value={query}
                onChangeText={setQuery}
                placeholder="Search"
                autoCapitalize="none"
                autoCorrect={false}
                uniProps={placeholderColor}
              />
            </View>
          </View>

          {tab === "containers" ? (
            <ContainersPanel
              containers={filteredContainers}
              collapsedProjects={collapsedProjects}
              busyGroup={busyGroup}
              onToggleProject={toggleProject}
              onGroupAction={handleGroupAction}
              rows={rows}
            />
          ) : null}
          {tab === "images" ? (
            <ImagesPanel
              images={filteredImages}
              busyImage={busyImage}
              pullRef={pullRef}
              onPullRefChange={setPullRef}
              onPull={handlePull}
              onAction={handleImageAction}
            />
          ) : null}
          {tab === "volumes" ? (
            <VolumesPanel
              volumes={filteredVolumes}
              busyVolume={busyVolume}
              onPrune={handleVolumePrune}
              onRemove={handleVolumeRemove}
            />
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

const DOCKER_SKELETON_KEYS = Array.from({ length: 5 }, (_, i) => `docker-skel-${i}`);

function DockerSkeleton() {
  const pulse = useSkeletonPulse();
  return (
    <View style={styles.sectionCard}>
      {DOCKER_SKELETON_KEYS.map((key) => (
        <View key={key} style={styles.trow}>
          <View style={styles.colName}>
            <Skeleton pulse={pulse} width={9} height={9} radius={5} />
            <Skeleton pulse={pulse} width="70%" height={13} />
          </View>
          <Skeleton pulse={pulse} width="40%" height={12} style={styles.colImage} />
          <Skeleton pulse={pulse} width="30%" height={12} style={styles.colStatus} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
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
  },
  headerSpacer: {
    flex: 1,
  },
  header: {
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  livePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  liveText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    backgroundColor: theme.colors.palette.red[100],
    borderRadius: theme.borderRadius.lg,
  },
  errorText: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.red[800],
  },
  noticeCard: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  noticeTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  noticeBody: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  tabRow: {
    flexDirection: "row",
    gap: theme.spacing[1],
    padding: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    alignSelf: "flex-start",
  },
  tab: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  },
  tabActive: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  tabText: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  tabTextActive: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    height: 34,
    minWidth: 180,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  searchInput: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  sectionCard: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
  thead: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  th: {
    fontSize: 10,
    fontWeight: theme.fontWeight.semibold,
    letterSpacing: 0.5,
    color: theme.colors.foregroundMuted,
  },
  group: {
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  groupTitleBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  groupTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  groupMeta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  trow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  trowNested: {
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.surface3,
    paddingLeft: theme.spacing[3] - 2,
  },
  colName: {
    flex: 2.4,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  colNameHead: {
    flex: 2.4,
    marginLeft: 17,
  },
  colNameWide: {
    flex: 3.4,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  colImage: { flex: 2.6, minWidth: 0 },
  colStatus: { flex: 1.6, minWidth: 0 },
  colPorts: { flex: 2.4, minWidth: 0 },
  colActions: {
    width: 116,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[1],
  },
  colActionsWide: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[1],
  },
  cell: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  cellStrong: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  statusRunning: {
    color: theme.colors.palette.green[600],
  },
  dot: { width: 9, height: 9, borderRadius: 5 },
  dotOn: { backgroundColor: theme.colors.palette.green[500] },
  dotOff: { backgroundColor: theme.colors.foregroundExtraMuted },
  dotPaused: { backgroundColor: theme.colors.palette.amber[500] },
  iconBtn: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
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
  btnDisabled: {
    opacity: 0.5,
  },
  pullRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  pullInput: {
    flex: 1,
    height: 36,
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  // ── detail ──
  detail: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  detailHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  detailTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  detailTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  detailSubtitle: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  metaRow: {
    flexGrow: 0,
    marginBottom: theme.spacing[1],
  },
  metaRowContent: {
    flexDirection: "row",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
  },
  metaChip: {
    gap: 2,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  metaLabel: {
    fontSize: 9,
    fontWeight: theme.fontWeight.semibold,
    letterSpacing: 0.5,
    color: theme.colors.foregroundMuted,
  },
  metaValueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  metaValue: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    fontFamily: "monospace",
    maxWidth: 320,
  },
  metaCopy: {
    padding: 2,
  },
  detailTabsWrap: {
    paddingHorizontal: theme.spacing[4],
  },
  jsonKey: {
    color: theme.colors.palette.blue[400],
  },
  jsonStr: {
    color: theme.colors.palette.green[400],
  },
  jsonNum: {
    color: theme.colors.palette.amber[500],
  },
  jsonKeyword: {
    color: theme.colors.palette.purple[500],
  },
  console: {
    flex: 1,
    minHeight: 0,
    marginHorizontal: theme.spacing[4],
    marginBottom: theme.spacing[4],
    marginTop: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.palette.zinc[900],
  },
  consoleContent: {
    padding: theme.spacing[3],
  },
  consoleText: {
    fontSize: theme.fontSize.xs,
    lineHeight: 18,
    color: theme.colors.palette.zinc[100],
    fontFamily: "monospace",
  },
  consoleHint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    padding: theme.spacing[4],
  },
  metricGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  metric: {
    minWidth: 150,
    flexGrow: 1,
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  metricLabel: {
    fontSize: 10,
    fontWeight: theme.fontWeight.semibold,
    letterSpacing: 0.5,
    color: theme.colors.foregroundMuted,
  },
  metricValue: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  execWrap: {
    flex: 1,
    minHeight: 0,
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
  },
}));
