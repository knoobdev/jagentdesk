import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { KeyRound, Plus } from "lucide-react-native";
import { AccountIcon } from "./icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  DaemonClient,
  SideloadAccountSummary,
  SideloadAuthPrompt,
  SideloadCert,
} from "@jagentdesk/client/internal/daemon-client";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useFetchQuery } from "@/data/query";
import { useFilePicker } from "@/hooks/use-file-picker";
import { MutationButton, ValueButton } from "./buttons";
import { sideloadKey, unwrap, useSideloadAccounts } from "./queries";
import { sideloadStyles as styles } from "./styles";
import { TwoFactorCard } from "./two-factor-card";

// 26.3 / 26.9 Accounts: Apple IDs and App Store Connect keys, their team, anisette source,
// keep signed in, App IDs left this week, and the team's development certificates.

const SIGN_IN_TIMEOUT_MS = 15 * 60_000;
const SNAP = ["85%"];
type AnisetteChoice = "native" | "remote";
const ANISETTE_OPTIONS = [
  { value: "native" as const, label: "Native" },
  { value: "remote" as const, label: "Remote server" },
];

function errorText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

function formatDate(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString() : "—";
}

function anisetteLabel(account: SideloadAccountSummary): string {
  if (account.anisetteSource === "none") return "Not needed (App Store Connect API)";
  if (account.anisetteSource === "remote") return `Remote: ${account.anisetteUrl ?? ""}`;
  return "Native (this host)";
}

export function AccountsSection({
  client,
  serverId,
  prompt,
}: {
  client: DaemonClient;
  serverId: string;
  prompt: SideloadAuthPrompt | null;
}) {
  const accounts = useSideloadAccounts(client, serverId);
  const [sheet, setSheet] = useState<
    { kind: "apple_id"; appleId: string } | { kind: "asc" } | null
  >(null);
  const hasAppleId = (accounts.data ?? []).some((account) => account.auth === "apple_id");
  const openAppleId = useCallback(() => setSheet({ kind: "apple_id", appleId: "" }), []);
  const openAsc = useCallback(() => setSheet({ kind: "asc" }), []);
  const close = useCallback(() => setSheet(null), []);
  const signIn = useCallback((appleId: string) => setSheet({ kind: "apple_id", appleId }), []);

  return (
    <ScrollView contentContainerStyle={styles.section} testID="sideload-accounts">
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>Apple accounts</Text>
        <View style={styles.headActions}>
          <Button size="sm" leftIcon={Plus} onPress={openAppleId} testID="sideload-add-apple-id">
            Add Apple ID
          </Button>
          <Button
            size="sm"
            variant="outline"
            leftIcon={KeyRound}
            onPress={openAsc}
            testID="sideload-add-asc"
          >
            Add API key
          </Button>
        </View>
      </View>
      {prompt && sheet === null ? <TwoFactorCard client={client} prompt={prompt} /> : null}
      {accounts.error ? (
        <Alert
          variant="error"
          title="Could not load accounts"
          description={errorText(accounts.error)}
        />
      ) : null}
      {accounts.data && accounts.data.length === 0 ? (
        <View style={styles.card}>
          <View style={styles.empty}>
            <AccountIcon size={20} />
            <Text style={styles.title}>No Apple account yet</Text>
            <Text style={styles.muted}>
              Add an Apple ID (free or paid) or an App Store Connect API key. JAgentDesk signs and
              installs apps with it and refreshes them before they expire.
            </Text>
          </View>
        </View>
      ) : null}
      {(accounts.data ?? []).map((account) => (
        <AccountCard
          key={account.id}
          client={client}
          serverId={serverId}
          account={account}
          onSignIn={signIn}
        />
      ))}
      {sheet?.kind === "apple_id" ? (
        <AddAppleIdSheet
          client={client}
          serverId={serverId}
          initialAppleId={sheet.appleId}
          needsTerms={!hasAppleId}
          prompt={prompt}
          onClose={close}
        />
      ) : null}
      {sheet?.kind === "asc" ? (
        <AddAscKeySheet client={client} serverId={serverId} onClose={close} />
      ) : null}
    </ScrollView>
  );
}

