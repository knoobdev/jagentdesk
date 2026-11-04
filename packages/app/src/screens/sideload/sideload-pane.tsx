import { useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { Alert } from "@/components/ui/alert";
import { ValueButton } from "./buttons";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { AccountsSection } from "./accounts-section";
import { InstallSection } from "./install-section";
import { InstalledSection } from "./installed-section";
import { useSideloadJobs, useSideloadNotices, useSideloadPrompt } from "./queries";

// The Sideload tab of Sims (spec 26.9), desktop and mobile: Accounts, Install, Installed apps.
// Jobs, 2FA prompts and notices are subscribed here so they survive switching sections.

type Section = "accounts" | "install" | "installed";
const SECTIONS = [
  { value: "accounts" as const, label: "Accounts", testID: "sideload-tab-accounts" },
  { value: "install" as const, label: "Install", testID: "sideload-tab-install" },
  { value: "installed" as const, label: "Installed apps", testID: "sideload-tab-installed" },
];

export function SideloadPane({
  client,
  serverId,
}: {
  client: DaemonClient | null;
  serverId: string;
}) {
  const [section, setSection] = useState<Section>("install");
  const jobs = useSideloadJobs(client, serverId);
  const prompt = useSideloadPrompt(client);
  const { notices, dismiss } = useSideloadNotices(client, serverId);

  if (!client) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>Connecting to the host…</Text>
      </View>
    );
  }
  return (
    <View style={styles.pane} testID="sideload-pane">
      <View style={styles.bar}>
        <SegmentedControl options={SECTIONS} value={section} onValueChange={setSection} size="sm" />
      </View>
      {notices.map((notice) => (
        <View key={notice.at_ms} style={styles.notice}>
          <Alert
            variant={notice.kind === "refreshed" ? "success" : "warning"}
            title={notice.title}
            description={notice.body}
          >
            <ValueButton size="sm" variant="ghost" value={notice.at_ms} onValue={dismiss}>
              Dismiss
            </ValueButton>
          </Alert>
        </View>
      ))}
      {prompt && section !== "accounts" ? (
        <View style={styles.notice}>
          <Alert
            variant="warning"
            title="Apple is asking for a verification code"
            description={`For ${prompt.appleId}.`}
          >
            <ValueButton size="sm" value="accounts" onValue={setSection}>
              Enter code
            </ValueButton>
          </Alert>
        </View>
      ) : null}
      <View style={styles.body}>
        {section === "accounts" ? (
          <AccountsSection client={client} serverId={serverId} prompt={prompt} />
        ) : null}
        {section === "install" ? (
          <InstallSection client={client} serverId={serverId} jobs={jobs} />
        ) : null}
        {section === "installed" ? <InstalledSection client={client} serverId={serverId} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  pane: { flex: 1, minHeight: 0 },
  bar: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    alignItems: "flex-start",
  },
  body: { flex: 1, minHeight: 0 },
  notice: { paddingHorizontal: theme.spacing[4], paddingTop: theme.spacing[2] },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  muted: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
}));
