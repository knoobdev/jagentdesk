import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { StatusBadge } from "@/components/ui/status-badge";
import type {
  DaemonClient,
  SshGroup,
  SshIdentity,
  SshKey,
  SshKeyType,
} from "@jagentdesk/client/internal/daemon-client";
import type { SshTerminalAppearance } from "@jagentdesk/protocol/ssh/snippets-schemas";
import { useAppSettings } from "@/hooks/use-settings";
import { buildGroupOptions } from "@/ssh/server-form-model";
import { resolveTerminalAppearance } from "@/ssh/snippets/appearance";
import { TerminalAppearancePicker } from "@/ssh/snippets/terminal-appearance-picker";
import { buildSshKeyOptions, type SshIdentityFormSnapshot } from "@/ssh/identity-form-model";
import { useSshIdentityFormModel } from "@/ssh/use-ssh-connect-events";
import { useSheetFooter } from "./sheet-footer";
import { sshStyles as styles } from "./styles";

// Group, identity and key sheets (spec 25.2 data model, 25.13 Keychain). Secrets typed
// here go to the daemon once and are never shown again.

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function labelFor<T>(options: SelectFieldOption<T>[], value: T, fallback: string) {
  return { label: options.find((option) => option.value === value)?.label ?? fallback };
}

/** Group ids under `rootId` (a group cannot move inside its own subtree). */
export function descendantGroupIds(groups: readonly SshGroup[], rootId: string): Set<string> {
  const out = new Set<string>();
  let frontier = [rootId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const group of groups) {
      if (group.parentId && frontier.includes(group.parentId) && !out.has(group.id)) {
        out.add(group.id);
        next.push(group.id);
      }
    }
    frontier = next;
  }
  return out;
}

export interface GroupFormTarget {
  mode: "create" | "edit";
  group: SshGroup | null;
}

