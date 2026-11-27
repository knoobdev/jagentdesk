// The Bots section of the sidebar, between Tools and Projects (spec 37.4.1, 38.4.2). Ported from
// Orca dfdb4fda (MIT) src/renderer/src/components/bots/SidebarBotsSection.tsx:63-410 (header, `+`
// menu, empty card, list), BotRow.tsx:51-200 (row, context menu), BotSidebarRow.tsx, BotSidebarChats.tsx
// (chat → worker tree), SidebarBotsEmptyState.tsx, BotCollapsedPreview.tsx:120-140, and
// src/shared/bots/bot-sidebar-tree.ts (8 workers per step). Paired servers, search, drag reorder,
// Mark Read/Unread (the contract has no bot unread state) and "Import from another app…" are not here.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
} from "react-native";
import { useGlobalSearchParams, usePathname } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  Bot as BotIcon,
  ChevronDown,
  ChevronRight,
  Copy,
  Pause,
  Pencil,
  Play,
  Plus,
  Settings,
  Trash2,
  Users,
} from "lucide-react-native";
import type { Bot, BotRoom } from "@jagentdesk/protocol/bots/types";
import type { BotChat, BotChatWorker } from "@jagentdesk/protocol/bots/views";
import { BOT_EMPTY_STATE_MASCOTS } from "@jagentdesk/protocol/bots/rules";
import type { Theme } from "@/styles/theme";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  type MenuPageDefinition,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { confirmDialog } from "@/utils/confirm-dialog";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useHostFeature } from "@/runtime/host-features";
import { BotAvatar, BotAvatarTile, botPicture } from "./avatar";
import { minuteNow, useBotLiveState } from "./bot-status";
import { botRowLineText, type BotRowMark } from "./row-line";
import {
  useBots,
  useBotsConnection,
  useBotsMutation,
  useBotsPushes,
  useChatTree,
  useRooms,
  botErrorMessage,
} from "./queries";
import { openBot, openBotRoom } from "./navigation";
import { openBotsDialog } from "./dialogs-store";
import { useBotOwnedWorkspaces } from "./owned-workspaces-store";
import { BotsDialogsHost } from "./dialogs/host";
import { useIsCompactFormFactor } from "@/constants/layout";
import { PhoneBotsEmpty, PhoneBotsNewButton } from "./phone/drawer-parts";
import {
  SIDEBAR_BOTS_MAX_SHARE,
  clampBotsHeight,
  useBotsSidebarStore,
  useSidebarMiddleHeight,
} from "./sidebar-store";

const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foreground = (theme: Theme) => ({ color: theme.colors.foreground });
const ThemedPlus = withUnistyles(Plus);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const BOT_ICON = <BotIcon size={16} />;
const USERS_ICON = <Users size={16} />;
const SETTINGS_ICON = <Settings size={16} />;
const PENCIL_ICON = <Pencil size={16} />;
const PLAY_ICON = <Play size={16} />;
const PAUSE_ICON = <Pause size={16} />;
const COPY_ICON = <Copy size={16} />;
const TRASH_ICON = <Trash2 size={16} />;
/** `shared/bots/bot-sidebar-tree.ts`: a chat lists its workers 8 at a time. */
const WORKER_STEP = 8;
const EMPTY_PICTURES = BOT_EMPTY_STATE_MASCOTS.map((id) =>
  botPicture({ name: id, avatar: `mascot:${id}`, avatarColor: undefined, avatarOutfit: null }),
);

/** The bot whose page is open, from `/h/<serverId>/bots?botId=…`. */
function useActiveBotTarget(): { botId: string | null; roomId: string | null } {
  const pathname = usePathname();
  const params = useGlobalSearchParams<{ botId?: string; roomId?: string }>();
  if (!/\/h\/[^/]+\/bots(?:$|[/?])/.test(pathname)) return { botId: null, roomId: null };
  return { botId: params.botId ?? null, roomId: params.roomId ?? null };
}

export function SidebarBotsSection({
  serverId,
  onNavigate,
}: {
  serverId: string;
  onNavigate: () => void;
}) {
  const enabled = useHostFeature(serverId, "bots");
  if (!enabled) return null;
  return (
    <>
      <BotsSection serverId={serverId} onNavigate={onNavigate} />
      <BotsDialogsHost />
    </>
  );
}