function AccountCard({
  client,
  serverId,
  account,
  onSignIn,
}: {
  client: DaemonClient;
  serverId: string;
  account: SideloadAccountSummary;
  onSignIn: (appleId: string) => void;
}) {
  const isAppleId = account.auth === "apple_id";
  return (
    <View style={styles.card} testID={`sideload-account-${account.id}`}>
      <View style={styles.rowBetween}>
        <View style={styles.grow}>
          <Text style={styles.title} numberOfLines={1}>
            {account.appleId}
          </Text>
          <Text style={styles.muted} numberOfLines={1}>
            {account.teamName ?? "Team"} · {account.teamId ?? "team id after first install"}
          </Text>
        </View>
        <View style={styles.row}>
          <StatusBadge label={account.kind === "free" ? "Free" : "Paid"} variant="muted" />
          <StatusBadge
            label={account.signedIn ? "Signed in" : "Sign in again"}
            variant={account.signedIn ? "success" : "error"}
          />
        </View>
      </View>
      <Text style={styles.muted}>{appIdLine(account)}</Text>
      <Text style={styles.muted}>Anisette: {anisetteLabel(account)}</Text>
      {!account.signedIn && isAppleId ? (
        <ValueButton
          size="sm"
          value={account.appleId}
          onValue={onSignIn}
          testID={`sideload-sign-in-${account.id}`}
        >
          Sign in again
        </ValueButton>
      ) : null}
      {isAppleId ? (
        <>
          <View style={styles.divider} />
          <KeepSignedInControl client={client} serverId={serverId} account={account} />
          <AnisetteControl client={client} serverId={serverId} account={account} />
        </>
      ) : null}
      <View style={styles.divider} />
      <AccountActions client={client} serverId={serverId} account={account} />
    </View>
  );
}

function appIdLine(account: SideloadAccountSummary): string {
  if (account.appIdsLimit === null) return "App IDs: no weekly limit (paid team)";
  const next = account.nextAppIdAt_ms ? ` · next one at ${formatDate(account.nextAppIdAt_ms)}` : "";
  return `App IDs this week: ${account.appIdsUsed} of ${account.appIdsLimit}${next}`;
}

function useInvalidateAccounts(serverId: string) {
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: sideloadKey(serverId, "accounts") }),
    [queryClient, serverId],
  );
}

function KeepSignedInControl({
  client,
  serverId,
  account,
}: {
  client: DaemonClient;
  serverId: string;
  account: SideloadAccountSummary;
}) {
  const invalidate = useInvalidateAccounts(serverId);
  const [password, setPassword] = useState("");
  const [askPassword, setAskPassword] = useState(false);
  const keep = useMutation({
    mutationFn: async (input: { keepSignedIn: boolean; password?: string }) =>
      unwrap(
        await client.sideloadCall(
          "sideload.accounts.set_keep_signed_in.request",
          { accountId: account.id, ...input },
          { timeout: SIGN_IN_TIMEOUT_MS },
        ),
      ),
    onSuccess: () => {
      setAskPassword(false);
      void invalidate();
    },
  });
  const { mutate } = keep;
  const toggle = useCallback(
    (value: boolean) => {
      if (value) setAskPassword(true);
      else mutate({ keepSignedIn: false });
    },
    [mutate],
  );
  const enable = useMemo(() => ({ keepSignedIn: true, password }), [password]);
  return (
    <>
      <View style={styles.rowBetween}>
        <View style={styles.grow}>
          <Text style={styles.text}>Keep me signed in for automatic refresh</Text>
          <Text style={styles.muted}>
            Stores the password encrypted on this host so refresh runs unattended.
          </Text>
        </View>
        <Switch
          value={account.keepSignedIn}
          onValueChange={toggle}
          disabled={keep.isPending}
          accessibilityLabel="Keep me signed in for automatic refresh"
        />
      </View>
      {askPassword ? (
        <View style={styles.row}>
          <View style={styles.grow}>
            <AdaptiveTextInput
              initialValue=""
              onChangeText={setPassword}
              placeholder="Apple ID password"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />
          </View>
          <MutationButton
            size="sm"
            mutation={keep}
            variables={enable}
            disabled={password.length === 0}
          >
            Keep signed in
          </MutationButton>
          <ValueButton size="sm" variant="ghost" value={false} onValue={setAskPassword}>
            Cancel
          </ValueButton>
        </View>
      ) : null}
      {keep.error ? <Text style={styles.errorText}>{errorText(keep.error)}</Text> : null}
    </>
  );
}

