import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dimensions, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  ArrowDownToLine,
  ArrowLeft,
  Boxes,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleAlert,
  Container as ContainerIcon,
  Copy,
  Download,
  Eye,
  File as FileIcon,
  Folder,
  FolderPlus,
  FolderUp,
  HardDrive,
  MoreVertical,
  Pause,
  Pencil,
  Play,
  RotateCw,
  Search,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react-native";
import type { ComponentType } from "react";
import * as Clipboard from "expo-clipboard";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useWorkspaceDirectory, useWorkspaceKeys } from "@/stores/session-store-hooks";
import { getDesktopHost } from "@/desktop/host";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { Skeleton, useSkeletonPulse } from "@/components/ui/skeleton";
import { TerminalPane } from "@/components/terminal-pane";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { Theme } from "@/styles/theme";
import type {
  DockerAction,
  DockerContainer,
  DockerFsEntry,
  DockerImage,
  DockerImageAction,
  DockerStats,
  DockerVolume,
  DockerVolumeAction,
} from "@jagentdesk/protocol/docker/rpc-schemas";

const RUNNING_STATES = new Set(["running", "restarting"]);
type DockerTab = "containers" | "images" | "volumes";
type DetailTab = "logs" | "inspect" | "stats" | "files" | "exec";

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`;
}

// Native OS file/folder dialog (Electron). Returns a path on the machine running the desktop app
// — which is the daemon host for a local daemon, exactly what `docker cp` needs.
async function pickHostPath(mode: "dir" | "file"): Promise<string | null> {
  const open = getDesktopHost()?.dialog?.open;
  if (typeof open !== "function") return null;
  const sel = await open({
    directory: mode === "dir",
    multiple: false,
    createDirectory: mode === "dir",
  });
  if (typeof sel === "string") return sel;
  if (Array.isArray(sel)) return sel[0] ?? null;
  return null;
}

// Cmd/Ctrl+F toggles an in-panel find bar; Escape closes it. Web-only (Electron renderer).
function useCmdF(onToggle: () => void, onClose: () => void) {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        onToggle();
      } else if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onToggle, onClose]);
}

function FindBar({
  query,
  count,
  onQuery,
  onClose,
}: {
  query: string;
  count: number;
  onQuery: (v: string) => void;
  onClose: () => void;
}) {
  return (
    <View style={styles.findBar}>
      <ThemedSearch size={13} uniProps={muted} />
      <ThemedTextInput
        style={styles.findInput}
        value={query}
        onChangeText={onQuery}
        placeholder="Find"
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        uniProps={placeholderColor}
      />
      <Text style={styles.findCount}>{query ? `${count}` : ""}</Text>
      <Pressable style={styles.iconBtn} onPress={onClose} accessibilityLabel="Close find">
        <ThemedX size={14} uniProps={muted} />
      </Pressable>
    </View>
  );
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
const ThemedArrowDown = withUnistyles(ArrowDownToLine);
const ThemedCollapseAll = withUnistyles(ChevronsDownUp);
const ThemedExpandAll = withUnistyles(ChevronsUpDown);
const ThemedFile = withUnistyles(FileIcon);
const ThemedFolder = withUnistyles(Folder);
const ThemedFolderUp = withUnistyles(FolderUp);
const ThemedUpload = withUnistyles(Upload);
const ThemedX = withUnistyles(X);
const ThemedMore = withUnistyles(MoreVertical);
const ThemedEye = withUnistyles(Eye);
const ThemedPencil = withUnistyles(Pencil);
const ThemedFolderPlus = withUnistyles(FolderPlus);

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

  const compact = useIsCompactFormFactor();
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
      {compact ? null : (
        <Text style={[styles.cell, styles.colImage]} numberOfLines={1}>
          {container.image}
        </Text>
      )}
      <Text
        style={[styles.cell, styles.colStatus, running ? styles.statusRunning : null]}
        numberOfLines={1}
      >
        {container.status}
      </Text>
      {compact ? null : (
        <Text style={[styles.cell, styles.colPorts]} numberOfLines={1}>
          {container.ports || "—"}
        </Text>
      )}
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
  const compact = useIsCompactFormFactor();
  return (
    <View style={styles.thead}>
      <Text style={[styles.th, styles.colNameHead]}>NAME</Text>
      {compact ? null : <Text style={[styles.th, styles.colImage]}>IMAGE</Text>}
      <Text style={[styles.th, styles.colStatus]}>STATUS</Text>
      {compact ? null : <Text style={[styles.th, styles.colPorts]}>PORTS</Text>}
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
  const compact = useIsCompactFormFactor();
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
      {compact ? null : (
        <Text style={[styles.cell, styles.colPorts]} numberOfLines={1}>
          {image.createdSince}
        </Text>
      )}
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
  const compact = useIsCompactFormFactor();
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
            {compact ? null : <Text style={[styles.th, styles.colPorts]}>CREATED</Text>}
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
  const compact = useIsCompactFormFactor();
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
      {compact ? null : (
        <Text style={[styles.cell, styles.colPorts]} numberOfLines={1}>
          {volume.scope}
        </Text>
      )}
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
  const compact = useIsCompactFormFactor();
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
            {compact ? null : <Text style={[styles.th, styles.colPorts]}>SCOPE</Text>}
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
  const [stuck, setStuck] = useState(true);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const scrollRef = useRef<ScrollView>(null);
  const stickRef = useRef(true);
  useEffect(() => {
    if (!client) return;
    const subscriptionId = randomId("dlogs");
    setText("");
    stickRef.current = true;
    setStuck(true);
    const off = client.onDockerLogChunk(subscriptionId, ({ chunk }) => {
      setText((prev) => (prev + chunk).slice(-400_000));
    });
    void client.dockerLogsSubscribe({ subscriptionId, container: container.id, tail: 500 });
    return () => {
      off();
      client.dockerLogsUnsubscribe({ subscriptionId });
    };
  }, [client, container.id]);

  const toggleFind = useCallback(() => setFindOpen((v) => !v), []);
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setQuery("");
  }, []);
  useCmdF(toggleFind, closeFind);

  const onContentSizeChange = useCallback(() => {
    if (stickRef.current) scrollRef.current?.scrollToEnd({ animated: false });
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
      const atBottom = layoutMeasurement.height + contentOffset.y >= contentSize.height - 48;
      stickRef.current = atBottom;
      setStuck(atBottom);
    },
    [],
  );
  const jumpToBottom = useCallback(() => {
    stickRef.current = true;
    setStuck(true);
    scrollRef.current?.scrollToEnd({ animated: true });
  }, []);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!q) return text;
    return text
      .split("\n")
      .filter((line) => line.toLowerCase().includes(q))
      .join("\n");
  }, [text, q]);
  const matchCount = useMemo(
    () => (q ? shown.split("\n").filter((l) => l.length > 0).length : 0),
    [shown, q],
  );

  return (
    <View style={styles.tabBody}>
      {findOpen ? (
        <FindBar query={query} count={matchCount} onQuery={setQuery} onClose={closeFind} />
      ) : null}
      <View style={styles.consoleWrap}>
        <ScrollView
          ref={scrollRef}
          style={styles.console}
          contentContainerStyle={styles.consoleContent}
          onContentSizeChange={onContentSizeChange}
          onScroll={onScroll}
          scrollEventThrottle={80}
        >
          <Text style={styles.consoleText} selectable>
            {shown || (q ? "No matching lines." : "Waiting for output…")}
          </Text>
        </ScrollView>
        {stuck ? null : (
          <Pressable
            style={styles.followBtn}
            onPress={jumpToBottom}
            accessibilityLabel="Follow logs"
          >
            <ThemedArrowDown size={16} uniProps={accentFg} />
            <Text style={styles.followText}>Follow</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

// ── collapsible JSON viewer for Inspect: fold/expand, line numbers, colors, find ──
type JsonKind = "key" | "str" | "num" | "kw" | "punct" | "muted" | "plain";
interface JsonToken {
  t: string;
  k: JsonKind;
}
interface JsonRow {
  id: string;
  depth: number;
  tokens: JsonToken[];
  path: string;
  collapsible: boolean;
}

// Module-level cache so the indent spacer's style object isn't recreated each render.
const jsonIndentCache = new Map<number, { width: number }>();
function jsonIndent(depth: number): { width: number } {
  let s = jsonIndentCache.get(depth);
  if (!s) {
    s = { width: depth * 14 };
    jsonIndentCache.set(depth, s);
  }
  return s;
}

function primitiveToken(val: unknown): JsonToken {
  if (typeof val === "string") return { t: JSON.stringify(val), k: "str" };
  if (typeof val === "number") return { t: String(val), k: "num" };
  if (typeof val === "boolean" || val === null) return { t: String(val), k: "kw" };
  return { t: String(val), k: "plain" };
}

function buildJsonRows(
  root: unknown,
  collapsed: ReadonlySet<string>,
  forceExpand: boolean,
): { rows: JsonRow[]; collapsiblePaths: string[] } {
  const rows: JsonRow[] = [];
  const collapsiblePaths: string[] = [];
  const keyToks = (key: string | undefined): JsonToken[] =>
    key === undefined
      ? []
      : [
          { t: JSON.stringify(key), k: "key" },
          { t: ": ", k: "punct" },
        ];

  const walk = (
    key: string | undefined,
    val: unknown,
    depth: number,
    path: string,
    comma: boolean,
  ) => {
    const tail = comma ? "," : "";
    if (Array.isArray(val)) {
      if (val.length === 0) {
        rows.push({
          id: path,
          depth,
          path,
          collapsible: false,
          tokens: [...keyToks(key), { t: `[]${tail}`, k: "punct" }],
        });
        return;
      }
      collapsiblePaths.push(path);
      const isCollapsed = !forceExpand && collapsed.has(path);
      if (isCollapsed) {
        rows.push({
          id: path,
          depth,
          path,
          collapsible: true,
          tokens: [
            ...keyToks(key),
            { t: "[", k: "punct" },
            { t: ` ⋯ ${val.length} `, k: "muted" },
            { t: `]${tail}`, k: "punct" },
          ],
        });
      } else {
        rows.push({
          id: path,
          depth,
          path,
          collapsible: true,
          tokens: [...keyToks(key), { t: "[", k: "punct" }],
        });
        val.forEach((v, i) => walk(undefined, v, depth + 1, `${path}/${i}`, i < val.length - 1));
        rows.push({
          id: `${path}~c`,
          depth,
          path,
          collapsible: false,
          tokens: [{ t: `]${tail}`, k: "punct" }],
        });
      }
    } else if (val && typeof val === "object") {
      const keys = Object.keys(val as Record<string, unknown>);
      if (keys.length === 0) {
        rows.push({
          id: path,
          depth,
          path,
          collapsible: false,
          tokens: [...keyToks(key), { t: `{}${tail}`, k: "punct" }],
        });
        return;
      }
      collapsiblePaths.push(path);
      const isCollapsed = !forceExpand && collapsed.has(path);
      if (isCollapsed) {
        rows.push({
          id: path,
          depth,
          path,
          collapsible: true,
          tokens: [
            ...keyToks(key),
            { t: "{", k: "punct" },
            { t: ` ⋯ ${keys.length} `, k: "muted" },
            { t: `}${tail}`, k: "punct" },
          ],
        });
      } else {
        rows.push({
          id: path,
          depth,
          path,
          collapsible: true,
          tokens: [...keyToks(key), { t: "{", k: "punct" }],
        });
        keys.forEach((k, i) =>
          walk(
            k,
            (val as Record<string, unknown>)[k],
            depth + 1,
            `${path}/${k}`,
            i < keys.length - 1,
          ),
        );
        rows.push({
          id: `${path}~c`,
          depth,
          path,
          collapsible: false,
          tokens: [{ t: `}${tail}`, k: "punct" }],
        });
      }
    } else {
      rows.push({
        id: path,
        depth,
        path,
        collapsible: false,
        tokens: [
          ...keyToks(key),
          primitiveToken(val),
          ...(comma ? [{ t: ",", k: "punct" as JsonKind }] : []),
        ],
      });
    }
  };

  walk(undefined, root, 0, "$", false);
  return { rows, collapsiblePaths };
}

const JSON_TOKEN_STYLE: Record<
  JsonKind,
  "jsonKey" | "jsonStr" | "jsonNum" | "jsonKeyword" | "jsonPunct" | "jsonMuted" | "jsonPlain"
> = {
  key: "jsonKey",
  str: "jsonStr",
  num: "jsonNum",
  kw: "jsonKeyword",
  punct: "jsonPunct",
  muted: "jsonMuted",
  plain: "jsonPlain",
};

function JsonRowView({
  row,
  lineNo,
  query,
  onToggle,
  collapsed,
}: {
  row: JsonRow;
  lineNo: number;
  query: string;
  onToggle: (path: string) => void;
  collapsed: boolean;
}) {
  const toggle = useCallback(() => onToggle(row.path), [onToggle, row.path]);
  const keyedTokens = useMemo(
    () => row.tokens.map((tok, i) => ({ tok, key: `${row.id}#${i}` })),
    [row.tokens, row.id],
  );
  let chevron = <View style={styles.jsonChevronSpacer} />;
  if (row.collapsible) {
    chevron = collapsed ? (
      <ThemedChevronRight size={13} uniProps={muted} />
    ) : (
      <ThemedChevronDown size={13} uniProps={muted} />
    );
  }
  return (
    <Pressable style={styles.jsonRow} onPress={row.collapsible ? toggle : undefined}>
      <Text style={styles.jsonGutter} selectable={false}>
        {lineNo}
      </Text>
      <View style={jsonIndent(row.depth)} />
      {chevron}
      <Text style={styles.jsonLine} selectable>
        {keyedTokens.map(({ tok, key }) => (
          <Text
            key={key}
            style={[
              styles[JSON_TOKEN_STYLE[tok.k]],
              query.length > 0 && tok.t.toLowerCase().includes(query) ? styles.jsonMatch : null,
            ]}
          >
            {tok.t}
          </Text>
        ))}
      </Text>
    </Pressable>
  );
}

