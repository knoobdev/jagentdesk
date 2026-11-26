import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { MemoryCitationWire, MemoryRecordWire } from "@jagentdesk/protocol/memory";
import {
  Button,
  useHostRuntimeClient,
  useToast,
  type Theme,
} from "../../../packages/app/src/plugins/builtin/host-api";
import { CitationSheet } from "./citation-sheet";
import { GraduationSheet } from "./graduation-sheet";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function CitationLink({
  citation,
  onOpen,
}: {
  citation: MemoryCitationWire;
  onOpen: (citation: MemoryCitationWire) => void;
}) {
  const open = useCallback(() => onOpen(citation), [citation, onOpen]);
  return (
    <Pressable onPress={open} accessibilityRole="link" testID="memory-row-citation">
      <Text style={[styles.citation, styles.link]} numberOfLines={1}>
        {citation.symbol ? `${citation.path} · ${citation.symbol}` : citation.path}
      </Text>
    </Pressable>
  );
}

function StatusLine({ memory }: { memory: MemoryRecordWire }) {
  const { t } = useTranslation();
  const kind = memory.kind ?? "memory";
  const status = memory.status ?? "active";
  const helpful = memory.helpful ?? 0;
  const harmful = memory.harmful ?? 0;
  const showCounts = kind === "lesson" || helpful > 0 || harmful > 0;
  return (
    <>
      <View style={styles.line}>
        {kind === "lesson" ? <Text style={styles.badge}>{t("memory.kind.lesson")}</Text> : null}
        {status !== "active" ? (
          <Text style={[styles.badge, styles[`status_${status}`]]} testID="memory-row-status">
            {t(`memory.status.${status}`)}
          </Text>
        ) : null}
        {showCounts ? (
          <Text style={styles.meta} testID="memory-row-ratings">
            {t("memory.lesson.ratings", { helpful, harmful })}
          </Text>
        ) : null}
      </View>
      {memory.statusReason && status !== "active" ? (
        <Text style={styles.meta}>{memory.statusReason}</Text>
      ) : null}
    </>
  );
}

function LessonActions({
  serverId,
  memory,
  onGraduate,
}: {
  serverId: string;
  memory: MemoryRecordWire;
  onGraduate: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const status = memory.status ?? "active";
  const approve = useCallback(() => {
    client?.saveMemory({ id: memory.id, status: "active" }).catch((error: unknown) => {
      toast.error(errorText(error));
    });
  }, [client, memory.id, toast]);
  const validate = useCallback(() => {
    client?.validateMemories({ id: memory.id }).then(
      ({ memories }) => {
        const result = memories[0];
        if (result?.status === "stale")
          toast.error(result.statusReason ?? t("memory.status.stale"));
        else toast.show(t("memory.lesson.validated"));
        return undefined;
      },
      (error: unknown) => toast.error(errorText(error)),
    );
  }, [client, memory.id, t, toast]);
  return (
    <View style={styles.line}>
      {status === "pending" ? (
        <Button size="sm" variant="default" onPress={approve} testID="memory-row-approve">
          {t("memory.lesson.approve")}
        </Button>
      ) : null}
      {status === "stale" || status === "deprecated" ? (
        <Button size="sm" variant="secondary" onPress={approve} testID="memory-row-restore">
          {t("memory.lesson.restore")}
        </Button>
      ) : null}
      {status === "active" || status === "stale" ? (
        <Button size="sm" variant="ghost" onPress={validate} testID="memory-row-validate">
          {t("memory.lesson.validate")}
        </Button>
      ) : null}
      {memory.graduationReady ? (
        <Button size="sm" variant="secondary" onPress={onGraduate} testID="memory-row-graduate">
          {t("memory.lesson.graduate")}
        </Button>
      ) : null}
      {status === "graduated" && memory.graduatedPath ? (
        <Text style={styles.meta}>
          {t("memory.lesson.graduatedTo", { path: memory.graduatedPath })}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Spec 42 §8 on a Memory row: kind and status, citations (open the file), helpful/harmful, and the
 * lesson actions — Approve, Restore, Validate now, Make this a project rule.
 */
export function LessonDetails({
  serverId,
  memory,
  projectRoot,
}: {
  serverId: string;
  memory: MemoryRecordWire;
  projectRoot: string | null;
}) {
  const [citation, setCitation] = useState<MemoryCitationWire | null>(null);
  const [graduating, setGraduating] = useState(false);
  const openGraduation = useCallback(() => setGraduating(true), []);
  const closeGraduation = useCallback(() => setGraduating(false), []);
  const closeCitation = useCallback(() => setCitation(null), []);
  const kind = memory.kind ?? "memory";
  const citations = memory.citations ?? [];
  const plain =
    kind !== "lesson" &&
    (memory.status ?? "active") === "active" &&
    !(memory.helpful ?? 0) &&
    !(memory.harmful ?? 0);
  if (plain) return null;
  return (
    <View style={styles.root} testID="memory-lesson-details">
      <StatusLine memory={memory} />
      {citations.length > 0 ? (
        <View style={styles.line}>
          {citations.map((entry) => (
            <CitationLink
              key={`${entry.path}:${entry.symbol ?? ""}:${entry.excerpt ?? ""}`}
              citation={entry}
              onOpen={setCitation}
            />
          ))}
        </View>
      ) : null}
      {kind === "lesson" ? (
        <LessonActions serverId={serverId} memory={memory} onGraduate={openGraduation} />
      ) : null}
      {citation ? (
        <CitationSheet
          serverId={serverId}
          root={projectRoot}
          citation={citation}
          onClose={closeCitation}
        />
      ) : null}
      {graduating ? (
        <GraduationSheet serverId={serverId} memory={memory} onClose={closeGraduation} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  root: { gap: 4 },
  line: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  badge: {
    fontSize: 12,
    fontWeight: "500",
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  status_pending: { color: theme.colors.foreground },
  status_stale: { color: theme.colors.foregroundMuted },
  status_deprecated: { color: theme.colors.foregroundMuted },
  status_graduated: { color: theme.colors.foreground },
  status_active: {},
  meta: { fontSize: 13, color: theme.colors.foregroundMuted },
  citation: { fontSize: 13, color: theme.colors.foregroundMuted, maxWidth: 320 },
  link: { textDecorationLine: "underline" },
}));
