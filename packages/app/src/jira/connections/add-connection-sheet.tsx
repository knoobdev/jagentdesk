import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useQueryClient } from "@tanstack/react-query";
import {
  JIRA_OAUTH_LOOPBACK_REDIRECT_URI,
  type JiraConnection,
  type JiraOAuthSite,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { errorMessage, useJiraCall } from "../api";
import { jiraKeys } from "../queries";
import { ErrorBanner, Field, Input, Tabs } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";
import { canUseLoopback, completeOAuth, finishWithLoopback, type OAuthOutcome } from "./oauth-flow";

// Add a Jira connection (spec 29.1): Cloud with email + API token, Cloud with OAuth through an app
// the user registered (desktop loopback, paste-URL fallback, phone → desktop delegation), or
// Data Center with a personal access token.

type Method = "api_token" | "oauth" | "pat";
type OAuthMode = "loopback" | "paste" | "delegate";

const METHOD_TABS: ReadonlyArray<{ id: Method; label: string }> = [
  { id: "api_token", label: "Cloud · API token" },
  { id: "oauth", label: "Cloud · OAuth" },
  { id: "pat", label: "Data Center · PAT" },
];
const SHEET_HEADER = { title: "Add Jira connection" };
const API_TOKEN_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";
const DEVELOPER_CONSOLE_URL = "https://developer.atlassian.com/console/myapps/";

interface FormState {
  siteUrl: string;
  email: string;
  token: string;
  label: string;
  clientId: string;
  clientSecret: string;
  pastedUrl: string;
}
type FormKey = keyof FormState;
type PatchForm = (patch: Partial<FormState>) => void;

const EMPTY_FORM: FormState = {
  siteUrl: "",
  email: "",
  token: "",
  label: "",
  clientId: "",
  clientSecret: "",
  pastedUrl: "",
};

type Phase =
  | { kind: "idle" }
  | { kind: "busy"; message: string }
  | {
      kind: "awaiting_browser";
      state: string;
      authorizeUrl: string;
      redirectUri: string;
      delegated: boolean;
    }
  | { kind: "choose_site"; state: string; sites: JiraOAuthSite[] }
  | { kind: "error"; message: string };

function formReducer(state: FormState, patch: Partial<FormState>): FormState {
  return { ...state, ...patch };
}

function FormInput({
  field,
  form,
  patchForm,
  secure,
  placeholder,
  keyboardType,
  testID,
}: {
  field: FormKey;
  form: FormState;
  patchForm: PatchForm;
  secure?: boolean;
  placeholder?: string;
  keyboardType?: "url" | "email-address";
  testID?: string;
}) {
  const change = useCallback((value: string) => patchForm({ [field]: value }), [field, patchForm]);
  return (
    <Input
      value={form[field]}
      onChangeText={change}
      secureTextEntry={secure}
      placeholder={placeholder}
      keyboardType={keyboardType}
      testID={testID}
    />
  );
}

function OpenLink({ url, label }: { url: string; label: string }) {
  const open = useCallback(() => void Linking.openURL(url), [url]);
  return (
    <Pressable onPress={open} accessibilityRole="link">
      <Text style={jiraStyles.textStrong}>{label}</Text>
    </Pressable>
  );
}

function TokenForm({
  method,
  form,
  patchForm,
}: {
  method: "api_token" | "pat";
  form: FormState;
  patchForm: PatchForm;
}) {
  const cloud = method === "api_token";
  return (
    <>
      <Field label="Site URL">
        <FormInput
          field="siteUrl"
          form={form}
          patchForm={patchForm}
          placeholder={cloud ? "https://<site>.atlassian.net" : "https://jira.<company>.<tld>"}
          keyboardType="url"
          testID="jira-site-url"
        />
      </Field>
      {cloud ? (
        <Field label="Atlassian account email">
          <FormInput
            field="email"
            form={form}
            patchForm={patchForm}
            keyboardType="email-address"
            testID="jira-email"
          />
        </Field>
      ) : null}
      <Field label={cloud ? "API token" : "Personal access token"}>
        <FormInput field="token" form={form} patchForm={patchForm} secure testID="jira-token" />
      </Field>
      <Field label="Label (optional)">
        <FormInput field="label" form={form} patchForm={patchForm} testID="jira-label" />
      </Field>
      <Text style={jiraStyles.textSmall}>
        {cloud
          ? "Create a token at id.atlassian.com → Security → API tokens. It stays on the host; JAgentDesk never shows it again."
          : "Create one in Jira → Profile → Personal Access Tokens. It stays on the host."}
      </Text>
      {cloud ? <OpenLink url={API_TOKEN_URL} label="Open API token page" /> : null}
    </>
  );
}

function OAuthForm({ form, patchForm }: { form: FormState; patchForm: PatchForm }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void Clipboard.setStringAsync(JIRA_OAUTH_LOOPBACK_REDIRECT_URI).then(() => {
      setCopied(true);
      return undefined;
    });
  }, []);
  return (
    <>
      <View style={jiraStyles.formField} testID="jira-oauth-guide">
        <Text style={jiraStyles.formLabel}>Register your own OAuth app (once)</Text>
        <Text style={jiraStyles.text}>
          1. Open the Atlassian developer console and create an “OAuth 2.0 integration”.
        </Text>
        <Text style={jiraStyles.text}>
          2. Permissions: add “Jira API” (read/write Jira work, read Jira user) and the Jira
          Software board, sprint, epic and issue scopes.
        </Text>
        <Text style={jiraStyles.text}>3. Authorization: set the callback URL below.</Text>
        <Text style={jiraStyles.text}>
          4. Settings: copy the Client ID and Secret here. The secret stays on the host.
        </Text>
        <View style={jiraStyles.row}>
          <Text style={jiraStyles.mono} selectable>
            {JIRA_OAUTH_LOOPBACK_REDIRECT_URI}
          </Text>
          <Button size="sm" variant="outline" onPress={copy} testID="jira-copy-callback">
            {copied ? "Copied" : "Copy"}
          </Button>
        </View>
        <OpenLink url={DEVELOPER_CONSOLE_URL} label="Open developer console" />
      </View>
      <Field label="Client ID">
        <FormInput field="clientId" form={form} patchForm={patchForm} testID="jira-client-id" />
      </Field>
      <Field label="Client secret">
        <FormInput
          field="clientSecret"
          form={form}
          patchForm={patchForm}
          secure
          testID="jira-client-secret"
        />
      </Field>
      <Field label="Label (optional)">
        <FormInput field="label" form={form} patchForm={patchForm} />
      </Field>
    </>
  );
}

