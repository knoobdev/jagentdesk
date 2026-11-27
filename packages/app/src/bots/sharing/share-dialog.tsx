// Share bot… (spec 37.13.1): the parts to share, the safety check, then Publish link / Copy link /
// Update link / Stop sharing. A port of Orca dfdb4fda src/renderer/src/components/bots/sharing/
// BotShareDialog.tsx, BotShareOverview.tsx, BotShareLists.tsx, BotShareFlagPages.tsx and
// BotShareFooter.tsx (MIT) onto JAgentDesk's sheet and form kit. Self-contained: open it from Settings
// › Sharing or the Home panel's More menu with a bot.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { useQueryClient } from "@tanstack/react-query";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type {
  BotShareCandidate,
  BotShareFlag,
  BotSharePartFile,
  BotShareSelection,
  BotShareStatus,
} from "@jagentdesk/protocol/bots/share-schemas";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { botsKey, useBotsConnection } from "../queries";
import { Input } from "../ui";
import { styles } from "../styles";
import {
  canPublish,
  checkSummary,
  flagLabel,
  flagPart,
  flagWhere,
  leftOutWhy,
  partValue,
  pickedOf,
  selectionWith,
  shareErrorCopy,
  toggled,
} from "./share-model";
import { useBotShareStatus } from "./share-queries";

type Page =
  | { kind: "overview" }
  | { kind: "skills" }
  | { kind: "automations" }
  | { kind: "memory" }
  | { kind: "note" }
  | { kind: "check" }
  | { kind: "notIncluded" }
  | { kind: "part"; part: string; line?: number };

const OVERVIEW: Page = { kind: "overview" };
const SKILLS: Page = { kind: "skills" };
const AUTOMATIONS: Page = { kind: "automations" };
const MEMORY: Page = { kind: "memory" };
const NOTE: Page = { kind: "note" };
const CHECK: Page = { kind: "check" };
const NOT_INCLUDED: Page = { kind: "notIncluded" };
const SOUL: Page = { kind: "part", part: "soul" };

type Phase = "idle" | "busy" | "confirmStop" | "stopping";
type Open = (page: Page) => void;
type Select = (patch: Partial<BotShareSelection>) => void;

function PartRow({
  title,
  value,
  danger,
  children,
  page,
  open,
  testID,
}: {
  title: string;
  value?: string;
  danger?: boolean;
  /** A control on the row (the memory switch); it acts on its own. */
  children?: ReactNode;
  page?: Page | null;
  open: Open;
  testID?: string;
}) {
  const press = useCallback(
    function press() {
      if (page) open(page);
    },
    [page, open],
  );
  return (
    <Pressable
      accessibilityRole={page ? "button" : undefined}
      onPress={press}
      disabled={!page}
      style={[styles.between, styles.navRow]}
      testID={testID}
    >
      <Text style={styles.text}>{title}</Text>
      <View style={styles.row}>
        {value ? (
          <Text style={danger ? styles.warning : styles.muted} numberOfLines={1}>
            {value}
          </Text>
        ) : null}
        {children}
      </View>
    </Pressable>
  );
}

function TickRow({
  name,
  title,
  detail,
  value,
  onToggle,
  testID,
}: {
  name: string;
  title: string;
  detail?: string;
  value: boolean;
  onToggle: (name: string, on: boolean) => void;
  testID?: string;
}) {
  const change = useCallback((on: boolean) => onToggle(name, on), [name, onToggle]);
  return (
    <View style={[styles.between, styles.navRow]}>
      <View style={styles.column}>
        <Text style={styles.text}>{title}</Text>
        {detail ? <Text style={styles.muted}>{detail}</Text> : null}
      </View>
      <Switch value={value} onValueChange={change} accessibilityLabel={title} testID={testID} />
    </View>
  );
}

interface ShareRequests {
  enabled: boolean;
  prepare: (
    botId: string,
    selection: BotShareSelection,
    last: boolean,
  ) => Promise<{ candidate: BotShareCandidate; last?: BotShareSelection }>;
  view: (botId: string, previewId: string, part: string) => Promise<BotSharePartFile[]>;
  publish: (botId: string, previewId: string) => Promise<BotShareStatus>;
  stop: (botId: string) => Promise<BotShareStatus>;
}

