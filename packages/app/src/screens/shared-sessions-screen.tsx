import { type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { SessionSharesCard } from "@/screens/settings/session-shares-card";
import { useHosts } from "@/runtime/host-runtime";

// Global "Shared sessions" page (spec §21 / ADR-0019): manage every active share across connected
// hosts from the main menu — outside a specific agent chat and outside Settings. Each host renders a
// SessionSharesCard (which self-hides when the host is disconnected or doesn't support sharing).
export function SharedSessionsScreen(): ReactElement {
  const isFocused = useIsFocused();
  const hosts = useHosts();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return (
    <View style={styles.container}>
      <MenuHeader title="Shared sessions" />
      <ScrollView contentContainerStyle={styles.body}>
        {hosts.length === 0 ? (
          <Text style={styles.empty}>Connect to a host to manage its shared sessions.</Text>
        ) : (
          hosts.map((host) => (
            <View key={host.serverId} style={styles.hostBlock}>
              {hosts.length > 1 ? <Text style={styles.hostLabel}>{host.label}</Text> : null}
              <SessionSharesCard serverId={host.serverId} />
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  body: { padding: theme.spacing[4], gap: theme.spacing[4] },
  hostBlock: { gap: theme.spacing[2] },
  hostLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    marginTop: theme.spacing[8],
  },
}));
