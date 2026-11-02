import { useCallback, useMemo, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ForwardingKind, ForwardingRule } from "@jagentdesk/protocol/ssh/forwarding-schemas";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { ErrorBanner } from "../ui";
import type { ForwardingApi } from "./api";
import {
  exposesToNetwork,
  parseRuleForm,
  type RuleForm,
  type RuleFormErrors,
  type RuleFormField,
} from "./model";

export interface ForwardingServerChoice {
  serverId: string;
  label: string;
}

const ThemedTextInput = withUnistyles(TextInput);
const placeholderColor = (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundExtraMuted,
});

function Field({
  label,
  value,
  onChange,
  placeholder,
  error,
  numeric = false,
  testID,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  error: string | null;
  numeric?: boolean;
  testID: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <ThemedTextInput
        style={[styles.input, error ? styles.inputError : null]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={numeric ? "number-pad" : "default"}
        uniProps={placeholderColor}
        accessibilityLabel={label}
        testID={testID}
      />
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

/**
 * Create or edit a port forwarding rule (spec 25.6) — the single-form version of Termius' setup
 * wizard: kind, server, listening side, destination. A bind address off loopback asks first,
 * because it opens the port to the network.
 */
export function ForwardingRuleEditor({
  api,
  initial,
  servers,
  lockServer,
  onClose,
  onSaved,
}: {
  api: ForwardingApi;
  initial: RuleForm;
  servers: ForwardingServerChoice[];
  /** Hide the server picker (the editor was opened from one server's screen). */
  lockServer: boolean;
  onClose: () => void;
  onSaved: (rule: ForwardingRule) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<RuleForm>(initial);
  const [errors, setErrors] = useState<RuleFormErrors>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const update = useCallback(
    (field: keyof RuleForm) => (value: string) => {
      setForm((current) => ({ ...current, [field]: value }));
      if (field in errors) setErrors((current) => ({ ...current, [field]: undefined }));
    },
    [errors],
  );
  const setKind = useCallback(
    (kind: ForwardingKind) => setForm((current) => ({ ...current, kind })),
    [],
  );
  const kindOptions = useMemo<SelectFieldOption<ForwardingKind>[]>(
    () =>
      (["local", "remote", "dynamic"] as const).map((kind) => ({
        id: kind,
        value: kind,
        label: t(`ssh.forwarding.kinds.${kind}`),
      })),
    [t],
  );
  const kindDisplay = useMemo(
    () => ({ label: t(`ssh.forwarding.kinds.${form.kind}`) }),
    [form.kind, t],
  );
  const serverOptions = useMemo<SelectFieldOption<string>[]>(
    () => servers.map((s) => ({ id: s.serverId, value: s.serverId, label: s.label })),
    [servers],
  );
  const selectedServer = servers.find((s) => s.serverId === form.serverId);
  const selectedDisplay = useMemo(
    () => (selectedServer ? { label: selectedServer.label } : null),
    [selectedServer],
  );
  const errorText = (field: RuleFormField): string | null => {
    const error = errors[field];
    return error ? t(`ssh.forwarding.editor.errors.${error}`) : null;
  };

  const save = useCallback(async () => {
    const parsed = parseRuleForm(form);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    if (exposesToNetwork({ bindAddress: parsed.input.bindAddress ?? "" })) {
      const confirmed = await confirmDialog({
        title: t("ssh.forwarding.exposeConfirm.title"),
        message: t("ssh.forwarding.exposeConfirm.message", {
          address: parsed.input.bindAddress,
          port: parsed.input.bindPort,
        }),
        confirmLabel: t("ssh.forwarding.exposeConfirm.confirm"),
        destructive: true,
      });
      if (!confirmed) return;
    }
    setSaving(true);
    setFailure(null);
    try {
      const rule = await api.save(parsed.input);
      setSaving(false);
      onSaved(rule);
    } catch (error) {
      setSaving(false);
      setFailure(error instanceof Error ? error.message : String(error));
    }
  }, [api, form, onSaved, t]);
  const handleSave = useCallback(() => void save(), [save]);
  const dismissFailure = useCallback(() => setFailure(null), []);

  const header = useMemo<SheetHeader>(
    () => ({
      title: form.id ? t("ssh.forwarding.editor.editTitle") : t("ssh.forwarding.editor.newTitle"),
    }),
    [form.id, t],
  );
  const isDynamic = form.kind === "dynamic";

  return (
    <AdaptiveModalSheet visible onClose={onClose} header={header} testID="forwarding-rule-editor">
      <View style={styles.body}>
        <SelectField
          label={t("ssh.forwarding.editor.kind")}
          value={form.kind}
          selectedDisplay={kindDisplay}
          options={kindOptions}
          onChange={setKind}
          placeholder={t("ssh.forwarding.editor.kind")}
          emptyText={t("ssh.forwarding.editor.kind")}
          size="sm"
          testID="forwarding-kind"
        />
        <Text style={styles.hint}>{t(`ssh.forwarding.kindHints.${form.kind}`)}</Text>
        <Field
          label={t("ssh.forwarding.editor.label")}
          value={form.label}
          onChange={update("label")}
          placeholder={t("ssh.forwarding.editor.labelPlaceholder")}
          error={errorText("label")}
          testID="forwarding-label"
        />
        {lockServer ? null : (
          <SelectField
            label={t("ssh.forwarding.editor.server")}
            value={form.serverId || null}
            selectedDisplay={selectedDisplay}
            options={serverOptions}
            onChange={update("serverId")}
            placeholder={t("ssh.forwarding.editor.serverPlaceholder")}
            emptyText={t("ssh.forwarding.editor.noServers")}
            error={errorText("serverId")}
            size="sm"
          />
        )}
        <Text style={styles.section}>
          {form.kind === "remote"
            ? t("ssh.forwarding.editor.listenOnServer")
            : t("ssh.forwarding.editor.listenOnDaemon")}
        </Text>
        <View style={styles.pair}>
          <View style={styles.grow}>
            <Field
              label={t("ssh.forwarding.editor.bindAddress")}
              value={form.bindAddress}
              onChange={update("bindAddress")}
              placeholder="127.0.0.1"
              error={null}
              testID="forwarding-bind-address"
            />
          </View>
          <View style={styles.port}>
            <Field
              label={t("ssh.forwarding.editor.port")}
              value={form.bindPort}
              onChange={update("bindPort")}
              placeholder={isDynamic ? "1080" : "15432"}
              error={errorText("bindPort")}
              numeric
              testID="forwarding-bind-port"
            />
          </View>
        </View>
        {isDynamic ? null : (
          <>
            <Text style={styles.section}>
              {form.kind === "remote"
                ? t("ssh.forwarding.editor.destinationFromDaemon")
                : t("ssh.forwarding.editor.destinationFromServer")}
            </Text>
            <View style={styles.pair}>
              <View style={styles.grow}>
                <Field
                  label={t("ssh.forwarding.editor.destHost")}
                  value={form.destHost}
                  onChange={update("destHost")}
                  placeholder={t("ssh.forwarding.editor.destHostPlaceholder")}
                  error={errorText("destHost")}
                  testID="forwarding-dest-host"
                />
              </View>
              <View style={styles.port}>
                <Field
                  label={t("ssh.forwarding.editor.port")}
                  value={form.destPort}
                  onChange={update("destPort")}
                  placeholder="5432"
                  error={errorText("destPort")}
                  numeric
                  testID="forwarding-dest-port"
                />
              </View>
            </View>
          </>
        )}
        {failure ? (
          <ErrorBanner
            message={failure}
            dismissLabel={t("common.actions.dismiss")}
            onDismiss={dismissFailure}
          />
        ) : null}
        <View style={styles.actions}>
          <Button
            variant="secondary"
            size="sm"
            style={styles.grow}
            onPress={onClose}
            disabled={saving}
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            size="sm"
            style={styles.grow}
            onPress={handleSave}
            loading={saving}
            testID="forwarding-save"
          >
            {t("ssh.forwarding.editor.save")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  hint: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  section: {
    marginTop: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  field: {
    gap: theme.spacing[1],
  },
  label: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  input: {
    height: 36,
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  inputError: {
    borderColor: theme.colors.destructive,
  },
  errorText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
  },
  pair: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  grow: {
    flex: 1,
  },
  port: {
    width: 96,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
}));
