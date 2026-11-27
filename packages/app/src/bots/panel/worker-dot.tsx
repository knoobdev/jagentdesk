// The status dot a worker shows in place of an icon (spec 09.5 colours: amber while it works or asks,
// red when it failed, green when it finished, the border colour once stopped).
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { BotChatWorker } from "@jagentdesk/protocol/bots/views";

export function BotWorkerDot({ state }: { state: BotChatWorker["state"] }) {
  return <View style={[styles.dot, styles[state]]} />;
}

const styles = StyleSheet.create((theme) => ({
  dot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  running: { backgroundColor: theme.colors.palette.amber[500] },
  "needs-you": { backgroundColor: theme.colors.palette.amber[500] },
  failed: { backgroundColor: theme.colors.palette.red[500] },
  done: { backgroundColor: theme.colors.palette.green[500] },
  stopped: { backgroundColor: theme.colors.border },
}));
