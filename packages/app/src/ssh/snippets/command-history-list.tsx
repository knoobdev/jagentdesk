import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { BookmarkPlus, ClipboardPaste, Play } from "lucide-react-native";
import type { SshCommandHistoryEntry } from "@jagentdesk/protocol/ssh/snippets-schemas";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { SnippetsApi } from "./api";
import { useClearHistory, useCommandHistory, useSnippetLibrary } from "./queries";
import { SnippetEditor, type SnippetServerOption } from "./snippet-editor";
import { snippetTerminalInput } from "./snippet-input";
import { SshEmpty, SshRow, SshSection, sshStyles } from "./ui";

export interface CommandHistoryListProps {
  api: SnippetsApi;
  serverId: string;
  servers: readonly SnippetServerOption[];
  /** Present while this server's terminal is focused. */
  onInsert?: (input: string) => void;
}

/** Per-server command history (spec 25.7): run, paste, or "Save as snippet". */
export function CommandHistoryList({ api, serverId, servers, onInsert }: CommandHistoryListProps) {
  const { t } = useTranslation();
  const history = useCommandHistory(api, serverId);
  const [saving, setSaving] = useState<string | null>(null);
  const stopSaving = useCallback(() => setSaving(null), []);
  const hasEntries = (history.data ?? []).length > 0;
  const actions = useMemo(
    () => (hasEntries ? <ClearHistoryButton api={api} serverId={serverId} /> : null),
    [hasEntries, api, serverId],
  );

  if (saving !== null) {
    return (
      <SaveAsSnippet
        api={api}
        command={saving}
        serverId={serverId}
        servers={servers}
        onDone={stopSaving}
      />
    );
  }

  const entries = history.data ?? [];
  return (
    <ScrollView contentContainerStyle={sshStyles.padded} testID="ssh-command-history">
      <SshSection title={t("ssh.snippets.history.title")} actions={actions}>
        {history.error ? (
          <Alert
            variant="error"
            title={t("ssh.snippets.history.loadFailed")}
            description={history.error.message}
          />
        ) : null}
        {history.isPending ? <SshEmpty text={t("common.loading")} /> : null}
        {history.isSuccess && entries.length === 0 ? (
          <SshEmpty text={t("ssh.snippets.history.empty")} />
        ) : null}
        {entries.map((entry) => (
          <HistoryRow
            key={`${entry.atMs}-${entry.command}`}
            entry={entry}
            onInsert={onInsert}
            onSave={setSaving}
          />
        ))}
      </SshSection>
    </ScrollView>
  );
}

function SaveAsSnippet({
  api,
  command,
  serverId,
  servers,
  onDone,
}: {
  api: SnippetsApi;
  command: string;
  serverId: string;
  servers: readonly SnippetServerOption[];
  onDone: () => void;
}) {
  const library = useSnippetLibrary(api);
  const initial = useMemo(
    () => ({ label: command.split("\n")[0] ?? "", script: command, defaultTargets: [serverId] }),
    [command, serverId],
  );
  return (
    <ScrollView>
      <SnippetEditor
        api={api}
        packages={library.data?.packages ?? []}
        servers={servers}
        initial={initial}
        onSaved={onDone}
        onCancel={onDone}
      />
    </ScrollView>
  );
}

function ClearHistoryButton({ api, serverId }: { api: SnippetsApi; serverId: string }) {
  const { t } = useTranslation();
  const clear = useClearHistory(api, serverId);
  const { mutate } = clear;
  const run = useCallback(() => mutate(), [mutate]);
  return (
    <View style={sshStyles.inlineRow}>
      {clear.error ? (
        <Text style={sshStyles.dangerText}>{t("ssh.snippets.history.clearFailed")}</Text>
      ) : null}
      <Button size="xs" variant="ghost" loading={clear.isPending} onPress={run}>
        {t("ssh.snippets.history.clear")}
      </Button>
    </View>
  );
}

function HistoryRow({
  entry,
  onInsert,
  onSave,
}: {
  entry: SshCommandHistoryEntry;
  onInsert?: (input: string) => void;
  onSave: (command: string) => void;
}) {
  const { t } = useTranslation();
  const run = useCallback(
    () => onInsert?.(snippetTerminalInput(entry.command, "run")),
    [onInsert, entry.command],
  );
  const paste = useCallback(
    () => onInsert?.(snippetTerminalInput(entry.command, "paste")),
    [onInsert, entry.command],
  );
  const save = useCallback(() => onSave(entry.command), [onSave, entry.command]);
  const sourceKey =
    entry.source === "snippet"
      ? "ssh.snippets.history.fromSnippet"
      : "ssh.snippets.history.fromInput";
  return (
    <SshRow>
      <Text style={sshStyles.mono} numberOfLines={3} selectable>
        {entry.command}
      </Text>
      <Text style={sshStyles.rowMeta}>
        {t(sourceKey, { time: new Date(entry.atMs).toLocaleString() })}
      </Text>
      <View style={sshStyles.rowActions}>
        {onInsert ? (
          <Button size="xs" variant="outline" leftIcon={Play} onPress={run}>
            {t("ssh.snippets.library.run")}
          </Button>
        ) : null}
        {onInsert ? (
          <Button size="xs" variant="ghost" leftIcon={ClipboardPaste} onPress={paste}>
            {t("ssh.snippets.library.paste")}
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" leftIcon={BookmarkPlus} onPress={save}>
          {t("ssh.snippets.history.saveAsSnippet")}
        </Button>
      </View>
    </SshRow>
  );
}
