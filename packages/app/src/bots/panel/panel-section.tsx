// A section of the bot's right panel: a 14/600 title with its count or note, actions on the right,
// then its rows. Ported from Orca dfdb4fda (MIT) src/renderer/src/components/bots/BotPanelSection.tsx.
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export function BotPanelSection({
  title,
  note,
  actions,
  children,
  testID,
}: {
  title: string;
  /** Muted text beside the title ("Looked 4:12 PM", "2 new"). */
  note?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  testID?: string;
}) {
  return (
    <View style={styles.section} testID={testID}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {note ? (
          <Text style={styles.note} numberOfLines={1}>
            {note}
          </Text>
        ) : null}
        <View style={styles.spacer} />
        {actions}
      </View>
      {children}
    </View>
  );
}

/** A muted line inside a section: an empty state or a status. */
export function BotPanelNote({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <Text style={styles.empty} testID={testID}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { gap: 2, paddingVertical: 8 },
  header: { minHeight: 32, flexDirection: "row", alignItems: "center", gap: 8 },
  title: { fontSize: 14, fontWeight: "600", color: theme.colors.foreground, flexShrink: 1 },
  note: { fontSize: 13, color: theme.colors.foregroundMuted, flexShrink: 1 },
  spacer: { flex: 1 },
  empty: { fontSize: 13, lineHeight: 18, color: theme.colors.foregroundMuted, paddingVertical: 4 },
}));