function AnisetteControl({
  client,
  serverId,
  account,
}: {
  client: DaemonClient;
  serverId: string;
  account: SideloadAccountSummary;
}) {
  const invalidate = useInvalidateAccounts(serverId);
  const [anisette, setAnisette] = useState<AnisetteChoice>(
    account.anisetteSource === "remote" ? "remote" : "native",
  );
  const [anisetteUrl, setAnisetteUrl] = useState(account.anisetteUrl ?? "");
  const save = useMutation({
    mutationFn: async () =>
      unwrap(
        await client.sideloadCall("sideload.accounts.set_anisette.request", {
          accountId: account.id,
          source: anisette,
          ...(anisette === "remote" ? { url: anisetteUrl.trim() } : {}),
        }),
      ),
    onSuccess: invalidate,
  });
  const urlChanged = anisette === "remote" && anisetteUrl.trim() !== (account.anisetteUrl ?? "");
  const changed = anisette !== account.anisetteSource || urlChanged;
  return (
    <View style={styles.field}>
      <Text style={styles.text}>Anisette source</Text>
      <SegmentedControl
        options={ANISETTE_OPTIONS}
        value={anisette}
        onValueChange={setAnisette}
        size="sm"
      />
      {anisette === "remote" ? (
        <AdaptiveTextInput
          initialValue={anisetteUrl}
          onChangeText={setAnisetteUrl}
          placeholder="http://<host>:6969"
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.inputMono}
        />
      ) : null}
      {changed ? (
        <MutationButton size="sm" variant="outline" mutation={save} variables={undefined}>
          Save anisette source
        </MutationButton>
      ) : null}
      {save.error ? <Text style={styles.errorText}>{errorText(save.error)}</Text> : null}
    </View>
  );
}

function AccountActions({
  client,
  serverId,
  account,
}: {
  client: DaemonClient;
  serverId: string;
  account: SideloadAccountSummary;
}) {
  const invalidate = useInvalidateAccounts(serverId);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [showCerts, setShowCerts] = useState(false);
  const remove = useMutation({
    mutationFn: async () =>
      unwrap(
        await client.sideloadCall("sideload.accounts.remove.request", { accountId: account.id }),
      ),
    onSuccess: invalidate,
  });
  return (
    <>
      <View style={styles.wrapRow}>
        <ValueButton size="sm" variant="outline" value={!showCerts} onValue={setShowCerts}>
          {showCerts ? "Hide certificates" : "Certificates"}
        </ValueButton>
        {confirmRemove ? (
          <>
            <MutationButton size="sm" variant="destructive" mutation={remove} variables={undefined}>
              Remove account and its secrets
            </MutationButton>
            <ValueButton size="sm" variant="ghost" value={false} onValue={setConfirmRemove}>
              Keep
            </ValueButton>
          </>
        ) : (
          <ValueButton
            size="sm"
            variant="ghost"
            value={true}
            onValue={setConfirmRemove}
            testID={`sideload-remove-${account.id}`}
          >
            Remove
          </ValueButton>
        )}
      </View>
      {remove.error ? <Text style={styles.errorText}>{errorText(remove.error)}</Text> : null}
      {showCerts ? (
        <CertificateList client={client} serverId={serverId} accountId={account.id} />
      ) : null}
    </>
  );
}