function BotsSection({ serverId, onNavigate }: { serverId: string; onNavigate: () => void }) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const connection = useBotsConnection(serverId);
  useBotsPushes(serverId);
  const bots = useBots(serverId);
  const rooms = useRooms(serverId);
  const collapsed = useBotsSidebarStore((state) => state.collapsed);
  const toggleCollapsed = useBotsSidebarStore((state) => state.toggleCollapsed);
  const savedHeight = useBotsSidebarStore((state) => state.height);
  const setHeight = useBotsSidebarStore((state) => state.setHeight);
  const middle = useSidebarMiddleHeight((state) => state.height);
  const active = useActiveBotTarget();
  const list = bots.data ?? [];
  const groups = rooms.data ?? [];
  useEffect(() => {
    if (!bots.data) return;
    const live = new Set(bots.data.map((bot) => `${serverId}:${bot.id}`));
    const owned = useBotOwnedWorkspaces.getState();
    for (const key of Object.keys(owned.byBot))
      if (key.startsWith(`${serverId}:`) && !live.has(key))
        owned.publish(serverId, key.slice(serverId.length + 1), null);
  }, [bots.data, serverId]);
  const now = minuteNow();
  const expandedState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  const collapseLabel = collapsed ? t("bots.section.expand") : t("bots.section.collapse");
  // Unsized, the section fits its rows up to 40 % of the middle; dragged, it keeps that height.
  let maxHeight: number | undefined;
  if (middle > 0 && savedHeight !== null) maxHeight = clampBotsHeight(savedHeight, middle);
  else if (middle > 0) maxHeight = Math.max(88, middle * SIDEBAR_BOTS_MAX_SHARE);
  const [listHeight, setListHeight] = useState(0);
  const onListLayout = useCallback((event: LayoutChangeEvent) => {
    setListHeight(event.nativeEvent.layout.height);
  }, []);
  const dragStart = useRef(0);
  const resizer = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          dragStart.current = listHeight;
        },
        onPanResponderMove: (_event, gesture) => {
          const height = useSidebarMiddleHeight.getState().height;
          if (height > 0) setHeight(clampBotsHeight(dragStart.current + gesture.dy, height));
        },
      }),
    [listHeight, setHeight],
  );
  const scrollStyle = useMemo(
    () => [styles.list, maxHeight !== undefined ? { maxHeight } : null],
    [maxHeight],
  );
  const openNewBot = useCallback(() => openBotsDialog({ kind: "newBot", serverId }), [serverId]);
  const openTemplates = useCallback(
    () => openBotsDialog({ kind: "templates", serverId }),
    [serverId],
  );

  let body: ReactNode = null;
  if (!connection.orca && connection.connected && connection.supported)
    body = <Text style={styles.note}>{t("bots.jad.unsupported")}</Text>;
  else if (bots.isSuccess && list.length === 0 && groups.length === 0)
    body = (
      <BotsEmpty
        serverId={serverId}
        compact={compact}
        onNewBot={openNewBot}
        onTemplates={openTemplates}
      />
    );
  else if (bots.error) body = <Text style={styles.note}>{botErrorMessage(bots.error)}</Text>;
  else
    body = (
      <>
        {list.map((bot) => (
          <BotSidebarEntry
            key={bot.id}
            serverId={serverId}
            bot={bot}
            active={active.botId === bot.id}
            now={now}
            onNavigate={onNavigate}
          />
        ))}
        {groups.map((room) => (
          <BotGroupRow
            key={room.id}
            serverId={serverId}
            room={room}
            bots={list}
            active={active.roomId === room.id}
            onNavigate={onNavigate}
          />
        ))}
      </>
    );

  return (
    <View testID="sidebar-bots-section">
      <View style={styles.heading}>
        <Pressable
          style={styles.headingToggle}
          onPress={toggleCollapsed}
          accessibilityRole="button"
          accessibilityLabel={collapseLabel}
          accessibilityState={expandedState}
          aria-expanded={!collapsed}
          testID="sidebar-bots-toggle"
        >
          <Text style={styles.headingLabel} numberOfLines={1}>
            {t("bots.section.title")}
          </Text>
          {collapsed ? (
            <ThemedChevronRight size={14} uniProps={muted} />
          ) : (
            <ThemedChevronDown size={14} uniProps={muted} />
          )}
        </Pressable>
        {collapsed ? null : (
          <BotsNew
            serverId={serverId}
            compact={compact}
            botCount={list.length}
            onNewBot={openNewBot}
          />
        )}
      </View>
      {collapsed ? (
        <BotCollapsedPreview
          serverId={serverId}
          bots={list}
          onExpand={toggleCollapsed}
          onNavigate={onNavigate}
        />
      ) : (
        <>
          <ScrollView
            style={scrollStyle}
            contentContainerStyle={styles.listContent}
            onLayout={onListLayout}
            nestedScrollEnabled
            testID="sidebar-bots-list"
          >
            {body}
          </ScrollView>
          {list.length > 0 ? (
            <View
              {...resizer.panHandlers}
              style={styles.resizer}
              accessibilityRole="adjustable"
              accessibilityLabel={t("bots.section.title")}
              testID="sidebar-bots-resizer"
            >
              <View style={styles.resizerLine} />
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

/** A phone's drawer: `+` is New bot, an empty host one line (spec 37.6). */
function BotsNew({
  serverId,
  compact,
  botCount,
  onNewBot,
}: {
  serverId: string;
  compact: boolean;
  botCount: number;
  onNewBot: () => void;
}) {
  if (compact) return <PhoneBotsNewButton serverId={serverId} />;
  return <BotsNewMenu serverId={serverId} botCount={botCount} onNewBot={onNewBot} />;
}

function BotsEmpty({
  serverId,
  compact,
  onNewBot,
  onTemplates,
}: {
  serverId: string;
  compact: boolean;
  onNewBot: () => void;
  onTemplates: () => void;
}) {
  if (compact) return <PhoneBotsEmpty serverId={serverId} />;
  return <SidebarBotsEmptyState onNewBot={onNewBot} onTemplates={onTemplates} />;
}

/** The `+` menu: "New bot" (its submenu: Start from scratch, Browse templates, From a link…) and "New group". */
function BotsNewMenu({
  serverId,
  botCount,
  onNewBot,
}: {
  serverId: string;
  botCount: number;
  onNewBot: () => void;
}) {
  const { t } = useTranslation();
  const label = t("bots.section.new");
  const openTemplates = useCallback(
    () => openBotsDialog({ kind: "templates", serverId }),
    [serverId],
  );
  const openShareLink = useCallback(
    () => openBotsDialog({ kind: "shareLink", serverId }),
    [serverId],
  );
  const openGroup = useCallback(() => openBotsDialog({ kind: "group", serverId }), [serverId]);
  const pages = useMemo<MenuPageDefinition[]>(
    () => [
      {
        id: "new-bot",
        title: t("bots.section.newBot"),
        content: (
          <>
            <DropdownMenuItem onSelect={onNewBot} testID="bots-menu-from-scratch">
              {t("bots.section.startFromScratch")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={openTemplates} testID="bots-menu-templates">
              {t("bots.templates.browse")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={openShareLink} testID="bots-menu-from-link">
              {t("bots.share.receive.fromLinkMenu")}
            </DropdownMenuItem>
          </>
        ),
      },
    ],
    [onNewBot, openShareLink, openTemplates, t],
  );
  return (
    <DropdownMenu>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <View>
            <DropdownMenuTrigger
              style={styles.iconButton}
              accessibilityRole="button"
              accessibilityLabel={label}
              testID="sidebar-bots-new"
            >
              <ThemedPlus size={16} uniProps={foreground} />
            </DropdownMenuTrigger>
          </View>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={6}>
          <Text style={styles.tooltip}>{label}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" width={240} pages={pages} testID="sidebar-bots-new-menu">
        <DropdownMenuSubTrigger id="new-bot" leading={BOT_ICON}>
          {t("bots.section.newBot")}
        </DropdownMenuSubTrigger>
        {/* A group needs two bots to talk to each other. */}
        <DropdownMenuItem
          leading={USERS_ICON}
          disabled={botCount < 2}
          onSelect={openGroup}
          testID="bots-menu-new-group"
        >
          {t("bots.groups.newGroup")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** `SidebarBotsEmptyState.tsx`: the section before the first bot, a raised card with the ways to make one. */
function SidebarBotsEmptyState({
  onNewBot,
  onTemplates,
}: {
  onNewBot: () => void;
  onTemplates: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.emptyCard} testID="bots-empty">
      <View style={styles.emptyTitleRow}>
        <View style={styles.faces}>
          {EMPTY_PICTURES.map((picture, index) => (
            <BotAvatarTile
              key={picture.mascot ?? index}
              picture={picture}
              size={16}
              radius={4}
              style={index > 0 ? styles.faceOverlap : undefined}
              testID="bots-empty-mascot"
            />
          ))}
        </View>
        <Text style={styles.emptyTitle}>{t("bots.section.emptyCardTitle")}</Text>
      </View>
      <View style={styles.emptyActions}>
        <Button size="sm" variant="default" onPress={onNewBot} testID="bots-empty-new">
          {t("bots.section.newBot")}
        </Button>
        <Button size="sm" variant="outline" onPress={onTemplates} testID="bots-empty-templates">
          {t("bots.section.emptyTemplates")}
        </Button>
      </View>
    </View>
  );
}

/** `BotCollapsedPreview.tsx`: folded, a row of faces as wide as the sidebar, the rest a count. */
function BotCollapsedPreview({
  serverId,
  bots,
  onExpand,
  onNavigate,
}: {
  serverId: string;
  bots: readonly Bot[];
  onExpand: () => void;
  onNavigate: () => void;
}) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);
  // 24 px a face (20 px tile + 4 px gap); the overflow line takes the last slots.
  const capacity = width > 0 ? Math.max(1, Math.floor(width / 24)) : bots.length;
  const shown = bots.length > capacity ? bots.slice(0, Math.max(1, capacity - 4)) : bots;
  const hidden = bots.length - shown.length;
  if (bots.length === 0) return null;
  return (
    <View style={styles.preview} onLayout={onLayout} testID="sidebar-bots-preview">
      {shown.map((bot) => (
        <PreviewFace key={bot.id} serverId={serverId} bot={bot} onNavigate={onNavigate} />
      ))}
      {hidden > 0 ? (
        <Pressable accessibilityRole="button" onPress={onExpand}>
          <Text style={styles.previewMore}>{t("bots.section.showMore", { count: hidden })}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function PreviewFace({
  serverId,
  bot,
  onNavigate,
}: {
  serverId: string;
  bot: Bot;
  onNavigate: () => void;
}) {
  const open = useCallback(() => {
    onNavigate();
    openBot(serverId, bot.id);
  }, [onNavigate, serverId, bot.id]);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={bot.name} onPress={open}>
      <BotAvatar bot={bot} serverId={serverId} size={20} radius={5} />
    </Pressable>
  );
}

function StatusDot({ mark, style }: { mark: BotRowMark; style?: object }) {
  if (!mark) return null;
  return (
    <View
      style={[
        styles.badge,
        mark === "needs_input" ? styles.badgeNeeds : styles.badgeRunning,
        style,
      ]}
    />
  );
}

function rowStyle(selected: boolean, chat = false) {
  return ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
    chat ? styles.chatRow : styles.botRow,
    selected && styles.selected,
    (hovered || pressed) && !selected && styles.hovered,
  ];
}

function BotSidebarEntry({
  serverId,
  bot,
  active,
  now,
  onNavigate,
}: {
  serverId: string;
  bot: Bot;
  active: boolean;
  now: number;
  onNavigate: () => void;
}) {
  const { t } = useTranslation();
  const live = useBotLiveState(serverId, bot, now);
  useBotOwnedPublisher(serverId, bot);
  const selectedState = useMemo(() => ({ selected: active }), [active]);
  const unfoldKey = `${serverId}:${bot.id}`;
  const unfolded = useBotsSidebarStore((state) => state.unfolded[unfoldKey] === true);
  const setUnfolded = useBotsSidebarStore((state) => state.setUnfolded);
  const pause = useBotsMutation(serverId, "bots.pause.request");
  const update = useBotsMutation(serverId, "bots.update.request");
  const remove = useBotsMutation(serverId, "bots.delete.request");
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(bot.name);
  const open = useCallback(() => {
    onNavigate();
    openBot(serverId, bot.id);
  }, [onNavigate, serverId, bot.id]);
  const toggleFold = useCallback(
    () => setUnfolded(unfoldKey, !unfolded),
    [setUnfolded, unfoldKey, unfolded],
  );
  const openSettings = useCallback(() => {
    onNavigate();
    openBot(serverId, bot.id, { settings: "root" });
  }, [onNavigate, serverId, bot.id]);
  const togglePause = useCallback(
    () => pause.mutate({ botId: bot.id, paused: !bot.paused }),
    [pause, bot.id, bot.paused],
  );
  const startRename = useCallback(() => {
    setDraftName(bot.name);
    setRenaming(true);
  }, [bot.name]);
  const commitRename = useCallback(() => {
    setRenaming(false);
    const name = draftName.trim();
    if (name && name !== bot.name) update.mutate({ botId: bot.id, patch: { name } });
  }, [draftName, bot.id, bot.name, update]);
  const copyPath = useCallback(() => {
    if (bot.home) void copyToClipboard(bot.home);
  }, [bot.home]);
  const deleteBot = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t("bots.row.deleteTitle", { name: bot.name }),
      message: t("bots.row.deleteDescription", { path: bot.home ?? bot.folder ?? bot.slug }),
      confirmLabel: t("bots.row.deleteConfirm"),
      destructive: true,
    });
    if (confirmed) remove.mutate({ botId: bot.id });
  }, [t, bot, remove]);
  const foldLabel = unfolded
    ? t("bots.chats.fold", { name: bot.name })
    : t("bots.chats.unfold", { name: bot.name });
  const line = botRowLineText(live.line, t, now);
  // Long-press on a phone opens the same menu as a sheet.
  const compact = useIsCompactFormFactor();
  return (
    <View>
      <ContextMenu>
        <ContextMenuTrigger
          enabledOnMobile
          accessibilityRole="button"
          accessibilityLabel={bot.name}
          accessibilityState={selectedState}
          onPress={open}
          style={rowStyle(active)}
          testID={`sidebar-bot-${bot.slug}`}
        >
          <Pressable
            onPress={toggleFold}
            style={styles.fold}
            accessibilityRole="button"
            accessibilityLabel={foldLabel}
            aria-expanded={unfolded}
            testID={`sidebar-bot-fold-${bot.slug}`}
          >
            {unfolded ? (
              <ThemedChevronDown size={14} uniProps={muted} />
            ) : (
              <ThemedChevronRight size={14} uniProps={muted} />
            )}
          </Pressable>
          <View style={styles.avatarSlot}>
            <BotAvatar
              bot={bot}
              serverId={serverId}
              size={16}
              radius={4}
              style={bot.paused ? styles.dimmed : undefined}
            />
            <StatusDot mark={live.mark} />
          </View>
          <View style={styles.rowText}>
            {renaming ? (
              <TextInput
                value={draftName}
                onChangeText={setDraftName}
                onSubmitEditing={commitRename}
                onBlur={commitRename}
                autoFocus
                maxLength={64}
                style={styles.renameInput}
                accessibilityLabel={t("bots.row.rename")}
                testID={`sidebar-bot-rename-${bot.slug}`}
              />
            ) : (
              <Text style={styles.botName} numberOfLines={1}>
                {bot.name}
              </Text>
            )}
            <Text style={styles.botLine} numberOfLines={1} testID={`sidebar-bot-line-${bot.slug}`}>
              {line}
            </Text>
          </View>
        </ContextMenuTrigger>
        <ContextMenuContent
          align="start"
          width={220}
          mobileMode={compact ? "sheet" : "dropdown"}
          testID={`sidebar-bot-menu-${bot.slug}`}
        >
          <ContextMenuItem leading={SETTINGS_ICON} onSelect={openSettings}>
            {t("bots.row.settings")}
          </ContextMenuItem>
          <ContextMenuItem leading={PENCIL_ICON} onSelect={startRename}>
            {t("bots.row.rename")}
          </ContextMenuItem>
          <ContextMenuItem
            leading={bot.paused ? PLAY_ICON : PAUSE_ICON}
            onSelect={togglePause}
            testID={`sidebar-bot-pause-${bot.slug}`}
          >
            {bot.paused ? t("bots.row.resume") : t("bots.row.pause")}
          </ContextMenuItem>
          <ContextMenuItem leading={COPY_ICON} disabled={!bot.home} onSelect={copyPath}>
            {t("bots.row.copyPath")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem leading={TRASH_ICON} destructive onSelect={deleteBot}>
            {t("bots.row.delete")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {unfolded ? <BotSidebarChats serverId={serverId} bot={bot} onNavigate={onNavigate} /> : null}
    </View>
  );
}

/** Publishes what the bot owns so the Projects tree leaves it out (`owned-workspaces-store.ts`). */
function useBotOwnedPublisher(serverId: string, bot: Bot) {
  const tree = useChatTree(serverId, bot.id);
  useEffect(() => {
    const chats = [...(tree.data?.home ? [tree.data.home] : []), ...(tree.data?.chats ?? [])];
    const workspaceIds = [
      ...(bot.handedWorkspaces ?? []).map((entry) => entry.workspaceId),
      ...(tree.data?.workspaces ?? []).map((entry) => entry.workspaceId),
    ];
    const workerAgentIds: string[] = [];
    for (const chat of chats) {
      workerAgentIds.push(chat.id);
      for (const worker of chat.workers) workerAgentIds.push(worker.agentId);
    }
    useBotOwnedWorkspaces.getState().publish(serverId, bot.id, {
      workspaceIds: [...new Set(workspaceIds)].sort(),
      workerAgentIds: [...new Set(workerAgentIds)].sort(),
    });
  }, [serverId, bot.id, bot.handedWorkspaces, tree.data]);
}

function workerDotStyle(state: BotChatWorker["state"]) {
  switch (state) {
    case "running":
      return styles.badgeRunning;
    case "needs-you":
      return styles.badgeNeeds;
    case "failed":
      return styles.dotFailed;
    default:
      return styles.dotDone;
  }
}

/** `BotSidebarChats.tsx`: Home Chat first, then side chats, threads and runs, newest first, each with its workers. */
function BotSidebarChats({
  serverId,
  bot,
  onNavigate,
}: {
  serverId: string;
  bot: Bot;
  onNavigate: () => void;
}) {
  const { t } = useTranslation();
  const tree = useChatTree(serverId, bot.id);
  const chats = useMemo(
    () => [...(tree.data?.home ? [tree.data.home] : []), ...(tree.data?.chats ?? [])],
    [tree.data],
  );
  const workspaces = tree.data?.workspaces ?? [];
  return (
    <View style={styles.tree} testID={`sidebar-bot-tree-${bot.slug}`}>
      {chats.map((chat) => (
        <BotSidebarChat
          key={chat.id}
          serverId={serverId}
          bot={bot}
          chat={chat}
          isHome={chat.kind === "home"}
          onNavigate={onNavigate}
        />
      ))}
      {workspaces.length > 0 ? (
        <View>
          <Text style={styles.treeHeading}>
            {t("bots.workspaces.heading", { total: workspaces.length })}
          </Text>
          {workspaces.map((workspace) => (
            <HandedWorkspaceRow
              key={workspace.workspaceId}
              serverId={serverId}
              workspaceId={workspace.workspaceId}
              title={workspace.title}
              onNavigate={onNavigate}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const CHAT_ROW_STYLE = rowStyle(false, true);

function HandedWorkspaceRow({
  serverId,
  workspaceId,
  title,
  onNavigate,
}: {
  serverId: string;
  workspaceId: string;
  title: string;
  onNavigate: () => void;
}) {
  const open = useCallback(() => {
    onNavigate();
    navigateToWorkspace({ serverId, workspaceId });
  }, [onNavigate, serverId, workspaceId]);
  return (
    <Pressable style={CHAT_ROW_STYLE} accessibilityRole="button" onPress={open}>
      <Text style={styles.chatTitle} numberOfLines={1}>
        {title}
      </Text>
    </Pressable>
  );
}

function WorkerRow({
  serverId,
  worker,
  onNavigate,
}: {
  serverId: string;
  worker: BotChatWorker;
  onNavigate: () => void;
}) {
  const open = useCallback(() => {
    onNavigate();
    navigateToAgent({ serverId, agentId: worker.agentId });
  }, [onNavigate, serverId, worker.agentId]);
  const dotStyle = useMemo(() => [styles.workerDot, workerDotStyle(worker.state)], [worker.state]);
  return (
    <Pressable
      style={CHAT_ROW_STYLE}
      accessibilityRole="button"
      onPress={open}
      testID="sidebar-bot-worker"
    >
      <View style={styles.chatDotSlot}>
        <View style={dotStyle} />
      </View>
      <Text style={styles.chatTitle} numberOfLines={1}>
        {worker.title}
      </Text>
    </Pressable>
  );
}

/** `chatFoldSummary`: a folded chat's live workers, "1 waiting · 2 running". */
function foldSummary(t: ReturnType<typeof useTranslation>["t"], chat: BotChat): string {
  return [
    chat.waitingTotal > 0 ? t("bots.chats.waitingCount", { count: chat.waitingTotal }) : null,
    chat.runningTotal > 0 ? t("bots.chats.runningCount", { count: chat.runningTotal }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function BotSidebarChat({
  serverId,
  bot,
  chat,
  isHome,
  onNavigate,
}: {
  serverId: string;
  bot: Bot;
  chat: BotChat;
  isHome: boolean;
  onNavigate: () => void;
}) {
  const { t } = useTranslation();
  const foldKey = `${serverId}:${bot.id}:${chat.id}`;
  const fold = useBotsSidebarStore((state) => state.chatFolds[foldKey]);
  const setChatFold = useBotsSidebarStore((state) => state.setChatFold);
  // Without a manual fold a chat shows its workers while any is live.
  const open = fold ? fold === "open" : chat.runningTotal + chat.waitingTotal > 0;
  const [steps, setSteps] = useState(1);
  const title = isHome ? t("bots.chats.home") : chat.title || t("bots.chats.untitled");
  const foldable = chat.workers.length > 0;
  const pressChat = useCallback(() => {
    onNavigate();
    if (isHome) openBot(serverId, bot.id);
    else navigateToAgent({ serverId, agentId: chat.id });
  }, [onNavigate, isHome, serverId, bot.id, chat.id]);
  const toggle = useCallback(
    () => setChatFold(foldKey, open ? "folded" : "open"),
    [setChatFold, foldKey, open],
  );
  const showMoreWorkers = useCallback(() => setSteps((value) => value + 1), []);
  const shownWorkers = chat.workers.slice(0, steps * WORKER_STEP);
  const remaining = chat.workers.length - shownWorkers.length;
  const summary = !open ? foldSummary(t, chat) : "";
  return (
    <View>
      <Pressable
        style={CHAT_ROW_STYLE}
        onPress={pressChat}
        accessibilityRole="button"
        accessibilityLabel={[title, summary].filter(Boolean).join(" · ")}
        testID={`sidebar-bot-chat-${chat.kind}`}
      >
        <View style={styles.chatDotSlot}>
          {chat.live === "replying" ? (
            <View style={[styles.workerDot, styles.badgeRunning]} />
          ) : null}
          {chat.live === "needs-you" ? (
            <View style={[styles.workerDot, styles.badgeNeeds]} />
          ) : null}
        </View>
        <Text style={styles.chatTitle} numberOfLines={1}>
          {title}
        </Text>
        {summary ? <Text style={styles.chatSummary}>{summary}</Text> : null}
        {foldable ? (
          <Pressable
            onPress={toggle}
            style={styles.fold}
            accessibilityRole="button"
            accessibilityLabel={
              open ? t("bots.chats.fold", { name: title }) : t("bots.chats.unfold", { name: title })
            }
          >
            {open ? (
              <ThemedChevronDown size={14} uniProps={muted} />
            ) : (
              <ThemedChevronRight size={14} uniProps={muted} />
            )}
          </Pressable>
        ) : null}
      </Pressable>
      {open && foldable ? (
        <View style={styles.workers}>
          {shownWorkers.map((worker) => (
            <WorkerRow
              key={worker.agentId}
              serverId={serverId}
              worker={worker}
              onNavigate={onNavigate}
            />
          ))}
          {remaining > 0 ? (
            <Pressable accessibilityRole="button" onPress={showMoreWorkers}>
              <Text style={styles.paging}>
                {remaining >= WORKER_STEP
                  ? t("bots.chats.showEightMoreWorkers")
                  : t("bots.chats.showMoreWorkers", { count: remaining })}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** A group (spec 37.3.6): its members' faces and name; opens the group's room. */
function BotGroupRow({
  serverId,
  room,
  bots,
  active,
  onNavigate,
}: {
  serverId: string;
  room: BotRoom;
  bots: readonly Bot[];
  active: boolean;
  onNavigate: () => void;
}) {
  const members = bots.filter((bot) => room.memberBotIds.includes(bot.id)).slice(0, 3);
  const open = useCallback(() => {
    onNavigate();
    openBotRoom(serverId, room.id);
  }, [onNavigate, serverId, room.id]);
  return (
    <Pressable
      style={rowStyle(active)}
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={room.name}
      testID={`sidebar-bot-group-${room.id}`}
    >
      <View style={styles.fold} />
      <View style={styles.faces}>
        {members.map((bot, index) => (
          <BotAvatar
            key={bot.id}
            bot={bot}
            serverId={serverId}
            size={16}
            radius={4}
            style={index > 0 ? styles.faceOverlap : undefined}
          />
        ))}
      </View>
      <Text style={styles.botName} numberOfLines={1}>
        {room.name}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  heading: { height: { xs: 44, md: 32 }, flexDirection: "row", alignItems: "center" },
  headingToggle: {
    flex: 1,
    height: { xs: 44, md: 32 },
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  headingLabel: { flex: 1, fontSize: 12, fontWeight: "600", color: theme.colors.foregroundMuted },
  iconButton: {
    width: { xs: 44, md: 30 },
    height: { xs: 44, md: 32 },
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  tooltip: { fontSize: theme.fontSize.sm, color: theme.colors.popoverForeground },
  list: { flexGrow: 0 },
  listContent: { gap: 2, paddingBottom: 4 },
  note: { paddingHorizontal: 10, fontSize: 12, color: theme.colors.foregroundMuted },
  resizer: { height: 8, justifyContent: "center" },
  resizerLine: { height: 1, backgroundColor: theme.colors.border },
  emptyCard: {
    marginHorizontal: 2,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    gap: 10,
  },
  emptyTitleRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  emptyTitle: { flexShrink: 1, fontSize: 14, fontWeight: "600", color: theme.colors.foreground },
  emptyActions: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  faces: { flexDirection: "row", alignItems: "center" },
  faceOverlap: {
    marginLeft: -4,
    borderWidth: 1,
    borderColor: theme.colors.surfaceSidebar,
  },
  preview: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "nowrap",
    gap: 4,
    paddingHorizontal: 10,
    paddingBottom: 6,
    overflow: "hidden",
  },
  previewMore: { fontSize: 12, color: theme.colors.foregroundMuted },
  // 32 px + a 16 px second line (spec 38.4.4b), selected `selectedRow`, hover `surfaceSidebarHover`.
  botRow: {
    minHeight: { xs: 60, md: 48 },
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingRight: 10,
    borderRadius: 8,
  },
  chatRow: {
    height: { xs: 44, md: 32 },
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingRight: 4,
    borderRadius: 8,
  },
  selected: { backgroundColor: theme.chrome.selectedRow },
  hovered: { backgroundColor: theme.colors.surfaceSidebarHover },
  fold: { width: 20, height: 28, alignItems: "center", justifyContent: "center" },
  avatarSlot: { width: 16, height: 16 },
  dimmed: { opacity: 0.6 },
  // 7 × 7 px with a 1 px surfaceSidebar ring, at the mascot's bottom right (spec 37.4.1, colors 09.5).
  badge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 7,
    height: 7,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: theme.colors.surfaceSidebar,
  },
  badgeNeeds: { backgroundColor: theme.colors.palette.amber[500] },
  badgeRunning: { backgroundColor: theme.colors.palette.amber[500] },
  dotFailed: { backgroundColor: theme.colors.palette.red[500] },
  dotDone: { backgroundColor: theme.colors.border },
  rowText: { flex: 1, minWidth: 0 },
  botName: { fontSize: 14, lineHeight: 20, fontWeight: "500", color: theme.colors.foreground },
  botLine: { fontSize: 12, lineHeight: 16, color: theme.colors.foregroundMuted },
  renameInput: {
    fontSize: 14,
    lineHeight: 20,
    color: theme.colors.foreground,
    padding: 0,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  // Chat and worker rows are 32 px, 16 px in per level (spec 37.4.1).
  tree: { paddingLeft: 16, gap: 2 },
  workers: { paddingLeft: 16, gap: 2 },
  treeHeading: {
    paddingHorizontal: 10,
    paddingTop: 6,
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
  },
  chatDotSlot: { width: 16, alignItems: "center", justifyContent: "center" },
  workerDot: { width: 8, height: 8, borderRadius: 4 },
  chatTitle: { flex: 1, minWidth: 0, fontSize: 14, color: theme.colors.foreground },
  chatSummary: { fontSize: 12, color: theme.colors.foregroundMuted },
  paging: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
}));
