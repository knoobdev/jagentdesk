import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  ClipboardPaste,
  FolderPlus,
  Pencil,
  Play,
  Plus,
  Server,
  Trash2,
} from "lucide-react-native";
import type {
  SshSnippet,
  SshSnippetPackage,
  SshSnippetRun,
} from "@jagentdesk/protocol/ssh/snippets-schemas";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { SnippetsApi } from "./api";
import { useDeletePackage, useDeleteSnippet, useSavePackage, useSnippetLibrary } from "./queries";
import { SnippetEditor, type SnippetServerOption } from "./snippet-editor";
import { snippetTerminalInput, type SnippetWorkspacePlan } from "./snippet-input";
import { SnippetRunPicker } from "./snippet-run-picker";
import { SshEmpty, SshField, SshRow, SshSearchInput, SshSection, sshStyles } from "./ui";

export interface SnippetLibraryProps {
  api: SnippetsApi;
  servers: readonly SnippetServerOption[];
  /** Present while a terminal tab is focused: Run (type + Enter) or Paste into it. */
  onInsert?: (input: string) => void;
  /** Present while SSH tabs are open: "Run in all tabs" types into every open session. */
  onRunInAllTabs?: (input: string) => void;
  onRunInWorkspace: (plan: SnippetWorkspacePlan) => void;
  onRunStarted: (run: SshSnippetRun) => void;
}

type LibraryMode =
  | { kind: "list" }
  | { kind: "edit"; snippet?: SshSnippet }
  | { kind: "pick"; snippet: SshSnippet }
  | { kind: "package" };

interface SnippetGroup {
  key: string;
  pkg: SshSnippetPackage | null;
  snippets: SshSnippet[];
}

interface SnippetRowActions {
  onInsert?: (input: string) => void;
  onRunInAllTabs?: (input: string) => void;
  onEdit: (snippet: SshSnippet) => void;
  onPick: (snippet: SshSnippet) => void;
}

function matchesSnippet(snippet: SshSnippet, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return (
    snippet.label.toLowerCase().includes(needle) || snippet.script.toLowerCase().includes(needle)
  );
}

function groupByPackage(
  packages: readonly SshSnippetPackage[],
  snippets: readonly SshSnippet[],
): SnippetGroup[] {
  const groups: SnippetGroup[] = packages.map((pkg) => ({
    key: pkg.id,
    pkg,
    snippets: snippets.filter((snippet) => snippet.packageId === pkg.id),
  }));
  const known = new Set(packages.map((pkg) => pkg.id));
  const loose = snippets.filter((snippet) => !snippet.packageId || !known.has(snippet.packageId));
  return [{ key: "none", pkg: null, snippets: loose }, ...groups];
}