function OAuthButtons({ busy, onBegin }: { busy: boolean; onBegin: (mode: OAuthMode) => void }) {
  const paste = useCallback(() => onBegin("paste"), [onBegin]);
  const loopback = useCallback(() => onBegin("loopback"), [onBegin]);
  const delegate = useCallback(() => onBegin("delegate"), [onBegin]);
  if (canUseLoopback()) {
    return (
      <>
        <Button variant="outline" disabled={busy} onPress={paste} testID="jira-oauth-paste">
          Paste URL instead
        </Button>
        <Button variant="default" loading={busy} onPress={loopback} testID="jira-oauth-browser">
          Sign in with browser
        </Button>
      </>
    );
  }
  return (
    <>
      <Button variant="outline" disabled={busy} onPress={delegate} testID="jira-oauth-delegate">
        Sign in on a desktop
      </Button>
      <Button variant="default" loading={busy} onPress={paste} testID="jira-oauth-paste">
        Open sign-in page
      </Button>
    </>
  );
}

function AwaitingBrowser({
  phase,
  form,
  patchForm,
  onSubmit,
}: {
  phase: Extract<Phase, { kind: "awaiting_browser" }>;
  form: FormState;
  patchForm: PatchForm;
  onSubmit: (state: string) => void;
}) {
  const submit = useCallback(() => onSubmit(phase.state), [onSubmit, phase.state]);
  return (
    <View style={jiraStyles.formField} testID="jira-oauth-waiting">
      <Text style={jiraStyles.text}>
        {phase.delegated
          ? "A paired desktop running JAgentDesk will open the sign-in page. Approve it there — or open the page here and paste the address you land on."
          : "Approve access in the browser. If the browser shows an error page at the callback address, copy that whole address and paste it here."}
      </Text>
      <OpenLink url={phase.authorizeUrl} label="Open the sign-in page again" />
      <FormInput
        field="pastedUrl"
        form={form}
        patchForm={patchForm}
        placeholder={`${phase.redirectUri}?code=…&state=…`}
        testID="jira-oauth-pasted-url"
      />
      <Button
        variant="secondary"
        disabled={form.pastedUrl.trim().length === 0}
        onPress={submit}
        testID="jira-oauth-paste-submit"
      >
        Finish sign-in
      </Button>
    </View>
  );
}

