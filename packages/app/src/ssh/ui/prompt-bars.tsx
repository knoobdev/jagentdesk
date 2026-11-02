import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { Check, X } from "lucide-react-native";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import type { SshAuthPrompt, SshAuthPromptItem } from "@jagentdesk/client/internal/daemon-client";
import type { SshServerLiveState } from "@/ssh/use-ssh-connect-events";
import { sshStyles as styles } from "./styles";

// Host-key / keyboard-interactive / passphrase bars shown in the connecting tab
// (spec 25.3 steps 3–4, 25.13). Answers live only in component state until sent and are
// never persisted.

const AUTH_PROMPT_TITLES: Record<SshAuthPrompt["kind"], string> = {
  password: "Password required",
  keyboard_interactive: "The server asks",
  passphrase: "Key passphrase required",
};

export const HostkeyPromptBar = memo(function HostkeyPromptBar({
  serverId,
  live,
  onDecision,
}: {
  serverId: string;
  live: SshServerLiveState;
  onDecision: (serverId: string, decision: "accept" | "reject") => void;
}) {
  const handleAccept = useCallback(() => onDecision(serverId, "accept"), [onDecision, serverId]);
  const handleReject = useCallback(() => onDecision(serverId, "reject"), [onDecision, serverId]);
  const prompt = live.hostkeyPrompt;
  if (!prompt) return null;
  const hop =
    prompt.hopCount && prompt.hopIndex !== undefined
      ? ` · hop ${prompt.hopIndex + 1} of ${prompt.hopCount}`
      : "";
  return (
    <Alert variant="warning" title="Unknown host key" testID="ssh-hostkey-prompt">
      <Text style={styles.promptBody}>
        {prompt.address}:{prompt.port} · {prompt.keyType}
        {hop}
      </Text>
      <Text style={styles.promptFingerprint} selectable>
        {prompt.fingerprintSha256}
      </Text>
      <Text style={styles.promptHint}>
        Compare this fingerprint with the server (ssh-keygen -lf) before trusting it. Trusted keys
        are saved in Known hosts.
      </Text>
      <View style={styles.promptActions}>
        {live.hostkeyDecision ? (
          <Text style={styles.promptHint}>
            {live.hostkeyDecision === "accept" ? "Trusting…" : "Rejecting…"}
          </Text>
        ) : (
          <>
            <Button size="sm" leftIcon={X} onPress={handleReject} testID="ssh-hostkey-reject">
              Reject
            </Button>
            <Button
              size="sm"
              variant="default"
              leftIcon={Check}
              onPress={handleAccept}
              testID="ssh-hostkey-accept"
            >
              Trust and connect
            </Button>
          </>
        )}
      </View>
    </Alert>
  );
});

function AnswerField({
  item,
  index,
  value,
  onChange,
}: {
  item: SshAuthPromptItem;
  index: number;
  value: string;
  onChange: (index: number, value: string) => void;
}) {
  const handleChange = useCallback((text: string) => onChange(index, text), [index, onChange]);
  return (
    <View style={styles.authFieldRow}>
      <Text style={styles.promptBody}>{item.prompt}</Text>
      <FormTextInput
        size="sm"
        initialValue=""
        value={value}
        onChangeText={handleChange}
        secureTextEntry={!item.echo}
        autoCapitalize="none"
        autoCorrect={false}
        testID={`ssh-auth-answer-${index}`}
      />
    </View>
  );
}

export const AuthPromptBar = memo(function AuthPromptBar({
  serverId,
  live,
  onSubmit,
}: {
  serverId: string;
  live: SshServerLiveState;
  onSubmit: (serverId: string, answers: string[] | null) => void;
}) {
  const prompt = live.authPrompt;
  const promptId = prompt?.promptId ?? null;
  const [answers, setAnswers] = useState<string[]>([]);
  useEffect(() => {
    setAnswers([]);
  }, [promptId]);
  const handleChange = useCallback((index: number, value: string) => {
    setAnswers((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }, []);
  const count = prompt?.prompts.length ?? 0;
  const handleContinue = useCallback(() => {
    onSubmit(
      serverId,
      Array.from({ length: count }, (_, index) => answers[index] ?? ""),
    );
    setAnswers([]);
  }, [answers, count, onSubmit, serverId]);
  const handleCancel = useCallback(() => onSubmit(serverId, null), [onSubmit, serverId]);
  const items = useMemo(
    () =>
      prompt
        ? prompt.prompts.map((item, index) => ({ item, index, key: `${prompt.promptId}:${index}` }))
        : [],
    [prompt],
  );
  if (!prompt) return null;
  return (
    <Alert variant="info" title={AUTH_PROMPT_TITLES[prompt.kind]} testID="ssh-auth-prompt">
      {prompt.instructions ? <Text style={styles.promptBody}>{prompt.instructions}</Text> : null}
      {items.map(({ item, index, key }) => (
        <AnswerField
          key={key}
          item={item}
          index={index}
          value={answers[index] ?? ""}
          onChange={handleChange}
        />
      ))}
      <View style={styles.promptActions}>
        {live.authSubmitted ? (
          <Text style={styles.promptHint}>Authenticating…</Text>
        ) : (
          <>
            <Button size="sm" onPress={handleCancel} testID="ssh-auth-cancel">
              Cancel
            </Button>
            <Button size="sm" variant="default" onPress={handleContinue} testID="ssh-auth-submit">
              Continue
            </Button>
          </>
        )}
      </View>
    </Alert>
  );
});

export function MismatchBanner({
  storedFingerprint,
  receivedFingerprint,
  onReplace,
}: {
  storedFingerprint: string;
  receivedFingerprint: string;
  onReplace: () => void;
}) {
  return (
    <Alert variant="error" title="Host key changed — connection blocked" testID="ssh-mismatch">
      <Text style={styles.promptHint}>
        The server presents a different key than the one in Known hosts. Unless you expected this
        change, do not connect: it can mean someone is intercepting the connection.
      </Text>
      <Text style={styles.promptFingerprint} selectable>
        Stored: {storedFingerprint}
      </Text>
      <Text style={styles.promptFingerprint} selectable>
        Received: {receivedFingerprint}
      </Text>
      <View style={styles.promptActions}>
        <Button size="sm" variant="destructive" onPress={onReplace} testID="ssh-mismatch-replace">
          Trust the new key and connect
        </Button>
      </View>
    </Alert>
  );
}
