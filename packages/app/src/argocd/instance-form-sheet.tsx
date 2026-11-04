import { useCallback, useMemo, useReducer, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ChevronDown, ChevronRight, Plus, X } from "lucide-react-native";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { ArgoCdAuthMethod, ArgoCdInstance } from "@jagentdesk/protocol/argocd/rpc-schemas";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  buildInstanceInput,
  INSTANCE_FORM_ERRORS,
  openInstanceForm,
  reduceInstanceForm,
  validateInstanceForm,
  type HeaderDraft,
  type InstanceFormAction,
} from "./instance-form";
import { errorMessage } from "./use-instances";

// Add / edit sheet for an Argo CD instance (spec 30.2, 30.2.3). Saving a password or token
// instance with the secret filled in signs in right away, so adding an instance is one step.

const AUTH_OPTIONS: SegmentedControlOption<ArgoCdAuthMethod>[] = [
  { value: "password", label: "Password", testID: "argocd-form-auth-password" },
  { value: "token", label: "API token", testID: "argocd-form-auth-token" },
  { value: "sso", label: "SSO", testID: "argocd-form-auth-sso" },
];

type SaveState = { status: "idle" } | { status: "saving" } | { status: "failed"; message: string };

interface InstanceFormSheetProps {
  client: DaemonClient;
  instance: ArgoCdInstance | null;
  onClose: () => void;
  onSaved: (instance: ArgoCdInstance) => void;
}

