import type { HostCapabilityId } from "@jagentdesk/protocol/host-capabilities";
import type { ServerCapabilityState } from "@jagentdesk/protocol/messages";
import type { DaemonServerInfo } from "@/stores/session-store";

export type VoiceReadinessMode = "dictation" | "voice";

export function getServerCapabilities(params: {
  serverInfo: DaemonServerInfo | null | undefined;
}): DaemonServerInfo["capabilities"] | null {
  const capabilities = params.serverInfo?.capabilities;
  if (!capabilities) {
    return null;
  }
  return capabilities;
}

export function getVoiceReadinessState(params: {
  serverInfo: DaemonServerInfo | null | undefined;
  mode: VoiceReadinessMode;
}): ServerCapabilityState | null {
  const capabilities = getServerCapabilities({ serverInfo: params.serverInfo });
  const voice = capabilities?.voice;
  if (!voice) {
    return null;
  }
  if (params.mode === "dictation") {
    return voice.dictation;
  }
  return voice.voice;
}

export function resolveVoiceUnavailableMessage(params: {
  serverInfo: DaemonServerInfo | null | undefined;
  mode: VoiceReadinessMode;
}): string | null {
  const readiness = getVoiceReadinessState({
    serverInfo: params.serverInfo,
    mode: params.mode,
  });
  if (!readiness) {
    return null;
  }
  if (readiness.enabled && readiness.reason.trim().length === 0) {
    return null;
  }
  const message = readiness.reason.trim();
  if (message.length > 0) {
    return message;
  }
  return null;
}

/**
 * Whether a host can run a feature at all (spec 24.4): true unless every listed
 * capability is `unsupported_os`. A daemon that reports no host capabilities (older
 * versions) is assumed to support it.
 */
export function hostSupportsCapability(
  serverInfo: DaemonServerInfo | null | undefined,
  ids: readonly HostCapabilityId[],
): boolean {
  const host = serverInfo?.capabilities?.host;
  if (!host) return true;
  return ids.some((id) => host[id] !== undefined && host[id]!.state !== "unsupported_os");
}
