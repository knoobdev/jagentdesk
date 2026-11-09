import { memo, useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { Check, X } from "lucide-react-native";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { useAppSettings } from "@/hooks/use-settings";
import { resolveTerminalAppearance } from "@/ssh/snippets/appearance";
import { TerminalAppearancePicker } from "@/ssh/snippets/terminal-appearance-picker";
import { formatBytes } from "@/ssh/sftp/model";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "react-i18next";
import type {
  DaemonClient,
  RemoteCheckResult,
  SshAuthMethod,
  SshGroup,
  SshIdentity,
  SshServer,
  SshServerInfo,
} from "@jagentdesk/client/internal/daemon-client";
import {
  buildGroupOptions,
  SSH_AUTH_METHOD_LABELS,
  SSH_AUTH_METHODS,
  type SshServerFormState,
} from "@/ssh/server-form-model";
import { useSshServerFormModel } from "@/ssh/use-ssh-connect-events";
import { Chip, Disclosure, IconBtn, mutedTint, ThemedArrowDown, ThemedArrowUp } from "./primitives";
import { useSheetFooter } from "./sheet-footer";
import { sshStyles as styles } from "./styles";

// Add / edit / duplicate a server (spec 25.2, 25.13): basic target, tags, authentication
// (identity, ordered methods, password kept in the daemon store), and the connection
// options of 25.3 (jump hosts, proxy, env, startup snippet, agent forwarding, keepalive,
// auto-reconnect). Empty fields inherit from the group.

export interface ServerFormTarget {
  mode: "create" | "edit" | "duplicate";
  server: SshServer | null;
}

type FormHandle = ReturnType<typeof useSshServerFormModel>;
type TriState = "inherit" | "on" | "off";
type ProxyChoice = "" | "socks5" | "http";

const TRI_STATE_OPTIONS: SelectFieldOption<TriState>[] = [
  { id: "inherit", value: "inherit", label: "Inherit (group or default)" },
  { id: "on", value: "on", label: "On" },
  { id: "off", value: "off", label: "Off" },
];
const PROXY_OPTIONS: SelectFieldOption<ProxyChoice>[] = [
  { id: "none", value: "", label: "No proxy" },
  { id: "socks5", value: "socks5", label: "SOCKS5" },
  { id: "http", value: "http", label: "HTTP CONNECT" },
];
const DEFAULT_PROXY_PORTS = { socks5: "1080", http: "3128" } as const;
const SHEET_TITLES: Record<ServerFormTarget["mode"], string> = {
  create: "Add server",
  edit: "Edit server",
  duplicate: "Duplicate server",
};

function optionLabel<T>(options: SelectFieldOption<T>[], value: T, fallback: string) {
  return { label: options.find((option) => option.value === value)?.label ?? fallback };
}

const AuthOrderRow = memo(function AuthOrderRow({
  method,
  index,
  last,
  model,
}: {
  method: SshAuthMethod;
  index: number;
  last: boolean;
  model: FormHandle["model"];
}) {
  const moveUp = useCallback(() => model.moveAuthMethod(index, -1), [index, model]);
  const moveDown = useCallback(() => model.moveAuthMethod(index, 1), [index, model]);
  return (
    <View style={styles.authOrderRow}>
      <Text style={styles.cell}>{`${index + 1}. ${SSH_AUTH_METHOD_LABELS[method]}`}</Text>
      <IconBtn
        icon={ThemedArrowUp}
        tint={mutedTint}
        label="Move up"
        onPress={moveUp}
        disabled={index === 0}
      />
      <IconBtn
        icon={ThemedArrowDown}
        tint={mutedTint}
        label="Move down"
        onPress={moveDown}
        disabled={last}
      />
    </View>
  );
});

function AuthSection({ form, identities }: { form: FormHandle; identities: SshIdentity[] }) {
  const { model, state } = form;
  const identityOptions = useMemo<SelectFieldOption<string>[]>(
    () => [
      { id: "", value: "", label: "None (inherit from group)" },
      ...identities.map((identity) => ({
        id: identity.id,
        value: identity.id,
        label: identity.username ? `${identity.label} (${identity.username})` : identity.label,
      })),
    ],
    [identities],
  );
  const identityDisplay = useMemo(
    () => optionLabel(identityOptions, state.identityId, "None (inherit from group)"),
    [identityOptions, state.identityId],
  );
  let passwordHint = "Saved in the daemon's secret store; never sent back to this device.";
  if (state.clearRequested) passwordHint = "The saved password is removed when you save.";
  else if (state.hasStoredPassword) passwordHint = "Type a new password to replace the saved one.";
  return (
    <>
      <Field label="Username" hint="Leave blank to use the group's or the identity's.">
        <FormTextInput
          testID="ssh-server-username"
          initialValue={state.username}
          value={state.username}
          onChangeText={model.setUsername}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
      <SelectField<string>
        label="Identity"
        value={state.identityId}
        selectedDisplay={identityDisplay}
        options={identityOptions}
        onChange={model.setIdentity}
        placeholder="None"
        emptyText="No identities yet — add one in Keychain."
        testID="ssh-server-identity"
      />
      <Field
        label="Auth methods"
        hint="Tried in this order. None selected: password, key, then keyboard-interactive."
      >
        <View style={styles.tagRow}>
          {SSH_AUTH_METHODS.map((method) => (
            <Chip
              key={method}
              label={SSH_AUTH_METHOD_LABELS[method]}
              value={method}
              active={state.authMethods.includes(method)}
              onToggle={model.toggleAuthMethod}
              testID={`ssh-auth-method-${method}`}
            />
          ))}
        </View>
        {state.authMethods.length > 0 ? (
          <View style={styles.authOrderList}>
            {state.authMethods.map((method, index) => (
              <AuthOrderRow
                key={method}
                method={method}
                index={index}
                last={index === state.authMethods.length - 1}
                model={model}
              />
            ))}
          </View>
        ) : null}
      </Field>
      {state.hasStoredPassword && !state.passwordDraft ? (
        <View style={styles.savedSecretRow}>
          <StatusBadge label="Password saved" variant="muted" />
          <Button
            size="xs"
            variant="ghost"
            onPress={model.requestClearPassword}
            testID="ssh-server-clear-password"
          >
            Remove
          </Button>
        </View>
      ) : null}
      <Field label="Password" hint={passwordHint}>
        <FormTextInput
          testID="ssh-server-password"
          initialValue=""
          value={state.passwordDraft}
          onChangeText={model.setPasswordDraft}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
    </>
  );
}

function ProxyFields({ form }: { form: FormHandle }) {
  const { model, state } = form;
  const setHost = useCallback((value: string) => model.setAdvanced({ proxyHost: value }), [model]);
  const setPort = useCallback((value: string) => model.setAdvanced({ proxyPort: value }), [model]);
  const setUser = useCallback(
    (value: string) => model.setAdvanced({ proxyUsername: value }),
    [model],
  );
  const setPassword = useCallback(
    (value: string) => model.setAdvanced({ proxyPasswordDraft: value }),
    [model],
  );
  return (
    <>
      {state.errors.proxy ? <Alert variant="error" title={state.errors.proxy} /> : null}
      <View style={styles.formRow}>
        <View style={styles.formColGrow}>
          <Field label="Proxy host">
            <FormTextInput
              testID="ssh-server-proxy-host"
              initialValue={state.proxyHost}
              value={state.proxyHost}
              onChangeText={setHost}
              placeholder="Hostname or IP address"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
        </View>
        <View style={styles.formColPort}>
          <Field label="Port">
            <FormTextInput
              testID="ssh-server-proxy-port"
              initialValue={state.proxyPort}
              value={state.proxyPort}
              onChangeText={setPort}
              keyboardType="number-pad"
            />
          </Field>
        </View>
      </View>
      <View style={styles.formRow}>
        <View style={styles.formColGrow}>
          <Field label="Proxy username">
            <FormTextInput
              testID="ssh-server-proxy-username"
              initialValue={state.proxyUsername}
              value={state.proxyUsername}
              onChangeText={setUser}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
        </View>
        <View style={styles.formColGrow}>
          <Field
            label="Proxy password"
            hint={state.hasStoredProxyPassword ? "Saved. Type to replace it." : undefined}
          >
            <FormTextInput
              testID="ssh-server-proxy-password"
              initialValue=""
              value={state.proxyPasswordDraft}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
        </View>
      </View>
    </>
  );
}

function AdvancedSection({
  form,
  jumpCandidates,
}: {
  form: FormHandle;
  jumpCandidates: SshServerInfo[];
}) {
  const { t } = useTranslation();
  const { model, state } = form;
  const setProxyType = useCallback(
    (value: ProxyChoice) =>
      model.setAdvanced({
        proxyType: value,
        ...(value && !state.proxyPort ? { proxyPort: DEFAULT_PROXY_PORTS[value] } : {}),
      }),
    [model, state.proxyPort],
  );
  const setEnv = useCallback((value: string) => model.setAdvanced({ envText: value }), [model]);
  const setSnippet = useCallback(
    (value: string) => model.setAdvanced({ startupSnippetId: value }),
    [model],
  );
  const setAgent = useCallback(
    (value: TriState) => model.setAdvanced({ agentForwarding: value }),
    [model],
  );
  const setReconnect = useCallback(
    (value: TriState) => model.setAdvanced({ autoReconnect: value }),
    [model],
  );
  const setDetectEnvironment = useCallback(
    (value: boolean) => model.setAdvanced({ detectEnvironment: value }),
    [model],
  );
  const setKeepalive = useCallback(
    (value: string) => model.setAdvanced({ keepaliveS: value }),
    [model],
  );
  const proxyDisplay = useMemo(
    () => optionLabel(PROXY_OPTIONS, state.proxyType, "No proxy"),
    [state.proxyType],
  );
  const agentDisplay = useMemo(
    () => optionLabel(TRI_STATE_OPTIONS, state.agentForwarding, "Inherit"),
    [state.agentForwarding],
  );
  const reconnectDisplay = useMemo(
    () => optionLabel(TRI_STATE_OPTIONS, state.autoReconnect, "Inherit"),
    [state.autoReconnect],
  );
  return (
    <>
      <Field label="Jump hosts" hint="Tap servers in hop order. Each hop checks its own host key.">
        <View style={styles.tagRow}>
          {jumpCandidates.length === 0 ? (
            <Text style={styles.noticeBody}>Save another server to use it as a jump host.</Text>
          ) : null}
          {jumpCandidates.map((candidate) => {
            const index = state.jumpChain.indexOf(candidate.id);
            return (
              <Chip
                key={candidate.id}
                label={index >= 0 ? `${index + 1}. ${candidate.label}` : candidate.label}
                value={candidate.id}
                active={index >= 0}
                onToggle={model.toggleJumpHost}
                testID={`ssh-server-jump-${candidate.id}`}
              />
            );
          })}
        </View>
      </Field>
      <SelectField<ProxyChoice>
        label="Proxy"
        value={state.proxyType}
        selectedDisplay={proxyDisplay}
        options={PROXY_OPTIONS}
        onChange={setProxyType}
        placeholder="No proxy"
        emptyText="No proxy types"
        testID="ssh-server-proxy-type"
      />
      {state.proxyType ? <ProxyFields form={form} /> : null}
      <Field
        label="Environment variables"
        hint="One NAME=value per line. The server keeps only names its AcceptEnv allows."
        error={state.errors.env}
      >
        <FormTextInput
          testID="ssh-server-env"
          initialValue={state.envText}
          value={state.envText}
          onChangeText={setEnv}
          multiline
          numberOfLines={3}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.privateKeyInput}
        />
      </Field>
      <Field label="Startup snippet" hint="Snippet id that runs every time the shell opens.">
        <FormTextInput
          testID="ssh-server-startup-snippet"
          initialValue={state.startupSnippetId}
          value={state.startupSnippetId}
          onChangeText={setSnippet}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
      <View style={styles.formRow}>
        <View style={styles.formColGrow}>
          <SelectField<TriState>
            label="Agent forwarding"
            value={state.agentForwarding}
            selectedDisplay={agentDisplay}
            options={TRI_STATE_OPTIONS}
            onChange={setAgent}
            placeholder="Inherit"
            emptyText="No options"
            testID="ssh-server-agent-forwarding"
          />
        </View>
        <View style={styles.formColGrow}>
          <SelectField<TriState>
            label="Auto-reconnect"
            value={state.autoReconnect}
            selectedDisplay={reconnectDisplay}
            options={TRI_STATE_OPTIONS}
            onChange={setReconnect}
            placeholder="Inherit"
            emptyText="No options"
            testID="ssh-server-auto-reconnect"
          />
        </View>
      </View>
      <Field
        label={t("ssh.server.detectOnConnect.label")}
        hint={t("ssh.server.detectOnConnect.hint")}
      >
        <Switch
          value={state.detectEnvironment}
          onValueChange={setDetectEnvironment}
          accessibilityLabel={t("ssh.server.detectOnConnect.label")}
          testID="ssh-server-detect-environment"
        />
      </Field>
      <Field
        label="Keepalive (seconds)"
        hint="Blank inherits (default 30). 0 turns keepalive off."
        error={state.errors.keepalive}
      >
        <FormTextInput
          testID="ssh-server-keepalive"
          initialValue={state.keepaliveS}
          value={state.keepaliveS}
          onChangeText={setKeepalive}
          keyboardType="number-pad"
          placeholder="30"
        />
      </Field>
    </>
  );
}

