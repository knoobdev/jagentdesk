import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { selectHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { type AgentDurableAction, useAgentDurableActionStore } from "./agent-durable-action-store";
import { useArchivePromptStore } from "./archive-capture-lessons";

function useRunAction(serverId: string) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const supported = useSessionStore((state) =>
    selectHostFeature(state, serverId, "durableContext"),
  );
  return useCallback(
    async (agentId: string, action: AgentDurableAction): Promise<boolean> => {
      if (!supported) {
        toast.error(t("continuity.durable.updateHost"));
        return false;
      }
      if (!client) {
        toast.error(t("common.errors.daemonClientUnavailable"));
        return false;
      }
      try {
        if (action === "rollover") {
          await client.rolloverAgent(agentId);
          toast.show(t("continuity.durable.rolloverDone"));
        } else {
          await client.captureAgentLessons(agentId);
          toast.show(t("continuity.durable.captureSent"));
        }
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [client, supported, t, toast],
  );
}

function ConfirmSheet({
  title,
  body,
  confirmLabel,
  cancelLabel,
  busy,
  onConfirm,
  onCancel,
  onDismiss,
  testID,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Closing the sheet without a choice; the cancel button's action by default. */
  onDismiss?: () => void;
  testID: string;
}) {
  const header = useMemo(() => ({ title }), [title]);
  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onDismiss ?? onCancel}
      desktopMaxWidth={520}
      testID={testID}
    >
      <View style={styles.body}>
        <Text style={styles.text}>{body}</Text>
        <View style={styles.actions}>
          <Button size="sm" variant="ghost" onPress={onCancel} testID={`${testID}-cancel`}>
            {cancelLabel}
          </Button>
          <Button
            size="sm"
            variant="default"
            onPress={onConfirm}
            disabled={busy}
            testID={`${testID}-confirm`}
          >
            {confirmLabel}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

/** Mounted next to the workspace: runs the ⋯ menu's Rollover and Capture lessons after a confirm. */
export function AgentDurableActionHost({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const request = useAgentDurableActionStore((state) => state.request);
  const close = useAgentDurableActionStore((state) => state.close);
  const run = useRunAction(serverId);
  const [busy, setBusy] = useState(false);
  const confirm = useCallback(async () => {
    if (!request) return;
    setBusy(true);
    const ok = await run(request.agentId, request.action);
    setBusy(false);
    if (ok) close();
  }, [close, request, run]);
  const handleConfirm = useCallback(() => void confirm(), [confirm]);
  if (!request) return null;
  const rollover = request.action === "rollover";
  return (
    <ConfirmSheet
      title={t(rollover ? "continuity.durable.rolloverTitle" : "continuity.durable.captureTitle")}
      body={t(rollover ? "continuity.durable.rolloverBody" : "continuity.durable.captureBody")}
      confirmLabel={t(
        rollover ? "continuity.durable.rolloverConfirm" : "continuity.durable.captureConfirm",
      )}
      cancelLabel={t("common.actions.cancel")}
      busy={busy}
      onConfirm={handleConfirm}
      onCancel={close}
      testID={rollover ? "agent-rollover-sheet" : "agent-capture-lessons-sheet"}
    />
  );
}

/** Mounted once at the app root: the "Capture lessons before archiving?" question. */
export function ArchiveCaptureLessonsHost() {
  const { t } = useTranslation();
  const prompt = useArchivePromptStore((state) => state.prompt);
  const settle = useArchivePromptStore((state) => state.settle);
  const run = useRunAction(prompt?.serverId ?? "");
  const [busy, setBusy] = useState(false);
  const capture = useCallback(async () => {
    if (!prompt) return;
    setBusy(true);
    const ok = await run(prompt.agentId, "captureLessons");
    setBusy(false);
    settle(ok ? "capture" : "cancel");
  }, [prompt, run, settle]);
  const handleCapture = useCallback(() => void capture(), [capture]);
  const archiveNow = useCallback(() => settle("archive"), [settle]);
  const dismiss = useCallback(() => settle("cancel"), [settle]);
  if (!prompt) return null;
  return (
    <ConfirmSheet
      title={t("continuity.durable.archiveTitle")}
      body={t("continuity.durable.archiveBody", { count: prompt.turns })}
      confirmLabel={t("continuity.durable.captureConfirm")}
      cancelLabel={t("continuity.durable.archiveNow")}
      busy={busy}
      onConfirm={handleCapture}
      onCancel={archiveNow}
      onDismiss={dismiss}
      testID="archive-capture-lessons-sheet"
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
