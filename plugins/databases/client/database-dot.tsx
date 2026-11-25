import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DatabaseInfo } from "@jagentdesk/protocol/database/rpc-schemas";

export function DatabaseStatusDot({ state }: { state: DatabaseInfo["state"] }) {
  styles.useVariants({ dbState: state });
  return <View style={styles.dot} />;
}

const styles = StyleSheet.create((theme) => ({
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    flexShrink: 0,
    backgroundColor: theme.colors.border,
    variants: {
      dbState: {
        connected: { backgroundColor: theme.colors.palette.green[400] },
        connecting: { backgroundColor: theme.colors.palette.amber[500] },
        error: { backgroundColor: theme.colors.palette.red[500] },
        saved: { backgroundColor: theme.colors.border },
      },
    },
  },
}));
