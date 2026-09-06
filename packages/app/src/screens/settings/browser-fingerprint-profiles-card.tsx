import React, { useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import {
  generateFingerprintProfile,
  type FingerprintOs,
} from "@jagentdesk/protocol/browser-automation/fingerprint-profile";
import type { MutableDaemonConfigPatch } from "@jagentdesk/protocol/messages";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import {
  activeFingerprintProfileId,
  deleteProfilePatch,
  listFingerprintProfiles,
  newFingerprintProfileId,
  selectProfilePatch,
  upsertProfilePatch,
} from "./browser-fingerprint-config";

const OS_LABELS: Record<FingerprintOs, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
};

/**
 * Manage the agentic browser's anti-detect fingerprint profiles (see ADR-0011).
 * Create a coherent per-OS identity, pick the active one (or the host's real
 * identity), and delete profiles. The active profile is stored in the daemon
 * config and applied to new browser tabs by the desktop host. Only shown when
 * browser tools are enabled — profiles do nothing otherwise.
 */
export function BrowserFingerprintProfilesCard({ serverId }: { serverId: string }) {
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const profiles = listFingerprintProfiles(config);
  const activeId = activeFingerprintProfileId(config);

  const mutation = useMutation({
    mutationFn: async (patch: MutableDaemonConfigPatch) => {
      const result = await patchConfig(patch);
      if (!result) {
        throw new Error("Host disconnected");
      }
      return result;
    },
  });

  const createForOs = useCallback(
    (os: FingerprintOs) => {
      const profile = generateFingerprintProfile({
        id: newFingerprintProfileId(),
        os,
        nowMs: Date.now(),
      });
      mutation.mutate(upsertProfilePatch(profiles, profile));
      mutation.mutate(selectProfilePatch(profile.id));
    },
    [mutation, profiles],
  );

  const selectProfile = useCallback(
    (id: string | null) => mutation.mutate(selectProfilePatch(id)),
    [mutation],
  );

  const removeProfile = useCallback(
    (id: string) => mutation.mutate(deleteProfilePatch(profiles, id, activeId)),
    [mutation, profiles, activeId],
  );

  if (!isConnected || config?.browserTools.enabled !== true) {
    return null;
  }

  return (
    <View style={settingsStyles.card} testID="host-page-browser-fingerprint-card">
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>Browser fingerprint profiles</Text>
        <Text style={settingsStyles.rowHint}>
          Anti-detect identities for the agentic browser. The active profile is applied to new tabs.
          A proxy is the only way to change the observed IP — no proxy means your real IP.
        </Text>
      </View>

      <Pressable
        onPress={() => selectProfile(null)}
        disabled={mutation.isPending}
        style={settingsStyles.row}
        accessibilityRole="button"
      >
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>Real identity (no spoofing)</Text>
          <Text style={settingsStyles.rowHint}>Use the host browser as-is.</Text>
        </View>
        <Text style={settingsStyles.rowTitle}>{activeId === null ? "● Active" : "○"}</Text>
      </Pressable>

      {profiles.map((profile) => (
        <View key={profile.id} style={settingsStyles.row}>
          <Pressable
            onPress={() => selectProfile(profile.id)}
            disabled={mutation.isPending}
            style={settingsStyles.rowContent}
            accessibilityRole="button"
          >
            <Text style={settingsStyles.rowTitle}>
              {profile.id === activeId ? "● " : "○ "}
              {profile.name}
            </Text>
            <Text style={settingsStyles.rowHint} numberOfLines={1}>
              {OS_LABELS[profile.os]} · {profile.timezone}
              {profile.proxy ? " · proxy" : ""}
              {profile.stealthEnabled ? "" : " · no spoof"}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => removeProfile(profile.id)}
            disabled={mutation.isPending}
            accessibilityRole="button"
            accessibilityLabel={`Delete ${profile.name}`}
          >
            <Text style={settingsStyles.rowError}>Delete</Text>
          </Pressable>
        </View>
      ))}

      <View style={settingsStyles.row}>
        <Text style={settingsStyles.rowHint}>Add profile:</Text>
        {(Object.keys(OS_LABELS) as FingerprintOs[]).map((os) => (
          <Pressable
            key={os}
            onPress={() => createForOs(os)}
            disabled={mutation.isPending}
            accessibilityRole="button"
            accessibilityLabel={`Add ${OS_LABELS[os]} profile`}
          >
            <Text style={settingsStyles.rowTitle}> + {OS_LABELS[os]}</Text>
          </Pressable>
        ))}
      </View>

      {mutation.error ? (
        <Text style={settingsStyles.rowError}>
          {mutation.error instanceof Error ? mutation.error.message : String(mutation.error)}
        </Text>
      ) : null}
    </View>
  );
}
