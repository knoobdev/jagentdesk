import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { SimDevice, SimSignerAccount } from "@jagentdesk/protocol/simulator/rpc-schemas";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { deviceErrorCopy } from "@/screens/sim-device-errors";
import {
  TOUCH_SETUP_STARTING,
  appleIdFormDefaults,
  stepAfterPrepare,
  type TouchSetupStep,
} from "@/screens/sim-touch-setup";
import { AppleIdForm } from "@/screens/sideload/apple-id-form";
import { useSideloadAccounts, useSideloadPrompt } from "@/screens/sideload/queries";
import { TwoFactorCard } from "@/screens/sideload/two-factor-card";

// Spec 27.4 "Enable touch" in place: opened by the first tap, swipe, type or button on an iPhone
// without WebDriverAgent (or the Enable touch button). Signs and installs WDA with the Apple
// account saved in Sideload, offers Add Apple ID inline when there is none, shows each step, and
// then performs the touch that opened it.

const SNAP = ["85%"];
const ThemedSpinner = withUnistyles(ActivityIndicator);
const spinnerColor = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

export type TouchAction = () => Promise<{ error: string | null }>;

function randomRequestId(): string {
  return `touch-${Math.random().toString(36).slice(2)}`;
}

export function TouchSetupDialog({
  client,
  serverId,
  device,
  action,
  onClose,
  onFinished,
}: {
  client: DaemonClient;
  serverId: string;
  device: SimDevice;
  // The touch that opened the dialog; performed once WDA runs. Null from the Enable touch button.
  action: TouchAction | null;
  onClose: () => void;
  // Touch is on; error is the copy for an action that then failed.
  onFinished: (error: string | null) => void;
}) {
  const [step, setStep] = useState<TouchSetupStep>(TOUCH_SETUP_STARTING);
  const prompt = useSideloadPrompt(client);
  const accounts = useSideloadAccounts(client, serverId);
  const started = useRef(false);
  const closed = useRef(false);

  const prepare = useCallback(
    async (accountId?: string) => {
      setStep(TOUCH_SETUP_STARTING);
      const requestId = randomRequestId();
      const off = client.onSimulatorPrepareProgress(requestId, (progress) => {
        if (!closed.current) setStep({ kind: "working", message: progress.message });
      });
      try {
        const response = await client.simulatorPhysicalPrepare({
          udid: device.udid,
          accountId,
          requestId,
        });
        if (closed.current) return;
        const next = stepAfterPrepare(response);
        if (next.kind !== "done") {
          setStep(next);
          return;
        }
        setStep({
          kind: "working",
          message: action ? "Touch is on. Sending your touch" : "Touch is on",
        });
        const result = action ? await action() : { error: null };
        if (!closed.current) onFinished(result.error ? deviceErrorCopy(result.error) : null);
      } catch (error) {
        if (!closed.current) {
          setStep({
            kind: "failed",
            message: error instanceof Error ? error.message : "Touch could not be turned on",
          });
        }
      } finally {
        off();
      }
    },
    [action, client, device.udid, onFinished],
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void prepare();
  }, [prepare]);
  useEffect(
    () => () => {
      closed.current = true;
    },
    [],
  );

  const retry = useCallback(() => void prepare(), [prepare]);
  const signedIn = useCallback(() => void prepare(), [prepare]);
  const header = useMemo<SheetHeader>(
    () => ({ title: `Enable touch on ${device.name}` }),
    [device.name],
  );
  const formDefaults = useMemo(() => appleIdFormDefaults(accounts.data ?? []), [accounts.data]);

  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      desktopMaxWidth={520}
      snapPoints={SNAP}
      testID="device-touch-setup"
    >
      <View style={styles.body}>
        <Text style={styles.text}>
          The screen keeps showing. To tap and type on an iPhone, JAgentDesk installs
          WebDriverAgent, a test app signed with your Apple account. A free account uses one of its
          3 app slots; the signature lasts 7 days and renews automatically.
        </Text>
        {step.kind === "working" ? (
          <View style={styles.row} testID="device-touch-setup-progress">
            <ThemedSpinner size="small" uniProps={spinnerColor} />
            <Text style={styles.text}>{step.message}</Text>
          </View>
        ) : null}
        {step.kind === "working" && prompt ? (
          <TwoFactorCard client={client} prompt={prompt} />
        ) : null}
        {step.kind === "choose_account" ? (
          <AccountChoices accounts={step.accounts} onChoose={prepare} />
        ) : null}
        {step.kind === "add_apple_id" ? (
          <View style={styles.form} testID="device-touch-setup-add-apple-id">
            <Text style={styles.title}>Sign in with an Apple ID</Text>
            <Text style={styles.text}>
              No Apple account is saved on this host yet. It is saved for Sideload too.
            </Text>
            {accounts.isLoading ? null : (
              <AppleIdForm
                client={client}
                serverId={serverId}
                initialAppleId={formDefaults.appleId}
                initialSource={formDefaults.source}
                initialUrl={formDefaults.url}
                needsTerms={formDefaults.needsTerms}
                prompt={prompt}
                onSignedIn={signedIn}
                onCancel={onClose}
                embedded
              />
            )}
          </View>
        ) : null}
        {step.kind === "failed" ? (
          <View style={styles.form}>
            <Text style={styles.error} testID="device-touch-setup-error">
              {step.message}
            </Text>
            <View style={styles.row}>
              <Button size="sm" onPress={retry} testID="device-touch-setup-retry">
                Try again
              </Button>
              <Button size="sm" variant="ghost" onPress={onClose}>
                Close
              </Button>
            </View>
          </View>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

function AccountChoices({
  accounts,
  onChoose,
}: {
  accounts: SimSignerAccount[];
  onChoose: (accountId: string) => Promise<void>;
}) {
  return (
    <View style={styles.form} testID="device-touch-setup-accounts">
      <Text style={styles.title}>Choose the Apple account</Text>
      <View style={styles.choices}>
        {accounts.map((account) => (
          <AccountChoice key={account.id} account={account} onChoose={onChoose} />
        ))}
      </View>
    </View>
  );
}

function AccountChoice({
  account,
  onChoose,
}: {
  account: SimSignerAccount;
  onChoose: (accountId: string) => Promise<void>;
}) {
  const choose = useCallback(() => void onChoose(account.id), [account.id, onChoose]);
  return (
    <Button
      size="sm"
      variant="outline"
      onPress={choose}
      testID={`device-touch-account-${account.id}`}
    >
      {account.label}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[3], paddingBottom: theme.spacing[4] },
  form: { gap: theme.spacing[2] },
  row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.spacing[2] },
  choices: { gap: theme.spacing[2], alignItems: "flex-start" },
  title: { fontSize: theme.fontSize.sm, fontWeight: "600", color: theme.colors.foreground },
  text: { flexShrink: 1, fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
