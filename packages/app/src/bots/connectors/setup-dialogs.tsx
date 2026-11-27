// The setup dialog behind each Connectors row (spec 37.4.7): Slack reuses the round-1 Slack form
// (spec 37.8.1); GitHub, GitLab and Telegram follow spec 37.10.1, 37.11.1 and 37.12.1 and call the
// bt4 RPCs through `hooks-rpc.ts`. Orca's own setup dialogs (bots/slack/*, bots/github/*) talk to its
// cloud connector, so only their layout and strings carry over.
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { openExternalUrl } from "@/utils/open-external-url";
import { BotSlackSettings } from "@/bots/slack";
import { Input } from "@/bots/ui";
import { botErrorMessage } from "@/bots/queries";
import {
  useBotsHooksSupported,
  useHooksMutation,
  useHooksRead,
  type HookAllowedUser,
  type HookManualSetup,
} from "./hooks-rpc";
import type { BotConnectorId } from "./connector-rows";

function Line({ children, tone }: { children: ReactNode; tone?: "danger" | "muted" }) {
  return (
    <Text
      style={[styles.line, tone === "danger" && styles.danger, tone === "muted" && styles.muted]}
    >
      {children}
    </Text>
  );
}

function ErrorLine({ error }: { error: unknown }) {
  return error ? <Line tone="danger">{botErrorMessage(error)}</Line> : null;
}

/** The hand-made hook (a 403/404 from gh/glab): shown once, the secret with "Copy secret". */
function ManualSetup({ manual }: { manual: HookManualSetup }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    await copyToClipboard(manual.secret);
    setCopied(true);
  }, [manual.secret]);
  const settingsUrl = manual.settingsUrl;
  const openSettings = useCallback(() => {
    if (settingsUrl) void openExternalUrl(settingsUrl);
  }, [settingsUrl]);
  return (
    <View style={styles.manual} testID="bot-connector-manual">
      <Text style={styles.subtitle}>{t("bots.jad.panels.connectors.manualTitle")}</Text>
      <Fact label={t("bots.jad.panels.connectors.payloadUrl")} value={manual.payloadUrl} />
      {manual.contentType ? (
        <Fact label={t("bots.jad.panels.connectors.contentType")} value={manual.contentType} />
      ) : null}
      <Fact
        label={
          manual.contentType
            ? t("bots.jad.panels.connectors.secret")
            : t("bots.jad.panels.connectors.secretToken")
        }
        value={manual.secret}
      />
      <Line tone="muted">{t("bots.jad.panels.connectors.secretOnce")}</Line>
      <Fact label={t("bots.jad.panels.connectors.events")} value={manual.events.join(", ")} />
      <View style={styles.actions}>
        <Button size="sm" variant="outline" onPress={copy}>
          {copied
            ? t("bots.jad.panels.connectors.copied")
            : t("bots.jad.panels.connectors.copySecret")}
        </Button>
        {settingsUrl ? (
          <Button size="sm" variant="ghost" onPress={openSettings}>
            {t("bots.jad.panels.connectors.openSettings")}
          </Button>
        ) : null}
      </View>
    </View>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue} selectable>
        {value}
      </Text>
    </View>
  );
}

function TargetRow<T>({
  name,
  target,
  state,
  onRotate,
  onRemove,
  pending,
}: {
  name: string;
  target: T;
  state: "waiting" | "connected" | "manual";
  onRotate: (target: T) => void;
  onRemove: (target: T) => void;
  pending: boolean;
}) {
  const { t } = useTranslation();
  const rotate = useCallback(() => onRotate(target), [onRotate, target]);
  const remove = useCallback(() => onRemove(target), [onRemove, target]);
  const stateText = {
    connected: t("bots.jad.panels.connectors.connected"),
    waiting: t("bots.jad.panels.connectors.waiting"),
    manual: t("bots.jad.panels.connectors.manual"),
  }[state];
  return (
    <View style={styles.row} testID={`bot-connector-target-${name}`}>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.muted}>{stateText}</Text>
      </View>
      <Button size="xs" variant="ghost" onPress={rotate} disabled={pending}>
        {t("bots.jad.panels.connectors.rotateSecret")}
      </Button>
      <Button size="xs" variant="ghost" onPress={remove} disabled={pending}>
        {t("bots.jad.panels.connectors.remove")}
      </Button>
    </View>
  );
}

