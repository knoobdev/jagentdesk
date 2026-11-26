import { useCallback } from "react";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ExplorerFile } from "@/stores/session-store";
import { explorerFileFromReadResult } from "@/file-explorer/read-result";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import { useFetchQuery } from "@/data/query";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { Alert } from "@/components/ui/alert";
import { useBotsConnection, useBotAgent, botsKey } from "./queries";
import { styles } from "./styles";
import { QueryNotice, ErrorNotice } from "./ui";
import { TabHint } from "./help";
interface HomeMarkdownFile extends ExplorerFile {
  content: string;
}
function MarkdownEditor({
  serverId,
  cwd,
  path,
  file,
}: {
  serverId: string;
  cwd: string;
  path: string;
  file: HomeMarkdownFile;
}) {
  const { t } = useTranslation();
  const { client, enabled } = useBotsConnection(serverId);
  const queryClient = useQueryClient();
  const [text, setText] = useState(file.content);
  const [conflict, setConflict] = useState(false);
  const [version, setVersion] = useState({ modifiedAt: file.modifiedAt, revision: file.revision });
  const mutation = useMutation({
    mutationFn: async () => {
      if (!client || !enabled) throw new Error(t("bots.offline"));
      const result = await client.writeFile({
        cwd,
        path,
        content: file.hasBom ? "\uFEFF" + text : text,
        expectedModifiedAt: version.modifiedAt,
        expectedRevision: version.revision,
      });
      if (result.status === "error") throw new Error(result.error);
      if (result.status === "conflict") {
        setConflict(true);
        throw new Error(t("bots.conflict"));
      }
      setVersion({ modifiedAt: result.modifiedAt, revision: result.revision });
      return result;
    },
  });
  const save = useCallback(
    function save() {
      mutation.mutate();
    },
    [mutation],
  );
  const reload = useCallback(
    function reload() {
      void queryClient.invalidateQueries({
        queryKey: [...botsKey(serverId), "home-file", cwd, path],
      });
    },
    [queryClient, serverId, cwd, path],
  );
  return (
    <View style={styles.column}>
      <FormTextInput
        value={text}
        initialValue={file.content}
        webControlled
        onChangeText={setText}
        multiline
        style={styles.editor}
        accessibilityLabel={path}
        testID="bot-home-editor"
      />
      {conflict ? <Alert title={t("bots.conflict")} /> : null}
      <ErrorNotice error={mutation.error} />
      <View style={styles.row}>
        <Button
          onPress={save}
          disabled={!enabled || mutation.isPending || conflict}
          loading={mutation.isPending}
        >
          {t("bots.save")}
        </Button>
        <Button variant="outline" onPress={reload}>
          {t("bots.reload")}
        </Button>
        {mutation.isSuccess ? <Text style={styles.muted}>{t("bots.saved")}</Text> : null}
      </View>
    </View>
  );
}
function HomeFile({ serverId, cwd, path }: { serverId: string; cwd: string; path: string }) {
  const { t } = useTranslation();
  const { client, enabled } = useBotsConnection(serverId);
  const query = useFetchQuery({
    queryKey: [...botsKey(serverId), "home-file", cwd, path],
    enabled,
    staleTimeMs: 1000,
    dataShape: "value",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () => {
      if (!client) throw new Error(t("bots.offline"));
      const file = explorerFileFromReadResult(
        await client.readFile(cwd, path, undefined, 1024 * 1024),
      );
      if (file.content === undefined) throw new Error(t("bots.textFileRequired"));
      return { ...file, content: file.content };
    },
  });
  return (
    <>
      <QueryNotice query={query} />
      {query.data ? (
        <MarkdownEditor
          key={`${path}:${query.dataUpdatedAt}`}
          serverId={serverId}
          cwd={cwd}
          path={path}
          file={query.data}
        />
      ) : null}
    </>
  );
}
export function HomeFiles({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const agent = useBotAgent(serverId, bot.agentId);
  const [path, setPath] = useState("SOUL.md");
  const openSoul = useCallback(
    function openSoul() {
      setPath("SOUL.md");
    },
    [setPath],
  );
  const openMemory = useCallback(
    function openMemory() {
      setPath("MEMORY.md");
    },
    [setPath],
  );
  const intro = <TabHint i18nKey="bots.help.soulMemory" bot={bot} testID="bot-soul-memory-hint" />;
  if (!bot.agentId)
    return (
      <View style={styles.body}>
        {intro}
        <Text style={styles.muted}>{t("bots.initializeHome")}</Text>
      </View>
    );
  return (
    <ScrollView contentContainerStyle={styles.body}>
      {intro}
      <View style={styles.row}>
        <Button variant={path === "SOUL.md" ? "default" : "outline"} onPress={openSoul}>
          {t("bots.soul")}
        </Button>
        <Button variant={path === "MEMORY.md" ? "default" : "outline"} onPress={openMemory}>
          {t("bots.memory")}
        </Button>
      </View>
      <QueryNotice query={agent} />
      {agent.data ? (
        <HomeFile key={path} serverId={serverId} cwd={agent.data.agent.cwd} path={path} />
      ) : null}
    </ScrollView>
  );
}
