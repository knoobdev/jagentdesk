import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { BookmarkPlus, ClipboardPaste, Play, RefreshCw } from "lucide-react-native";
import type { SshCommandHistoryEntry, SshSnippet } from "@jagentdesk/protocol/ssh/snippets-schemas";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { SnippetsApi } from "./api";
import { useClearHistory, useCommandHistory, useSnippetLibrary } from "./queries";
import { SnippetEditor, type SnippetServerOption } from "./snippet-editor";
import { snippetTerminalInput } from "./snippet-input";
import { filterHistory } from "./library-model";
import { SshEmpty, SshRow, SshSearchInput, SshSection, sshStyles } from "./ui";

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
  const [savedLabel, setSavedLabel] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const stopSaving = useCallback(() => setSaving(null), []);
  const saved = useCallback((label: string) => {
    setSaving(null);
    setSavedLabel(label);
  }, []);
  const startSaving = useCallback((command: string) => {
    setSavedLabel(null);
    setSaving(command);
  }, []);
  const { refetch } = history;
  const refresh = useCallback(() => void refetch(), [refetch]);
  const hasEntries = (history.data ?? []).length > 0;
  const actions = useMemo(
    () => (
      <View style={sshStyles.inlineRow}>
        <Button
          size="xs"
          variant="ghost"
          leftIcon={RefreshCw}
          loading={history.isFetching}
          onPress={refresh}
          accessibilityLabel={t("common.actions.reload")}
          testID="ssh-command-history-refresh"
        />
        {hasEntries ? <ClearHistoryButton api={api} serverId={serverId} /> : null}
      </View>
    ),
    [hasEntries, api, serverId, history.isFetching, refresh, t],
  );

  if (saving !== null) {
    return (
      <SaveAsSnippet
        api={api}
        command={saving}
        serverId={serverId}
        servers={servers}
        onSaved={saved}
        onCancel={stopSaving}
      />
    );
  }

  const allEntries = history.data ?? [];
  const entries = filterHistory(allEntries, query);
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
        {savedLabel !== null ? (
          <Text style={sshStyles.successText} testID="ssh-command-history-saved">
            {`${t("ssh.snippets.history.savedAsSnippet")}: ${savedLabel}`}
          </Text>
        ) : null}
        {allEntries.length > 0 ? (
          <SshSearchInput
            value={query}
            onChangeText={setQuery}
            placeholder={t("ssh.snippets.history.search")}
            testID="ssh-command-history-search"
          />
        ) : null}
        {history.isSuccess && allEntries.length === 0 ? (
          <SshEmpty text={t("ssh.snippets.history.empty")} />
        ) : null}
        {allEntries.length > 0 && entries.length === 0 ? (
          <SshEmpty text={t("ssh.snippets.history.noMatches")} />
        ) : null}
        {entries.map((entry) => (
          <HistoryRow
            key={`${entry.atMs}-${entry.command}`}
            entry={entry}
            onInsert={onInsert}
            onSave={startSaving}
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
  onSaved,
  onCancel,
}: {
  api: SnippetsApi;
  command: string;
  serverId: string;
  servers: readonly SnippetServerOption[];
  onSaved: (label: string) => void;
  onCancel: () => void;
}) {
  const library = useSnippetLibrary(api);
  const saveSnippet = useCallback((snippet: SshSnippet) => onSaved(snippet.label), [onSaved]);
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
        onSaved={saveSnippet}
        onCancel={onCancel}
      />
    </ScrollView>
  );
}

function ClearHistoryButton({ api, serverId }: { api: SnippetsApi; serverId: string }) {
  const { t } = useTranslation();
  const clear = useClearHistory(api, serverId);
  const [isConfirming, setConfirming] = useState(false);
  const { mutate } = clear;
  const askClear = useCallback(() => setConfirming(true), []);
  const cancel = useCallback(() => setConfirming(false), []);
  const run = useCallback(() => mutate(undefined, { onSuccess: cancel }), [mutate, cancel]);
  return (
    <View style={sshStyles.inlineRow}>
      {clear.error ? (
        <Text style={sshStyles.dangerText}>{t("ssh.snippets.history.clearFailed")}</Text>
      ) : null}
      {isConfirming ? (
        <>
          <Button
            size="xs"
            variant="destructive"
            loading={clear.isPending}
            onPress={run}
            testID="ssh-command-history-confirm-clear"
          >
            {t("ssh.snippets.history.confirmClear")}
          </Button>
          <Button size="xs" variant="ghost" onPress={cancel}>
            {t("common.actions.cancel")}
          </Button>
        </>
      ) : (
        <Button size="xs" variant="ghost" onPress={askClear} testID="ssh-command-history-clear">
          {t("ssh.snippets.history.clear")}
        </Button>
      )}
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
