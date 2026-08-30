import { useCallback, useMemo, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowUp } from "lucide-react-native";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useSessionStore } from "@/stores/session-store";
import { askAgentAboutResource } from "@/components/cluster-ask-agent";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useClusterChatStore } from "@/stores/cluster-chat-store";
import type { Theme } from "@/styles/theme";

const ThemedArrowUp = withUnistyles(ArrowUp);
const sendIconColor = (theme: Theme) => ({ color: theme.colors.accentForeground });

/**
 * A real chat composer pinned to the bottom of the cluster/workloads view.
 * The user types a question and sends it — this creates an agent with the
 * cluster context + the typed message and opens the chat (matches the mockup).
 */
export interface ClusterComposerResource {
  kind?: string | null;
  namespace?: string;
  name?: string;
  yaml?: string | null;
  logs?: string | null;
}

export function ClusterComposer({
  serverId,
  clusterId,
  clusterName,
  resource,
  onSent,
  onCreated,
  cwd: cwdProp,
  provider: providerProp,
}: {
  serverId: string;
  clusterId: string;
  clusterName: string;
  /** What the user is currently viewing — attached as context to their question. */
  resource?: ClusterComposerResource;
  /** Called after a message is sent (e.g. to close a detail sheet). */
  onSent?: () => void;
  /**
   * Where to open the created conversation. Defaults to the slide-in chat dock;
   * callers embedding this as the dock's own entry composer pass their handler so
   * the project (cwd) and dock state stay consistent.
   */
  onCreated?: (input: { clusterId: string; agentId: string; workspaceId: string | null }) => void;
  /** cwd/provider overrides so an embedding dock's picked project is honoured. */
  cwd?: string | null;
  provider?: string | null;
}) {
  const client = useHostRuntimeClient(serverId);
  const { entries: providerEntries } = useProvidersSnapshot(serverId);
  const firstWorkspace = useSessionStore(
    (state) => state.sessions[serverId]?.workspaces.values().next().value,
  );
  const provider = providerProp ?? providerEntries?.find((e) => e.enabled)?.provider ?? null;
  const cwd = cwdProp ?? firstWorkspace?.workspaceDirectory ?? null;
  const ready = Boolean(client && provider && cwd);

  const [text, setText] = useState("");
  const openChatStore = useClusterChatStore((s) => s.openChat);
  const openChat = onCreated ?? openChatStore;
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();
  // Clear the home indicator / gesture bar on phones without padding desktop.
  const wrapStyle = useMemo(
    () => [styles.wrap, isCompact && insets.bottom > 0 ? { paddingBottom: insets.bottom } : null],
    [isCompact, insets.bottom],
  );

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || !client || !provider || !cwd) return;
    void askAgentAboutResource({
      client,
      serverId,
      clusterId,
      clusterName,
      kind: resource?.kind ?? "cluster",
      namespace: resource?.namespace,
      name: resource?.name,
      yaml: resource?.yaml ?? undefined,
      logs: resource?.logs ?? undefined,
      provider,
      cwd,
      message: trimmed,
      // Open the conversation in the slide-in dock instead of a full agent tab
      // so the k8s resources stay on screen.
      onCreated: ({ id, workspaceId }) => openChat({ clusterId, agentId: id, workspaceId }),
    });
    setText("");
    onSent?.();
  }, [text, client, provider, cwd, serverId, clusterId, clusterName, resource, openChat, onSent]);

  const canSend = ready && text.trim().length > 0;

  const placeholder = useMemo(() => {
    if (!ready) return "Connect a host & add a project to chat with an agent";
    if (resource?.name) {
      return `Ask about ${resource.kind ?? "this"} "${resource.name}"…`;
    }
    if (resource?.kind) {
      const ns = resource.namespace ? ` in ${resource.namespace}` : "";
      return `Ask about ${resource.kind}${ns}…`;
    }
    return `Ask an agent about ${clusterName}…  e.g. "why is a pod crash-looping?"`;
  }, [ready, resource, clusterName]);

  return (
    <View style={wrapStyle}>
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
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
