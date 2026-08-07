import { invokeDesktopCommand } from "@/desktop/electron/invoke";

export interface DesktopRuntimeInfo {
  appVersion: string | null;
  runningUnderARM64Translation: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseDesktopRuntimeInfo(raw: unknown): DesktopRuntimeInfo {
  if (!isRecord(raw)) {
    return { appVersion: null, runningUnderARM64Translation: false };
  }

  return {
    appVersion: toStringOrNull(raw.appVersion),
    runningUnderARM64Translation: raw.runningUnderARM64Translation === true,
  };
}

export async function getDesktopRuntimeInfo(): Promise<DesktopRuntimeInfo> {
  return parseDesktopRuntimeInfo(await invokeDesktopCommand<unknown>("desktop_get_runtime_info"));
}

export function normalizeVersionForComparison(version: string | null | undefined): string | null {
  const value = version?.trim();
  return value ? value.replace(/^v/i, "") : null;
}

export function isVersionMismatch(
  appVersion: string | null | undefined,
  daemonVersion: string | null | undefined,
): boolean {
  const app = normalizeVersionForComparison(appVersion);
  const daemon = normalizeVersionForComparison(daemonVersion);

  return app !== null && daemon !== null && app !== daemon;
}

export function formatVersionWithPrefix(version: string | null | undefined): string {
  const value = version?.trim();
  if (!value) {
    return "\u2014";
  }

  return value.startsWith("v") ? value : `v${value}`;
}