type RemoteCheckState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "done"; result: RemoteCheckResult }
  | { phase: "failed"; error: string };

const ROUTE_OPTIONS: SelectFieldOption<SshServerFormState["via"]>[] = [
  { id: "direct", value: "direct", label: "Direct" },
  { id: "tailnet", value: "tailnet", label: "JAgentDesk Tailscale" },
];

/** One line of a `remote_exec.check_target` result with its pass/fail marker (spec 33.3). */
function RemoteCheckRow({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  const Marker = ok ? Check : X;
  return (
    <View style={styles.remoteCheckRow}>
      <Marker size={14} color={ok ? styles.remoteCheckOk.color : styles.remoteCheckFail.color} />
      <Text style={styles.remoteCheckLabel}>{label}</Text>
      {value ? (
        <Text style={styles.remoteCheckValue} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Remote tasks (spec 33.9): the route (direct or via the JAgentDesk tailnet, unusable with a
 * proxy), the switch that includes the server as a remote execution target, and the Check
 * button that probes a saved server with `remote_exec.check_target`.
 */
function RemoteTasksSection({
  form,
  client,
  serverId,
}: {
  form: FormHandle;
  client: DaemonClient | null;
  serverId: string | null;
}) {
  const { t } = useTranslation();
  const { model, state } = form;
  const [check, setCheck] = useState<RemoteCheckState>({ phase: "idle" });
  const proxySet = Boolean(state.proxyType);
  const routeDisplay = useMemo(() => optionLabel(ROUTE_OPTIONS, state.via, "Direct"), [state.via]);
  const setRoute = useCallback((value: SshServerFormState["via"]) => model.setVia(value), [model]);
  const setRemoteExecEnabled = useCallback(
    (value: boolean) => model.setRemoteExecEnabled(value),
    [model],
  );
  const setWorkRoot = useCallback((value: string) => model.setRemoteWorkRoot(value), [model]);
  const runCheck = useCallback(async () => {
    if (!client || !serverId) return;
    setCheck({ phase: "checking" });
    try {
      const res = await client.remoteExecCheckTarget({ serverId });
      if (res.error || !res.result) {
        setCheck({
          phase: "failed",
          error: res.error ?? t("ssh.server.remoteExec.checkFailed"),
        });
        return;
      }
      setCheck({ phase: "done", result: res.result });
    } catch (error) {
      setCheck({
        phase: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [client, serverId, t]);
  const handleCheck = useCallback(() => void runCheck(), [runCheck]);
  const result = check.phase === "done" ? check.result : null;
  return (
    <>
      <SelectField<SshServerFormState["via"]>
        label={t("ssh.server.remoteExec.route")}
        value={state.via}
        selectedDisplay={routeDisplay}
        options={ROUTE_OPTIONS}
        onChange={setRoute}
        placeholder={t("ssh.server.remoteExec.routeDirect")}
        emptyText={t("ssh.server.remoteExec.routeDirect")}
        disabled={proxySet}
        hint={proxySet ? t("ssh.server.remoteExec.routeProxyHint") : undefined}
        testID="ssh-server-route"
      />
      <Field
        label={t("ssh.server.remoteExec.enabled")}
        hint={
          state.remoteExecEnabled
            ? undefined
            : "Remote agents sync this server's work folder and run tasks on it."
        }
      >
        <Switch
          value={state.remoteExecEnabled}
          onValueChange={setRemoteExecEnabled}
          accessibilityLabel={t("ssh.server.remoteExec.enabled")}
          testID="ssh-server-remote-exec-enabled"
        />
      </Field>
      {state.remoteExecEnabled ? (
        <Field
          label={t("ssh.server.remoteExec.workFolder")}
          hint="Folder on the server that receives the synced workspace. Blank uses the default."
        >
          <FormTextInput
            testID="ssh-server-remote-work-root"
            initialValue={state.remoteWorkRoot}
            value={state.remoteWorkRoot}
            onChangeText={setWorkRoot}
            placeholder={t("ssh.server.remoteExec.workFolderPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
      ) : null}
      {serverId ? (
        <View style={styles.formRow}>
          <Button
            size="sm"
            variant="secondary"
            onPress={handleCheck}
            disabled={check.phase === "checking" || !client}
            testID="ssh-server-remote-check"
          >
            {check.phase === "checking"
              ? t("ssh.server.remoteExec.checking")
              : t("ssh.server.remoteExec.check")}
          </Button>
        </View>
      ) : null}
      {check.phase === "failed" ? <Alert variant="error" title={check.error} /> : null}
      {result ? (
        <View style={styles.remoteCheckList}>
          <RemoteCheckRow
            ok={result.os !== null}
            label={t("ssh.server.remoteExec.os")}
            value={result.os ?? "—"}
          />
          <RemoteCheckRow
            ok={result.shell !== null}
            label={t("ssh.server.remoteExec.shell")}
            value={result.shell ?? "—"}
          />
          <RemoteCheckRow
            ok={result.freeKb !== null}
            label={t("ssh.server.remoteExec.freeSpace")}
            value={result.freeKb !== null ? formatBytes(result.freeKb * 1024) : "—"}
          />
          <RemoteCheckRow
            ok={result.writable}
            label={t("ssh.server.remoteExec.writable")}
            value={t(
              result.writable
                ? "ssh.server.remoteExec.writableOk"
                : "ssh.server.remoteExec.writableFail",
            )}
          />
          {result.missing.length === 0 ? (
            <RemoteCheckRow ok label={t("ssh.server.remoteExec.toolsOk")} value="" />
          ) : (
            <RemoteCheckRow
              ok={false}
              label={t("ssh.server.remoteExec.toolsMissing")}
              value={result.missing.join(", ")}
            />
          )}
          {result.error ? <Alert variant="error" title={result.error.message} /> : null}
        </View>
      ) : null}
    </>
  );
}

export function ServerFormSheet({
  client,
  target,
  groups,
  identities,
  servers,
  onClose,
  onSaved,
}: {
  client: DaemonClient | null;
  target: ServerFormTarget;
  groups: SshGroup[];
  identities: SshIdentity[];
  servers: SshServerInfo[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [snapshot] = useState(() => ({ server: target.server, defaultGroupId: null }));
  const form = useSshServerFormModel(snapshot);
  const { model, state } = form;
  const [saving, setSaving] = useState(false);
  const groupOptions = useMemo<SelectFieldOption<string>[]>(
    () => [
      { id: "", value: "", label: "No group" },
      ...buildGroupOptions(groups, state.groupId).map((option) => ({
        id: option.value,
        value: option.value,
        label: option.label,
      })),
    ],
    [groups, state.groupId],
  );
  const groupDisplay = useMemo(
    () => optionLabel(groupOptions, state.groupId, "No group"),
    [groupOptions, state.groupId],
  );
  const jumpCandidates = useMemo(
    () => servers.filter((candidate) => candidate.id !== target.server?.id),
    [servers, target.server?.id],
  );
  const save = useCallback(async () => {
    if (!client) return;
    setSaving(true);
    model.setSubmitError(null);
    try {
      const res = await client.sshServersSave(model.buildSavePayload());
      if (res.error) model.setSubmitError(res.error);
      else onSaved();
    } catch (error) {
      model.setSubmitError(error instanceof Error ? error.message : "Failed to save the server");
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
  const header = useMemo(() => ({ title: SHEET_TITLES[target.mode] }), [target.mode]);
  const toggleAuth = useCallback(
    () => model.setDisclosure(state.disclosure === "auth" ? "basic" : "auth"),
    [model, state.disclosure],
  );
  const toggleAdvanced = useCallback(
    () => model.setDisclosure(state.disclosure === "advanced" ? "basic" : "advanced"),
    [model, state.disclosure],
  );
  const toggleRemoteExec = useCallback(
    () => model.setDisclosure(state.disclosure === "remoteExec" ? "basic" : "remoteExec"),
    [model, state.disclosure],
  );
  const toggleAppearance = useCallback(
    () => model.setDisclosure(state.disclosure === "appearance" ? "basic" : "appearance"),
    [model, state.disclosure],
  );
  const { settings } = useAppSettings();
  // What the server gets from its group chain when it sets nothing itself.
  const inheritedAppearance = useMemo(
    () => resolveTerminalAppearance({ groupId: state.groupId || undefined }, groups),
    [groups, state.groupId],
  );

  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      onDismiss={onClose}
      header={header}
      footer={footer}
      testID="ssh-server-sheet"
    >
      <View style={styles.formBody}>
        {state.formError ? <Alert variant="error" title={state.formError} /> : null}
        <Field label="Label" error={state.errors.label}>
          <FormTextInput
            testID="ssh-server-label"
            initialValue={state.label}
            value={state.label}
            onChangeText={model.setLabel}
            autoCapitalize="none"
          />
        </Field>
        <Field label="Address" error={state.errors.address}>
          <FormTextInput
            testID="ssh-server-address"
            initialValue={state.address}
            value={state.address}
            onChangeText={model.setAddress}
            placeholder="Hostname or IP address"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
        </Field>
        <View style={styles.formRow}>
          <View style={styles.formColPort}>
            <Field label="Port" error={state.errors.port}>
              <FormTextInput
                testID="ssh-server-port"
                initialValue={state.port}
                value={state.port}
                onChangeText={model.setPort}
                placeholder="22"
                keyboardType="number-pad"
              />
            </Field>
          </View>
          <View style={styles.formColGrow}>
            <SelectField<string>
              label="Group"
              value={state.groupId}
              selectedDisplay={groupDisplay}
              options={groupOptions}
              onChange={model.setGroup}
              placeholder="No group"
              emptyText="No groups yet"
              testID="ssh-server-group"
            />
          </View>
        </View>
        <Field label="Tags" hint="Press Return to add. Tap a tag to remove it.">
          <View style={styles.tagRow}>
            {state.tags.map((tag) => (
              <Chip
                key={tag}
                label={`${tag} ×`}
                value={tag}
                active
                onToggle={model.removeTag}
                accessibilityLabel={`Remove tag ${tag}`}
                testID={`ssh-server-tag-${tag}`}
              />
            ))}
          </View>
          <FormTextInput
            testID="ssh-server-tag-input"
            initialValue=""
            value={state.tagDraft}
            onChangeText={model.setTagDraft}
            onSubmitEditing={model.commitTagDraft}
            onBlur={model.commitTagDraft}
            placeholder="Add a tag"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
        <Disclosure
          title="Authentication"
          open={state.disclosure === "auth"}
          onToggle={toggleAuth}
          testID="ssh-server-auth-section"
        />
        {state.disclosure === "auth" ? <AuthSection form={form} identities={identities} /> : null}
        <Disclosure
          title="Jump hosts, proxy & session"
          open={state.disclosure === "advanced"}
          onToggle={toggleAdvanced}
          testID="ssh-server-advanced"
        />
        {state.disclosure === "advanced" ? (
          <AdvancedSection form={form} jumpCandidates={jumpCandidates} />
        ) : null}
        <Disclosure
          title="Remote tasks"
          open={state.disclosure === "remoteExec"}
          onToggle={toggleRemoteExec}
          testID="ssh-server-remote-exec-section"
        />
        {state.disclosure === "remoteExec" ? (
          <RemoteTasksSection
            form={form}
            client={client}
            serverId={target.mode === "edit" ? (target.server?.id ?? null) : null}
          />
        ) : null}
        <Disclosure
          title="Terminal theme & font size"
          open={state.disclosure === "appearance"}
          onToggle={toggleAppearance}
          testID="ssh-server-appearance-section"
        />
        {state.disclosure === "appearance" ? (
          <TerminalAppearancePicker
            value={state.appearance}
            inherited={inheritedAppearance}
            defaultFontSize={settings.codeFontSize}
            onChange={model.setAppearance}
          />
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}
