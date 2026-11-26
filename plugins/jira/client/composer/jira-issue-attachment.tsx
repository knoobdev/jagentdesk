import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { withUnistyles } from "react-native-unistyles";
import { KanbanSquare } from "lucide-react-native";
import {
  useFetchQuery,
  AttachmentLabel,
  AttachmentPill,
  useHostFeature,
  useHostRuntimeClient,
  tint,
} from "../../../../packages/app/src/plugins/builtin/host-api";
import type {
  BuiltinComposerTextWatcherProps,
  ComposerAttachment,
  UserComposerAttachment,
} from "../../../../packages/app/src/plugins/builtin/host-api";
import { callJira, useJiraCall } from "../api";
import { buildJiraIssueAttachment } from "../assistant/issue-attachment";
import { jiraKeys } from "../queries";
import {
  extractJiraIssueRefs,
  matchJiraIssueRefs,
  siteHost,
  type JiraConnectionKeys,
} from "./issue-key";

// `jira_issue` attachments in any composer (spec 29.4): a pasted issue link or a typed issue key
// that belongs to a connection attaches that issue; the `#ABC-123` chip shows it until sent.

const ThemedKanban = withUnistyles(KanbanSquare);
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
      <AttachmentLabel icon={KANBAN_ICON} title={`#${issue.key}`} subtitle={issue.summary} />
    </AttachmentPill>
  );
}

function attachedKeys(attachments: readonly ComposerAttachment[]): Set<string> {
  const keys = new Set<string>();
  for (const attachment of attachments) {
    if (attachment.kind === "jira_issue") keys.add(attachment.attachment.key);
  }
  return keys;
}

const AUTO_ATTACH_DEBOUNCE_MS = 400;

/** Adds the issue's chip unless the composer already has it; false when the issue is unavailable. */
async function attachIssue(input: {
  call: ReturnType<typeof useJiraCall>;
  connectionId: string;
  key: string;
  setAttachments: BuiltinComposerTextWatcherProps["setAttachments"];
}): Promise<boolean> {
  let attachment: Awaited<ReturnType<typeof buildJiraIssueAttachment>>;
  try {
    attachment = await buildJiraIssueAttachment(input.call, input.connectionId, input.key);
  } catch {
    return false;
  }
  input.setAttachments((previous) =>
    attachedKeys(previous).has(attachment.key)
      ? previous
      : [...previous, { kind: "jira_issue", attachment }],
  );
  return true;
}

/** Connected sites with their project keys, so typed keys match only real projects. */
function useJiraConnectionKeys(serverId: string): JiraConnectionKeys[] {
  const supportsJira = useHostFeature(serverId, "jira");
  const client = useHostRuntimeClient(serverId);
  const connections = useFetchQuery({
    queryKey: jiraKeys.connections(serverId),
    queryFn: async () => (await callJira(client, "jira.connections.list.request", {})).connections,
    enabled: supportsJira && client !== null,
    dataShape: "list",
    staleTimeMs: 60_000,
  });
  const connected = useMemo(
    () => (connections.data ?? []).filter((connection) => connection.authState === "connected"),
    [connections.data],
  );
  const projectKeys = useFetchQuery({
    queryKey: ["jira", serverId, "composer-project-keys", connected.map((c) => c.id).join(",")],
    queryFn: async () =>
      Promise.all(
        connected.map(async (connection) => {
          const { projects } = await callJira(client, "jira.projects.list.request", {
            connectionId: connection.id,
          });
          return { id: connection.id, keys: projects.map((project) => project.key) };
        }),
      ),
    enabled: supportsJira && client !== null && connected.length > 0,
    dataShape: "list",
    staleTimeMs: 5 * 60_000,
  });
  return useMemo(() => {
    const keysById = new Map((projectKeys.data ?? []).map((entry) => [entry.id, entry.keys]));
    return connected.flatMap((connection) => {
      const host = siteHost(connection.siteUrl);
      return host
        ? [{ connectionId: connection.id, host, projectKeys: new Set(keysById.get(connection.id)) }]
        : [];
    });
  }, [connected, projectKeys.data]);
}

/**
 * Spec 29.4 / A29.agent.2: a pasted `https://<site>/browse/ABC-1` link or a typed `ABC-1` whose
 * project belongs to a connection becomes a `#ABC-1` chip carrying the `jira_issue` attachment.
 * A chip the user removes stays removed while its key is in the text; unknown keys stay text.
 */
export function JiraIssueAutoAttach({
  serverId,
  text,
  attachments,
  setAttachments,
}: BuiltinComposerTextWatcherProps) {
  const value = useSyncExternalStore(text.subscribe, text.getSnapshot, text.getSnapshot);
  const connections = useJiraConnectionKeys(serverId);
  const call = useJiraCall(serverId);
  const added = useRef(new Set<string>());
  const dismissed = useRef(new Set<string>());
  const failed = useRef(new Set<string>());
  const pending = useRef(new Set<string>());

  const present = useMemo(() => attachedKeys(attachments), [attachments]);
  useEffect(() => {
    for (const key of added.current) {
      if (present.has(key)) continue;
      added.current.delete(key);
      dismissed.current.add(key);
    }
  }, [present]);

  useEffect(() => {
    if (connections.length === 0) return;
    const timer = setTimeout(() => {
      const matches = matchJiraIssueRefs(extractJiraIssueRefs(value), connections);
      const inText = new Set(matches.map((match) => match.key));
      // Deleting the key from the text forgets the dismissal, so typing it again chips it.
      for (const key of dismissed.current) if (!inText.has(key)) dismissed.current.delete(key);
      for (const match of matches) {
        const { key, connectionId } = match;
        if (
          present.has(key) ||
          dismissed.current.has(key) ||
          failed.current.has(key) ||
          pending.current.has(key)
        ) {
          continue;
        }
        pending.current.add(key);
        void attachIssue({ call, connectionId, key, setAttachments }).then((attached) => {
          pending.current.delete(key);
          // No such issue on that site: the key stays plain text.
          (attached ? added : failed).current.add(key);
          return undefined;
        });
      }
    }, AUTO_ATTACH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [call, connections, present, setAttachments, value]);

  return null;
}
