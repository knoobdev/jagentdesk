import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient, SideloadAuthPrompt } from "@jagentdesk/client/internal/daemon-client";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import {
  PASSWORD_HELP,
  advancedAfterFailure,
  advancedOpenInitially,
  anisetteRequestFields,
  canSubmitAppleId,
  type AnisetteChoice,
} from "./add-apple-id";
import { MutationButton, ValueButton } from "./buttons";
import { sideloadKey, unwrap } from "./queries";
import { sideloadStyles as styles } from "./styles";
import { TwoFactorCard } from "./two-factor-card";

// Add Apple ID (26.3, 26.4): terms, Apple ID + password + keep signed in, anisette under
// Advanced, and the 2FA code when Apple asks for one. Shared by the Sideload accounts sheet and the
// Sims "Enable touch" dialog (27.4), which signs in without leaving the device.

const SIGN_IN_TIMEOUT_MS = 15 * 60_000;
const ANISETTE_OPTIONS = [
  { value: "native" as const, label: "Native" },
  { value: "remote" as const, label: "Remote server" },
];

function errorText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

export function AppleIdForm({
  client,
  serverId,
  initialAppleId,
  initialSource,
  initialUrl,
  needsTerms,
  prompt,
  onSignedIn,
  onCancel,
  embedded = false,
}: {
  client: DaemonClient;
  serverId: string;
  initialAppleId: string;
  initialSource: AnisetteChoice;
  initialUrl: string;
  needsTerms: boolean;
  prompt: SideloadAuthPrompt | null;
  onSignedIn: () => void;
  onCancel: () => void;
  // Inside another dialog's body (Enable touch): no padding of its own.
  embedded?: boolean;
}) {
  const queryClient = useQueryClient();
  const [accepted, setAccepted] = useState(!needsTerms);
  const [appleId, setAppleId] = useState(initialAppleId);
  const [password, setPassword] = useState("");
  const [keepSignedIn, setKeepSignedIn] = useState(false);
  const [source, setSource] = useState<AnisetteChoice>(initialSource);
  const [url, setUrl] = useState(initialUrl);
  const [touched, setTouched] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(advancedOpenInitially(initialSource));
  const anisette = useMemo(() => ({ source, url, touched }), [source, url, touched]);
  const chooseSource = useCallback((value: AnisetteChoice) => {
    setSource(value);
    setTouched(true);
  }, []);
  const changeUrl = useCallback((value: string) => {
    setUrl(value);
    setTouched(true);
  }, []);
  const add = useMutation({
    mutationFn: async () => {
      const payload = await client.sideloadCall(
        "sideload.accounts.add.request",
        {
          auth: "apple_id",
          appleId: appleId.trim(),
          password,
          keepSignedIn,
          ...anisetteRequestFields(anisette),
          acceptedTerms: accepted,
        },
        { timeout: SIGN_IN_TIMEOUT_MS },
      );
      const next = advancedAfterFailure(payload.error ? payload.code : null);
      if (next) {
        setShowAdvanced(true);
        if (next.source) chooseSource(next.source);
      }
      return unwrap(payload).account;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sideloadKey(serverId, "accounts") });
      onSignedIn();
    },
  });

  return accepted ? (
    <View style={embedded ? styles.embeddedSection : styles.section}>
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
        <Text style={styles.muted}>{PASSWORD_HELP}</Text>
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
      <View style={styles.start}>
        <ValueButton
          size="sm"
          variant="ghost"
          leftIcon={showAdvanced ? ChevronDown : ChevronRight}
          value={!showAdvanced}
          onValue={setShowAdvanced}
          accessibilityLabel={showAdvanced ? "Hide advanced options" : "Show advanced options"}
          testID="sideload-apple-id-advanced"
        >
          Advanced
        </ValueButton>
      </View>
      {showAdvanced ? (
        <View style={styles.field} testID="sideload-apple-id-anisette">
          <Text style={styles.label}>Anisette</Text>
          <SegmentedControl
            options={ANISETTE_OPTIONS}
            value={source}
            onValueChange={chooseSource}
            size="sm"
          />
          <Text style={styles.muted}>
            Native uses this host’s own Apple framework (macOS, Windows). Linux needs a remote
            anisette server you run yourself.
          </Text>
          {source === "remote" ? (
            <AdaptiveTextInput
              initialValue={url}
              onChangeText={changeUrl}
              placeholder="http://<host>:6969"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.inputMono}
              testID="sideload-apple-id-anisette-url"
            />
          ) : null}
        </View>
      ) : null}
      {prompt ? <TwoFactorCard client={client} prompt={prompt} /> : null}
      {add.isPending && !prompt ? <Text style={styles.muted}>Signing in with Apple…</Text> : null}
      {add.error ? (
        <Alert variant="error" title="Sign-in failed" description={errorText(add.error)} />
      ) : null}
      <MutationButton
        mutation={add}
        variables={undefined}
        disabled={!canSubmitAppleId({ appleId, password, anisette })}
        testID="sideload-apple-id-submit"
      >
        Sign in
      </MutationButton>
    </View>
  ) : (
    <View style={embedded ? styles.embeddedSection : styles.section} testID="sideload-terms">
      <Text style={styles.label}>Before you add an Apple ID</Text>
      <Text style={styles.text}>
        Apple’s developer terms say an Apple Account must not be shared, and apps installed with a
        personal team are for testing on devices you own or control. Installing other people’s apps
        is at your own risk.
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
        <Button variant="ghost" onPress={onCancel}>
          Cancel
        </Button>
      </View>
    </View>
  );
}