function useShareRequests(serverId: string): ShareRequests {
  const { client, enabled } = useBotsConnection(serverId);
  return useMemo(() => {
    const live = () => {
      if (!client) throw new Error("offline");
      return client;
    };
    return {
      enabled,
      prepare: (botId, selection, last) =>
        live().botsRequest("bots.share.prepare.request", { botId, selection, last }),
      view: async (botId, previewId, part) =>
        (await live().botsRequest("bots.share.view.request", { botId, previewId, part })).files,
      publish: async (botId, previewId) =>
        (await live().botsRequest("bots.share.publish.request", { botId, previewId })).status,
      stop: async (botId) =>
        (await live().botsRequest("bots.share.stop.request", { botId })).status,
    };
  }, [client, enabled]);
}

/** One part's exact text as the link carries it, its flagged lines marked; `line` is highlighted. */
function PartView({
  requests,
  botId,
  previewId,
  part,
  line,
}: {
  requests: ShareRequests;
  botId: string;
  previewId: string;
  part: string;
  line?: number;
}) {
  const { t } = useTranslation();
  const [files, setFiles] = useState<BotSharePartFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const value = await requests.view(botId, previewId, part);
        if (live) setFiles(value);
      } catch (err) {
        if (live) setError(shareErrorCopy(err, t));
      }
    }
    void load();
    return () => {
      live = false;
    };
  }, [requests, botId, previewId, part, t]);
  if (error) return <Alert variant="error" title={error} />;
  if (!files) return <Text style={styles.muted}>{t("bots.jad.loading")}</Text>;
  return (
    <View style={styles.column}>
      {files.map((file) => {
        const lines = (file.text ?? "").split("\n").map((text, index) => ({
          number: index + 1,
          text,
          flag: file.flags.find((entry) => entry.line === index + 1),
        }));
        return (
          <View key={file.path} style={styles.card}>
            <Text style={styles.title}>{file.path}</Text>
            {lines.map((entry) => (
              <Text
                key={entry.number}
                selectable
                style={[styles.mono, (entry.flag || line === entry.number) && styles.selected]}
                testID={line === entry.number ? "bot-share-line" : undefined}
              >
                {`${entry.number}  ${entry.text}`}
                {entry.flag
                  ? `   ${t("bots.share.flagOnLine", { flag: flagLabel(entry.flag.kind, t), line: entry.number })}`
                  : ""}
              </Text>
            ))}
          </View>
        );
      })}
    </View>
  );
}

function MemorySwitch({
  candidate,
  on,
  onSelect,
  open,
}: {
  candidate: BotShareCandidate;
  on: boolean;
  onSelect: Select;
  open: Open;
}) {
  const { t } = useTranslation();
  const change = useCallback(
    function change(next: boolean) {
      // On sends every file; the list that opens is for leaving some out.
      onSelect({ memory: next ? candidate.available.memory.map((m) => m.topic) : undefined });
      if (next) open(MEMORY);
    },
    [candidate, onSelect, open],
  );
  return (
    <Switch
      value={on}
      disabled={candidate.available.memory.length === 0}
      accessibilityLabel={t("bots.share.includeMemory")}
      onValueChange={change}
      testID="bot-share-memory-switch"
    />
  );
}

