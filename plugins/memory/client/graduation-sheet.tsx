import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { MemoryGraduationPreview, MemoryRecordWire } from "@jagentdesk/protocol/memory";
import {
  AdaptiveModalSheet,
  Button,
  DiffViewer,
  parseUnifiedDiff,
  useHostRuntimeClient,
  useToast,
  type Theme,
} from "../../../packages/app/src/plugins/builtin/host-api";

type Preview =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; preview: MemoryGraduationPreview };

/**
 * "Make this a project rule" (spec 42 §5): the exact diff to AGENTS.md (or CLAUDE.md). Nothing is
 * written until the user approves; the write then shows in the workspace's Changes.
 */
export function GraduationSheet({
  serverId,
  memory,
  onClose,
}: {
  serverId: string;
  memory: MemoryRecordWire;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const [state, setState] = useState<Preview>({ status: "loading" });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!client) return undefined;
    let active = true;
    client.previewMemoryGraduation(memory.id).then(
      (preview) => {
        if (active) setState({ status: "ready", preview });
        return undefined;
      },
      (error: unknown) => {
        if (active)
          setState({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      active = false;
    };
  }, [client, memory.id]);
  const approve = useCallback(async () => {
    if (!client || state.status !== "ready") return;
    setSaving(true);
    try {
      await client.applyMemoryGraduation({ id: memory.id, baseHash: state.preview.baseHash });
      toast.show(t("memory.lesson.graduated", { path: state.preview.relativePath }));
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [client, memory.id, onClose, state, t, toast]);
  const handleApprove = useCallback(() => void approve(), [approve]);
  const header = useMemo(
    () => ({
      title: t("memory.lesson.graduateTitle"),
      subtitle:
        state.status === "ready"
          ? t(
              state.preview.created
                ? "memory.lesson.graduateCreates"
                : "memory.lesson.graduateEdits",
              {
                path: state.preview.relativePath,
              },
            )
          : undefined,
    }),
    [state, t],
  );
  const diffLines = useMemo(
    () => (state.status === "ready" ? parseUnifiedDiff(state.preview.diff) : []),
    [state],
  );
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      desktopMaxWidth={760}
      testID="memory-graduation-sheet"
    >
      <View style={styles.body}>
        {state.status === "loading" ? (
          <Text style={styles.meta}>{t("memory.lesson.loading")}</Text>
        ) : null}
        {state.status === "error" ? <Text style={styles.meta}>{state.error}</Text> : null}
        {state.status === "ready" ? <DiffViewer diffLines={diffLines} maxHeight={360} /> : null}
        <View style={styles.actions}>
          <Button size="sm" variant="ghost" onPress={onClose} testID="memory-graduation-cancel">
            {t("memory.editor.cancel")}
          </Button>
          <Button
            size="sm"
            variant="default"
            onPress={handleApprove}
            disabled={state.status !== "ready" || saving}
            testID="memory-graduation-approve"
          >
            {t("memory.lesson.graduateApprove")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  body: { gap: theme.spacing[3], paddingBottom: theme.spacing[4] },
  meta: { fontSize: 13, color: theme.colors.foregroundMuted },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
}));
