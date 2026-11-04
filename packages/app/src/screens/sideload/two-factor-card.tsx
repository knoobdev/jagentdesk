import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import type { DaemonClient, SideloadAuthPrompt } from "@jagentdesk/client/internal/daemon-client";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { unwrap } from "./queries";
import { sideloadStyles as styles } from "./styles";

/**
 * 26.3.1: Apple asked for a verification code. The code goes once to the daemon and is not
 * stored anywhere; "Send SMS instead" asks Apple to text a trusted number.
 */
export function TwoFactorCard({
  client,
  prompt,
}: {
  client: DaemonClient;
  prompt: SideloadAuthPrompt;
}) {
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<"code" | "sms" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const firstPhone = prompt.phoneNumbers[0] ?? null;

  const send = useCallback(
    async (action: "code" | "send_sms" | "cancel") => {
      setPending(action === "send_sms" ? "sms" : action);
      setError(null);
      try {
        unwrap(
          await client.sideloadCall("sideload.auth.respond.request", {
            promptId: prompt.promptId,
            action,
            ...(action === "code" ? { code: code.trim() } : {}),
            ...(action === "send_sms" && firstPhone ? { phoneId: firstPhone.id } : {}),
          }),
        );
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        setPending(null);
      }
    },
    [client, code, firstPhone, prompt.promptId],
  );

  const verify = useCallback(() => void send("code"), [send]);
  const sms = useCallback(() => void send("send_sms"), [send]);
  const cancel = useCallback(() => void send("cancel"), [send]);

  const where =
    prompt.method === "sms"
      ? `Apple sent a code by SMS${firstPhone ? ` to ${firstPhone.number}` : ""}.`
      : "Apple sent a code to your trusted devices.";

  return (
    <View style={styles.card} testID="sideload-two-factor">
      <Text style={styles.title}>Verification code for {prompt.appleId}</Text>
      <Text style={styles.muted}>{where} Enter it to continue.</Text>
      {prompt.message ? <Text style={styles.errorText}>{prompt.message}</Text> : null}
      <View style={styles.row}>
        <View style={styles.grow}>
          <AdaptiveTextInput
            resetKey={prompt.promptId}
            initialValue=""
            onChangeText={setCode}
            placeholder="6-digit code"
            keyboardType="number-pad"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={8}
            style={styles.inputMono}
            testID="sideload-two-factor-code"
          />
        </View>
        <Button
          size="sm"
          onPress={verify}
          loading={pending === "code"}
          disabled={code.trim().length < 6 || pending !== null}
          testID="sideload-two-factor-submit"
        >
          Verify
        </Button>
      </View>
      <View style={styles.wrapRow}>
        {prompt.method === "trusted_device" ? (
          <Button
            size="sm"
            variant="outline"
            onPress={sms}
            loading={pending === "sms"}
            disabled={pending !== null}
            testID="sideload-two-factor-sms"
          >
            Send SMS instead
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          onPress={cancel}
          loading={pending === "cancel"}
          disabled={pending !== null}
        >
          Cancel
        </Button>
      </View>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}