function Overview({
  candidate,
  selection,
  note,
  onSelect,
  open,
}: {
  candidate: BotShareCandidate;
  selection: BotShareSelection;
  note: string;
  onSelect: Select;
  open: Open;
}) {
  const { t } = useTranslation();
  const { available, flags } = candidate;
  const skills = pickedOf(
    selection.skills,
    available.skills.map((skill) => skill.name),
  );
  const schedules = available.schedules.filter(
    (entry) => pickedOf(selection.schedules, [entry.scheduleId]).length > 0,
  );
  const skillsLeftOut = candidate.leftOut.filter((entry) => entry.kind === "skill").length;
  const memoryOn = selection.memory !== undefined;
  const secrets = flags.filter((flag) => flag.kind === "secret").length;
  const lines =
    available.soulLines === 1
      ? t("bots.share.oneLine")
      : t("bots.share.lines", { count: available.soulLines });
  const words = note.trim().split(/\s+/).filter(Boolean);
  const noteValue =
    words.length === 0
      ? t("bots.share.add")
      : `${words.slice(0, 5).join(" ")}${words.length > 5 ? "…" : ""}`;
  const memoryValue = memoryOn
    ? t("bots.share.countOf", {
        picked: selection.memory?.length ?? 0,
        all: available.memory.length,
      })
    : t("bots.share.memoryLimit", { count: available.memory.length });
  return (
    <View style={styles.column}>
      <View style={styles.card}>
        <PartRow
          title={t("bots.share.soul")}
          value={lines}
          page={SOUL}
          open={open}
          testID="bot-share-soul"
        />
        <PartRow
          title={t("bots.share.skills")}
          value={partValue(skills, available.skills.length, t)}
          page={available.skills.length + skillsLeftOut > 0 ? SKILLS : null}
          open={open}
          testID="bot-share-skills"
        />
        <PartRow
          title={t("bots.share.automations")}
          value={partValue(
            schedules.map((entry) => entry.name),
            available.schedules.length,
            t,
          )}
          page={available.schedules.length > 0 ? AUTOMATIONS : null}
          open={open}
          testID="bot-share-automations"
        />
        <PartRow
          title={t("bots.share.includeMemory")}
          value={memoryValue}
          danger={flags.some((flag) => flag.kind === "secret" && flag.where.startsWith("memory/"))}
          page={memoryOn ? MEMORY : null}
          open={open}
          testID="bot-share-memory"
        >
          <MemorySwitch candidate={candidate} on={memoryOn} onSelect={onSelect} open={open} />
        </PartRow>
        {candidate.notIncluded.length > 0 ? (
          <PartRow
            title={t("bots.share.notIncluded")}
            value={String(candidate.notIncluded.length)}
            page={NOT_INCLUDED}
            open={open}
          />
        ) : null}
      </View>
      <View style={styles.card}>
        <PartRow
          title={t("bots.share.setupNote")}
          value={noteValue}
          page={NOTE}
          open={open}
          testID="bot-share-note"
        />
        <PartRow
          title={t("bots.share.safetyCheck")}
          value={checkSummary(flags, t)}
          danger={secrets > 0}
          page={flags.length > 0 ? CHECK : null}
          open={open}
          testID="bot-share-check"
        />
      </View>
    </View>
  );
}

function FlagRow({ flag, open }: { flag: BotShareFlag; open: Open }) {
  const { t } = useTranslation();
  const goToLine = useCallback(
    function goToLine() {
      open({ kind: "part", part: flagPart(flag), line: flag.line ?? undefined });
    },
    [flag, open],
  );
  return (
    <View style={styles.between}>
      <View style={styles.column}>
        <Text style={flag.kind === "secret" ? styles.warning : styles.text}>
          {flagLabel(flag.kind, t)}
        </Text>
        <Text style={styles.muted}>{flagWhere(flag, t)}</Text>
      </View>
      <Button size="sm" variant="outline" onPress={goToLine} testID="bot-share-go-to-line">
        {t("bots.share.goToLine")}
      </Button>
    </View>
  );
}