function JsonTree({ value }: { value: unknown }) {
  const [collapsedSet, setCollapsedSet] = useState<ReadonlySet<string>>(new Set());
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const toggleFind = useCallback(() => setFindOpen((v) => !v), []);
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setQuery("");
  }, []);
  useCmdF(toggleFind, closeFind);

  const { rows, collapsiblePaths } = useMemo(
    () => buildJsonRows(value, collapsedSet, q.length > 0),
    [value, collapsedSet, q],
  );
  const toggle = useCallback((path: string) => {
    setCollapsedSet((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const expandAll = useCallback(() => setCollapsedSet(new Set()), []);
  const collapseAll = useCallback(
    () => setCollapsedSet(new Set(collapsiblePaths.filter((p) => p !== "$"))),
    [collapsiblePaths],
  );
  const matchCount = useMemo(
    () => (q ? rows.filter((r) => r.tokens.some((t) => t.t.toLowerCase().includes(q))).length : 0),
    [rows, q],
  );

  return (
    <View style={styles.tabBody}>
      <View style={styles.jsonToolbar}>
        <Pressable style={styles.miniBtn} onPress={expandAll}>
          <ThemedExpandAll size={13} uniProps={muted} />
          <Text style={styles.miniBtnText}>Expand all</Text>
        </Pressable>
        <Pressable style={styles.miniBtn} onPress={collapseAll}>
          <ThemedCollapseAll size={13} uniProps={muted} />
          <Text style={styles.miniBtnText}>Collapse all</Text>
        </Pressable>
      </View>
      {findOpen ? (
        <FindBar query={query} count={matchCount} onQuery={setQuery} onClose={closeFind} />
      ) : null}
      <ScrollView style={styles.console} contentContainerStyle={styles.jsonContent}>
        {rows.map((row, i) => (
          <JsonRowView
            key={row.id}
            row={row}
            lineNo={i + 1}
            query={q}
            onToggle={toggle}
            collapsed={collapsedSet.has(row.path)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function InspectTab({
  client,
  container,
}: {
  client: DaemonClient | null;
  container: DockerContainer;
}) {
  const [value, setValue] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!client) return;
    let alive = true;
    setValue(null);
    setError(null);
    void client
      .dockerInspect({ container: container.id })
      .then((res) => {
        if (!alive) return undefined;
        if (res.error) {
          setError(res.error);
          return undefined;
        }
        try {
          const parsed = JSON.parse(res.inspect) as unknown;
          setValue(Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed);
        } catch {
          setError(res.inspect);
        }
        return undefined;
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : "Failed to inspect");
      });
    return () => {
      alive = false;
    };
  }, [client, container.id]);

  if (error) {
    return (
      <ScrollView style={styles.console} contentContainerStyle={styles.consoleContent}>
        <Text style={styles.consoleText} selectable>
          {error}
        </Text>
      </ScrollView>
    );
  }
  if (value === null) {
    return <Text style={styles.consoleHint}>Loading…</Text>;
  }
  return <JsonTree value={value} />;
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

// ── Files: browse the container filesystem and copy files to/from the daemon host ──
function joinPath(base: string, name: string): string {
  return base === "/" ? `/${name}` : `${base}/${name}`;
}
function parentPath(path: string): string {
  if (path === "/" || path === "") return "/";
  const idx = path.replace(/\/$/, "").lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

function FileRow({
  entry,
  busy,
  onOpen,
  onCopyToHost,
  onMenu,
}: {
  entry: DockerFsEntry;
  busy: boolean;
  onOpen: (entry: DockerFsEntry) => void;
  onCopyToHost: (name: string) => void;
  onMenu: (entry: DockerFsEntry, x: number, y: number) => void;
}) {
  const rowRef = useRef<View>(null);
  const open = useCallback(() => onOpen(entry), [onOpen, entry]);
  const copy = useCallback(() => onCopyToHost(entry.name), [onCopyToHost, entry.name]);
  const openMenu = useCallback(
    (e: { nativeEvent: { pageX: number; pageY: number } }) => {
      onMenu(entry, e.nativeEvent.pageX, e.nativeEvent.pageY);
    },
    [onMenu, entry],
  );
  // Native right-click (web) opens the same menu at the cursor.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const node = rowRef.current as unknown as HTMLElement | null;
    if (!node?.addEventListener) return;
    const handler = (ev: MouseEvent) => {
      ev.preventDefault();
      onMenu(entry, ev.clientX, ev.clientY);
    };
    node.addEventListener("contextmenu", handler);
    return () => node.removeEventListener("contextmenu", handler);
  }, [entry, onMenu]);

  return (
    <Pressable ref={rowRef} style={styles.trow} onPress={open}>
      <View style={styles.colNameWide}>
        {entry.isDir ? (
          <ThemedFolder size={15} uniProps={fg} />
        ) : (
          <ThemedFile size={15} uniProps={muted} />
        )}
        <Text style={styles.cellStrong} numberOfLines={1}>
          {entry.name}
        </Text>
      </View>
      <View style={styles.colActions}>
        {entry.isDir ? null : (
          <IconBtn
            icon={ThemedDownload}
            tint={muted}
            label="Copy to host"
            onPress={copy}
            disabled={busy}
          />
        )}
        <Pressable style={styles.iconBtn} onPress={openMenu} accessibilityLabel="More actions">
          <ThemedMore size={16} uniProps={muted} />
        </Pressable>
      </View>
    </Pressable>
  );
}

// ── overlays (Modal-based so coordinates are screen-relative) ──
type MenuAction = "view" | "edit" | "rename" | "delete";

function MenuItem({
  action,
  label,
  icon: Icon,
  tint,
  danger,
  onAction,
}: {
  action: MenuAction;
  label: string;
  icon: IconComponent;
  tint: (t: Theme) => object;
  danger: boolean;
  onAction: (action: MenuAction) => void;
}) {
  const press = useCallback(() => onAction(action), [onAction, action]);
  return (
    <Pressable style={styles.menuItem} onPress={press}>
      <Icon size={14} uniProps={tint} />
      <Text style={[styles.menuItemText, danger ? styles.menuItemDanger : null]}>{label}</Text>
    </Pressable>
  );
}

function RowMenu({
  entry,
  x,
  y,
  onAction,
  onClose,
}: {
  entry: DockerFsEntry;
  x: number;
  y: number;
  onAction: (action: MenuAction) => void;
  onClose: () => void;
}) {
  // Kebabs sit at the right edge, so open the menu to the LEFT of the cursor and keep it on-screen.
  const pos = useMemo(() => {
    const win = Dimensions.get("window");
    const menuW = 180;
    const menuH = entry.isDir ? 100 : 176;
    const left = Math.max(8, Math.min(x - menuW, win.width - menuW - 8));
    const top = Math.max(8, Math.min(y, win.height - menuH - 8));
    return { left, top };
  }, [x, y, entry.isDir]);
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlayBackdrop} onPress={onClose}>
        <View style={[styles.menu, pos]}>
          {entry.isDir ? null : (
            <MenuItem
              action="view"
              label="View"
              icon={ThemedEye}
              tint={muted}
              danger={false}
              onAction={onAction}
            />
          )}
          {entry.isDir ? null : (
            <MenuItem
              action="edit"
              label="Edit"
              icon={ThemedPencil}
              tint={muted}
              danger={false}
              onAction={onAction}
            />
          )}
          <MenuItem
            action="rename"
            label="Rename"
            icon={ThemedPencil}
            tint={muted}
            danger={false}
            onAction={onAction}
          />
          <MenuItem
            action="delete"
            label="Delete"
            icon={ThemedTrash}
            tint={red}
            danger
            onAction={onAction}
          />
        </View>
      </Pressable>
    </Modal>
  );
}

function PromptModal({
  title,
  initial,
  confirmLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  initial: string;
  confirmLabel: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const submit = useCallback(() => {
    if (value.trim()) onSubmit(value.trim());
  }, [value, onSubmit]);
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlayCenter} onPress={onClose}>
        <Pressable style={styles.dialog}>
          <Text style={styles.dialogTitle}>{title}</Text>
          <ThemedTextInput
            style={styles.pullInput}
            value={value}
            onChangeText={setValue}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            onSubmitEditing={submit}
            uniProps={placeholderColor}
          />
          <View style={styles.dialogActions}>
            <Pressable style={[styles.btn, styles.btnGhost]} onPress={onClose}>
              <Text style={styles.btnGhostText}>Cancel</Text>
            </Pressable>
            <Pressable style={[styles.btn, styles.btnPrimary]} onPress={submit}>
              <Text style={styles.btnPrimaryText}>{confirmLabel}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function FileViewer({
  client,
  container,
  path,
  name,
  startEditing,
  onClose,
  onSaved,
}: {
  client: DaemonClient | null;
  container: string;
  path: string;
  name: string;
  startEditing: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    if (!client) return;
    let alive = true;
    void client
      .dockerFsRead({ container, path })
      .then((res) => {
        if (!alive) return undefined;
        if (res.error) setError(res.error);
        else {
          setContent(res.content);
          setDraft(res.content);
          setTruncated(res.truncated);
        }
        return undefined;
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : "Failed to read file");
      });
    return () => {
      alive = false;
    };
  }, [client, container, path]);

  const startEdit = useCallback(() => setEditing(true), []);
  const save = useCallback(async () => {
    if (!client) return;
    setSaving(true);
    setError(null);
    try {
      const res = await client.dockerFsWrite({ container, path, content: draft });
      if (res.error) setError(res.error);
      else {
        setContent(draft);
        setEditing(false);
        onSaved();
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [client, container, path, draft, onSaved]);

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlayCenter} onPress={onClose}>
        <Pressable style={styles.viewerPanel}>
          <View style={styles.viewerHeader}>
            <ThemedFile size={15} uniProps={muted} />
            <Text style={styles.viewerTitle} numberOfLines={1}>
              {name}
            </Text>
            {truncated ? <Text style={styles.viewerBadge}>truncated</Text> : null}
            <View style={styles.headerSpacer} />
            {editing ? (
              <Pressable
                style={[styles.btn, styles.btnPrimary, saving && styles.btnDisabled]}
                onPress={save}
                disabled={saving}
              >
                <Text style={styles.btnPrimaryText}>{saving ? "Saving…" : "Save"}</Text>
              </Pressable>
            ) : (
              <Pressable style={[styles.btn, styles.btnGhost]} onPress={startEdit}>
                <ThemedPencil size={13} uniProps={fg} />
                <Text style={styles.btnGhostText}>Edit</Text>
              </Pressable>
            )}
            <Pressable style={styles.iconBtn} onPress={onClose} accessibilityLabel="Close">
              <ThemedX size={18} uniProps={muted} />
            </Pressable>
          </View>
          {error ? (
            <View style={styles.viewerError}>
              <ThemedCircleAlert size={15} uniProps={red} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}
          {editing ? (
            <ThemedTextInput
              style={styles.viewerEditor}
              value={draft}
              onChangeText={setDraft}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              uniProps={placeholderColor}
            />
          ) : (
            <ScrollView style={styles.viewerBody} contentContainerStyle={styles.consoleContent}>
              <Text style={styles.consoleText} selectable>
                {content ?? (error ? "" : "Loading…")}
              </Text>
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function FilesTab({
  client,
  container,
  defaultHostDir,
}: {
  client: DaemonClient | null;
  container: DockerContainer;
  defaultHostDir: string;
}) {
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<DockerFsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [hostDir, setHostDir] = useState(defaultHostDir);
  const [importPath, setImportPath] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (p: string) => {
      if (!client) return;
      setLoading(true);
      setError(null);
      try {
        const res = await client.dockerFsList({ container: container.id, path: p });
        if (res.error) setError(res.error);
        else {
          setEntries(res.entries);
          setPath(p);
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Failed to list files");
      } finally {
        setLoading(false);
      }
    },
    [client, container.id],
  );
  useEffect(() => {
    void load("/");
  }, [load]);

  const [menu, setMenu] = useState<{ entry: DockerFsEntry; x: number; y: number } | null>(null);
  const [viewer, setViewer] = useState<{ path: string; name: string; edit: boolean } | null>(null);
  const [prompt, setPrompt] = useState<{ kind: "rename" | "mkdir"; entry?: DockerFsEntry } | null>(
    null,
  );
  const hasNativePicker = typeof getDesktopHost()?.dialog?.open === "function";

  const onOpen = useCallback(
    (entry: DockerFsEntry) => {
      if (entry.isDir) void load(joinPath(path, entry.name));
      else setViewer({ path: joinPath(path, entry.name), name: entry.name, edit: false });
    },
    [load, path],
  );
  const goUp = useCallback(() => void load(parentPath(path)), [load, path]);
  const refresh = useCallback(() => void load(path), [load, path]);

  const onMenu = useCallback(
    (entry: DockerFsEntry, x: number, y: number) => setMenu({ entry, x, y }),
    [],
  );
  const openMkdir = useCallback(() => setPrompt({ kind: "mkdir" }), []);
  const browseHostDir = useCallback(() => {
    void pickHostPath("dir").then((p) => {
      if (p) setHostDir(p);
      return undefined;
    });
  }, []);
  const browseImport = useCallback(() => {
    void pickHostPath("file").then((p) => {
      if (p) setImportPath(p);
      return undefined;
    });
  }, []);

  const copyToHost = useCallback(
    async (name: string) => {
      if (!client) return;
      setBusy(name);
      setError(null);
      setNotice(null);
      try {
        const res = await client.dockerCp({
          container: container.id,
          direction: "to_host",
          containerPath: joinPath(path, name),
          hostPath: joinPath(hostDir, name),
        });
        if (res.error) setError(res.error);
        else setNotice(`Copied ${name} → ${joinPath(hostDir, name)}`);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Copy failed");
      } finally {
        setBusy(null);
      }
    },
    [client, container.id, path, hostDir],
  );
  const copyFromHost = useCallback(async () => {
    const hp = importPath.trim();
    if (!client || !hp) return;
    setBusy("__import__");
    setError(null);
    setNotice(null);
    try {
      const res = await client.dockerCp({
        container: container.id,
        direction: "to_container",
        containerPath: path,
        hostPath: hp,
      });
      if (res.error) setError(res.error);
      else {
        setNotice(`Copied ${hp} → ${path}`);
        setImportPath("");
        await load(path);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Copy failed");
    } finally {
      setBusy(null);
    }
  }, [client, container.id, path, importPath, load]);

  let list = (
    <View style={styles.sectionCard}>
      {entries.map((entry) => (
        <FileRow
          key={entry.name}
          entry={entry}
          busy={busy === entry.name}
          onOpen={onOpen}
          onCopyToHost={copyToHost}
          onMenu={onMenu}
        />
      ))}
    </View>
  );
  if (loading && entries.length === 0) {
    list = <Text style={styles.consoleHint}>Loading…</Text>;
  } else if (entries.length === 0) {
    list = <Text style={styles.emptyText}>Empty directory.</Text>;
  }

  return (
    <>
      <ScrollView style={styles.tabBody} contentContainerStyle={styles.filesContent}>
        <View style={styles.filesToolbar}>
          <Pressable
            style={[styles.btn, styles.btnGhost, path === "/" && styles.btnDisabled]}
            onPress={goUp}
            disabled={path === "/"}
          >
            <ThemedFolderUp size={14} uniProps={fg} />
            <Text style={styles.btnGhostText}>Up</Text>
          </Pressable>
          <View style={styles.filesPath}>
            <Text style={styles.filesPathText} numberOfLines={1}>
              {path}
            </Text>
          </View>
          <Pressable style={[styles.btn, styles.btnGhost]} onPress={openMkdir}>
            <ThemedFolderPlus size={14} uniProps={fg} />
            <Text style={styles.btnGhostText}>New folder</Text>
          </Pressable>
          <Pressable style={[styles.btn, styles.btnGhost]} onPress={refresh}>
            <ThemedRotate size={14} uniProps={fg} />
            <Text style={styles.btnGhostText}>Refresh</Text>
          </Pressable>
        </View>

        <View style={styles.filesCpRow}>
          <Text style={styles.filesCpLabel}>Host dir for downloads</Text>
          <ThemedTextInput
            style={styles.pullInput}
            value={hostDir}
            onChangeText={setHostDir}
            placeholder="/path/on/host"
            autoCapitalize="none"
            autoCorrect={false}
            uniProps={placeholderColor}
          />
          {hasNativePicker ? (
            <Pressable style={[styles.btn, styles.btnGhost]} onPress={browseHostDir}>
              <ThemedFolder size={14} uniProps={fg} />
              <Text style={styles.btnGhostText}>Browse</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={styles.filesCpRow}>
          <ThemedTextInput
            style={styles.pullInput}
            value={importPath}
            onChangeText={setImportPath}
            placeholder="Host file to copy into this folder"
            autoCapitalize="none"
            autoCorrect={false}
            uniProps={placeholderColor}
          />
          {hasNativePicker ? (
            <Pressable style={[styles.btn, styles.btnGhost]} onPress={browseImport}>
              <ThemedFile size={14} uniProps={fg} />
              <Text style={styles.btnGhostText}>Browse</Text>
            </Pressable>
          ) : null}
          <Pressable
            style={[
              styles.btn,
              styles.btnPrimary,
              (busy === "__import__" || !importPath) && styles.btnDisabled,
            ]}
            onPress={copyFromHost}
            disabled={busy === "__import__" || !importPath}
          >
            <ThemedUpload size={13} uniProps={accentFg} />
            <Text style={styles.btnPrimaryText}>
              {busy === "__import__" ? "Copying…" : "Upload"}
            </Text>
          </Pressable>
        </View>

        {error ? (
          <View style={styles.errorBanner}>
            <ThemedCircleAlert size={15} uniProps={red} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}
        {notice ? <Text style={styles.filesNotice}>{notice}</Text> : null}

        {list}
      </ScrollView>

      <FilesOverlays
        client={client}
        containerId={container.id}
        path={path}
        refresh={refresh}
        setError={setError}
        setNotice={setNotice}
        menu={menu}
        setMenu={setMenu}
        viewer={viewer}
        setViewer={setViewer}
        prompt={prompt}
        setPrompt={setPrompt}
      />
    </>
  );
}

type MenuState = { entry: DockerFsEntry; x: number; y: number } | null;
type ViewerState = { path: string; name: string; edit: boolean } | null;
type PromptState = { kind: "rename" | "mkdir"; entry?: DockerFsEntry } | null;
function FilesOverlays({
  client,
  containerId,
  path,
  refresh,
  setError,
  setNotice,
  menu,
  setMenu,
  viewer,
  setViewer,
  prompt,
  setPrompt,
}: {
  client: DaemonClient | null;
  containerId: string;
  path: string;
  refresh: () => void;
  setError: (v: string | null) => void;
  setNotice: (v: string | null) => void;
  menu: MenuState;
  setMenu: (v: MenuState) => void;
  viewer: ViewerState;
  setViewer: (v: ViewerState) => void;
  prompt: PromptState;
  setPrompt: (v: PromptState) => void;
}) {
  const runOp = useCallback(
    async (fn: () => Promise<{ error: string | null }>, successMsg: string) => {
      setError(null);
      setNotice(null);
      try {
        const res = await fn();
        if (res.error) setError(res.error);
        else {
          setNotice(successMsg);
          refresh();
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Operation failed");
      }
    },
    [setError, setNotice, refresh],
  );
  const closeMenu = useCallback(() => setMenu(null), [setMenu]);
  const onMenuAction = useCallback(
    (action: MenuAction) => {
      if (!menu) return;
      const entry = menu.entry;
      setMenu(null);
      const full = joinPath(path, entry.name);
      if (action === "view") setViewer({ path: full, name: entry.name, edit: false });
      else if (action === "edit") setViewer({ path: full, name: entry.name, edit: true });
      else if (action === "rename") setPrompt({ kind: "rename", entry });
      else if (client)
        void runOp(
          () => client.dockerFsOp({ container: containerId, op: "delete", path: full }),
          `Deleted ${entry.name}`,
        );
    },
    [menu, path, client, containerId, runOp, setMenu, setViewer, setPrompt],
  );
  const closeViewer = useCallback(() => setViewer(null), [setViewer]);
  const closePrompt = useCallback(() => setPrompt(null), [setPrompt]);
  const onPromptSubmit = useCallback(
    (value: string) => {
      if (!client || !prompt) return;
      const p = prompt;
      setPrompt(null);
      if (p.kind === "mkdir") {
        void runOp(
          () =>
            client.dockerFsOp({ container: containerId, op: "mkdir", path: joinPath(path, value) }),
          `Created ${value}`,
        );
      } else if (p.entry) {
        const from = p.entry.name;
        void runOp(
          () =>
            client.dockerFsOp({
              container: containerId,
              op: "rename",
              path: joinPath(path, from),
              newPath: joinPath(path, value),
            }),
          `Renamed to ${value}`,
        );
      }
    },
    [client, prompt, containerId, path, runOp, setPrompt],
  );
  return (
    <>
      {menu ? (
        <RowMenu
          entry={menu.entry}
          x={menu.x}
          y={menu.y}
          onAction={onMenuAction}
          onClose={closeMenu}
        />
      ) : null}
      {viewer ? (
        <FileViewer
          client={client}
          container={containerId}
          path={viewer.path}
          name={viewer.name}
          startEditing={viewer.edit}
          onClose={closeViewer}
          onSaved={refresh}
        />
      ) : null}
      {prompt ? (
        <PromptModal
          title={prompt.kind === "mkdir" ? "New folder name" : `Rename ${prompt.entry?.name ?? ""}`}
          initial={prompt.kind === "rename" ? (prompt.entry?.name ?? "") : ""}
          confirmLabel={prompt.kind === "mkdir" ? "Create" : "Rename"}
          onSubmit={onPromptSubmit}
          onClose={closePrompt}
        />
      ) : null}
    </>
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
  const showFiles = useCallback(() => setTab("files"), []);
  const showExec = useCallback(() => setTab("exec"), []);
  const stop = useCallback(() => onAction(container.id, "stop"), [onAction, container.id]);
  const start = useCallback(() => onAction(container.id, "start"), [onAction, container.id]);
  const unpause = useCallback(() => onAction(container.id, "unpause"), [onAction, container.id]);
  const restart = useCallback(() => onAction(container.id, "restart"), [onAction, container.id]);
  const remove = useCallback(() => onAction(container.id, "remove"), [onAction, container.id]);

  let content = <LogsTab client={client} container={container} />;
  if (tab === "inspect") content = <InspectTab client={client} container={container} />;
  else if (tab === "stats") content = <StatsTab client={client} container={container} />;
  else if (tab === "files")
    content = <FilesTab client={client} container={container} defaultHostDir={cwd} />;
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
        <View style={isCompact ? styles.tabRowWrap : styles.tabRow}>
          <TabButton label="Logs" active={tab === "logs"} onPress={showLogs} />
          <TabButton label="Stats" active={tab === "stats"} onPress={showStats} />
          <TabButton label="Inspect" active={tab === "inspect"} onPress={showInspect} />
          <TabButton label="Files" active={tab === "files"} onPress={showFiles} />
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
    marginTop: theme.spacing[2],
    marginBottom: theme.spacing[1],
  },
  tabRowWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    padding: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    alignSelf: "stretch",
  },
  tabBody: {
    flex: 1,
    minHeight: 0,
  },
  consoleWrap: {
    flex: 1,
    minHeight: 0,
  },
  followBtn: {
    position: "absolute",
    right: theme.spacing[6],
    bottom: theme.spacing[6],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  followText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  findBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginHorizontal: theme.spacing[4],
    marginTop: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    height: 34,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  findInput: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  findCount: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    minWidth: 24,
    textAlign: "right",
  },
  jsonToolbar: {
    flexDirection: "row",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    marginTop: theme.spacing[2],
  },
  miniBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  miniBtnText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  jsonContent: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  jsonRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 1,
  },
  jsonGutter: {
    width: 40,
    textAlign: "right",
    marginRight: theme.spacing[2],
    fontSize: 11,
    lineHeight: 18,
    color: theme.colors.palette.zinc[500],
    fontFamily: "monospace",
  },
  jsonChevronSpacer: {
    width: 13,
  },
  jsonLine: {
    flex: 1,
    fontSize: theme.fontSize.xs,
    lineHeight: 18,
    fontFamily: "monospace",
    color: theme.colors.palette.zinc[100],
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
  jsonPunct: {
    color: theme.colors.palette.zinc[400],
  },
  jsonMuted: {
    color: theme.colors.palette.zinc[500],
  },
  jsonPlain: {
    color: theme.colors.palette.zinc[100],
  },
  jsonMatch: {
    backgroundColor: theme.colors.palette.amber[500],
    color: theme.colors.palette.zinc[900],
  },
  filesContent: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  filesToolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  filesPath: {
    flex: 1,
    height: 34,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  filesPathText: {
    fontSize: theme.fontSize.sm,
    fontFamily: "monospace",
    color: theme.colors.foreground,
  },
  filesCpRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  filesCpLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    width: 160,
  },
  filesNotice: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.palette.green[600],
  },
  // ── overlays ──
  overlayBackdrop: {
    flex: 1,
  },
  overlayCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.35)",
    padding: theme.spacing[4],
  },
  menu: {
    position: "absolute",
    minWidth: 160,
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  menuItemText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  menuItemDanger: {
    color: theme.colors.palette.red[500],
  },
  dialog: {
    width: 420,
    maxWidth: "100%",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  dialogTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  dialogActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  viewerPanel: {
    width: 900,
    maxWidth: "100%",
    height: 640,
    maxHeight: "100%",
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  viewerHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  viewerTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  viewerBadge: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.palette.amber[700],
  },
  viewerError: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    backgroundColor: theme.colors.palette.red[100],
  },
  viewerBody: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.palette.zinc[900],
  },
  viewerEditor: {
    flex: 1,
    minHeight: 0,
    padding: theme.spacing[3],
    backgroundColor: theme.colors.palette.zinc[900],
    color: theme.colors.palette.zinc[100],
    fontFamily: "monospace",
    fontSize: theme.fontSize.xs,
    textAlignVertical: "top",
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
