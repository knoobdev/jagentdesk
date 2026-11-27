// SOUL.md (spec 37.4.9): a Read preview by default, Edit saves on blur and on Read; a write made
// from a stale read, or a `bots.home_file_changed` push under an unsaved edit, shows
// "SOUL.md changed on disk." with "Keep mine" (overwrite) and "Use theirs" (drop the edit).
// Ported from Orca dfdb4fda (MIT) src/renderer/src/components/settings/bots/BotSoulEditor.tsx:1-270
// and BotFileChangedNotice.tsx:1-28.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View, type TextInput } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useOptionalToast } from "@/contexts/toast-api-context";
import { botHomeFileKey, useBotHomeFileStore } from "@/bots/home-file-store";
import { botErrorCode, botErrorMessage, useBotsMutation, useBotsRead } from "@/bots/queries";
import { soulStats } from "./row-states";

const SOUL_FILE = "SOUL.md";
const DOUBLE_PRESS_MS = 350;

type Mode = "read" | "edit";
interface Base {
  content: string;
  hash: string;
}

export function BotSoulEditor({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const toast = useOptionalToast();
  const read = useBotsRead(serverId, "bots.home_file.read.request", {
    botId: bot.id,
    file: SOUL_FILE,
  });
  const write = useBotsMutation(serverId, "bots.home_file.write.request");
  const diskHash = useBotHomeFileStore(
    (state) => state.diskHashes[botHomeFileKey(bot.id, SOUL_FILE)],
  );
  // `base` is the disk text the draft started from; disk moving away from it is someone else's write.
  const [base, setBase] = useState<Base | null>(null);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<Mode | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const input = useRef<TextInput>(null);
  const dirty = base !== null && draft !== base.content;
  const { refetch } = read;

  // First read, and any later read while the owner has nothing unsaved, become the base.
  useEffect(() => {
    const disk = read.data;
    if (!disk) return;
    if (base === null) {
      setBase(disk);
      setDraft(disk.content);
      setMode((current) => current ?? (disk.content.trim() ? "read" : "edit"));
      return;
    }
    if (disk.hash !== base.hash && !dirty && !saving) {
      setBase(disk);
      setDraft(disk.content);
    }
  }, [base, dirty, read.data, saving]);

  // Someone else wrote the file: follow it, or flag it under an unsaved edit.
  useEffect(() => {
    if (!diskHash || !base || saving || diskHash === base.hash) return;
    if (dirty) setConflict(true);
    else void refetch();
  }, [base, diskHash, dirty, refetch, saving]);

  const save = useCallback(
    async (content: string, baseHash: string | undefined) => {
      setSaving(true);
      try {
        const result = await write.mutateAsync({
          botId: bot.id,
          file: SOUL_FILE,
          content,
          ...(baseHash ? { baseHash } : {}),
        });
        setBase(result);
        setConflict(false);
      } catch (error) {
        if (botErrorCode(error) === "file_changed") setConflict(true);
        else toast?.error(botErrorMessage(error));
      } finally {
        setSaving(false);
      }
    },
    [bot.id, toast, write],
  );
  const refresh = useCallback(() => void refetch(), [refetch]);
  const saveDraft = useCallback(() => {
    if (base && dirty && !conflict && !saving) void save(draft, base.hash);
  }, [base, conflict, dirty, draft, save, saving]);
  const keepMine = useCallback(() => void save(draft, undefined), [draft, save]);
  const takeTheirs = useCallback(async () => {
    const result = await refetch();
    if (!result.data) return;
    setBase(result.data);
    setDraft(result.data.content);
    setConflict(false);
  }, [refetch]);

  const effectiveMode: Mode = conflict ? "edit" : (mode ?? "read");
  const enterEdit = useCallback(() => {
    setMode("edit");
    requestAnimationFrame(() => input.current?.focus());
  }, []);
  const enterRead = useCallback(() => {
    saveDraft();
    setMode("read");
  }, [saveDraft]);
  const selectMode = useCallback(
    (next: Mode) => (next === "edit" ? enterEdit() : enterRead()),
    [enterEdit, enterRead],
  );
  const lastPress = useRef(0);
  const pressPreview = useCallback(() => {
    const now = Date.now();
    if (now - lastPress.current < DOUBLE_PRESS_MS) enterEdit();
    lastPress.current = now;
  }, [enterEdit]);

  const modeOptions = useMemo(
    () => [
      { value: "read" as const, label: t("bots.settingsBots.soulRead"), disabled: conflict },
      { value: "edit" as const, label: t("bots.settingsBots.soulEdit") },
    ],
    [conflict, t],
  );
  const stats = soulStats(draft);
  let status = t("bots.settingsBots.saved");
  if (saving) status = t("bots.settingsBots.saving");
  else if (dirty) status = t("bots.settingsBots.unsaved");

  if (read.isError && base === null) {
    return <Text style={styles.muted}>{botErrorMessage(read.error)}</Text>;
  }
  if (base === null) {
    return <Text style={styles.muted}>{t("bots.settingsView.reading", { file: SOUL_FILE })}</Text>;
  }
  return (
    <View style={styles.wrap} testID="bot-soul-editor">
      {conflict ? (
        <View style={styles.notice} accessibilityRole="alert" testID="bot-soul-conflict">
          <Text style={styles.noticeText}>
            {t("bots.settingsBots.fileChangedOnDisk", { file: SOUL_FILE })}
          </Text>
          <Button
            size="xs"
            variant="outline"
            disabled={saving}
            onPress={takeTheirs}
            testID="bot-soul-use-theirs"
          >
            {t("bots.settingsBots.useTheirs")}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={saving}
            onPress={keepMine}
            testID="bot-soul-keep-mine"
          >
            {t("bots.settingsBots.keepMine")}
          </Button>
        </View>
      ) : null}
      <View style={[styles.card, effectiveMode === "edit" && styles.cardEdit]}>
        <View style={styles.head}>
          <View style={styles.headTitle}>
            <Text style={styles.fileName}>{SOUL_FILE}</Text>
            <Text style={styles.status} testID="bot-soul-status">
              {status}
            </Text>
          </View>
          <SegmentedControl
            size="xs"
            options={modeOptions}
            value={effectiveMode}
            onValueChange={selectMode}
            testID="bot-soul-mode"
          />
        </View>
        {effectiveMode === "read" ? (
          <Pressable
            style={styles.body}
            onPress={pressPreview}
            accessibilityHint={t("bots.settingsBots.soulDoubleClickHint")}
            testID="bot-soul-preview"
          >
            {draft.trim() ? (
              <MarkdownRenderer text={draft} />
            ) : (
              <Text style={styles.muted}>{t("bots.settingsBots.soulEmpty")}</Text>
            )}
          </Pressable>
        ) : (
          <View style={styles.body}>
            <FormTextInput
              ref={input}
              value={draft}
              initialValue={base.content}
              webControlled
              multiline
              onChangeText={setDraft}
              onBlur={saveDraft}
              onFocus={refresh}
              accessibilityLabel={t("bots.settingsBots.soul")}
              style={styles.input}
              testID="bot-soul-input"
            />
          </View>
        )}
        <View style={styles.foot}>
          <Text style={styles.stat}>
            {t("bots.settingsBots.soulStats", { lines: stats.lines, words: stats.words })}
          </Text>
          {effectiveMode === "read" ? (
            <Text style={styles.stat}>{t("bots.settingsBots.soulDoubleClickHint")}</Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: { gap: 10, flex: 1, minHeight: 0 },
  notice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.statusWarningBackground,
  },
  noticeText: {
    flex: 1,
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusWarning,
  },
  card: {
    minHeight: 360,
    flex: 1,
    overflow: "hidden",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  cardEdit: { backgroundColor: theme.colors.surface0 },
  head: {
    height: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headTitle: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], minWidth: 0 },
  fileName: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  status: { fontSize: 11, color: theme.colors.foregroundMuted },
  body: { flex: 1, minHeight: 0, paddingHorizontal: theme.spacing[4], paddingVertical: 14 },
  input: { flex: 1, minHeight: 240 },
  foot: {
    height: 32,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  stat: { fontSize: 11, color: theme.colors.foregroundMuted },
  muted: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
}));