function Lists({
  page,
  candidate,
  selection,
  note,
  onSelect,
  onNote,
  open,
}: {
  page: Page;
  candidate: BotShareCandidate;
  selection: BotShareSelection;
  note: string;
  onSelect: Select;
  onNote: (note: string) => void;
  open: Open;
}) {
  const { t } = useTranslation();
  const { available } = candidate;
  const skillNames = useMemo(() => available.skills.map((skill) => skill.name), [available]);
  const scheduleIds = useMemo(
    () => available.schedules.map((entry) => entry.scheduleId),
    [available],
  );
  const topics = useMemo(() => available.memory.map((entry) => entry.topic), [available]);
  const toggleSkill = useCallback(
    (name: string, on: boolean) =>
      onSelect({ skills: toggled(selection.skills, skillNames, name, on) }),
    [onSelect, selection.skills, skillNames],
  );
  const toggleSchedule = useCallback(
    (id: string, on: boolean) =>
      onSelect({ schedules: toggled(selection.schedules, scheduleIds, id, on) }),
    [onSelect, selection.schedules, scheduleIds],
  );
  const toggleMemory = useCallback(
    (topic: string, on: boolean) =>
      onSelect({ memory: toggled(selection.memory ?? [], topics, topic, on) ?? topics }),
    [onSelect, selection.memory, topics],
  );
  if (page.kind === "skills") {
    const picked = pickedOf(selection.skills, skillNames);
    return (
      <View style={styles.card}>
        {available.skills.map((skill) => (
          <TickRow
            key={skill.name}
            name={skill.name}
            title={skill.name}
            detail={skill.description}
            value={picked.includes(skill.name)}
            onToggle={toggleSkill}
            testID={`bot-share-skill-${skill.name}`}
          />
        ))}
        {candidate.leftOut
          .filter((entry) => entry.kind === "skill")
          .map((entry) => (
            <PartRow
              key={`left:${entry.name}`}
              title={entry.name}
              value={leftOutWhy(entry, t)}
              open={open}
            />
          ))}
      </View>
    );
  }
  if (page.kind === "automations") {
    const picked = pickedOf(selection.schedules, scheduleIds);
    return (
      <View style={styles.card}>
        {available.schedules.map((entry) => (
          <TickRow
            key={entry.scheduleId}
            name={entry.scheduleId}
            title={entry.name}
            detail={entry.cron}
            value={picked.includes(entry.scheduleId)}
            onToggle={toggleSchedule}
          />
        ))}
      </View>
    );
  }
  if (page.kind === "memory") {
    const picked = pickedOf(selection.memory ?? [], topics);
    return (
      <View style={styles.card}>
        <Text style={styles.muted}>{t("bots.share.memoryLimit", { count: topics.length })}</Text>
        {available.memory.map((entry) => (
          <TickRow
            key={entry.topic}
            name={entry.topic}
            title={`${entry.topic}.md`}
            detail={
              entry.lines === 1
                ? t("bots.share.oneLine")
                : t("bots.share.lines", { count: entry.lines })
            }
            value={picked.includes(entry.topic)}
            onToggle={toggleMemory}
          />
        ))}
        {candidate.leftOut
          .filter((entry) => entry.kind === "memory")
          .map((entry) => (
            <PartRow
              key={`left:${entry.name}`}
              title={entry.name}
              value={leftOutWhy(entry, t)}
              open={open}
            />
          ))}
      </View>
    );
  }
  if (page.kind === "note")
    return (
      <Input
        label={t("bots.share.setupNote")}
        value={note}
        onChange={onNote}
        multiline
        testID="bot-share-note-input"
      />
    );
  if (page.kind === "notIncluded")
    return (
      <View style={styles.card}>
        {candidate.notIncluded.map((entry) => (
          <Text key={entry} style={styles.text}>
            {entry}
          </Text>
        ))}
      </View>
    );
  if (page.kind === "check")
    return (
      <View style={styles.card}>
        {candidate.flags.map((flag) => (
          <FlagRow key={`${flag.where}:${flag.line}:${flag.kind}`} flag={flag} open={open} />
        ))}
      </View>
    );
  return null;
}

function publishLabel(phase: Phase, secret: boolean, t: (key: string) => string): string {
  if (secret) return t("bots.share.removeSecret");
  return phase === "busy" ? t("bots.share.publishing") : t("bots.share.publishLink");
}

