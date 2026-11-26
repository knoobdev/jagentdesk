import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

/** A fork that failed says why and offers Retry, instead of hanging (spec 41 §6). */
export function ForkFailedNotice({
  message,
  retryLabel,
  onRetry,
}: {
  message: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.message} numberOfLines={3}>
        {message}
      </Text>
      <Pressable onPress={onRetry} accessibilityRole="button" testID="fork-retry">
        <Text style={styles.retry}>{retryLabel}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3], flexShrink: 1 },
  message: { flexShrink: 1, fontSize: 14, color: theme.colors.foreground },
  retry: {
    fontSize: 14,
    fontWeight: "600",
    color: theme.colors.foreground,
    textDecorationLine: "underline",
  },
}));