function PersonRow({
  person,
  onRemove,
}: {
  person: HookAllowedUser;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  const remove = useCallback(() => onRemove(person.id), [onRemove, person.id]);
  return (
    <View style={styles.row}>
      <Text style={styles.personName} numberOfLines={1}>
        {person.username ? `${person.name} · @${person.username}` : person.name}
      </Text>
      <Pressable
        onPress={remove}
        accessibilityRole="button"
        accessibilityLabel={t("bots.jad.panels.connectors.removePerson", { name: person.name })}
        style={styles.textButton}
      >
        <Text style={styles.muted}>{t("bots.jad.panels.connectors.remove")}</Text>
      </Pressable>
    </View>
  );
}

function PeopleList({
  people,
  onRemove,
}: {
  people: readonly HookAllowedUser[];
  onRemove: (id: string) => void;
}) {
  return (
    <>
      {people.map((person) => (
        <PersonRow key={person.id} person={person} onRemove={onRemove} />
      ))}
    </>
  );
}

function GitHubSetup({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const status = useHooksRead(serverId, "bots.github.status.request", { botId: bot.id });
  const add = useHooksMutation(serverId, "bots.github.add_repo.request");
  const rotate = useHooksMutation(serverId, "bots.github.rotate_secret.request");
  const remove = useHooksMutation(serverId, "bots.github.remove.request");
  const addUser = useHooksMutation(serverId, "bots.github.allowed.add.request");
  const removeUser = useHooksMutation(serverId, "bots.github.allowed.remove.request");
  const [target, setTarget] = useState("");
  const [login, setLogin] = useState("");
  const [manual, setManual] = useState<HookManualSetup | null>(null);
  const current = status.data?.status;
  const submit = useCallback(() => {
    const value = target.trim();
    if (!value) return;
    add.mutate(
      { botId: bot.id, target: value },
      {
        onSuccess: (result) => {
          setTarget("");
          setManual(result.manual ?? null);
        },
      },
    );
  }, [add, bot.id, target]);
  const submitUser = useCallback(() => {
    const value = login.trim();
    if (!value) return;
    addUser.mutate({ botId: bot.id, login: value }, { onSuccess: () => setLogin("") });
  }, [addUser, bot.id, login]);
  const rotateTarget = useCallback(
    (value: string) =>
      rotate.mutate(
        { botId: bot.id, target: value },
        { onSuccess: (result) => setManual(result.manual ?? null) },
      ),
    [bot.id, rotate],
  );
  const removeTarget = useCallback(
    (value: string) => remove.mutate({ botId: bot.id, target: value }),
    [bot.id, remove],
  );
  const removeLogin = useCallback(
    (id: string) => removeUser.mutate({ botId: bot.id, login: id }),
    [bot.id, removeUser],
  );
  if (!current) return <ErrorLine error={status.error} />;
  return (
    <View style={styles.body}>
      {!current.relayConnected ? (
        <Line tone="danger">
          {t("bots.jad.panels.connectors.relayOffline", { name: "GitHub" })}
        </Line>
      ) : null}
      {!current.signedIn ? (
        <Line tone="danger">
          {t("bots.jad.panels.connectors.github.signIn", { host: current.host })}
        </Line>
      ) : null}
      <Input
        label={t("bots.jad.panels.connectors.github.target")}
        value={target}
        onChange={setTarget}
        placeholder={t("bots.jad.panels.connectors.github.targetPlaceholder")}
        testID="bot-github-target"
      />
      <View style={styles.actions}>
        <Button
          size="sm"
          variant="outline"
          onPress={submit}
          disabled={!current.signedIn || !target.trim()}
          loading={add.isPending}
          testID="bot-github-add"
        >
          {t("bots.jad.panels.connectors.add")}
        </Button>
      </View>
      <ErrorLine error={add.error ?? rotate.error ?? remove.error} />
      {manual ? <ManualSetup manual={manual} /> : null}
      {current.targets.map((entry) => (
        <TargetRow
          key={entry.target}
          name={entry.target}
          target={entry.target}
          state={entry.state}
          pending={rotate.isPending || remove.isPending}
          onRotate={rotateTarget}
          onRemove={removeTarget}
        />
      ))}
      <Text style={styles.subtitle}>{t("bots.jad.panels.connectors.whoCanAsk")}</Text>
      <PeopleList people={current.allowedUsers} onRemove={removeLogin} />
      <Input
        label={t("bots.jad.panels.connectors.github.addUser")}
        value={login}
        onChange={setLogin}
        placeholder={t("bots.jad.panels.connectors.github.userPlaceholder")}
        testID="bot-github-user"
      />
      <View style={styles.actions}>
        <Button
          size="sm"
          variant="outline"
          onPress={submitUser}
          disabled={!login.trim()}
          loading={addUser.isPending}
        >
          {t("bots.jad.panels.connectors.github.addUser")}
        </Button>
      </View>
      <ErrorLine error={addUser.error ?? removeUser.error} />
    </View>
  );
}

function GitLabSetup({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const [host, setHost] = useState("gitlab.com");
  const [path, setPath] = useState("");
  const [username, setUsername] = useState("");
  const [manual, setManual] = useState<HookManualSetup | null>(null);
  const settledHost = host.trim() || "gitlab.com";
  const status = useHooksRead(serverId, "bots.gitlab.status.request", {
    botId: bot.id,
    host: settledHost,
  });
  const add = useHooksMutation(serverId, "bots.gitlab.add_project.request");
  const rotate = useHooksMutation(serverId, "bots.gitlab.rotate_secret.request");
  const remove = useHooksMutation(serverId, "bots.gitlab.remove.request");
  const addUser = useHooksMutation(serverId, "bots.gitlab.allowed.add.request");
  const removeUser = useHooksMutation(serverId, "bots.gitlab.allowed.remove.request");
  const current = status.data?.status;
  const submit = useCallback(() => {
    const value = path.trim();
    if (!value) return;
    add.mutate(
      { botId: bot.id, host: settledHost, path: value },
      {
        onSuccess: (result) => {
          setPath("");
          setManual(result.manual ?? null);
        },
      },
    );
  }, [add, bot.id, path, settledHost]);
  const rotateTarget = useCallback(
    (target: { host: string; path: string }) =>
      rotate.mutate(
        { botId: bot.id, host: target.host, path: target.path },
        { onSuccess: (result) => setManual(result.manual ?? null) },
      ),
    [bot.id, rotate],
  );
  const removeTarget = useCallback(
    (target: { host: string; path: string }) =>
      remove.mutate({ botId: bot.id, host: target.host, path: target.path }),
    [bot.id, remove],
  );
  const removeUsername = useCallback(
    (id: string) => removeUser.mutate({ botId: bot.id, username: id }),
    [bot.id, removeUser],
  );
  const submitUser = useCallback(() => {
    const value = username.trim();
    if (!value) return;
    addUser.mutate({ botId: bot.id, username: value }, { onSuccess: () => setUsername("") });
  }, [addUser, bot.id, username]);
  return (
    <View style={styles.body}>
      <Input
        label={t("bots.jad.panels.connectors.gitlab.host")}
        value={host}
        onChange={setHost}
        testID="bot-gitlab-host"
      />
      {!current ? <ErrorLine error={status.error} /> : null}
      {current && !current.relayConnected ? (
        <Line tone="danger">
          {t("bots.jad.panels.connectors.relayOffline", { name: "GitLab" })}
        </Line>
      ) : null}
      {current && !current.signedIn ? (
        <Line tone="danger">
          {t("bots.jad.panels.connectors.gitlab.signIn", { host: current.host })}
        </Line>
      ) : null}
      <Input
        label={t("bots.jad.panels.connectors.gitlab.target")}
        value={path}
        onChange={setPath}
        placeholder={t("bots.jad.panels.connectors.gitlab.targetPlaceholder")}
        testID="bot-gitlab-target"
      />
      <View style={styles.actions}>
        <Button
          size="sm"
          variant="outline"
          onPress={submit}
          disabled={!current?.signedIn || !path.trim()}
          loading={add.isPending}
          testID="bot-gitlab-add"
        >
          {t("bots.jad.panels.connectors.add")}
        </Button>
      </View>
      <ErrorLine error={add.error ?? rotate.error ?? remove.error} />
      {manual ? <ManualSetup manual={manual} /> : null}
      {current?.targets.map((entry) => (
        <TargetRow
          key={`${entry.host}/${entry.path}`}
          name={`${entry.host}/${entry.path}`}
          target={entry}
          state={entry.state}
          pending={rotate.isPending || remove.isPending}
          onRotate={rotateTarget}
          onRemove={removeTarget}
        />
      ))}
      {current ? (
        <>
          <Text style={styles.subtitle}>{t("bots.jad.panels.connectors.whoCanAsk")}</Text>
          <PeopleList people={current.allowedUsers} onRemove={removeUsername} />
        </>
      ) : null}
      <Input
        label={t("bots.jad.panels.connectors.gitlab.addUser")}
        value={username}
        onChange={setUsername}
        placeholder={t("bots.jad.panels.connectors.gitlab.userPlaceholder")}
        testID="bot-gitlab-user"
      />
      <View style={styles.actions}>
        <Button
          size="sm"
          variant="outline"
          onPress={submitUser}
          disabled={!username.trim()}
          loading={addUser.isPending}
        >
          {t("bots.jad.panels.connectors.gitlab.addUser")}
        </Button>
      </View>
      <ErrorLine error={addUser.error ?? removeUser.error} />
    </View>
  );
}

function TelegramSetup({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const status = useHooksRead(serverId, "bots.telegram.status.request", { botId: bot.id });
  const connect = useHooksMutation(serverId, "bots.telegram.connect.request");
  const linkCode = useHooksMutation(serverId, "bots.telegram.link_code.request");
  const removeUser = useHooksMutation(serverId, "bots.telegram.allowed.remove.request");
  const disconnect = useHooksMutation(serverId, "bots.telegram.disconnect.request");
  const [token, setToken] = useState("");
  const current = status.data?.status;
  const submit = useCallback(() => {
    const value = token.trim();
    if (!value) return;
    // The token never stays in the field once sent; the daemon keeps it.
    connect.mutate({ botId: bot.id, token: value }, { onSuccess: () => setToken("") });
  }, [bot.id, connect, token]);
  const link = useCallback(() => linkCode.mutate({ botId: bot.id }), [bot.id, linkCode]);
  const stop = useCallback(() => disconnect.mutate({ botId: bot.id }), [bot.id, disconnect]);
  const removeUserId = useCallback(
    (id: string) => removeUser.mutate({ botId: bot.id, userId: id }),
    [bot.id, removeUser],
  );
  if (!current) return <ErrorLine error={status.error} />;
  const code = linkCode.data;
  return (
    <View style={styles.body}>
      {!current.relayConnected ? (
        <Line tone="danger">
          {t("bots.jad.panels.connectors.relayOffline", { name: "Telegram" })}
        </Line>
      ) : null}
      {current.connected ? (
        <>
          <Line>
            {t("bots.jad.panels.connectors.telegram.connected", {
              username: current.botUsername ?? "",
            })}
          </Line>
          <Line tone="muted">
            {t("bots.jad.panels.connectors.telegram.groupsHint", {
              username: current.botUsername ?? "",
            })}
          </Line>
          <View style={styles.actions}>
            <Button size="sm" variant="outline" onPress={link} loading={linkCode.isPending}>
              {t("bots.jad.panels.connectors.telegram.linkAccount")}
            </Button>
          </View>
          {code ? (
            <Line>
              {t("bots.jad.panels.connectors.telegram.linkCode", {
                code: code.code,
                time: new Date(code.expiresAt_ms).toLocaleTimeString(),
              })}
            </Line>
          ) : null}
          <Text style={styles.subtitle}>{t("bots.jad.panels.connectors.telegram.allowed")}</Text>
          {current.allowedUsers.length === 0 ? (
            <Line tone="muted">{t("bots.jad.panels.connectors.telegram.noUsers")}</Line>
          ) : (
            <PeopleList people={current.allowedUsers} onRemove={removeUserId} />
          )}
          <View style={styles.actions}>
            <Button size="sm" variant="outline" onPress={stop} loading={disconnect.isPending}>
              {t("bots.jad.panels.connectors.telegram.disconnect")}
            </Button>
          </View>
        </>
      ) : (
        <>
          <Line tone="muted">{t("bots.jad.panels.connectors.telegram.steps")}</Line>
          <Input
            label={t("bots.jad.panels.connectors.telegram.token")}
            value={token}
            onChange={setToken}
            testID="bot-telegram-token"
          />
          <View style={styles.actions}>
            <Button
              size="sm"
              variant="outline"
              onPress={submit}
              disabled={!token.trim()}
              loading={connect.isPending}
              testID="bot-telegram-connect"
            >
              {t("bots.jad.panels.connectors.telegram.connect")}
            </Button>
          </View>
        </>
      )}
      <ErrorLine error={connect.error ?? linkCode.error ?? removeUser.error ?? disconnect.error} />
    </View>
  );
}

const TITLES: Record<BotConnectorId, string> = {
  slack: "Slack",
  github: "GitHub",
  gitlab: "GitLab",
  telegram: "Telegram",
};

export function BotConnectorSetupDialog({
  serverId,
  bot,
  connector,
  onClose,
}: {
  serverId: string;
  bot: Bot;
  connector: BotConnectorId | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const hooks = useBotsHooksSupported(serverId);
  const title = connector ? TITLES[connector] : "";
  const header = useMemo(() => ({ title }), [title]);
  let body: ReactNode = null;
  if (connector === "slack") body = <BotSlackSettings serverId={serverId} botId={bot.id} />;
  else if (connector && !hooks)
    body = <Line tone="muted">{t("bots.jad.panels.connectors.updateHost")}</Line>;
  else if (connector === "github") body = <GitHubSetup serverId={serverId} bot={bot} />;
  else if (connector === "gitlab") body = <GitLabSetup serverId={serverId} bot={bot} />;
  else if (connector === "telegram") body = <TelegramSetup serverId={serverId} bot={bot} />;
  return (
    <AdaptiveModalSheet
      header={header}
      visible={connector !== null}
      onClose={onClose}
      desktopMaxWidth={560}
      testID="bot-connector-setup"
    >
      {body}
      <View style={styles.actions}>
        <Button size="sm" variant="ghost" onPress={onClose}>
          {t("bots.jad.panels.connectors.close")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: 8 },
  line: { fontSize: 14, lineHeight: 20, color: theme.colors.foreground },
  muted: { fontSize: 13, color: theme.colors.foregroundMuted },
  danger: { color: theme.colors.statusDanger },
  subtitle: { fontSize: 14, fontWeight: "600", color: theme.colors.foreground, paddingTop: 8 },
  actions: { flexDirection: "row", gap: 8, justifyContent: "flex-end" },
  manual: {
    gap: 6,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  fact: { gap: 2 },
  factLabel: { fontSize: 12, color: theme.colors.foregroundMuted },
  factValue: { fontSize: 13, fontFamily: theme.fontFamily.mono, color: theme.colors.foreground },
  row: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 14, color: theme.colors.foreground },
  personName: { flex: 1, minWidth: 0, fontSize: 14, color: theme.colors.foreground },
  textButton: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
}));
