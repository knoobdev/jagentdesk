import React, { useCallback } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import {
  createAutorunPatch,
  getAutorunCardState,
  getAutorunMutationViewState,
} from "./autorun-config";

export function AutorunOptInCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const state = getAutorunCardState({ isConnected, config });
  const mutation = useMutation({
    mutationFn: async (next: boolean) => {
      const result = await patchConfig(createAutorunPatch(next));
      if (!result) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return result;
    },
  });
  const mutationView = getAutorunMutationViewState({
    isPending: mutation.isPending,
    error: mutation.error,
  });

  const handleValueChange = useCallback(
    (next: boolean) => {
      mutation.mutate(next);
    },
    [mutation],
  );

  if (!state.isVisible) return null;

  return (
    <View style={settingsStyles.card} testID="host-page-autorun-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{state.title}</Text>
          <Text style={settingsStyles.rowHint}>{state.warning}</Text>
          {mutationView.loadingText ? (
            <Text style={settingsStyles.rowHint} testID="host-page-autorun-loading">
              {mutationView.loadingText}
            </Text>
          ) : null}
          {mutationView.errorText ? (
            <Text style={settingsStyles.rowError} testID="host-page-autorun-error">
              {mutationView.errorText}
            </Text>
          ) : null}
        </View>
        <Switch
          value={state.isEnabled}
          onValueChange={handleValueChange}
          disabled={mutationView.isSwitchDisabled}
          accessibilityLabel="Enable autonomous run"
          testID="host-page-autorun-switch"
        />
      </View>
    </View>
  );
}
