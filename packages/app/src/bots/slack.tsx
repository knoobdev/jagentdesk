import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Linking, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useBotSlackStatus, useBotsConnection, useBotsMutation } from "./queries";
import { ErrorNotice, QueryNotice, Section } from "./ui";
import { styles } from "./styles";
import { SlackFormModel } from "./slack-form-model";

function SlackErrorNotice({ error }: { error: Error | null }) {
  const message = error?.message.replace(/\s+requestType=\S+(?:\s+code=\S+)?$/, "");
  return <ErrorNotice error={message ? new Error(message) : null} />;
}
function AllowedUser({
  serverId,
  botId,
  user,
}: {
  serverId: string;
  botId: string;
  user: { id: string; name: string };
}) {
  const { t } = useTranslation();
  const remove = useBotsMutation(serverId, "bots.slack.allowed.remove.request");
  const press = useCallback(
    () => remove.mutate({ botId, userId: user.id }),
    [remove, botId, user.id],
  );
  return (
    <View style={styles.card}>
      <Text style={styles.text}>
        {user.name} · {user.id}
      </Text>
      <Button
        size="sm"
        variant="outline"
        onPress={press}
        loading={remove.isPending}
        disabled={remove.isPending}
      >
        {t("bots.jad.slack.removeUser")}
      </Button>
      <SlackErrorNotice error={remove.error} />
    </View>
  );
}
function ManifestDialog({ manifest, onClose }: { manifest: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const header = useMemo(() => ({ title: t("bots.jad.slack.createApp") }), [t]);
  const copy = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(manifest);
      setCopied(true);
      setError(null);
    } catch {
      setError(new Error(t("bots.jad.slack.copyFailed")));
    }
  }, [manifest, t]);
  const openSlack = useCallback(async () => {
    try {
      await Linking.openURL("https://api.slack.com/apps?new_app=1");
      setError(null);
    } catch {
      setError(new Error(t("bots.jad.slack.openFailed")));
    }
  }, [t]);
  return (
    <AdaptiveModalSheet visible onClose={onClose} onDismiss={onClose} header={header}>
      <ScrollView>
        <View style={styles.body}>
          <Text selectable style={styles.text} testID="slack-manifest">
            {manifest}
          </Text>
          <Button onPress={copy}>
            {t(copied ? "bots.jad.slack.copied" : "bots.jad.slack.copyManifest")}
          </Button>
          <Button variant="outline" onPress={openSlack}>
            {t("bots.jad.slack.openSlack")}
          </Button>
          <SlackErrorNotice error={error} />
          <Button variant="ghost" onPress={onClose}>
            {t("bots.jad.close")}
          </Button>
        </View>
      </ScrollView>
    </AdaptiveModalSheet>
  );
}
export function BotSlackSettings({ serverId, botId }: { serverId: string; botId: string }) {
  const { t } = useTranslation();
  const { enabled } = useBotsConnection(serverId);
  const compact = useIsCompactFormFactor();
  const [model] = useState(() => new SlackFormModel());
  const draft = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const [manifest, setManifest] = useState<string | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt_ms: number } | null>(null);
  const status = useBotSlackStatus(serverId, botId, true);
  const create = useBotsMutation(serverId, "bots.slack.manifest.request");
  const connect = useBotsMutation(serverId, "bots.slack.connect.request");
  const link = useBotsMutation(serverId, "bots.slack.link_code.request");
  const disconnect = useBotsMutation(serverId, "bots.slack.disconnect.request");
  const setToken = useCallback((value: string) => model.set("botToken", value), [model]);
  const setSecret = useCallback((value: string) => model.set("signingSecret", value), [model]);
  const closeManifest = useCallback(() => setManifest(null), []);
  const showManifest = useCallback(
    () => create.mutate({ botId }, { onSuccess: (result) => setManifest(result.manifest) }),
    [create, botId],
  );
  const submit = useCallback(
    () =>
      connect.mutate(
        { botId, ...model.input() },
        {
          onSuccess: () => {
            model.clear();
            connect.reset();
          },
        },
      ),
    [connect, botId, model],
  );
  const showCode = useCallback(() => link.mutate({ botId }, { onSuccess: setCode }), [link, botId]);
  const unlink = useCallback(
    () =>
      disconnect.mutate(
        { botId },
        {
          onSuccess: () => {
            model.clear();
            setCode(null);
            setManifest(null);
            connect.reset();
          },
        },
      ),
    [disconnect, botId, model, connect],
  );
  const busy = connect.isPending || disconnect.isPending;
  const data = status.data;
  return (
    <Section title={t("bots.jad.slack.title")}>
      <QueryNotice query={status} />
      {data ? (
        <>
          <Text style={styles.text} testID="slack-status">
            {data.connected
              ? t("bots.jad.slack.connected", { workspace: data.workspace, bot: data.botName })
              : t("bots.jad.slack.disconnected")}
          </Text>
          {!data.relayConnected ? (
            <Text style={styles.muted}>{t("bots.jad.slack.relayOffline")}</Text>
          ) : null}
          <Button
            variant="outline"
            onPress={showManifest}
            disabled={!enabled || create.isPending || busy}
            loading={create.isPending}
            testID="slack-create-app"
          >
            {t("bots.jad.slack.createApp")}
          </Button>
          <SlackErrorNotice error={create.error} />
          <Field label={t("bots.jad.slack.token")}>
            <FormTextInput
              value={draft.botToken}
              initialValue={draft.botToken}
              resetKey={draft.revision}
              webControlled
              onChangeText={setToken}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              size={compact ? "md" : "sm"}
              accessibilityLabel={t("bots.jad.slack.token")}
              testID="slack-token"
              editable={!busy}
            />
          </Field>
          <Field label={t("bots.jad.slack.secret")}>
            <FormTextInput
              value={draft.signingSecret}
              initialValue={draft.signingSecret}
              resetKey={draft.revision}
              webControlled
              onChangeText={setSecret}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              size={compact ? "md" : "sm"}
              accessibilityLabel={t("bots.jad.slack.secret")}
              testID="slack-secret"
              editable={!busy}
            />
          </Field>
          <Button
            onPress={submit}
            disabled={!enabled || !draft.canSubmit || busy}
            loading={connect.isPending}
            testID="slack-connect"
          >
            {t("bots.jad.slack.connect")}
          </Button>
          <SlackErrorNotice error={connect.error} />
          {data.connected ? (
            <>
              <Button
                variant="outline"
                onPress={showCode}
                loading={link.isPending}
                disabled={!enabled || link.isPending || busy}
                testID="slack-link"
              >
                {t("bots.jad.slack.linkAccount")}
              </Button>
              <SlackErrorNotice error={link.error} />
              {code && code.expiresAt_ms > Date.now() ? (
                <Text selectable style={styles.text} testID="slack-link-code">
                  {t("bots.jad.slack.linkCode", {
                    code: code.code,
                    time: new Date(code.expiresAt_ms).toLocaleTimeString(),
                  })}
                </Text>
              ) : null}
              <Text style={styles.title}>{t("bots.jad.slack.allowedUsers")}</Text>
              {data.allowedUsers.length === 0 ? (
                <Text style={styles.muted}>{t("bots.jad.slack.noUsers")}</Text>
              ) : null}
              {data.allowedUsers.map((user) => (
                <AllowedUser key={user.id} serverId={serverId} botId={botId} user={user} />
              ))}
              <Button
                variant="destructive"
                onPress={unlink}
                loading={disconnect.isPending}
                disabled={!enabled || busy}
                testID="slack-disconnect"
              >
                {t("bots.jad.slack.disconnect")}
              </Button>
              <SlackErrorNotice error={disconnect.error} />
            </>
          ) : null}
        </>
      ) : null}
      {manifest ? <ManifestDialog manifest={manifest} onClose={closeManifest} /> : null}
    </Section>
  );
}
