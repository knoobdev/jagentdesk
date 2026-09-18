import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Animated, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { ForumChatMessage, ForumRole, StoredForumTopic } from "@jagentdesk/protocol/messages";

// The "chém gió" tab: a Telegram-style banter chat that runs alongside the task thread. Agents drop in
// organically via the forum.chat* tools; the user can join too (type, emoji, stickers, reactions). The
// whole topic (including chatRooms/chatMessages) streams in live via forum.stream, so this component is
// a pure render of topic.chatMessages for the selected room plus a composer that calls the client.

// Matches the app's own dark + green identity (same neutrals as the forum screen), not Telegram blue.
const CH = {
  bg: "#000000",
  header: "#0e0e0e",
  surface: "#0e0e0e",
  inBubble: "#191919",
  outBubble: "#1d3a27",
  border: "#232323",
  chip: "#171717",
  chipOn: "#20402b",
  text: "#ededed",
  soft: "#a6a6a6",
  muted: "#7c7c7c",
  faint: "#4a4a4a",
  accent: "#3ba55d",
  green: "#3ba55d",
  amber: "#e6a23c",
  red: "#e2564d",
  reactionBg: "#182a1e",
} as const;

// Kill the browser's blue focus ring on the web textarea (RN has no style for this).
const WEB_INPUT_RESET =
  Platform.OS === "web"
    ? ({ outlineStyle: "none", outlineWidth: 0, outlineColor: "transparent" } as object)
    : null;

const STICKER_EMOJI: Record<string, string> = {
  shipit: "🚢",
  fire: "🔥",
  party: "🎉",
  bug: "🐛",
  eyes: "👀",
  coffee: "☕",
  thumbsup: "👍",
  brain: "🧠",
  rocket: "🚀",
  sob: "😭",
  clown: "🤡",
  hundred: "💯",
  heart: "❤️",
  facepalm: "🤦",
};
const STICKER_IDS = Object.keys(STICKER_EMOJI);
const REACT_EMOJIS = ["👍", "❤️", "😂", "🔥", "👀", "🎉", "😮", "😭"];
const QUICK_EMOJIS = ["😂", "🔥", "👍", "🎉", "😅", "🙌", "🤔", "💯", "🚀", "❤️", "😭", "👀"];

function roleColor(role: ForumRole): string {
  switch (role) {
    case "lead":
    case "supervisor":
      return CH.green;
    case "ba":
    case "reviewer":
      return CH.amber;
    case "tester":
      return "#1fc3ba";
    case "pentester":
      return CH.red;
    case "user":
      return CH.accent;
    default:
      return CH.faint;
  }
}

function initial(label: string): string {
  const c = label.trim()[0];
  return c ? c.toUpperCase() : "?";
}

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// An "animated sticker": a big emoji that pops on mount (scale bounce), our dependency-free, original
// stand-in for a GIF/Telegram sticker.
const StickerArt = memo(function StickerArt({
  id,
  size,
}: {
  id: string;
  size: number;
}): ReactElement {
  const scale = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    Animated.spring(scale, { toValue: 1, friction: 4, tension: 90, useNativeDriver: true }).start();
  }, [scale]);
  const glyph = STICKER_EMOJI[id] ?? "❓";
  const style = useMemo(() => ({ transform: [{ scale }] }), [scale]);
  const textStyle = useMemo(() => ({ fontSize: size }), [size]);
  return (
    <Animated.View style={style}>
      <Text style={textStyle}>{glyph}</Text>
    </Animated.View>
  );
});

const ReactionChips = memo(function ReactionChips({
  message,
  onReact,
}: {
  message: ForumChatMessage;
  onReact: (messageId: string, emoji: string) => void;
}): ReactElement | null {
  if (message.reactions.length === 0) return null;
  return (
    <View style={styles.reactionRow}>
      {message.reactions.map((r) => (
        <ReactionChip
          key={r.emoji}
          messageId={message.id}
          emoji={r.emoji}
          count={r.by.length}
          onReact={onReact}
        />
      ))}
    </View>
  );
});

