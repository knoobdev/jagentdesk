import { useCallback, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ArrowUp } from "lucide-react-native";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useSessionStore } from "@/stores/session-store";
import { askAgentAboutResource } from "@/components/cluster-ask-agent";
import type { Theme } from "@/styles/theme";

const ThemedArrowUp = withUnistyles(ArrowUp);
const sendIconColor = (theme: Theme) => ({ color: theme.colors.accentForeground });

/**
 * A real chat composer pinned to the bottom of the cluster/workloads view.
 * The user types a question and sends it — this creates an agent with the
 * cluster context + the typed message and opens the chat (matches the mockup).
 */
export function ClusterComposer({
  serverId,
  clusterId,
  clusterName,
  currentKind,
}: {
  serverId: string;
  clusterId: string;
  clusterName: string;
  currentKind?: string | null;
}) {
  const client = useHostRuntimeClient(serverId);
  const { entries: providerEntries } = useProvidersSnapshot(serverId);
  const firstWorkspace = useSessionStore(
    (state) => state.sessions[serverId]?.workspaces.values().next().value,
  );
  const provider = providerEntries?.find((e) => e.enabled)?.provider ?? null;
  const cwd = firstWorkspace?.workspaceDirectory ?? null;
  const ready = Boolean(client && provider && cwd);

  const [text, setText] = useState("");

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || !client || !provider || !cwd) return;
    void askAgentAboutResource({
      client,
      serverId,
      clusterId,
      kind: currentKind ?? "cluster",
      provider,
      cwd,
      message: trimmed,
    });
    setText("");
  }, [text, client, provider, cwd, serverId, clusterId, currentKind]);

  const canSend = ready && text.trim().length > 0;

  return (
    <View style={styles.wrap}>
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder={
            ready
              ? `Ask an agent about ${clusterName}…  e.g. "why is a pod crash-looping?"`
              : "Connect a host & add a project to chat with an agent"
          }
          placeholderTextColor={placeholderColor}
          editable={ready}
          multiline
          onSubmitEditing={handleSend}
          submitBehavior="submit"
        />
        <Pressable
          style={[styles.send, !canSend && styles.sendDisabled]}
          onPress={handleSend}
          disabled={!canSend}
          accessibilityLabel="Send message to agent"
        >
          <ThemedArrowUp size={18} uniProps={sendIconColor} />
        </Pressable>
      </View>
    </View>
  );
}

const placeholderColor = "#717574";

const styles = StyleSheet.create((theme: Theme) => ({
  wrap: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius["2xl"],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1.5],
    paddingVertical: theme.spacing[1.5],
  },
  input: {
    flex: 1,
    minHeight: 24,
    maxHeight: 120,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    paddingVertical: theme.spacing[1],
  },
  send: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.accent,
  },
  sendDisabled: {
    opacity: 0.4,
  },
}));