/** The Snippets tab (spec 25.7, 25.13): packages, search, run/paste/run on servers. */
export function SnippetLibrary(props: SnippetLibraryProps) {
  const { api, servers, onInsert, onRunInAllTabs, onRunInWorkspace, onRunStarted } = props;
  const { t } = useTranslation();
  const library = useSnippetLibrary(api);
  const [mode, setMode] = useState<LibraryMode>({ kind: "list" });
  const [query, setQuery] = useState("");
  const showList = useCallback(() => setMode({ kind: "list" }), []);
  const newSnippet = useCallback(() => setMode({ kind: "edit" }), []);
  const newPackage = useCallback(() => setMode({ kind: "package" }), []);
  const { refetch } = library;
  const retry = useCallback(() => void refetch(), [refetch]);
  const runInWorkspace = useCallback(
    (plan: SnippetWorkspacePlan) => {
      showList();
      onRunInWorkspace(plan);
    },
    [showList, onRunInWorkspace],
  );
  const runStarted = useCallback(
    (run: SshSnippetRun) => {
      showList();
      onRunStarted(run);
    },
    [showList, onRunStarted],
  );
  const rowActions = useMemo<SnippetRowActions>(
    () => ({
      onInsert,
      onRunInAllTabs,
      onEdit: (snippet) => setMode({ kind: "edit", snippet }),
      onPick: (snippet) => setMode({ kind: "pick", snippet }),
    }),
    [onInsert, onRunInAllTabs],
  );
  const packages = library.data?.packages ?? [];
  const groups = useMemo(() => {
    const visible = (library.data?.snippets ?? []).filter((s) => matchesSnippet(s, query));
    return groupByPackage(library.data?.packages ?? [], visible);
  }, [library.data, query]);

  if (mode.kind === "edit") {
    return (
      <ScrollView>
        <SnippetEditor
          api={api}
          packages={packages}
          servers={servers}
          initial={mode.snippet}
          onSaved={showList}
          onCancel={showList}
        />
      </ScrollView>
    );
  }
  if (mode.kind === "pick") {
    return (
      <ScrollView>
        <SnippetRunPicker
          api={api}
          snippet={mode.snippet}
          servers={servers}
          onRunInWorkspace={runInWorkspace}
          onRunStarted={runStarted}
          onCancel={showList}
        />
      </ScrollView>
    );
  }

  const isEmpty = library.isSuccess && library.data.snippets.length === 0;
  return (
    <ScrollView contentContainerStyle={sshStyles.padded} testID="ssh-snippet-library">
      <View style={sshStyles.inlineRow}>
        <View style={sshStyles.grow}>
          <SshSearchInput
            value={query}
            onChangeText={setQuery}
            placeholder={t("ssh.snippets.library.search")}
            testID="ssh-snippet-search"
          />
        </View>
        <Button
          size="sm"
          variant="default"
          leftIcon={Plus}
          onPress={newSnippet}
          testID="ssh-snippet-new"
        >
          {t("ssh.snippets.library.newSnippet")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          leftIcon={FolderPlus}
          onPress={newPackage}
          testID="ssh-snippet-new-package"
        >
          {t("ssh.snippets.library.newPackage")}
        </Button>
      </View>
      {mode.kind === "package" ? <NewPackageForm api={api} onDone={showList} /> : null}
      {library.error ? (
        <Alert
          variant="error"
          title={t("ssh.snippets.library.loadFailed")}
          description={library.error.message}
        >
          <Button size="sm" variant="outline" onPress={retry}>
            {t("common.actions.retry")}
          </Button>
        </Alert>
      ) : null}
      {library.isPending ? <SshEmpty text={t("common.loading")} /> : null}
      {isEmpty ? <SshEmpty text={t("ssh.snippets.library.empty")} /> : null}
      {groups.map((group) =>
        group.snippets.length === 0 && group.pkg === null ? null : (
          <PackageSection key={group.key} group={group} api={api} actions={rowActions} />
        ),
      )}
    </ScrollView>
  );
}

function NewPackageForm({ api, onDone }: { api: SnippetsApi; onDone: () => void }) {
  const { t } = useTranslation();
  const [label, setLabel] = useState("");
  const save = useSavePackage(api);
  const { mutate } = save;
  const create = useCallback(
    () => mutate({ label }, { onSuccess: onDone }),
    [mutate, label, onDone],
  );
  return (
    <View style={sshStyles.stack} testID="ssh-snippet-package-form">
      <SshField
        label={t("ssh.snippets.library.packageName")}
        value={label}
        onChangeText={setLabel}
        testID="ssh-snippet-package-label"
      />
      {save.error ? (
        <Alert
          variant="error"
          title={t("ssh.snippets.library.packageSaveFailed")}
          description={save.error.message}
        />
      ) : null}
      <View style={sshStyles.rowActions}>
        <Button
          size="sm"
          variant="default"
          disabled={label.trim() === ""}
          loading={save.isPending}
          onPress={create}
          testID="ssh-snippet-package-save"
        >
          {t("ssh.snippets.library.createPackage")}
        </Button>
        <Button size="sm" variant="ghost" onPress={onDone}>
          {t("common.actions.cancel")}
        </Button>
      </View>
    </View>
  );
}

function PackageSection({
  group,
  api,
  actions,
}: {
  group: SnippetGroup;
  api: SnippetsApi;
  actions: SnippetRowActions;
}) {
  const { t } = useTranslation();
  const title = group.pkg ? group.pkg.label : t("ssh.snippets.library.noPackage");
  const header = useMemo(
    () => (group.pkg ? <DeletePackageButton api={api} pkg={group.pkg} /> : null),
    [api, group.pkg],
  );
  return (
    <SshSection title={title} actions={header} testID={`ssh-snippet-package-${group.key}`}>
      {group.snippets.length === 0 ? (
        <SshEmpty text={t("ssh.snippets.library.emptyPackage")} />
      ) : null}
      {group.snippets.map((snippet) => (
        <SnippetRow key={snippet.id} snippet={snippet} api={api} actions={actions} />
      ))}
    </SshSection>
  );
}

function DeletePackageButton({ api, pkg }: { api: SnippetsApi; pkg: SshSnippetPackage }) {
  const { t } = useTranslation();
  const remove = useDeletePackage(api);
  const { mutate } = remove;
  const run = useCallback(() => mutate(pkg.id), [mutate, pkg.id]);
  return (
    <View style={sshStyles.inlineRow}>
      {remove.error ? (
        <Text style={sshStyles.dangerText}>{t("ssh.snippets.library.packageDeleteFailed")}</Text>
      ) : null}
      <Button size="xs" variant="ghost" leftIcon={Trash2} loading={remove.isPending} onPress={run}>
        {t("ssh.snippets.library.deletePackage")}
      </Button>
    </View>
  );
}

function SnippetRow({
  snippet,
  api,
  actions,
}: {
  snippet: SshSnippet;
  api: SnippetsApi;
  actions: SnippetRowActions;
}) {
  const { t } = useTranslation();
  const remove = useDeleteSnippet(api);
  const [confirming, setConfirming] = useState(false);
  const { onInsert, onRunInAllTabs, onEdit, onPick } = actions;
  const { mutate } = remove;
  const run = useCallback(
    () => onInsert?.(snippetTerminalInput(snippet.script, "run")),
    [onInsert, snippet.script],
  );
  const paste = useCallback(
    () => onInsert?.(snippetTerminalInput(snippet.script, "paste")),
    [onInsert, snippet.script],
  );
  const runInAllTabs = useCallback(
    () => onRunInAllTabs?.(snippetTerminalInput(snippet.script, "run")),
    [onRunInAllTabs, snippet.script],
  );
  const edit = useCallback(() => onEdit(snippet), [onEdit, snippet]);
  const pick = useCallback(() => onPick(snippet), [onPick, snippet]);
  const askDelete = useCallback(() => setConfirming(true), []);
  const confirmDelete = useCallback(() => mutate(snippet.id), [mutate, snippet.id]);
  return (
    <SshRow testID={`ssh-snippet-${snippet.id}`}>
      <Text style={sshStyles.rowTitle}>{snippet.label}</Text>
      <Text style={sshStyles.mono} numberOfLines={2}>
        {snippet.script}
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
        {onRunInAllTabs ? (
          <Button size="xs" variant="ghost" onPress={runInAllTabs}>
            {t("ssh.snippets.library.runInAllTabs")}
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          leftIcon={Server}
          onPress={pick}
          testID={`ssh-snippet-run-on-${snippet.id}`}
        >
          {t("ssh.snippets.library.runOnServers")}
        </Button>
        <Button size="xs" variant="ghost" leftIcon={Pencil} onPress={edit}>
          {t("ssh.snippets.library.edit")}
        </Button>
        {confirming ? (
          <Button
            size="xs"
            variant="destructive"
            loading={remove.isPending}
            onPress={confirmDelete}
            testID={`ssh-snippet-confirm-delete-${snippet.id}`}
          >
            {t("ssh.snippets.library.confirmDelete")}
          </Button>
        ) : (
          <Button size="xs" variant="ghost" leftIcon={Trash2} onPress={askDelete}>
            {t("ssh.snippets.library.delete")}
          </Button>
        )}
      </View>
      {remove.error ? (
        <Alert
          variant="error"
          title={t("ssh.snippets.library.deleteFailed")}
          description={remove.error.message}
        />
      ) : null}
    </SshRow>
  );
}