const ReactionChip = memo(function ReactionChip({
  messageId,
  emoji,
  count,
  onReact,
}: {
  messageId: string;
  emoji: string;
  count: number;
  onReact: (messageId: string, emoji: string) => void;
}): ReactElement {
  const press = useCallback(() => onReact(messageId, emoji), [messageId, emoji, onReact]);
  return (
    <Pressable onPress={press} style={styles.reactionChip}>
      <Text style={styles.reactionEmoji}>{emoji}</Text>
      <Text style={styles.reactionCount}>{count}</Text>
    </Pressable>
  );
});

function previewOf(message: ForumChatMessage): string {
  if (message.kind === "sticker") return `${STICKER_EMOJI[message.stickerId ?? ""] ?? "🖼"} sticker`;
  const line = message.text.split("\n", 1)[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

const ChatBubble = memo(function ChatBubble({
  message,
  repliedTo,
  showHeader,
  onReact,
  onPickReaction,
}: {
  message: ForumChatMessage;
  repliedTo: ForumChatMessage | null;
  showHeader: boolean;
  onReact: (messageId: string, emoji: string) => void;
  onPickReaction: (messageId: string) => void;
}): ReactElement {
  const mine = message.authorAgentId === "user";
  const color = roleColor(message.role);
  const openReactions = useCallback(() => onPickReaction(message.id), [message.id, onPickReaction]);
  const isSticker = message.kind === "sticker" && Boolean(message.stickerId);

  const rowStyle = [
    styles.row,
    mine ? styles.rowMine : styles.rowIn,
    showHeader ? styles.rowLead : styles.rowTight,
  ];
  let leadStyle = null;
  if (showHeader) leadStyle = mine ? styles.bubbleOutLead : styles.bubbleInLead;
  return (
    <View style={rowStyle}>
      {!mine ? (
        <View style={styles.avatarSlot}>
          {showHeader ? (
            <View style={[styles.avatar, { backgroundColor: color }]}>
              <Text style={styles.avatarText}>{initial(message.authorLabel)}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
      <View style={[styles.bubbleCol, mine ? styles.bubbleColMine : null]}>
        {isSticker ? (
          <Pressable onLongPress={openReactions} style={styles.stickerWrap}>
            <StickerArt id={message.stickerId ?? ""} size={72} />
          </Pressable>
        ) : (
          <Pressable
            onLongPress={openReactions}
            style={[styles.bubble, mine ? styles.bubbleOut : styles.bubbleIn, leadStyle]}
          >
            {showHeader && !mine ? (
              <Text style={[styles.author, { color }]} numberOfLines={1}>
                {message.authorLabel}
              </Text>
            ) : null}
            {repliedTo ? (
              <View style={styles.reply}>
                <Text style={styles.replyAuthor} numberOfLines={1}>
                  {repliedTo.authorAgentId === "user" ? "You" : repliedTo.authorLabel}
                </Text>
                <Text style={styles.replyText} numberOfLines={1}>
                  {previewOf(repliedTo)}
                </Text>
              </View>
            ) : null}
            <Text style={styles.bubbleText}>{message.text}</Text>
            <Text style={[styles.time, mine ? styles.timeOut : null]}>
              {timeAgo(message.createdAt_ms)}
            </Text>
          </Pressable>
        )}
        <ReactionChips message={message} onReact={onReact} />
      </View>
    </View>
  );
});

const RoomChips = memo(function RoomChips({
  rooms,
  selected,
  onSelect,
  onNewRoom,
}: {
  rooms: StoredForumTopic["chatRooms"];
  selected: string;
  onSelect: (roomId: string) => void;
  onNewRoom: () => void;
}): ReactElement {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.roomBar}
    >
      {rooms.map((room) => (
        <RoomChip
          key={room.id}
          id={room.id}
          name={room.name}
          active={room.id === selected}
          onSelect={onSelect}
        />
      ))}
      <Pressable onPress={onNewRoom} style={styles.roomNew}>
        <Text style={styles.roomNewText}>+ room</Text>
      </Pressable>
    </ScrollView>
  );
});

const RoomChip = memo(function RoomChip({
  id,
  name,
  active,
  onSelect,
}: {
  id: string;
  name: string;
  active: boolean;
  onSelect: (roomId: string) => void;
}): ReactElement {
  const press = useCallback(() => onSelect(id), [id, onSelect]);
  return (
    <Pressable onPress={press} style={[styles.roomChip, active ? styles.roomChipOn : null]}>
      <Text style={[styles.roomChipText, active ? styles.roomChipTextOn : null]}>#{name}</Text>
    </Pressable>
  );
});

const StickerPicker = memo(function StickerPicker({
  onPick,
}: {
  onPick: (id: string) => void;
}): ReactElement {
  return (
    <View style={styles.pickerWrap}>
      {STICKER_IDS.map((id) => (
        <StickerButton key={id} id={id} onPick={onPick} />
      ))}
    </View>
  );
});

const StickerButton = memo(function StickerButton({
  id,
  onPick,
}: {
  id: string;
  onPick: (id: string) => void;
}): ReactElement {
  const press = useCallback(() => onPick(id), [id, onPick]);
  return (
    <Pressable onPress={press} style={styles.pickerCell}>
      <Text style={styles.pickerGlyph}>{STICKER_EMOJI[id]}</Text>
    </Pressable>
  );
});

const EmojiRow = memo(function EmojiRow({
  onPick,
}: {
  onPick: (emoji: string) => void;
}): ReactElement {
  return (
    <View style={styles.emojiRow}>
      {QUICK_EMOJIS.map((e) => (
        <EmojiButton key={e} emoji={e} onPick={onPick} />
      ))}
    </View>
  );
});

const EmojiButton = memo(function EmojiButton({
  emoji,
  onPick,
}: {
  emoji: string;
  onPick: (emoji: string) => void;
}): ReactElement {
  const press = useCallback(() => onPick(emoji), [emoji, onPick]);
  return (
    <Pressable onPress={press} style={styles.emojiBtn}>
      <Text style={styles.emojiGlyph}>{emoji}</Text>
    </Pressable>
  );
});

// A small emoji palette shown when reacting to a specific message.
const ReactionPalette = memo(function ReactionPalette({
  onReact,
  onClose,
}: {
  onReact: (emoji: string) => void;
  onClose: () => void;
}): ReactElement {
  return (
    <View style={styles.palette}>
      {REACT_EMOJIS.map((e) => (
        <EmojiButton key={e} emoji={e} onPick={onReact} />
      ))}
      <Pressable onPress={onClose} style={styles.emojiBtn}>
        <Text style={styles.paletteClose}>✕</Text>
      </Pressable>
    </View>
  );
});

const NOOP = (): void => {};

export const ChatTab = memo(function ChatTab({
  topic,
  client,
}: {
  topic: StoredForumTopic;
  client: DaemonClient | null;
}): ReactElement {
  const rooms = topic.chatRooms;
  // Open on the room with the freshest banter (so you land where the action is), not always #general.
  const [selectedRoom, setSelectedRoom] = useState<string>(() => {
    const last = topic.chatMessages[topic.chatMessages.length - 1];
    if (last && rooms.some((r) => r.id === last.roomId)) return last.roomId;
    return rooms[0]?.id ?? "";
  });
  const activeRoom = rooms.some((r) => r.id === selectedRoom) ? selectedRoom : (rooms[0]?.id ?? "");
  const [text, setText] = useState("");
  const [showStickers, setShowStickers] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [reactingTo, setReactingTo] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);

  const messages = useMemo(
    () => topic.chatMessages.filter((m) => m.roomId === activeRoom),
    [topic.chatMessages, activeRoom],
  );
  const byId = useMemo(
    () => new Map(topic.chatMessages.map((m) => [m.id, m])),
    [topic.chatMessages],
  );

  useEffect(() => {
    const id = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 60);
    return () => clearTimeout(id);
  }, [messages.length, activeRoom]);

  const send = useCallback(() => {
    const body = text.trim();
    if (!body || !client) return;
    setText("");
    setShowEmoji(false);
    void client.forumChatPost({ topicId: topic.id, text: body, roomId: activeRoom }).catch(NOOP);
  }, [text, client, topic.id, activeRoom]);

  const sendSticker = useCallback(
    (stickerId: string) => {
      setShowStickers(false);
      void client
        ?.forumChatPost({ topicId: topic.id, kind: "sticker", stickerId, roomId: activeRoom })
        .catch(NOOP);
    },
    [client, topic.id, activeRoom],
  );

  const react = useCallback(
    (messageId: string, emoji: string) => {
      void client?.forumChatReact({ topicId: topic.id, messageId, emoji }).catch(NOOP);
    },
    [client, topic.id],
  );

  const reactChosen = useCallback(
    (emoji: string) => {
      if (reactingTo) react(reactingTo, emoji);
      setReactingTo(null);
    },
    [reactingTo, react],
  );

  const insertEmoji = useCallback((emoji: string) => setText((t) => t + emoji), []);
  const toggleEmoji = useCallback(() => {
    setShowEmoji((v) => !v);
    setShowStickers(false);
  }, []);
  const toggleStickers = useCallback(() => {
    setShowStickers((v) => !v);
    setShowEmoji(false);
  }, []);
  const closeReacting = useCallback(() => setReactingTo(null), []);

  const newRoom = useCallback(() => {
    if (!client) return;
    const n = topic.chatRooms.length;
    void client
      .forumChatRoom({ topicId: topic.id, name: `room-${n}` })
      .then((res) => {
        if (res.roomId) setSelectedRoom(res.roomId);
        return res;
      })
      .catch(NOOP);
  }, [client, topic.id, topic.chatRooms.length]);

  const roomBlurb = rooms.find((r) => r.id === activeRoom)?.topic ?? "";

  // Group consecutive messages from the same author (within 5 min) — Telegram-style: the avatar + name
  // show only on the first of a run, the rest tuck in tight beneath it.
  const rows = useMemo(
    () =>
      messages.map((m, i) => {
        const prev = messages[i - 1];
        const leadRun =
          !prev ||
          prev.authorAgentId !== m.authorAgentId ||
          m.createdAt_ms - prev.createdAt_ms > 300_000;
        return { m, showHeader: leadRun };
      }),
    [messages],
  );
  const canSend = text.trim().length > 0;

  return (
    <View style={styles.root}>
      <View style={styles.container}>
        <View style={styles.roomHeader}>
          <RoomChips
            rooms={rooms}
            selected={activeRoom}
            onSelect={setSelectedRoom}
            onNewRoom={newRoom}
          />
          {roomBlurb ? <Text style={styles.blurb}>{roomBlurb}</Text> : null}
        </View>
        <ScrollView ref={scrollRef} style={styles.list} contentContainerStyle={styles.listContent}>
          {messages.length === 0 ? (
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyGlyph}>💬</Text>
              <Text style={styles.empty}>No banter yet — say hi 👋</Text>
            </View>
          ) : null}
          {rows.map((r) => (
            <ChatBubble
              key={r.m.id}
              message={r.m}
              repliedTo={r.m.replyToId ? (byId.get(r.m.replyToId) ?? null) : null}
              showHeader={r.showHeader}
              onReact={react}
              onPickReaction={setReactingTo}
            />
          ))}
        </ScrollView>
        {reactingTo ? <ReactionPalette onReact={reactChosen} onClose={closeReacting} /> : null}
        {showStickers ? <StickerPicker onPick={sendSticker} /> : null}
        {showEmoji ? <EmojiRow onPick={insertEmoji} /> : null}
        <View style={styles.composer}>
          <Pressable onPress={toggleEmoji} style={styles.iconBtn}>
            <Text style={styles.icon}>😀</Text>
          </Pressable>
          <Pressable onPress={toggleStickers} style={styles.iconBtn}>
            <Text style={styles.icon}>🎨</Text>
          </Pressable>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Message the team…"
            placeholderTextColor={CH.muted}
            style={[styles.input, WEB_INPUT_RESET]}
            onSubmitEditing={send}
            returnKeyType="send"
            multiline
          />
          <Pressable
            onPress={send}
            style={[styles.sendBtn, canSend ? styles.sendBtnOn : null]}
            disabled={!canSend}
          >
            <Text style={[styles.sendGlyph, canSend ? styles.sendGlyphOn : null]}>➤</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create(() => ({
  root: { flex: 1, backgroundColor: CH.bg, alignItems: "center" },
  // Constrain the conversation to a centered column so it doesn't stretch full-width on desktop, but
  // keep the same background as the rest of the app (no distinct wallpaper / bordered box).
  container: { flex: 1, width: "100%", maxWidth: 900, alignSelf: "center" },
  roomHeader: { paddingTop: 6 },
  roomBar: { gap: 6, paddingHorizontal: 20, paddingVertical: 6, alignItems: "center" },
  roomChip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: CH.chip,
  },
  roomChipOn: { backgroundColor: CH.chipOn },
  roomChipText: { color: CH.soft, fontSize: 12, fontWeight: "600" },
  roomChipTextOn: { color: CH.text },
  roomNew: { paddingHorizontal: 10, paddingVertical: 5 },
  roomNewText: { color: CH.muted, fontSize: 12 },
  blurb: { color: CH.faint, fontSize: 11, paddingHorizontal: 20, paddingBottom: 6 },
  list: { flex: 1 },
  listContent: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
    gap: 2,
    flexGrow: 1,
    justifyContent: "flex-end",
  },
  emptyWrap: {
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    gap: 8,
    paddingVertical: 40,
  },
  emptyGlyph: { fontSize: 40, opacity: 0.5 },
  empty: { color: CH.muted, fontSize: 13, textAlign: "center" },
  row: { flexDirection: "row", gap: 6, maxWidth: "100%", alignItems: "flex-end" },
  rowIn: { justifyContent: "flex-start" },
  rowMine: { justifyContent: "flex-end" },
  rowLead: { marginTop: 8 },
  rowTight: { marginTop: 1 },
  avatarSlot: { width: 30, alignItems: "center", justifyContent: "flex-end" },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 12, fontWeight: "700", color: "#ffffff" },
  bubbleCol: { maxWidth: "74%", alignItems: "flex-start", gap: 2 },
  bubbleColMine: { alignItems: "flex-end" },
  author: { fontSize: 12, fontWeight: "700", marginBottom: 2 },
  bubble: {
    borderRadius: 14,
    paddingHorizontal: 11,
    paddingTop: 6,
    paddingBottom: 5,
  },
  bubbleIn: { backgroundColor: CH.inBubble, borderBottomLeftRadius: 5 },
  bubbleOut: { backgroundColor: CH.outBubble, borderBottomRightRadius: 5 },
  bubbleInLead: { borderTopLeftRadius: 5 },
  bubbleOutLead: { borderTopRightRadius: 5 },
  reply: {
    borderLeftWidth: 2,
    borderLeftColor: CH.accent,
    paddingLeft: 7,
    marginBottom: 4,
    opacity: 0.9,
  },
  replyAuthor: { color: CH.accent, fontSize: 11.5, fontWeight: "700" },
  replyText: { color: CH.soft, fontSize: 12 },
  bubbleText: { color: CH.text, fontSize: 14.5, lineHeight: 20 },
  time: { color: CH.muted, fontSize: 10, alignSelf: "flex-end", marginTop: 1 },
  timeOut: { color: "#7fb28f" },
  stickerWrap: { paddingVertical: 2 },
  reactionRow: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 2, marginBottom: 2 },
  reactionChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: CH.reactionBg,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: "#2a4a34",
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  reactionEmoji: { fontSize: 12 },
  reactionCount: { color: "#8fd0a3", fontSize: 11, fontWeight: "700" },
  palette: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    padding: 8,
    backgroundColor: CH.header,
    borderTopWidth: 1,
    borderColor: CH.border,
    alignItems: "center",
    justifyContent: "center",
  },
  paletteClose: { color: CH.muted, fontSize: 14 },
  pickerWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    padding: 10,
    backgroundColor: CH.header,
    borderTopWidth: 1,
    borderColor: CH.border,
    justifyContent: "center",
  },
  pickerCell: {
    width: 46,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: CH.chip,
  },
  pickerGlyph: { fontSize: 28 },
  emojiRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: CH.header,
    borderTopWidth: 1,
    borderColor: CH.border,
    justifyContent: "center",
  },
  emojiBtn: { padding: 4 },
  emojiGlyph: { fontSize: 24 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderColor: CH.border,
    backgroundColor: CH.header,
  },
  iconBtn: { paddingHorizontal: 4, paddingVertical: 8 },
  icon: { fontSize: 22 },
  input: {
    flex: 1,
    color: CH.text,
    fontSize: 14.5,
    maxHeight: 110,
    minHeight: 40,
    paddingHorizontal: 14,
    paddingVertical: 9,
    backgroundColor: CH.bg,
    borderRadius: 20,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: CH.chip,
  },
  sendBtnOn: { backgroundColor: CH.accent },
  sendGlyph: { fontSize: 16, color: CH.faint, fontWeight: "700" },
  sendGlyphOn: { color: "#04140a" },
}));
