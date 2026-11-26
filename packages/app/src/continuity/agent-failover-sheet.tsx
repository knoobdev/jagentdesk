import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ProviderModelRef } from "@jagentdesk/protocol/messages";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useAgentFailoverSheetStore } from "./agent-failover-store";
import { ProviderModelListEditor } from "./provider-model-list-editor";

interface Draft {
  useHost: boolean;
  enabled: boolean;
  order: ProviderModelRef[];
}

function FailoverSheet({
  serverId,
  agentId,
  onClose,
}: {
  serverId: string;
  agentId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!client) return;
    let active = true;
    async function load(loaded: NonNullable<typeof client>) {
      try {
        const payload = await loaded.getAgentContinuity(agentId);
        const source = payload.override?.failover ?? payload.host?.failover;
        if (!active) return;
        setDraft({
          useHost: !payload.override?.failover,
          enabled: source?.enabled ?? false,
          order: source?.order ?? [],
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    }
    void load(client);
    return () => {
      active = false;
    };
  }, [agentId, client, toast]);
  const header = useMemo(() => ({ title: t("continuity.failover.sheetTitle") }), [t]);
  const setUseHost = useCallback(
    (useHost: boolean) => setDraft((current) => (current ? { ...current, useHost } : current)),
    [],
  );
  const setEnabled = useCallback(
    (enabled: boolean) => setDraft((current) => (current ? { ...current, enabled } : current)),
    [],
  );
  const setOrder = useCallback(
    (order: ProviderModelRef[]) =>
      setDraft((current) => (current ? { ...current, order } : current)),
    [],
  );
  const handleSave = useCallback(async () => {
    if (!client || !draft) return;
    setSaving(true);
    try {
      await client.setAgentContinuity(agentId, {
        failover: draft.useHost ? null : { enabled: draft.enabled, order: draft.order },
      });
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [agentId, client, draft, onClose, toast]);
  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      desktopMaxWidth={560}
      testID="agent-failover-sheet"
    >
      {draft ? (
        <View style={styles.body}>
          <View style={styles.row}>
            <Text style={styles.label}>{t("continuity.failover.useHost")}</Text>
            <Switch
              value={draft.useHost}
              onValueChange={setUseHost}
              accessibilityLabel={t("continuity.failover.useHost")}
              testID="agent-failover-use-host"
            />
          </View>
          {draft.useHost ? null : (
            <>
              <View style={styles.row}>
                <Text style={styles.label}>{t("continuity.settings.failoverTitle")}</Text>
                <Switch
                  value={draft.enabled}
                  onValueChange={setEnabled}
                  accessibilityLabel={t("continuity.settings.failoverTitle")}
                  testID="agent-failover-enabled"
                />
              </View>
              <ProviderModelListEditor
                serverId={serverId}
                value={draft.order}
                onChange={setOrder}
                reorderable
                testIDPrefix="agent-failover"
              />
            </>
          )}
          <View style={styles.footer}>
            <Button variant="ghost" onPress={onClose} disabled={saving}>
              {t("common.actions.cancel")}
            </Button>
            <Button onPress={handleSave} disabled={saving} testID="agent-failover-save">
              {t("continuity.failover.save")}
            </Button>
          </View>
        </View>
      ) : (
        <Text style={styles.label}>{t("continuity.ledger.loading")}</Text>
      )}
    </AdaptiveModalSheet>
  );
}

/** Mounted once per workspace screen; shows the sheet for the agent the ⋯ menu picked. */
export function AgentFailoverSheetHost({ serverId }: { serverId: string }) {
  const agentId = useAgentFailoverSheetStore((state) => state.agentId);
  const close = useAgentFailoverSheetStore((state) => state.close);
  if (!agentId) return null;
  return <FailoverSheet serverId={serverId} agentId={agentId} onClose={close} />;
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[4],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
