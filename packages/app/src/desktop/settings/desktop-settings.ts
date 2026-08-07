import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getIsElectron } from "@/constants/platform";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import {
  useDesktopIpcErrorReporter,
  useDesktopIpcQueryErrorToast,
} from "@/desktop/hooks/desktop-ipc-error";
import { i18n } from "@/i18n/i18next";

const DESKTOP_SETTINGS_QUERY_KEY = ["desktop-settings"] as const;

export interface DesktopSettings {
  daemon: {
    manageBuiltInDaemon: boolean;
    keepRunningAfterQuit: boolean;
  };
  tailscale: {
    authKeyConfigured: boolean;
  };
}

export interface DesktopSettingsPatch {
  daemon?: Partial<DesktopSettings["daemon"]>;
  tailscale?: { authKey?: string | null };
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  daemon: {
    manageBuiltInDaemon: true,
    keepRunningAfterQuit: false,
  },
  tailscale: {
    authKeyConfigured: false,
  },
};

export function useDesktopSettings(): {
  settings: DesktopSettings;
  isLoading: boolean;
  isSaving: boolean;
  error: unknown;
  updateSettings: (updates: DesktopSettingsPatch) => Promise<void>;
} {
  const queryClient = useQueryClient();
  const reportError = useDesktopIpcErrorReporter();
  const {
    data,
    isPending,
    error: loadError,
  } = useQuery<DesktopSettings, Error>({
    queryKey: DESKTOP_SETTINGS_QUERY_KEY,
    queryFn: loadDesktopSettings,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  useDesktopIpcQueryErrorToast({
    error: loadError,
    message: i18n.t("desktop.settings.loadFailed"),
    logLabel: "[DesktopSettings] Failed to load settings",
  });

  const { mutateAsync: saveDesktopSettings, isPending: isSaving } = useMutation<
    DesktopSettings,
    Error,
    DesktopSettingsPatch,
    DesktopSettingsMutationContext
  >({
    mutationFn: updatePersistedDesktopSettings,
    onMutate: (updates) => {
      const previous =
        queryClient.getQueryData<DesktopSettings>(DESKTOP_SETTINGS_QUERY_KEY) ??
        DEFAULT_DESKTOP_SETTINGS;
      queryClient.setQueryData<DesktopSettings>(
        DESKTOP_SETTINGS_QUERY_KEY,
        mergeDesktopSettings(previous, updates),
      );
      return { previous };
    },
    onSuccess: (persisted) => {
      queryClient.setQueryData<DesktopSettings>(DESKTOP_SETTINGS_QUERY_KEY, persisted);
    },
    onError: (saveError, _updates, context) => {
      if (context) {
        queryClient.setQueryData<DesktopSettings>(DESKTOP_SETTINGS_QUERY_KEY, context.previous);
      }
      reportError({
        error: saveError,
        message: i18n.t("desktop.settings.saveFailed"),
        logLabel: "[DesktopSettings] Failed to save settings",
      });
    },
  });

  const updateSettings = useCallback(
    async (updates: DesktopSettingsPatch) => {
      if (!getIsElectron()) {
        return;
      }

      await saveDesktopSettings(updates);
    },
    [saveDesktopSettings],
  );

  return {
    settings: data ?? DEFAULT_DESKTOP_SETTINGS,
    isLoading: isPending,
    isSaving,
    error: loadError ?? null,
    updateSettings,
  };
}

interface DesktopSettingsMutationContext {
  previous: DesktopSettings;
}

export async function loadDesktopSettings(): Promise<DesktopSettings> {
  if (!getIsElectron()) {
    return DEFAULT_DESKTOP_SETTINGS;
  }
  return parseDesktopSettings(await invokeDesktopCommand<unknown>("get_desktop_settings"));
}

export async function updatePersistedDesktopSettings(
  updates: DesktopSettingsPatch,
): Promise<DesktopSettings> {
  if (!getIsElectron()) {
    return DEFAULT_DESKTOP_SETTINGS;
  }
  return parseDesktopSettings(
    await invokeDesktopCommand<unknown>("patch_desktop_settings", normalizePatch(updates)),
  );
}

export async function migrateLegacyDesktopSettings(input: {
  manageBuiltInDaemon?: boolean;
}): Promise<void> {
  if (!getIsElectron()) {
    return;
  }
  await invokeDesktopCommand("migrate_legacy_desktop_settings", input);
}

function parseDesktopSettings(raw: unknown): DesktopSettings {
  const record = isRecord(raw) ? raw : {};
  const daemon = isRecord(record.daemon) ? record.daemon : {};

  return {
    daemon: {
      manageBuiltInDaemon:
        typeof daemon.manageBuiltInDaemon === "boolean"
          ? daemon.manageBuiltInDaemon
          : DEFAULT_DESKTOP_SETTINGS.daemon.manageBuiltInDaemon,
      keepRunningAfterQuit:
        typeof daemon.keepRunningAfterQuit === "boolean"
          ? daemon.keepRunningAfterQuit
          : DEFAULT_DESKTOP_SETTINGS.daemon.keepRunningAfterQuit,
    },
    tailscale: {
      authKeyConfigured:
        isRecord(record.tailscale) && record.tailscale.authKeyConfigured === true,
    },
  };
}

function mergeDesktopSettings(
  current: DesktopSettings,
  updates: DesktopSettingsPatch,
): DesktopSettings {
  return {
    daemon: {
      ...current.daemon,
      ...updates.daemon,
    },
    tailscale: {
      authKeyConfigured:
        updates.tailscale?.authKey !== undefined
          ? updates.tailscale.authKey !== null
          : current.tailscale.authKeyConfigured,
    },
  };
}

function normalizePatch(updates: DesktopSettingsPatch): Record<string, unknown> {
  return {
    ...(updates.daemon ? { daemon: updates.daemon } : {}),
    ...(updates.tailscale ? { tailscale: updates.tailscale } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
