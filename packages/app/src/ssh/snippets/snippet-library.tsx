import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
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
import {
  buildSnippetPackageGroups,
  type PickerGroup,
  type SnippetPackageGroup,
} from "./library-model";
import { useDeletePackage, useDeleteSnippet, useSavePackage, useSnippetLibrary } from "./queries";
import { SnippetEditor, type SnippetServerOption } from "./snippet-editor";
import { snippetTerminalInput, type SnippetWorkspacePlan } from "./snippet-input";
import { SnippetRunPicker } from "./snippet-run-picker";
import { SshEmpty, SshField, SshRow, SshSearchInput, SshSection, sshStyles } from "./ui";

export interface SnippetLibraryProps {
  api: SnippetsApi;
  servers: readonly SnippetServerOption[];
  /** Server groups, for selecting a whole group in "Run on servers". */
  groups: readonly PickerGroup[];
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

interface SnippetRowActions {
  onInsert?: (input: string) => void;
  onRunInAllTabs?: (input: string) => void;
  onEdit: (snippet: SshSnippet) => void;
  onPick: (snippet: SshSnippet) => void;
}

/** The Snippets tab (spec 25.7, 25.13): packages, search, run/paste/run on servers. */
export function SnippetLibrary(props: SnippetLibraryProps) {
  const { api, servers, groups: serverGroups, onInsert, onRunInAllTabs } = props;
  const { onRunInWorkspace, onRunStarted } = props;
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
  const groups = useMemo(
    () =>
      buildSnippetPackageGroups({
        packages: library.data?.packages ?? [],
        snippets: library.data?.snippets ?? [],
        query,
      }),
    [library.data, query],
  );

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
          groups={serverGroups}
          onRunInWorkspace={runInWorkspace}
          onRunStarted={runStarted}
          onCancel={showList}
        />
      </ScrollView>
    );
  }

  const isEmpty = library.isSuccess && library.data.snippets.length === 0;
  const hasNoMatches = library.isSuccess && !isEmpty && query.trim() !== "" && groups.length === 0;
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
      {hasNoMatches ? (
        <SshEmpty text={t("ssh.snippets.library.noMatches", { query: query.trim() })} />
      ) : null}
      {groups.map((group) => (
        <PackageSection
          key={group.key}
          group={group}
          api={api}
          actions={rowActions}
          // A search shows every match, even inside a collapsed package.
          isSearching={query.trim() !== ""}
        />
      ))}
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
  isSearching,
}: {
  group: SnippetPackageGroup;
  api: SnippetsApi;
  actions: SnippetRowActions;
  isSearching: boolean;
}) {
  const { t } = useTranslation();
  const [isCollapsed, setCollapsed] = useState(false);
  const [isRenaming, setRenaming] = useState(false);
  const toggle = useCallback(() => setCollapsed((current) => !current), []);
  const startRename = useCallback(() => setRenaming(true), []);
  const stopRename = useCallback(() => setRenaming(false), []);
  const name = group.pkg ? group.pkg.label : t("ssh.snippets.library.noPackage");
  const title = `${name} · ${t("ssh.snippets.library.packageCount", { count: group.snippets.length })}`;
  const isOpen = isSearching || !isCollapsed;
  const header = useMemo(
    () => (
      <View style={sshStyles.inlineRow}>
        <Button
          size="xs"
          variant="ghost"
          leftIcon={isOpen ? ChevronDown : ChevronRight}
          onPress={toggle}
          accessibilityLabel={t(
            isOpen ? "ssh.snippets.library.collapse" : "ssh.snippets.library.expand",
            { name },
          )}
          testID={`ssh-snippet-package-toggle-${group.key}`}
        />
        {group.pkg ? (
          <Button size="xs" variant="ghost" leftIcon={Pencil} onPress={startRename}>
            {t("ssh.snippets.library.renamePackage")}
          </Button>
        ) : null}
        {group.pkg ? <DeletePackageButton api={api} pkg={group.pkg} /> : null}
      </View>
    ),
    [api, group.key, group.pkg, isOpen, name, startRename, t, toggle],
  );
  return (
    <SshSection title={title} actions={header} testID={`ssh-snippet-package-${group.key}`}>
      {isRenaming && group.pkg ? (
        <RenamePackageForm api={api} pkg={group.pkg} onDone={stopRename} />
      ) : null}
      {isOpen && group.snippets.length === 0 ? (
        <SshEmpty text={t("ssh.snippets.library.emptyPackage")} />
      ) : null}
      {isOpen
        ? group.snippets.map((snippet) => (
            <SnippetRow key={snippet.id} snippet={snippet} api={api} actions={actions} />
          ))
        : null}
    </SshSection>
  );
}

function RenamePackageForm({
  api,
  pkg,
  onDone,
}: {
  api: SnippetsApi;
  pkg: SshSnippetPackage;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState(pkg.label);
  const save = useSavePackage(api);
  const { mutate } = save;
  const rename = useCallback(
    () => mutate({ id: pkg.id, label: label.trim() }, { onSuccess: onDone }),
    [mutate, pkg.id, label, onDone],
  );
  return (
    <View style={sshStyles.stack} testID={`ssh-snippet-package-rename-${pkg.id}`}>
      <SshField
        label={t("ssh.snippets.library.packageName")}
        value={label}
        onChangeText={setLabel}
        testID={`ssh-snippet-package-rename-input-${pkg.id}`}
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
          disabled={label.trim() === "" || label.trim() === pkg.label}
          loading={save.isPending}
          onPress={rename}
          testID={`ssh-snippet-package-rename-save-${pkg.id}`}
        >
          {t("ssh.snippets.library.savePackageName")}
        </Button>
        <Button size="sm" variant="ghost" onPress={onDone}>
          {t("common.actions.cancel")}
        </Button>
      </View>
    </View>
  );
}

function DeletePackageButton({ api, pkg }: { api: SnippetsApi; pkg: SshSnippetPackage }) {
  const { t } = useTranslation();
  const remove = useDeletePackage(api);
  const [isConfirming, setConfirming] = useState(false);
  const { mutate } = remove;
  const askDelete = useCallback(() => setConfirming(true), []);
  const cancel = useCallback(() => setConfirming(false), []);
  const confirm = useCallback(() => mutate(pkg.id), [mutate, pkg.id]);
  if (!isConfirming) {
    return (
      <Button
        size="xs"
        variant="ghost"
        leftIcon={Trash2}
        onPress={askDelete}
        testID={`ssh-snippet-package-delete-${pkg.id}`}
      >
        {t("ssh.snippets.library.deletePackage")}
      </Button>
    );
  }
  return (
    <View style={sshStyles.inlineRow}>
      <Text style={remove.error ? sshStyles.dangerText : sshStyles.rowMeta}>
        {remove.error
          ? t("ssh.snippets.library.packageDeleteFailed")
          : t("ssh.snippets.library.deletePackageHint")}
      </Text>
      <Button
        size="xs"
        variant="destructive"
        loading={remove.isPending}
        onPress={confirm}
        testID={`ssh-snippet-package-confirm-delete-${pkg.id}`}
      >
        {t("ssh.snippets.library.confirmDeletePackage")}
      </Button>
      <Button size="xs" variant="ghost" onPress={cancel}>
        {t("common.actions.cancel")}
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
