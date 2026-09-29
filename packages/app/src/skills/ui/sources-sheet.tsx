import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { SkillSourceStatus } from "@jagentdesk/protocol/native-skills";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { skillErrorMessage } from "@/skills/native-skill-logic";
import {
  describeSourceAddError,
  describeSourceSpec,
  missingDefaultSources,
} from "@/skills/skill-sources-logic";
import { SectionTitle, SkillBadge } from "@/skills/ui/skill-chrome";
import {
  useSkillSourceActions,
  useSkillSourcesQuery,
  type SkillSourceActions,
} from "@/skills/ui/use-skill-sources";
import type { Theme } from "@/styles/theme";
import { formatTimeAgo } from "@/utils/time";

type Translate = ReturnType<typeof useTranslation>["t"];

function sourceStatusLine(source: SkillSourceStatus, t: Translate): string {
  if (source.lastRefreshMs === null) return t("skillsHub.sources.neverRefreshed");
  const when = formatTimeAgo(new Date(source.lastRefreshMs));
  return t("skillsHub.sources.refreshed", { when, count: source.itemCount ?? 0 });
}

interface SourceRowProps {
  source: SkillSourceStatus;
  actions: SkillSourceActions;
}

function SourceRow({ source, actions }: SourceRowProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<"toggle" | "refresh" | "remove" | null>(null);
  const run = useCallback(
    async (kind: "toggle" | "refresh" | "remove", work: () => Promise<void>) => {
      setBusy(kind);
      try {
        await work();
      } finally {
        setBusy(null);
      }
    },
    [],
  );
  const handleToggle = useCallback(
    (enabled: boolean) => void run("toggle", () => actions.setEnabled(source, enabled)),
    [actions, run, source],
  );
  const handleRefresh = useCallback(
    () => void run("refresh", () => actions.refresh(source)),
    [actions, run, source],
  );
  const handleRemove = useCallback(
    () => void run("remove", () => actions.remove(source)),
    [actions, run, source],
  );
  return (
    <View style={styles.row} testID={`skills-source-${source.sourceId}`}>
      <View style={styles.rowMain}>
        <View style={styles.rowHead}>
          <Text style={styles.rowLabel} numberOfLines={1}>
            {source.label}
          </Text>
          <SkillBadge label={t(`skillsHub.sources.kind.${source.spec.kind}`)} />
          {source.builtin ? <SkillBadge label={t("skillsHub.sources.builtin")} /> : null}
        </View>
        <Text style={styles.spec} numberOfLines={2} selectable>
          {describeSourceSpec(source.spec)}
        </Text>
        <Text style={styles.status}>{sourceStatusLine(source, t)}</Text>
        {source.error ? (
          <Text style={styles.error} testID={`skills-source-error-${source.sourceId}`}>
            {source.error}
          </Text>
        ) : null}
        <View style={styles.rowActions}>
          <Button
            size="sm"
            variant="outline"
            onPress={handleRefresh}
            loading={busy === "refresh"}
            disabled={busy !== null || !source.enabled}
            testID={`skills-source-refresh-${source.sourceId}`}
          >
            {t("skillsHub.sources.refresh")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onPress={handleRemove}
            loading={busy === "remove"}
            disabled={busy !== null}
            testID={`skills-source-remove-${source.sourceId}`}
          >
            {t("skillsHub.sources.remove")}
          </Button>
        </View>
      </View>
      <Switch
        value={source.enabled}
        onValueChange={handleToggle}
        disabled={busy !== null}
        accessibilityLabel={t("skillsHub.sources.enable", { label: source.label })}
        testID={`skills-source-enabled-${source.sourceId}`}
      />
    </View>
  );
}

interface AddSourceFormProps {
  actions: SkillSourceActions;
  disabled: boolean;
}

/** "Add source" (spec 22.5): the daemon validates by listing once and explains failures. */
export function AddSourceForm({ actions, disabled }: AddSourceFormProps) {
  const { t } = useTranslation();
  const [source, setSource] = useState("");
  const [label, setLabel] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<ReturnType<typeof describeSourceAddError> | null>(null);
  const trimmed = source.trim();

  const handleAdd = useCallback(async () => {
    if (!trimmed) return;
    setAdding(true);
    setError(null);
    try {
      const customLabel = label.trim();
      await actions.add({ source: trimmed, ...(customLabel ? { label: customLabel } : {}) });
      setSource("");
      setLabel("");
      setResetKey((prev) => prev + 1);
    } catch (addError) {
      setError(describeSourceAddError(addError));
    } finally {
      setAdding(false);
    }
  }, [actions, label, trimmed]);
  const handleSubmit = useCallback(() => void handleAdd(), [handleAdd]);

  return (
    <View style={styles.block} testID="skills-source-add">
      <SectionTitle title={t("skillsHub.sources.addTitle")} />
      <AdaptiveTextInput
        style={styles.input}
        resetKey={resetKey}
        onChangeText={setSource}
        onSubmitEditing={handleSubmit}
        placeholder={t("skillsHub.sources.addPlaceholder")}
        autoCapitalize="none"
        autoCorrect={false}
        testID="skills-source-add-input"
      />
      <Text style={styles.hint}>{t("skillsHub.sources.addHint")}</Text>
      <AdaptiveTextInput
        style={styles.input}
        resetKey={resetKey}
        onChangeText={setLabel}
        placeholder={t("skillsHub.sources.labelPlaceholder")}
        autoCorrect={false}
        testID="skills-source-add-label"
      />
      {error ? (
        <Alert
          variant="error"
          title={t(`skillsHub.sources.addError.${error.kind}`)}
          description={error.message}
          testID="skills-source-add-error"
        />
      ) : null}
      <View style={styles.rowActions}>
        <Button
          size="sm"
          variant="default"
          onPress={handleSubmit}
          loading={adding}
          disabled={disabled || !trimmed}
          testID="skills-source-add-submit"
        >
          {t("skillsHub.sources.add")}
        </Button>
      </View>
    </View>
  );
}

function RestoreDefaults({ missing, actions }: { missing: string[]; actions: SkillSourceActions }) {
  const { t } = useTranslation();
  const [restoring, setRestoring] = useState(false);
  const handleRestore = useCallback(async () => {
    setRestoring(true);
    try {
      await actions.restoreDefaults(missing);
    } finally {
      setRestoring(false);
    }
  }, [actions, missing]);
  const handlePress = useCallback(() => void handleRestore(), [handleRestore]);
  if (missing.length === 0) return null;
  return (
    <Alert
      variant="info"
      title={t("skillsHub.sources.defaultsMissing", { repos: missing.join(", ") })}
      testID="skills-sources-defaults-missing"
    >
      <Button
        size="sm"
        variant="outline"
        onPress={handlePress}
        loading={restoring}
        testID="skills-sources-restore-defaults"
      >
        {t("skillsHub.sources.restoreDefaults")}
      </Button>
    </Alert>
  );
}

export interface SourcesSheetProps {
  serverId: string;
  client: DaemonClient | null;
  onClose: () => void;
}

/** Manage the marketplace sources (spec 22.5, 22.6 "Sources"). */
export function SourcesSheet({ serverId, client, onClose }: SourcesSheetProps) {
  const { t } = useTranslation();
  const query = useSkillSourcesQuery(serverId, client);
  const actions = useSkillSourceActions(serverId, client);
  const sources = useMemo(() => query.data ?? [], [query.data]);
  const missing = useMemo(
    () => (query.data ? missingDefaultSources(query.data) : []),
    [query.data],
  );
  const header = useMemo<SheetHeader>(
    () => ({ title: t("skillsHub.sources.title"), back: { onPress: onClose } }),
    [onClose, t],
  );
  const { refetch } = query;
  const handleRetry = useCallback(() => void refetch(), [refetch]);

  let list = null;
  if (query.isLoading) {
    list = <Text style={styles.hint}>{t("skillsHub.sources.loading")}</Text>;
  } else if (query.error) {
    list = (
      <Alert
        variant="error"
        title={t("skillsHub.sources.loadError")}
        description={skillErrorMessage(query.error)}
      >
        <Button variant="outline" size="sm" onPress={handleRetry}>
          {t("skillsHub.states.retry")}
        </Button>
      </Alert>
    );
  } else if (sources.length === 0) {
    list = <Text style={styles.hint}>{t("skillsHub.sources.empty")}</Text>;
  } else {
    list = sources.map((source) => (
      <SourceRow key={source.sourceId} source={source} actions={actions} />
    ));
  }

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      testID="skills-sources-sheet"
      contentStyle={styles.body}
      desktopMaxWidth={640}
    >
      <Text style={styles.hint}>{t("skillsHub.sources.subtitle")}</Text>
      <RestoreDefaults missing={missing} actions={actions} />
      <View style={styles.block}>
        <SectionTitle title={t("skillsHub.sources.listTitle")} />
        {list}
      </View>
      <AddSourceForm actions={actions} disabled={!client} />
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  body: { gap: theme.spacing[4], paddingBottom: theme.spacing[6] },
  block: { gap: theme.spacing[2] },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
  },
  rowMain: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  rowHead: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[2] },
  rowLabel: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  spec: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  status: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  error: { fontSize: theme.fontSize.xs, color: theme.colors.statusDanger },
  rowActions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  hint: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  input: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
