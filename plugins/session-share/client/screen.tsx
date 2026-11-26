import { useGumloopPageGutterStyle } from "../../../packages/app/src/plugins/builtin/host-api";
import {
  PageHeader,
  useHosts,
  usePageScroll,
  useIsGumloopTheme,
  gumloopListStyles,
} from "../../../packages/app/src/plugins/builtin/host-api";
import { type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Share2 } from "lucide-react-native";
import { SessionSharesCard } from "./shares-card";

// Global "Shared sessions" page (spec §21 / ADR-0019): manage every active share across connected
// hosts from the main menu — outside a specific agent chat and outside Settings. Each host renders a
// SessionSharesCard (which self-hides when the host is disconnected or doesn't support sharing).
export function SharedSessionsScreen({ focused }: { focused?: boolean }): ReactElement {
  const gutter = useGumloopPageGutterStyle();
  const hosts = useHosts();
  const isGumloop = useIsGumloopTheme();
  const pageScroll = usePageScroll();

  if (focused === false) {
    return <View style={styles.container} />;
  }

  return (
    <View style={styles.container}>
      <PageHeader
        icon={Share2}
        title="Shared sessions"
        description="Sessions you have shared with other people, per host. Revoke access at any time."
        scrolled={pageScroll.scrolled}
      />
      <ScrollView contentContainerStyle={[styles.body, gutter]} {...pageScroll.scrollProps}>
        {hosts.length === 0 ? (
          <Text style={styles.empty}>Connect to a host to manage its shared sessions.</Text>
        ) : (
          hosts.map((host) => (
            <View key={host.serverId} style={styles.hostBlock}>
              {hosts.length > 1 ? <HostLabel label={host.label} isGumloop={isGumloop} /> : null}
              <SessionSharesCard serverId={host.serverId} />
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

// Gumloop labels each host's group of shares with its bordered uppercase group pill.
function HostLabel({ label, isGumloop }: { label: string; isGumloop: boolean }): ReactElement {
  if (!isGumloop) {
    return <Text style={styles.hostLabel}>{label}</Text>;
  }
  return (
    <View style={styles.hostPillRow}>
      <View style={gumloopListStyles.groupPill}>
        <Text style={gumloopListStyles.groupPillText}>{label}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  body: { padding: theme.spacing[4], gap: theme.spacing[4] },
  hostBlock: { gap: theme.spacing[2] },
  hostPillRow: { flexDirection: "row" },
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
