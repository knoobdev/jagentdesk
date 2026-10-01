import React, { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import {
  generateFingerprintProfile,
  type BrowserFingerprintProfile,
  type FingerprintOs,
  type WebRtcPolicy,
} from "@jagentdesk/protocol/browser-automation/fingerprint-profile";
import type { MutableDaemonConfigPatch } from "@jagentdesk/protocol/messages";
import { FormTextInput } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
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

const WEBRTC_LABELS: Record<WebRtcPolicy, string> = {
  default: "Default",
  "force-proxy": "Force proxy",
  disable: "Disabled",
};

const WEBRTC_ORDER: WebRtcPolicy[] = ["default", "force-proxy", "disable"];

interface ProxyDraft {
  server: string;
  username: string;
  password: string;
}

/**
 * Manage the agentic browser's anti-detect fingerprint profiles (ADR-0011): create
 * a coherent per-OS identity, inspect its fingerprint, attach a proxy, toggle
 * spoofing / WebRTC policy, pick the active one (or the host's real identity), and
 * delete. Stored in the daemon config; the desktop host applies the active profile
 * to new browser tabs. Shown when browser tools are enabled.
 */
export function BrowserFingerprintProfilesCard({ serverId }: { serverId: string }) {
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const profiles = listFingerprintProfiles(config);
  const activeId = activeFingerprintProfileId(config);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [proxyDrafts, setProxyDrafts] = useState<Record<string, ProxyDraft>>({});

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

  const saveProfile = useCallback(
    (next: BrowserFingerprintProfile) => {
      mutation.mutate(upsertProfilePatch(profiles, { ...next, updatedAtMs: Date.now() }));
    },
    [mutation, profiles],
  );

  const toggleExpand = useCallback((profile: BrowserFingerprintProfile) => {
    setExpandedId((current) => {
      if (current === profile.id) {
        return null;
      }
      setProxyDrafts((drafts) => ({
        ...drafts,
        [profile.id]: {
          server: profile.proxy?.server ?? "",
          username: profile.proxy?.username ?? "",
          password: profile.proxy?.password ?? "",
        },
      }));
      return profile.id;
    });
  }, []);

  const setDraft = useCallback((id: string, patch: Partial<ProxyDraft>) => {
    setProxyDrafts((drafts) => {
      const prev = drafts[id] ?? { server: "", username: "", password: "" };
      return { ...drafts, [id]: { ...prev, ...patch } };
    });
  }, []);

  const saveProxy = useCallback(
    (profile: BrowserFingerprintProfile) => {
      const draft = proxyDrafts[profile.id];
      const server = draft?.server.trim() ?? "";
      const proxy = server
        ? {
            server,
            ...(draft?.username ? { username: draft.username } : {}),
            ...(draft?.password ? { password: draft.password } : {}),
          }
        : null;
      const webrtcPolicy = webrtcPolicyForProxy(proxy !== null, profile.webrtcPolicy);
      saveProfile({ ...profile, proxy, webrtcPolicy });
    },
    [proxyDrafts, saveProfile],
  );

  const cycleWebrtc = useCallback(
    (profile: BrowserFingerprintProfile) => {
      const next =
        WEBRTC_ORDER[(WEBRTC_ORDER.indexOf(profile.webrtcPolicy) + 1) % WEBRTC_ORDER.length];
      saveProfile({ ...profile, webrtcPolicy: next });
    },
    [saveProfile],
  );

  const toggleGeoFromIp = useCallback(
    (profile: BrowserFingerprintProfile, value: boolean) => {
      saveProfile({ ...profile, geoFromIp: value });
    },
    [saveProfile],
  );

  const toggleStealth = useCallback(
    (profile: BrowserFingerprintProfile, value: boolean) => {
      saveProfile({ ...profile, stealthEnabled: value });
    },
    [saveProfile],
  );

  const selectRealIdentity = useCallback(() => selectProfile(null), [selectProfile]);

  if (!isConnected || config?.browserTools.enabled !== true) {
    return null;
  }

  return (
    <View style={settingsStyles.card} testID="host-page-browser-fingerprint-card">
      <View style={styles.header}>
        <Text style={settingsStyles.rowTitle}>Browser fingerprint profiles</Text>
        <Text style={settingsStyles.rowHint}>
          Anti-detect identities for the agentic browser. The active profile is applied to new tabs.
          A proxy is the only way to change the observed IP — no proxy means your real IP.
        </Text>
      </View>

      <Pressable
        onPress={selectRealIdentity}
        disabled={mutation.isPending}
        style={styles.selectRow}
        accessibilityRole="button"
      >
        <View style={styles.rowMain}>
          <Text style={styles.name}>Real identity (no spoofing)</Text>
          <Text style={settingsStyles.rowHint}>Use the host browser as-is.</Text>
        </View>
        <Text style={activeId === null ? styles.activeDot : styles.inactiveDot}>
          {activeId === null ? "● Active" : "○"}
        </Text>
      </Pressable>

      {profiles.map((profile) => (
        <FingerprintProfileRow
          key={profile.id}
          profile={profile}
          active={profile.id === activeId}
          expanded={expandedId === profile.id}
          draft={proxyDrafts[profile.id]}
          pending={mutation.isPending}
          onSelect={selectProfile}
          onToggleExpand={toggleExpand}
          onRemove={removeProfile}
          onDraft={setDraft}
          onSaveProxy={saveProxy}
          onToggleStealth={toggleStealth}
          onToggleGeoFromIp={toggleGeoFromIp}
          onCycleWebrtc={cycleWebrtc}
        />
      ))}

      <View style={styles.createRow}>
        <Text style={settingsStyles.rowHint}>Add profile:</Text>
        {(Object.keys(OS_LABELS) as FingerprintOs[]).map((os) => (
          <AddProfileChip key={os} os={os} disabled={mutation.isPending} onAdd={createForOs} />
        ))}
      </View>

      {mutation.error ? (
        <Text style={styles.error}>
          {mutation.error instanceof Error ? mutation.error.message : String(mutation.error)}
        </Text>
      ) : null}
    </View>
  );
}

// Turning a proxy on defaults WebRTC to force-proxy so the real IP can't leak over STUN;
// removing it relaxes the policy back to default.
function webrtcPolicyForProxy(hasProxy: boolean, current: WebRtcPolicy): WebRtcPolicy {
  if (hasProxy) return current === "default" ? "force-proxy" : current;
  return current === "force-proxy" ? "default" : current;
}

interface FingerprintProfileRowProps {
  profile: BrowserFingerprintProfile;
  active: boolean;
  expanded: boolean;
  draft: ProxyDraft | undefined;
  pending: boolean;
  onSelect: (id: string) => void;
  onToggleExpand: (profile: BrowserFingerprintProfile) => void;
  onRemove: (id: string) => void;
  onDraft: (id: string, patch: Partial<ProxyDraft>) => void;
  onSaveProxy: (profile: BrowserFingerprintProfile) => void;
  onToggleStealth: (profile: BrowserFingerprintProfile, value: boolean) => void;
  onToggleGeoFromIp: (profile: BrowserFingerprintProfile, value: boolean) => void;
  onCycleWebrtc: (profile: BrowserFingerprintProfile) => void;
}

function FingerprintProfileRow({
  profile,
  active,
  expanded,
  draft,
  pending,
  onSelect,
  onToggleExpand,
  onRemove,
  onDraft,
  onSaveProxy,
  onToggleStealth,
  onToggleGeoFromIp,
  onCycleWebrtc,
}: FingerprintProfileRowProps) {
  const id = profile.id;
  const select = useCallback(() => onSelect(id), [onSelect, id]);
  const toggleExpand = useCallback(() => onToggleExpand(profile), [onToggleExpand, profile]);
  const remove = useCallback(() => onRemove(id), [onRemove, id]);
  const setServer = useCallback((server: string) => onDraft(id, { server }), [onDraft, id]);
  const setUsername = useCallback((username: string) => onDraft(id, { username }), [onDraft, id]);
  const setPassword = useCallback((password: string) => onDraft(id, { password }), [onDraft, id]);
  const saveProxy = useCallback(() => onSaveProxy(profile), [onSaveProxy, profile]);
  const toggleStealth = useCallback(
    (value: boolean) => onToggleStealth(profile, value),
    [onToggleStealth, profile],
  );
  const toggleGeoFromIp = useCallback(
    (value: boolean) => onToggleGeoFromIp(profile, value),
    [onToggleGeoFromIp, profile],
  );
  const cycleWebrtc = useCallback(() => onCycleWebrtc(profile), [onCycleWebrtc, profile]);
  const location = profile.geoFromIp === false ? profile.timezone : "IP location";

  return (
    <View style={styles.profileBlock}>
      <View style={styles.profileHeader}>
        <Pressable
          onPress={select}
          disabled={pending}
          style={styles.rowMain}
          accessibilityRole="button"
        >
          <Text style={styles.name}>
            {active ? "● " : "○ "}
            {profile.name}
          </Text>
          <Text style={settingsStyles.rowHint} numberOfLines={1}>
            {OS_LABELS[profile.os]} · {location}
            {profile.proxy ? " · proxy" : ""}
            {profile.stealthEnabled ? "" : " · no spoof"}
          </Text>
        </Pressable>
        <Pressable
          onPress={toggleExpand}
          accessibilityRole="button"
          accessibilityLabel={expanded ? "Hide details" : "Show details"}
          style={styles.actionBtn}
        >
          <Text style={styles.actionText}>{expanded ? "Hide" : "Details"}</Text>
        </Pressable>
        <Pressable
          onPress={remove}
          disabled={pending}
          accessibilityRole="button"
          accessibilityLabel={`Delete ${profile.name}`}
          style={styles.actionBtn}
        >
          <Text style={styles.deleteText}>Delete</Text>
        </Pressable>
      </View>

      {expanded ? (
        <View style={styles.detail}>
          <DetailRow label="User-Agent" value={profile.userAgent} />
          <DetailRow label="Platform" value={`${OS_LABELS[profile.os]} (${profile.os})`} />
          <DetailRow label="Languages" value={profile.languages.join(", ")} />
          <DetailRow
            label="Timezone"
            value={
              profile.geoFromIp === false
                ? profile.timezone
                : `From the exit IP (fallback ${profile.timezone})`
            }
          />
          <DetailRow label="Locale" value={profile.locale} />
          <DetailRow label="WebGL vendor" value={profile.webglVendor} />
          <DetailRow label="WebGL renderer" value={profile.webglRenderer} />
          <DetailRow
            label="Screen"
            value={`${profile.screen.width}×${profile.screen.height} @${profile.screen.devicePixelRatio}x`}
          />
          <DetailRow
            label="Hardware"
            value={`${profile.hardwareConcurrency} cores · ${profile.deviceMemory} GB`}
          />
          <DetailRow
            label="Canvas/Audio seed"
            value={`${profile.canvasNoiseSeed >>> 0} / ${profile.audioNoiseSeed >>> 0}`}
          />

          <Text style={styles.sectionLabel}>Proxy (the only real IP control)</Text>
          <FormTextInput
            value={draft?.server ?? ""}
            onChangeText={setServer}
            placeholder="scheme://host:port (http / https / socks5)"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <FormTextInput
            value={draft?.username ?? ""}
            onChangeText={setUsername}
            placeholder="Proxy username (optional)"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <FormTextInput
            value={draft?.password ?? ""}
            onChangeText={setPassword}
            placeholder="Proxy password (optional)"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
          <Pressable
            onPress={saveProxy}
            disabled={pending}
            accessibilityRole="button"
            style={styles.saveBtn}
          >
            <Text style={styles.saveText}>Save proxy</Text>
          </Pressable>

          <View style={styles.toggleRow}>
            <View style={styles.rowMain}>
              <Text style={styles.name}>Fingerprint spoofing</Text>
              <Text style={settingsStyles.rowHint}>
                Off = the host&apos;s real identity, keep proxy/extensions only.
              </Text>
            </View>
            <Switch
              value={profile.stealthEnabled}
              onValueChange={toggleStealth}
              disabled={pending}
              accessibilityLabel="Toggle fingerprint spoofing"
            />
          </View>

          <View style={styles.toggleRow}>
            <View style={styles.rowMain}>
              <Text style={styles.name}>Match IP location</Text>
              <Text style={settingsStyles.rowHint}>
                Timezone, locale and languages follow the exit IP (through the proxy). Located on
                this device with IP Geolocation by DB-IP.
              </Text>
            </View>
            <Switch
              value={profile.geoFromIp !== false}
              onValueChange={toggleGeoFromIp}
              disabled={pending}
              accessibilityLabel="Toggle matching the IP location"
            />
          </View>

          <Pressable
            onPress={cycleWebrtc}
            disabled={pending}
            accessibilityRole="button"
            style={styles.toggleRow}
          >
            <View style={styles.rowMain}>
              <Text style={styles.name}>WebRTC policy</Text>
              <Text style={settingsStyles.rowHint}>
                force-proxy closes the STUN IP leak behind a proxy.
              </Text>
            </View>
            <Text style={styles.pill}>{WEBRTC_LABELS[profile.webrtcPolicy]}</Text>
          </Pressable>

          {profile.extensions.length > 0 ? (
            <DetailRow label="Extensions" value={`${profile.extensions.length} loaded`} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function AddProfileChip({
  os,
  disabled,
  onAdd,
}: {
  os: FingerprintOs;
  disabled: boolean;
  onAdd: (os: FingerprintOs) => void;
}) {
  const add = useCallback(() => onAdd(os), [onAdd, os]);
  return (
    <Pressable
      onPress={add}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`Add ${OS_LABELS[os]} profile`}
      style={styles.chip}
    >
      <Text style={styles.chipText}>+ {OS_LABELS[os]}</Text>
    </Pressable>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  // Stacked (label above value) so long strings — User-Agent, WebGL renderer — wrap
  // cleanly instead of fighting a fixed-width label column on a narrow window.
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue} selectable>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[2],
    gap: theme.spacing[1],
  },
  selectRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    gap: theme.spacing[2],
  },
  profileBlock: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  profileHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[2],
  },
  rowMain: {
    flex: 1,
    gap: theme.spacing[1],
  },
  name: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  activeDot: { color: theme.colors.statusSuccess, fontSize: theme.fontSize.sm },
  inactiveDot: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  actionBtn: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  actionText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  deleteText: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  detail: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
  },
  detailRow: {
    flexDirection: "column",
    gap: 2,
  },
  detailLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  detailValue: {
    alignSelf: "stretch",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
  sectionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[2],
  },
  saveBtn: {
    alignSelf: "flex-start",
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  saveText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: theme.spacing[2],
    gap: theme.spacing[2],
  },
  pill: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    overflow: "hidden",
  },
  createRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  chip: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  chipText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
}));
