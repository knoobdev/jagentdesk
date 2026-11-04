import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { KanbanSquare, X } from "lucide-react-native";
import { useFetchQuery } from "@/data/query";
import type { ComposerAttachment, UserComposerAttachment } from "@/attachments/types";
import { AttachmentLabel, AttachmentPill } from "@/components/attachment-pill";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { callJira, errorMessage, useJiraCall } from "../api";
import { buildJiraIssueAttachment, type JiraIssueAttachment } from "../assistant/issue-attachment";
import { jiraKeys } from "../queries";
import { lastIssueKey } from "./issue-key";
import { tint } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";

// `jira_issue` attachments in any composer (spec 29.4): typing an issue key (ABC-123) offers to
// attach that issue; the pill shows it until sent.

const ThemedKanban = withUnistyles(KanbanSquare);
const ThemedX = withUnistyles(X);
const KANBAN_ICON = <ThemedKanban size={14} uniProps={tint.muted} />;

export type JiraComposerAttachment = Extract<UserComposerAttachment, { kind: "jira_issue" }>;

export function JiraIssuePill({
  attachment,
  index,
  disabled,
  onOpen,
  onRemove,
}: {
  attachment: JiraComposerAttachment;
  index: number;
  disabled: boolean;
  onOpen: (attachment: JiraComposerAttachment) => void;
  onRemove: (index: number) => void;
}) {
  const issue = attachment.attachment;
  const open = useCallback(() => onOpen(attachment), [attachment, onOpen]);
  const remove = useCallback(() => onRemove(index), [index, onRemove]);
  return (
    <AttachmentPill
      testID="composer-jira-attachment-pill"
      onOpen={open}
      onRemove={remove}
      openAccessibilityLabel={`Open Jira issue ${issue.key}`}
      removeAccessibilityLabel={`Remove Jira issue ${issue.key}`}
      disabled={disabled}
    >
      <AttachmentLabel icon={KANBAN_ICON} title={issue.summary} subtitle={`Jira ${issue.key}`} />
    </AttachmentPill>
  );
}

function hasIssue(attachments: ComposerAttachment[], key: string): boolean {
  return attachments.some(
    (attachment) => attachment.kind === "jira_issue" && attachment.attachment.key === key,
  );
}

/** "Attach ABC-12 from Jira" above the composer input when the text names an issue key. */
export function JiraIssueSuggestion({
  serverId,
  text,
  attachments,
  onAttach,
}: {
  serverId: string;
  text: string;
  attachments: ComposerAttachment[];
  onAttach: (attachment: JiraIssueAttachment) => void;
}) {
  const supportsJira = useHostFeature(serverId, "jira");
  const client = useHostRuntimeClient(serverId);
  const call = useJiraCall(serverId);
  const connections = useFetchQuery({
    queryKey: jiraKeys.connections(serverId),
    queryFn: async () => (await callJira(client, "jira.connections.list.request", {})).connections,
    enabled: supportsJira && client !== null,
    dataShape: "list",
    staleTimeMs: 60_000,
  });
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "attaching" } | { kind: "error"; message: string }
  >({ kind: "idle" });
  const key = useMemo(() => (supportsJira ? lastIssueKey(text) : null), [supportsJira, text]);
  const connection =
    connections.data?.find((candidate) => candidate.authState === "connected") ?? null;

  const attach = useCallback(async () => {
    if (!key || !connection) return;
    setState({ kind: "attaching" });
    try {
      onAttach(await buildJiraIssueAttachment(call, connection.id, key));
      setState({ kind: "idle" });
    } catch (error) {
      setState({ kind: "error", message: errorMessage(error) });
    }
  }, [call, connection, key, onAttach]);

  const handleAttach = useCallback(() => void attach(), [attach]);
  const dismiss = useCallback(() => {
    if (key) setDismissed((previous) => new Set([...previous, key]));
  }, [key]);

  if (!key || !connection || dismissed.has(key) || hasIssue(attachments, key)) return null;
  const label = state.kind === "attaching" ? `Attaching ${key}…` : `Attach ${key} from Jira`;
  return (
    <View style={jiraStyles.rowWrap} testID="composer-jira-suggestion">
      <Pressable
        style={jiraStyles.chip}
        onPress={handleAttach}
        disabled={state.kind === "attaching"}
        testID="composer-jira-attach"
      >
        <ThemedKanban size={12} uniProps={tint.muted} />
        <Text style={jiraStyles.chipText}>{label}</Text>
      </Pressable>
      <Pressable onPress={dismiss} accessibilityLabel="Dismiss" hitSlop={6}>
        <ThemedX size={12} uniProps={tint.muted} />
      </Pressable>
      {state.kind === "error" ? <Text style={jiraStyles.textSmall}>{state.message}</Text> : null}
    </View>
  );
}