function CertificateList({
  client,
  serverId,
  accountId,
}: {
  client: DaemonClient;
  serverId: string;
  accountId: string;
}) {
  const queryClient = useQueryClient();
  const key = sideloadKey(serverId, `certs:${accountId}`);
  const certs = useFetchQuery({
    queryKey: key,
    dataShape: "list",
    staleTimeMs: 30_000,
    queryFn: async () =>
      unwrap(await client.sideloadCall("sideload.certs.list.request", { accountId })).certs,
  });
  const revoke = useMutation({
    mutationFn: async (certId: string) =>
      unwrap(await client.sideloadCall("sideload.certs.revoke.request", { accountId, certId })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  return (
    <View style={styles.field}>
      {certs.isPending ? <Text style={styles.muted}>Loading the team’s certificates…</Text> : null}
      {certs.error ? <Text style={styles.errorText}>{errorText(certs.error)}</Text> : null}
      {certs.data && certs.data.length === 0 ? (
        <Text style={styles.muted}>No development certificates.</Text>
      ) : null}
      {(certs.data ?? []).map((cert: SideloadCert) => (
        <View key={cert.id} style={styles.rowBetween}>
          <View style={styles.grow}>
            <Text style={styles.text} numberOfLines={1}>
              {cert.name} {cert.ownedByDaemon ? "· this host" : ""}
            </Text>
            <Text style={styles.mono} numberOfLines={1}>
              {cert.machineName ?? "unknown machine"} · expires {formatDate(cert.expiresAt_ms)}
            </Text>
          </View>
          <MutationButton size="sm" variant="ghost" mutation={revoke} variables={cert.id}>
            Revoke
          </MutationButton>
        </View>
      ))}
      {revoke.error ? <Text style={styles.errorText}>{errorText(revoke.error)}</Text> : null}
    </View>
  );
}

function AddAppleIdSheet({
  client,
  serverId,
  initialAppleId,
  needsTerms,
  prompt,
  onClose,
}: {
  client: DaemonClient;
  serverId: string;
  initialAppleId: string;
  needsTerms: boolean;
  prompt: SideloadAuthPrompt | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [accepted, setAccepted] = useState(!needsTerms);
  const [appleId, setAppleId] = useState(initialAppleId);
  const [password, setPassword] = useState("");
  const [keepSignedIn, setKeepSignedIn] = useState(false);
  const [source, setSource] = useState<AnisetteChoice>("native");
  const [url, setUrl] = useState("");
  const header = useMemo<SheetHeader>(
    () => ({ title: initialAppleId ? "Sign in again" : "Add Apple ID" }),
    [initialAppleId],
  );
  const add = useMutation({
    mutationFn: async () => {
      const payload = await client.sideloadCall(
        "sideload.accounts.add.request",
        {
          auth: "apple_id",
          appleId: appleId.trim(),
          password,
          keepSignedIn,
          anisetteSource: source,
          ...(source === "remote" ? { anisetteUrl: url.trim() } : {}),
          acceptedTerms: accepted,
        },
        { timeout: SIGN_IN_TIMEOUT_MS },
      );
      return unwrap(payload).account;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sideloadKey(serverId, "accounts") });
      onClose();
    },
  });

  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      desktopMaxWidth={520}
      snapPoints={SNAP}
      testID="sideload-apple-id-sheet"
    >
      {accepted ? (
        <View style={styles.section}>
          <View style={styles.field}>
            <Text style={styles.label}>Apple ID</Text>
            <AdaptiveTextInput
              initialValue={initialAppleId}
              onChangeText={setAppleId}
              placeholder="name@<domain>"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              editable={!add.isPending && initialAppleId === ""}
              style={styles.input}
              testID="sideload-apple-id-email"
            />
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>Password</Text>
            <AdaptiveTextInput
              initialValue=""
              onChangeText={setPassword}
              placeholder="Apple ID password"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!add.isPending}
              style={styles.input}
              testID="sideload-apple-id-password"
            />
            <Text style={styles.muted}>
              Sent once to this host to sign in with Apple. Kept only if you turn on “Keep me signed
              in”.
            </Text>
          </View>
          <View style={styles.rowBetween}>
            <View style={styles.grow}>
              <Text style={styles.text}>Keep me signed in for automatic refresh</Text>
              <Text style={styles.muted}>
                Off: refresh stops when the session expires and asks you to sign in.
              </Text>
            </View>
            <Switch
              value={keepSignedIn}
              onValueChange={setKeepSignedIn}
              disabled={add.isPending}
              accessibilityLabel="Keep me signed in"
            />
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>Anisette</Text>
            <SegmentedControl
              options={ANISETTE_OPTIONS}
              value={source}
              onValueChange={setSource}
              size="sm"
            />
            <Text style={styles.muted}>
              Native uses this host’s own Apple framework (macOS, Windows). Linux needs a remote
              anisette server you run yourself.
            </Text>
            {source === "remote" ? (
              <AdaptiveTextInput
                initialValue=""
                onChangeText={setUrl}
                placeholder="http://<host>:6969"
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.inputMono}
              />
            ) : null}
          </View>
          {prompt ? <TwoFactorCard client={client} prompt={prompt} /> : null}
          {add.isPending && !prompt ? (
            <Text style={styles.muted}>Signing in with Apple…</Text>
          ) : null}
          {add.error ? (
            <Alert variant="error" title="Sign-in failed" description={errorText(add.error)} />
          ) : null}
          <MutationButton
            mutation={add}
            variables={undefined}
            disabled={
              !appleId.trim() || password.length === 0 || (source === "remote" && !url.trim())
            }
            testID="sideload-apple-id-submit"
          >
            Sign in
          </MutationButton>
        </View>
      ) : (
        <View style={styles.section} testID="sideload-terms">
          <Text style={styles.label}>Before you add an Apple ID</Text>
          <Text style={styles.text}>
            Apple’s developer terms say an Apple Account must not be shared, and apps installed with
            a personal team are for testing on devices you own or control. Installing other people’s
            apps is at your own risk.
          </Text>
          <Text style={styles.text}>
            Use a secondary Apple ID, not your main one: Apple can lock accounts that sideload.
          </Text>
          <Text style={styles.muted}>
            Your password and sign-in data stay on this host, encrypted. The app only shows account
            details and passes 2FA codes.
          </Text>
          <View style={styles.wrapRow}>
            <ValueButton value={true} onValue={setAccepted} testID="sideload-terms-accept">
              I understand
            </ValueButton>
            <Button variant="ghost" onPress={onClose}>
              Cancel
            </Button>
          </View>
        </View>
      )}
    </AdaptiveModalSheet>
  );
}