export function GroupFormSheet({
  client,
  target,
  groups,
  identities,
  onClose,
  onSaved,
}: {
  client: DaemonClient | null;
  target: GroupFormTarget;
  groups: SshGroup[];
  identities: SshIdentity[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const group = target.group;
  const [label, setLabel] = useState(group?.label ?? "");
  const [parentId, setParentId] = useState(group?.parentId ?? "");
  const [username, setUsername] = useState(group?.username ?? "");
  const [port, setPort] = useState(group?.port !== undefined ? String(group.port) : "");
  const [identityId, setIdentityId] = useState(group?.identityId ?? "");
  const [appearance, setAppearance] = useState<SshTerminalAppearance>(() => ({
    theme: group?.theme,
    fontSize: group?.fontSize,
  }));
  const { settings } = useAppSettings();
  // What this group inherits from its parent chain for the fields it leaves unset.
  const inheritedAppearance = useMemo(
    () => resolveTerminalAppearance({ groupId: parentId || undefined }, groups),
    [groups, parentId],
  );
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const parentOptions = useMemo<SelectFieldOption<string>[]>(() => {
    const blocked = group ? descendantGroupIds(groups, group.id) : new Set<string>();
    const allowed = groups.filter(
      (candidate) => candidate.id !== group?.id && !blocked.has(candidate.id),
    );
    return [
      { id: "", value: "", label: "No parent" },
      ...buildGroupOptions(allowed, parentId).map((option) => ({
        id: option.value,
        value: option.value,
        label: option.label,
      })),
    ];
  }, [group, groups, parentId]);
  const identityOptions = useMemo<SelectFieldOption<string>[]>(
    () => [
      { id: "", value: "", label: "None (inherit from parent)" },
      ...identities.map((identity) => ({
        id: identity.id,
        value: identity.id,
        label: identity.label,
      })),
    ],
    [identities],
  );
  const parentDisplay = useMemo(
    () => labelFor(parentOptions, parentId, "No parent"),
    [parentId, parentOptions],
  );
  const identityDisplay = useMemo(
    () => labelFor(identityOptions, identityId, "None (inherit from parent)"),
    [identityId, identityOptions],
  );
  const portNumber = Number.parseInt(port, 10);
  const portError =
    port.trim() && (!Number.isFinite(portNumber) || portNumber < 1 || portNumber > 65535)
      ? "Port must be between 1 and 65535"
      : null;
  const canSubmit = label.trim() !== "" && portError === null;
  const save = useCallback(async () => {
    if (!client || !canSubmit) return;
    setSaving(true);
    setFormError(null);
    try {
      // Keep inheritable fields this sheet does not edit (proxy, env, …).
      const res = await client.sshGroupsSave({
        group: {
          ...group,
          id: group?.id ?? "",
          label: label.trim(),
          parentId: parentId || undefined,
          username: username.trim() || undefined,
          port: Number.isFinite(portNumber) ? portNumber : undefined,
          identityId: identityId || undefined,
          theme: appearance.theme,
          fontSize: appearance.fontSize,
        },
      });
      if (res.error) setFormError(res.error);
      else onSaved();
    } catch (error) {
      setFormError(errorText(error, "Failed to save the group"));
    } finally {
      setSaving(false);
    }
  }, [
    appearance,
    canSubmit,
    client,
    group,
    identityId,
    label,
    onSaved,
    parentId,
    portNumber,
    username,
  ]);
  const handleSave = useCallback(() => void save(), [save]);
  const footer = useSheetFooter({ onClose, onSave: handleSave, saving, canSubmit });
  const header = useMemo(
    () => ({ title: target.mode === "create" ? "Add group" : "Edit group" }),
    [target.mode],
  );
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      onDismiss={onClose}
      header={header}
      footer={footer}
      testID="ssh-group-sheet"
    >
      <View style={styles.formBody}>
        {formError ? <Alert variant="error" title={formError} /> : null}
        <Field label="Name" error={label.trim() ? null : "Name is required"}>
          <FormTextInput
            testID="ssh-group-label"
            initialValue={label}
            value={label}
            onChangeText={setLabel}
            autoCapitalize="none"
          />
        </Field>
        <SelectField<string>
          label="Parent group"
          value={parentId}
          selectedDisplay={parentDisplay}
          options={parentOptions}
          onChange={setParentId}
          placeholder="No parent"
          emptyText="No groups yet"
          testID="ssh-group-parent"
        />
        <Field label="Default username" hint="Servers in this group without a username use it.">
          <FormTextInput
            testID="ssh-group-username"
            initialValue={username}
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
        <Field label="Default port" error={portError} hint="Blank inherits (default 22).">
          <FormTextInput
            testID="ssh-group-port"
            initialValue={port}
            value={port}
            onChangeText={setPort}
            keyboardType="number-pad"
          />
        </Field>
        <SelectField<string>
          label="Default identity"
          value={identityId}
          selectedDisplay={identityDisplay}
          options={identityOptions}
          onChange={setIdentityId}
          placeholder="None"
          emptyText="No identities yet"
          testID="ssh-group-identity"
        />
        <Field
          label="Terminal theme & font size"
          hint="Servers and sub-groups without their own values use these."
        >
          <TerminalAppearancePicker
            value={appearance}
            inherited={inheritedAppearance}
            defaultFontSize={settings.codeFontSize}
            onChange={setAppearance}
          />
        </Field>
      </View>
    </AdaptiveModalSheet>
  );
}

export interface IdentityFormTarget {
  mode: "create" | "edit";
  identity: SshIdentity | null;
}

export function IdentityFormSheet({
  client,
  target,
  keys,
  onClose,
  onSaved,
}: {
  client: DaemonClient | null;
  target: IdentityFormTarget;
  keys: SshKey[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [snapshot] = useState<SshIdentityFormSnapshot>(() => ({
    mode: target.mode,
    identity: target.identity ?? undefined,
    keys,
  }));
  const { model, state } = useSshIdentityFormModel(snapshot);
  const [saving, setSaving] = useState(false);
  const keyOptions = useMemo<SelectFieldOption<string>[]>(
    () => [
      { id: "", value: "", label: "No key" },
      ...buildSshKeyOptions(keys).map((option) => ({
        id: option.id,
        value: option.id,
        label: option.label,
      })),
    ],
    [keys],
  );
  const keyDisplay = useMemo(
    () => labelFor(keyOptions, state.keyId ?? "", "No key"),
    [keyOptions, state.keyId],
  );
  const handleKeyChange = useCallback(
    (value: string, display: { label: string }) =>
      model.setKey(value || null, value ? display : null),
    [model],
  );
  const save = useCallback(async () => {
    if (!client) return;
    const payload = model.buildSavePayload();
    if (!payload) return;
    setSaving(true);
    model.setSubmitError(null);
    try {
      const res = await client.sshIdentitiesSave(payload);
      if (res.error) model.setSubmitError(res.error);
      else onSaved();
    } catch (error) {
      model.setSubmitError(errorText(error, "Failed to save the identity"));
    } finally {
      setSaving(false);
    }
  }, [client, model, onSaved]);
  const handleSave = useCallback(() => void save(), [save]);
  const footer = useSheetFooter({
    onClose,
    onSave: handleSave,
    saving,
    canSubmit: state.canSubmit,
  });
  const header = useMemo(
    () => ({ title: target.mode === "create" ? "Add identity" : "Edit identity" }),
    [target.mode],
  );
  let passwordHint = "For password login. A key's passphrase is saved with the key.";
  if (state.clearPasswordRequested) passwordHint = "The saved password is removed when you save.";
  else if (state.hasStoredPassword) passwordHint = "Type a new password to replace the saved one.";
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      onDismiss={onClose}
      header={header}
      footer={footer}
      testID="ssh-identity-sheet"
    >
      <View style={styles.formBody}>
        {state.submitError ? <Alert variant="error" title={state.submitError} /> : null}
        <Field label="Label" error={state.errors.label}>
          <FormTextInput
            testID="ssh-identity-label"
            initialValue={state.label}
            value={state.label}
            onChangeText={model.setLabel}
            autoCapitalize="none"
          />
        </Field>
        <Field label="Username">
          <FormTextInput
            testID="ssh-identity-username"
            initialValue={state.username}
            value={state.username}
            onChangeText={model.setUsername}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
        <SelectField<string>
          label="Key"
          value={state.keyId ?? ""}
          selectedDisplay={keyDisplay}
          options={keyOptions}
          onChange={handleKeyChange}
          placeholder="No key"
          emptyText="No keys yet — generate or import one first."
          testID="ssh-identity-key"
        />
        {state.hasStoredPassword && !state.passwordDraft ? (
          <View style={styles.savedSecretRow}>
            <StatusBadge label="Password saved" variant="muted" />
            <Button
              size="xs"
              variant="ghost"
              onPress={model.requestClearPassword}
              testID="ssh-identity-clear-password"
            >
              Remove
            </Button>
          </View>
        ) : null}
        <Field label="Password" hint={passwordHint}>
          <FormTextInput
            testID="ssh-identity-password"
            initialValue=""
            value={state.passwordDraft}
            onChangeText={model.setPasswordDraft}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
      </View>
    </AdaptiveModalSheet>
  );
}

const SSH_KEY_TYPES: readonly SshKeyType[] = [
  "ed25519",
  "ecdsa-256",
  "ecdsa-384",
  "ecdsa-521",
  "rsa-2048",
  "rsa-3072",
  "rsa-4096",
];
const KEY_TYPE_OPTIONS: SelectFieldOption<SshKeyType>[] = SSH_KEY_TYPES.map((type) => ({
  id: type,
  value: type,
  label: type === "ed25519" ? "Ed25519 (recommended)" : type.toUpperCase(),
}));

export function KeyFormSheet({
  client,
  mode,
  onClose,
  onSaved,
}: {
  client: DaemonClient | null;
  mode: "generate" | "import";
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState("");
  const [keyType, setKeyType] = useState<SshKeyType>("ed25519");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const canSubmit = label.trim() !== "" && (mode === "generate" || privateKey.trim() !== "");
  const save = useCallback(async () => {
    if (!client || !canSubmit) return;
    setSaving(true);
    setFormError(null);
    try {
      const secret = passphrase ? { passphrase } : {};
      const res =
        mode === "generate"
          ? await client.sshKeysGenerate({ label: label.trim(), type: keyType, ...secret })
          : await client.sshKeysImport({ label: label.trim(), privateKey, ...secret });
      if (res.error) setFormError(res.error);
      else onSaved();
    } catch (error) {
      setFormError(errorText(error, "Failed to save the key"));
    } finally {
      setSaving(false);
    }
  }, [canSubmit, client, keyType, label, mode, onSaved, passphrase, privateKey]);
  const handleSave = useCallback(() => void save(), [save]);
  const footer = useSheetFooter({
    onClose,
    onSave: handleSave,
    saving,
    canSubmit,
    label: mode === "generate" ? "Generate" : "Import",
  });
  const header = useMemo(
    () => ({ title: mode === "generate" ? "Generate key pair" : "Import private key" }),
    [mode],
  );
  const keyTypeDisplay = useMemo(() => labelFor(KEY_TYPE_OPTIONS, keyType, keyType), [keyType]);
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      onDismiss={onClose}
      header={header}
      footer={footer}
      testID="ssh-key-sheet"
    >
      <View style={styles.formBody}>
        {formError ? <Alert variant="error" title={formError} /> : null}
        <Field label="Name">
          <FormTextInput
            testID="ssh-key-label"
            initialValue=""
            value={label}
            onChangeText={setLabel}
            autoCapitalize="none"
          />
        </Field>
        {mode === "generate" ? (
          <SelectField<SshKeyType>
            label="Type"
            value={keyType}
            selectedDisplay={keyTypeDisplay}
            options={KEY_TYPE_OPTIONS}
            onChange={setKeyType}
            placeholder="Ed25519"
            emptyText="No key types"
            testID="ssh-key-type"
          />
        ) : (
          <Field label="Private key" hint="Paste an OpenSSH or PEM private key.">
            <FormTextInput
              testID="ssh-key-private"
              initialValue=""
              value={privateKey}
              onChangeText={setPrivateKey}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              multiline
              numberOfLines={5}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.privateKeyInput}
            />
          </Field>
        )}
        <Field
          label="Passphrase"
          hint={
            mode === "generate"
              ? "Optional. Saved in the daemon's secret store."
              : "Only if the key is encrypted."
          }
        >
          <FormTextInput
            testID="ssh-key-passphrase"
            initialValue=""
            value={passphrase}
            onChangeText={setPassphrase}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
      </View>
    </AdaptiveModalSheet>
  );
}