export function InstanceFormSheet({ client, instance, onClose, onSaved }: InstanceFormSheetProps) {
  const isCompact = useIsCompactFormFactor();
  const size = isCompact ? "md" : "sm";
  const [form, dispatch] = useReducer(reduceInstanceForm, instance, openInstanceForm);
  const actions = useMemo(() => createFormActions(dispatch), []);
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const [submitted, setSubmitted] = useState(false);
  const validation = validateInstanceForm(form);
  const saving = save.status === "saving";

  const submit = useCallback(async () => {
    setSubmitted(true);
    if (validation) return;
    setSave({ status: "saving" });
    try {
      const saved = await client.argocd("argocd.instances.save.request", {
        instance: buildInstanceInput(form),
      });
      if (saved.error || !saved.instance) {
        setSave({ status: "failed", message: saved.error ?? "Unable to save the instance" });
        return;
      }
      dispatch({ type: "saved", id: saved.instance.id });
      onSaved(saved.instance);
      const secret = form.authMethod === "token" ? form.secret.trim() : form.secret;
      if (form.authMethod === "sso" || !secret) {
        onClose();
        return;
      }
      const login = await client.argocd(
        "argocd.instances.login.request",
        form.authMethod === "token"
          ? { id: saved.instance.id, token: secret }
          : { id: saved.instance.id, password: secret },
      );
      if (login.instance) onSaved(login.instance);
      if (login.error) {
        setSave({ status: "failed", message: `Saved, but sign-in failed: ${login.error}` });
        return;
      }
      onClose();
    } catch (error) {
      setSave({ status: "failed", message: errorMessage(error, "Unable to save the instance") });
    }
  }, [client, form, onClose, onSaved, validation]);

  const handleSave = useCallback(() => {
    void submit();
  }, [submit]);

  const header = useMemo(
    () => ({ title: instance ? "Edit Argo CD instance" : "Add Argo CD instance" }),
    [instance],
  );
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button size="md" variant="ghost" onPress={onClose}>
          Cancel
        </Button>
        <View style={styles.spacer} />
        <Button
          size="md"
          variant="default"
          loading={saving}
          disabled={saving}
          onPress={handleSave}
          testID="argocd-form-save"
        >
          {saving ? "Saving..." : "Save"}
        </Button>
      </View>
    ),
    [handleSave, onClose, saving],
  );

  const fieldError = submitted && validation ? INSTANCE_FORM_ERRORS[validation] : null;
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      onDismiss={onClose}
      header={header}
      footer={footer}
      testID="argocd-instance-sheet"
    >
      <View style={styles.body}>
        {save.status === "failed" ? (
          <Alert variant="error" title={save.message} testID="argocd-form-error" />
        ) : null}
        <Field label="URL" error={validation === "client_pair_incomplete" ? null : fieldError}>
          <FormTextInput
            size={size}
            initialValue={form.url}
            onChangeText={actions.setUrl}
            placeholder="https://argocd.<domain>"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            testID="argocd-form-url"
          />
        </Field>
        <Field label="Display name">
          <FormTextInput
            size={size}
            initialValue={form.displayName}
            onChangeText={actions.setDisplayName}
            placeholder="Defaults to the host name"
            testID="argocd-form-name"
          />
        </Field>
        <Field label="Sign-in method">
          <SegmentedControl
            size={size}
            options={AUTH_OPTIONS}
            value={form.authMethod}
            onValueChange={actions.setAuthMethod}
            testID="argocd-form-auth"
          />
        </Field>
        <AuthFields form={form} actions={actions} size={size} editing={instance !== null} />
        <SwitchRow
          label="Skip TLS verify"
          value={form.tlsSkipVerify}
          onChange={actions.setTlsSkipVerify}
          testID="argocd-form-skip-tls"
        />
        <View style={styles.disclosure}>
          <Button
            size="sm"
            variant="ghost"
            leftIcon={form.advancedOpen ? ChevronDown : ChevronRight}
            onPress={actions.toggleAdvanced}
            testID="argocd-form-advanced"
          >
            Advanced
          </Button>
        </View>
        {form.advancedOpen ? (
          <AdvancedFields
            form={form}
            actions={actions}
            size={size}
            pairError={submitted && validation === "client_pair_incomplete" ? fieldError : null}
          />
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

type FormState = ReturnType<typeof openInstanceForm>;
type FieldSize = "sm" | "md";

function createFormActions(dispatch: (action: InstanceFormAction) => void) {
  return {
    setUrl: (value: string) => dispatch({ type: "setUrl", value }),
    setDisplayName: (value: string) => dispatch({ type: "setDisplayName", value }),
    setAuthMethod: (value: ArgoCdAuthMethod) => dispatch({ type: "setAuthMethod", value }),
    setUsername: (value: string) => dispatch({ type: "setUsername", value }),
    setSecret: (value: string) => dispatch({ type: "setSecret", value }),
    setRememberPassword: (value: boolean) => dispatch({ type: "setRememberPassword", value }),
    setTlsSkipVerify: (value: boolean) => dispatch({ type: "setTlsSkipVerify", value }),
    setCaPem: (value: string) => dispatch({ type: "setCaPem", value }),
    setClientCertPem: (value: string) => dispatch({ type: "setClientCertPem", value }),
    setClientKeyPem: (value: string) => dispatch({ type: "setClientKeyPem", value }),
    toggleRemoveClientCert: () => dispatch({ type: "toggleRemoveClientCert" }),
    toggleAdvanced: () => dispatch({ type: "toggleAdvanced" }),
    addHeader: () => dispatch({ type: "addHeader" }),
    setHeaderName: (key: string, value: string) => dispatch({ type: "setHeaderName", key, value }),
    setHeaderValue: (key: string, value: string) =>
      dispatch({ type: "setHeaderValue", key, value }),
    removeHeader: (key: string) => dispatch({ type: "removeHeader", key }),
  };
}
type FormActions = ReturnType<typeof createFormActions>;

function AuthFields({
  form,
  actions,
  size,
  editing,
}: {
  form: FormState;
  actions: FormActions;
  size: FieldSize;
  editing: boolean;
}) {
  if (form.authMethod === "sso") {
    return (
      <Text style={styles.note}>
        Sign in with SSO from the instance row after saving. On a phone, the sign-in runs on a
        paired desktop.
      </Text>
    );
  }
  const secretLabel = form.authMethod === "token" ? "API token" : "Password";
  const secretHint = editing
    ? "Optional. Fill in to sign in again when you save."
    : "Optional. Fill in to sign in when you save.";
  return (
    <>
      {form.authMethod === "password" ? (
        <Field label="Username">
          <FormTextInput
            size={size}
            initialValue={form.username}
            onChangeText={actions.setUsername}
            placeholder="admin"
            autoCapitalize="none"
            autoCorrect={false}
            testID="argocd-form-username"
          />
        </Field>
      ) : null}
      <Field label={secretLabel} hint={secretHint}>
        <FormTextInput
          key={form.authMethod}
          size={size}
          initialValue=""
          onChangeText={actions.setSecret}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          testID="argocd-form-secret"
        />
      </Field>
      {form.authMethod === "password" ? (
        <SwitchRow
          label="Remember password"
          hint="Kept in the daemon's secret store to sign in again when the session expires"
          value={form.rememberPassword}
          onChange={actions.setRememberPassword}
          testID="argocd-form-remember"
        />
      ) : null}
    </>
  );
}

function AdvancedFields({
  form,
  actions,
  size,
  pairError,
}: {
  form: FormState;
  actions: FormActions;
  size: FieldSize;
  pairError: string | null;
}) {
  let pairHint = "Paste PEM. Leave blank to keep the stored pair.";
  if (!form.hasClientCert) pairHint = "Paste PEM for mutual TLS";
  if (form.removeClientCert) pairHint = "The stored certificate and key are removed when you save.";
  return (
    <View style={styles.advanced}>
      <Field label="CA certificate" hint="PEM of the CA that signed the Argo CD certificate">
        <FormTextInput
          size={size}
          initialValue={form.caPem}
          onChangeText={actions.setCaPem}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.pem}
          testID="argocd-form-ca"
        />
      </Field>
      <Field label="Client certificate" hint={pairHint} error={pairError}>
        <FormTextInput
          size={size}
          initialValue=""
          onChangeText={actions.setClientCertPem}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          editable={!form.removeClientCert}
          style={styles.pem}
          testID="argocd-form-client-cert"
        />
      </Field>
      <Field label="Client key">
        <FormTextInput
          size={size}
          initialValue=""
          onChangeText={actions.setClientKeyPem}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          editable={!form.removeClientCert}
          style={styles.pem}
          testID="argocd-form-client-key"
        />
      </Field>
      {form.hasClientCert ? (
        <View style={styles.inlineAction}>
          <Button
            size="xs"
            variant="ghost"
            onPress={actions.toggleRemoveClientCert}
            testID="argocd-form-remove-client-cert"
          >
            {form.removeClientCert ? "Keep stored certificate" : "Remove stored certificate"}
          </Button>
        </View>
      ) : null}
      <Field label="Custom headers" hint="Sent with every request, e.g. for an auth proxy">
        <View style={styles.headers}>
          {form.headers.map((header) => (
            <HeaderRow key={header.key} header={header} actions={actions} size={size} />
          ))}
          <View style={styles.inlineAction}>
            <Button
              size="xs"
              variant="ghost"
              leftIcon={Plus}
              onPress={actions.addHeader}
              testID="argocd-form-add-header"
            >
              Add header
            </Button>
          </View>
        </View>
      </Field>
    </View>
  );
}

function HeaderRow({
  header,
  actions,
  size,
}: {
  header: HeaderDraft;
  actions: FormActions;
  size: FieldSize;
}) {
  const { key } = header;
  const { setHeaderName, setHeaderValue, removeHeader } = actions;
  const handleName = useCallback(
    (value: string) => setHeaderName(key, value),
    [key, setHeaderName],
  );
  const handleValue = useCallback(
    (value: string) => setHeaderValue(key, value),
    [key, setHeaderValue],
  );
  const handleRemove = useCallback(() => removeHeader(key), [key, removeHeader]);
  return (
    <View style={styles.headerRow}>
      <View style={styles.headerName}>
        <FormTextInput
          size={size}
          initialValue={header.name}
          onChangeText={handleName}
          placeholder="Header"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
      <View style={styles.headerValue}>
        <FormTextInput
          size={size}
          initialValue=""
          onChangeText={handleValue}
          placeholder={header.stored ? "Saved value" : "Value"}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
      <Button
        size={size}
        variant="ghost"
        leftIcon={X}
        accessibilityLabel={`Remove header ${header.name}`}
        onPress={handleRemove}
      />
    </View>
  );
}

function SwitchRow({
  label,
  hint,
  value,
  onChange,
  testID,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  testID: string;
}) {
  return (
    <View style={styles.switchRow}>
      <View style={styles.switchText}>
        <Text style={styles.switchLabel}>{label}</Text>
        {hint ? <Text style={styles.note}>{hint}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={label} testID={testID} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  spacer: { flex: 1 },
  note: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  switchText: {
    flex: 1,
    gap: theme.spacing[1],
  },
  switchLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  disclosure: {
    alignItems: "flex-start",
    marginLeft: -theme.spacing[2],
  },
  advanced: {
    gap: theme.spacing[4],
  },
  pem: {
    minHeight: 88,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  inlineAction: {
    alignItems: "flex-start",
    marginLeft: -theme.spacing[2],
  },
  headers: {
    gap: theme.spacing[2],
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  headerName: { flex: 2, minWidth: 0 },
  headerValue: { flex: 3, minWidth: 0 },
}));