function SiteChoice({
  site,
  state,
  onChoose,
}: {
  site: JiraOAuthSite;
  state: string;
  onChoose: (state: string, cloudId: string) => void;
}) {
  const choose = useCallback(() => onChoose(state, site.cloudId), [onChoose, site.cloudId, state]);
  return (
    <Button variant="outline" onPress={choose}>
      {`${site.name} · ${site.url}`}
    </Button>
  );
}

/** Mobile delegation: the desktop completes the flow; the daemon reports it on every session. */
function useDelegationProgress(input: {
  serverId: string;
  phase: Phase;
  onDone: () => void;
  onFailed: (message: string) => void;
}): void {
  const { serverId, phase, onDone, onFailed } = input;
  const client = useHostRuntimeClient(serverId);
  const delegatedState = phase.kind === "awaiting_browser" && phase.delegated ? phase.state : null;
  useEffect(() => {
    if (!client || !delegatedState) return;
    return client.onJiraPush("jira.oauth.progress", (message) => {
      if (message.state !== delegatedState) return;
      if (message.phase === "done") onDone();
      if (message.phase === "failed") onFailed(message.error ?? "Sign-in failed.");
    });
  }, [client, delegatedState, onDone, onFailed]);
}

// oxlint-disable-next-line max-lines-per-function
export function AddConnectionSheet({
  serverId,
  visible,
  onClose,
  onAdded,
}: {
  serverId: string;
  visible: boolean;
  onClose: () => void;
  onAdded: (connection: JiraConnection) => void;
}) {
  const call = useJiraCall(serverId);
  const queryClient = useQueryClient();
  const [method, setMethod] = useState<Method>("api_token");
  const [form, patchForm] = useReducer(formReducer, EMPTY_FORM);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const fail = useCallback((error: unknown) => {
    setPhase({ kind: "error", message: errorMessage(error) });
  }, []);

  const finished = useCallback(
    async (connection: JiraConnection) => {
      await queryClient.invalidateQueries({ queryKey: jiraKeys.connections(serverId) });
      setPhase({ kind: "idle" });
      patchForm(EMPTY_FORM);
      onAdded(connection);
    },
    [onAdded, queryClient, serverId],
  );
  const handleOutcome = useCallback(
    async (outcome: OAuthOutcome) => {
      if (outcome.kind === "connected") await finished(outcome.connection);
      else setPhase({ kind: "choose_site", state: outcome.state, sites: outcome.sites });
    },
    [finished],
  );
  const delegatedDone = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: jiraKeys.connections(serverId) });
    setPhase({ kind: "idle" });
    onClose();
  }, [onClose, queryClient, serverId]);
  useDelegationProgress({ serverId, phase, onDone: delegatedDone, onFailed: fail });

  const submitToken = useCallback(async () => {
    setPhase({ kind: "busy", message: "Checking the connection…" });
    try {
      const { connection } = await call("jira.connections.add.request", {
        deployment: method === "pat" ? "datacenter" : "cloud",
        siteUrl: form.siteUrl,
        method: method === "pat" ? "pat" : "api_token",
        token: form.token,
        ...(method === "api_token" ? { email: form.email } : {}),
        ...(form.label.trim() ? { label: form.label.trim() } : {}),
      });
      if (connection) await finished(connection);
    } catch (error) {
      fail(error);
    }
  }, [call, fail, finished, form, method]);

  const beginOAuth = useCallback(
    async (mode: OAuthMode) => {
      setPhase({ kind: "busy", message: "Starting sign-in…" });
      const input = {
        clientId: form.clientId,
        clientSecret: form.clientSecret,
        ...(form.label.trim() ? { label: form.label.trim() } : {}),
      };
      try {
        const begun =
          mode === "delegate"
            ? await call("jira.oauth.delegate.request", input)
            : await call("jira.oauth.begin.request", input);
        setPhase({ kind: "awaiting_browser", ...begun, delegated: mode === "delegate" });
        if (mode === "paste") await Linking.openURL(begun.authorizeUrl);
        if (mode === "loopback") await handleOutcome(await finishWithLoopback(call, begun));
      } catch (error) {
        fail(error);
      }
    },
    [call, fail, form.clientId, form.clientSecret, form.label, handleOutcome],
  );
  const submitPasted = useCallback(
    async (state: string) => {
      setPhase({ kind: "busy", message: "Finishing sign-in…" });
      try {
        await handleOutcome(await completeOAuth(call, { state, callbackUrl: form.pastedUrl }));
      } catch (error) {
        fail(error);
      }
    },
    [call, fail, form.pastedUrl, handleOutcome],
  );
  const chooseSite = useCallback(
    async (state: string, cloudId: string) => {
      setPhase({ kind: "busy", message: "Connecting the site…" });
      try {
        await handleOutcome(await completeOAuth(call, { state, cloudId }));
      } catch (error) {
        fail(error);
      }
    },
    [call, fail, handleOutcome],
  );
  const handleBegin = useCallback((mode: OAuthMode) => void beginOAuth(mode), [beginOAuth]);
  const handlePasted = useCallback((state: string) => void submitPasted(state), [submitPasted]);
  const handleChoose = useCallback(
    (state: string, cloudId: string) => void chooseSite(state, cloudId),
    [chooseSite],
  );
  const handleConnect = useCallback(() => void submitToken(), [submitToken]);

  const busy = phase.kind === "busy";
  const body = useMemo(
    () =>
      method === "oauth" ? (
        <OAuthForm form={form} patchForm={patchForm} />
      ) : (
        <TokenForm method={method} form={form} patchForm={patchForm} />
      ),
    [form, method],
  );
  return (
    <AdaptiveModalSheet
      header={SHEET_HEADER}
      visible={visible}
      onClose={onClose}
      desktopMaxWidth={560}
      testID="jira-add-connection"
    >
      <View style={jiraStyles.sheetBody}>
        <Tabs tabs={METHOD_TABS} value={method} onChange={setMethod} testIDPrefix="jira-method" />
        {body}
        {phase.kind === "error" ? <ErrorBanner message={phase.message} /> : null}
        {phase.kind === "busy" ? <Text style={jiraStyles.textMuted}>{phase.message}</Text> : null}
        {phase.kind === "awaiting_browser" ? (
          <AwaitingBrowser
            phase={phase}
            form={form}
            patchForm={patchForm}
            onSubmit={handlePasted}
          />
        ) : null}
        {phase.kind === "choose_site" ? (
          <View style={jiraStyles.formField}>
            <Text style={jiraStyles.formLabel}>Choose the Jira site</Text>
            {phase.sites.map((site) => (
              <SiteChoice
                key={site.cloudId}
                site={site}
                state={phase.state}
                onChoose={handleChoose}
              />
            ))}
          </View>
        ) : null}
        <View style={jiraStyles.sheetFooter}>
          <Button variant="ghost" onPress={onClose}>
            Cancel
          </Button>
          {method === "oauth" ? (
            <OAuthButtons busy={busy} onBegin={handleBegin} />
          ) : (
            <Button
              variant="default"
              loading={busy}
              onPress={handleConnect}
              testID="jira-connect-submit"
            >
              Connect
            </Button>
          )}
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}