function SharedLink({
  bot,
  status,
  upToDate,
}: {
  bot: Bot;
  status: BotShareStatus;
  upToDate: boolean;
}) {
  const { t } = useTranslation();
  const updated = status.updatedAt_ms
    ? ` · ${t("bots.share.updatedAt", { date: new Date(status.updatedAt_ms).toLocaleString() })}`
    : "";
  return (
    <View style={styles.card}>
      <Text style={styles.text}>{t("bots.share.isShared", { name: bot.name })}</Text>
      <Text style={styles.muted}>
        {upToDate ? t("bots.share.upToDate") : t("bots.share.changedSince")}
        {updated}
      </Text>
      <Text selectable style={styles.mono} testID="bot-share-link">
        {status.link}
      </Text>
      <Text style={styles.muted}>{t("bots.share.sameLink")}</Text>
    </View>
  );
}

function ShareFooter({
  bot,
  status,
  phase,
  candidate,
  building,
  copied,
  onPublish,
  onStop,
  onConfirmStop,
  onCancelStop,
  onCopy,
  onClose,
}: {
  bot: Bot;
  status: BotShareStatus | undefined;
  phase: Phase;
  candidate: BotShareCandidate | null;
  building: boolean;
  copied: boolean;
  onPublish: () => void;
  onStop: () => void;
  onConfirmStop: () => void;
  onCancelStop: () => void;
  onCopy: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const link = status?.link;
  const relayOff = status ? !status.relayConnected : false;
  const secret = candidate?.blocked ?? false;
  const upToDate = Boolean(link) && status?.changedSince === false;
  const disabled = !canPublish(candidate) || building || phase === "busy";
  let hint: ReactNode = null;
  if (secret) hint = <Text style={styles.warning}>{t("bots.share.removeSecret")}</Text>;
  else if (!link) hint = <Text style={styles.muted}>{t("bots.share.description")}</Text>;

  if (phase === "confirmStop" || phase === "stopping")
    return (
      <View style={styles.column}>
        <Text style={styles.text}>{t("bots.share.stopTitle", { name: bot.name })}</Text>
        <Text style={styles.muted}>{t("bots.share.stopDescription")}</Text>
        <View style={styles.row}>
          <Button variant="outline" onPress={onCancelStop} disabled={phase === "stopping"}>
            {t("bots.share.cancel")}
          </Button>
          <Button
            variant="destructive"
            onPress={onStop}
            loading={phase === "stopping"}
            disabled={phase === "stopping"}
            testID="bot-share-stop-confirm"
          >
            {t("bots.share.stopSharing")}
          </Button>
        </View>
      </View>
    );
  if (relayOff && !link)
    return <Alert title={t("bots.share.relayOff")} testID="bot-share-relay-off" />;
  if (link && status)
    return (
      <View style={styles.column}>
        {hint}
        <SharedLink bot={bot} status={status} upToDate={upToDate} />
        <View style={styles.row}>
          <Button variant="ghost" onPress={onConfirmStop} testID="bot-share-stop">
            {t("bots.share.stopSharing")}
          </Button>
          <Button variant="outline" onPress={onCopy} testID="bot-share-copy">
            {copied ? t("bots.share.linkCopied") : t("bots.share.copyLink")}
          </Button>
          <Button
            onPress={onPublish}
            loading={phase === "busy"}
            disabled={disabled || upToDate}
            testID="bot-share-update"
          >
            {phase === "busy" ? t("bots.share.updating") : t("bots.share.updateLink")}
          </Button>
        </View>
      </View>
    );
  return (
    <View style={styles.column}>
      {hint}
      <View style={styles.row}>
        <Button variant="outline" onPress={onClose}>
          {t("bots.share.cancel")}
        </Button>
        <Button
          onPress={onPublish}
          loading={phase === "busy"}
          disabled={disabled}
          testID="bot-share-publish"
        >
          {publishLabel(phase, secret, t)}
        </Button>
      </View>
    </View>
  );
}

export function BotShareDialog({
  serverId,
  bot,
  onClose,
}: {
  serverId: string;
  bot: Bot;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const status = useBotShareStatus(serverId, bot.id);
  const requests = useShareRequests(serverId);
  const [selection, setSelection] = useState<BotShareSelection>({});
  const [note, setNote] = useState("");
  const [page, setPage] = useState<Page>(OVERVIEW);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [candidate, setCandidate] = useState<BotShareCandidate | null>(null);
  const [building, setBuilding] = useState(false);
  const first = useRef(true);
  const link = status.data?.link;
  const header = useMemo(() => ({ title: bot.name }), [bot.name]);

  // Each change of picks or note builds the candidate again; the first build starts from the picks
  // the link was last published with.
  useEffect(() => {
    if (!requests.enabled) return;
    let live = true;
    const last = first.current;
    first.current = false;
    setBuilding(true);
    async function build() {
      try {
        const result = await requests.prepare(
          bot.id,
          selectionWith(selection, { setupNote: note || undefined }),
          last,
        );
        if (!live) return;
        setCandidate(result.candidate);
        if (result.last) {
          setSelection(selectionWith({}, { ...result.last, setupNote: undefined }));
          setNote(result.last.setupNote ?? "");
        }
        setError(null);
      } catch (err) {
        if (live) setError(shareErrorCopy(err, t));
      } finally {
        if (live) setBuilding(false);
      }
    }
    const timer = setTimeout(() => void build(), 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [requests, bot.id, selection, note, t]);

  const refreshStatus = useCallback(
    () => queryClient.invalidateQueries({ queryKey: [...botsKey(serverId), "share", bot.id] }),
    [queryClient, serverId, bot.id],
  );
  const onSelect = useCallback<Select>(
    (patch) => setSelection((current) => selectionWith(current, patch)),
    [],
  );
  const toOverview = useCallback(() => setPage(OVERVIEW), []);
  const publish = useCallback(
    async function publish() {
      if (!candidate) return;
      setPhase("busy");
      setError(null);
      try {
        await requests.publish(bot.id, candidate.previewId);
        await refreshStatus();
      } catch (err) {
        setError(shareErrorCopy(err, t));
      } finally {
        setPhase("idle");
      }
    },
    [candidate, requests, bot.id, refreshStatus, t],
  );
  const stop = useCallback(
    async function stop() {
      setPhase("stopping");
      setError(null);
      try {
        await requests.stop(bot.id);
        await refreshStatus();
        setPhase("idle");
      } catch (err) {
        setError(shareErrorCopy(err, t));
        setPhase("confirmStop");
      }
    },
    [requests, bot.id, refreshStatus, t],
  );
  const confirmStop = useCallback(() => setPhase("confirmStop"), []);
  const cancelStop = useCallback(() => setPhase("idle"), []);
  const copyLink = useCallback(
    async function copyLink() {
      if (!link) return;
      await Clipboard.setStringAsync(link);
      setCopied(true);
    },
    [link],
  );

  let body: ReactNode;
  if (!candidate) body = <Text style={styles.muted}>{t("bots.jad.loading")}</Text>;
  else if (page.kind === "overview")
    body = (
      <Overview
        candidate={candidate}
        selection={selection}
        note={note}
        onSelect={onSelect}
        open={setPage}
      />
    );
  else if (page.kind === "part")
    body = (
      <PartView
        requests={requests}
        botId={bot.id}
        previewId={candidate.previewId}
        part={page.part}
        line={page.line}
      />
    );
  else
    body = (
      <Lists
        page={page}
        candidate={candidate}
        selection={selection}
        note={note}
        onSelect={onSelect}
        onNote={setNote}
        open={setPage}
      />
    );

  const footer = (
    <ShareFooter
      bot={bot}
      status={status.data}
      phase={phase}
      candidate={candidate}
      building={building}
      copied={copied}
      onPublish={publish}
      onStop={stop}
      onConfirmStop={confirmStop}
      onCancelStop={cancelStop}
      onCopy={copyLink}
      onClose={onClose}
    />
  );

  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      onDismiss={onClose}
      header={header}
      testID="bot-share-dialog"
    >
      <ScrollView>
        <View style={styles.body}>
          {page.kind === "overview" ? null : (
            <Button size="sm" variant="ghost" onPress={toOverview}>
              {t("bots.share.receive.back")}
            </Button>
          )}
          {error ? <Alert variant="error" title={error} testID="bot-share-error" /> : null}
          {body}
          {footer}
        </View>
      </ScrollView>
    </AdaptiveModalSheet>
  );
}