function AddAscKeySheet({
  client,
  serverId,
  onClose,
}: {
  client: DaemonClient;
  serverId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { pickFiles } = useFilePicker();
  const [issuerId, setIssuerId] = useState("");
  const [keyId, setKeyId] = useState("");
  const [key, setKey] = useState<{ name: string; pem: string } | null>(null);
  const header = useMemo<SheetHeader>(() => ({ title: "Add App Store Connect API key" }), []);
  const pick = useMutation({
    mutationFn: async () => {
      const file = (await pickFiles())?.[0];
      if (!file) return null;
      const pem = new TextDecoder().decode(await file.readBytes());
      if (!pem.includes("PRIVATE KEY"))
        throw new Error(`${file.fileName} is not a .p8 private key.`);
      return { name: file.fileName, pem };
    },
    onSuccess: (picked) => {
      if (picked) setKey(picked);
    },
  });
  const add = useMutation({
    mutationFn: async () =>
      unwrap(
        await client.sideloadCall("sideload.accounts.add.request", {
          auth: "asc_api_key",
          issuerId: issuerId.trim(),
          keyId: keyId.trim(),
          privateKeyP8: key?.pem ?? "",
        }),
      ).account,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sideloadKey(serverId, "accounts") });
      onClose();
    },
  });
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      desktopMaxWidth={520}
      snapPoints={SNAP}
      testID="sideload-asc-sheet"
    >
      <View style={styles.section}>
        <Text style={styles.muted}>
          For paid Apple Developer Program teams. Create a key in App Store Connect → Users and
          Access → Integrations with the Developer role. No anisette and no Apple ID password are
          needed.
        </Text>
        <View style={styles.field}>
          <Text style={styles.label}>Issuer ID</Text>
          <AdaptiveTextInput
            initialValue=""
            onChangeText={setIssuerId}
            placeholder="<issuer uuid>"
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.inputMono}
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Key ID</Text>
          <AdaptiveTextInput
            initialValue=""
            onChangeText={setKeyId}
            placeholder="<KEY ID>"
            autoCapitalize="characters"
            autoCorrect={false}
            style={styles.inputMono}
          />
        </View>
        <View style={styles.rowBetween}>
          <Text style={styles.text}>{key ? key.name : "No .p8 file chosen"}</Text>
          <MutationButton size="sm" variant="outline" mutation={pick} variables={undefined}>
            Choose .p8…
          </MutationButton>
        </View>
        {pick.error ? <Text style={styles.errorText}>{errorText(pick.error)}</Text> : null}
        {add.error ? (
          <Alert variant="error" title="Could not add the key" description={errorText(add.error)} />
        ) : null}
        <MutationButton
          mutation={add}
          variables={undefined}
          disabled={!issuerId.trim() || !keyId.trim() || !key}
        >
          Add key
        </MutationButton>
      </View>
    </AdaptiveModalSheet>
  );
}
