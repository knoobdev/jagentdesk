import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { SkillSourceStatus } from "@jagentdesk/protocol/native-skills";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery } from "@/data/query";
import { skillErrorMessage } from "@/skills/native-skill-logic";
import { confirmDialog } from "@/utils/confirm-dialog";

export function skillsBrowseQueryKey(serverId: string, filter?: string) {
  return filter ? ["skills-browse", serverId, filter] : ["skills-browse", serverId];
}

export function skillsSourcesQueryKey(serverId: string) {
  return ["skills-sources", serverId];
}

/** `skills.sources.list` for one host (shared by the Browse tab and the Sources sheet). */
export function useSkillSourcesQuery(serverId: string, client: DaemonClient | null) {
  return useFetchQuery({
    queryKey: skillsSourcesQueryKey(serverId),
    queryFn: async (): Promise<SkillSourceStatus[]> => {
      if (!client) return [];
      return (await client.listSkillSources()).sources;
    },
    enabled: Boolean(client),
    dataShape: "list",
    staleTimeMs: 30_000,
  });
}

export interface SkillSourceActions {
  /** Store (string) or clear (null) a directory's API key (ADR-0023). */
  setApiKey: (source: SkillSourceStatus, apiKey: string | null) => Promise<boolean>;
  /** Validates by listing once; rejects with the daemon error (the form shows it). */
  add: (input: { source: string; label?: string }) => Promise<SkillSourceStatus>;
  setEnabled: (source: SkillSourceStatus, enabled: boolean) => Promise<void>;
  remove: (source: SkillSourceStatus) => Promise<void>;
  refresh: (source: SkillSourceStatus) => Promise<void>;
  restoreDefaults: (repos: readonly string[]) => Promise<void>;
}

/**
 * Source mutations (spec 22.5). Each one refreshes the source list and the
 * browse results. Remove asks for confirmation (native dialog on desktop).
 */
export function useSkillSourceActions(
  serverId: string,
  client: DaemonClient | null,
): SkillSourceActions {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();

  const invalidate = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: skillsSourcesQueryKey(serverId) }),
      queryClient.invalidateQueries({ queryKey: skillsBrowseQueryKey(serverId) }),
    ]);
  }, [queryClient, serverId]);

  const fail = useCallback(
    (error: unknown) => {
      toast.error(t("skillsHub.toasts.failed", { message: skillErrorMessage(error) }));
    },
    [t, toast],
  );

  const add = useCallback(
    async (input: { source: string; label?: string }) => {
      if (!client) throw new Error(t("skillsHub.offline"));
      const { source } = await client.addSkillSource(input);
      toast.show(t("skillsHub.sources.added", { label: source.label }));
      await invalidate();
      return source;
    },
    [client, invalidate, t, toast],
  );

  const setEnabled = useCallback(
    async (source: SkillSourceStatus, enabled: boolean) => {
      if (!client) return;
      try {
        await client.setSkillSourceEnabled({ sourceId: source.sourceId, enabled });
        await invalidate();
      } catch (error) {
        fail(error);
      }
    },
    [client, fail, invalidate],
  );

  const remove = useCallback(
    async (source: SkillSourceStatus) => {
      if (!client) return;
      const ok = await confirmDialog({
        title: t("skillsHub.sources.removeTitle", { label: source.label }),
        message: t(
          source.builtin ? "skillsHub.sources.removeBuiltin" : "skillsHub.sources.removeMessage",
        ),
        confirmLabel: t("skillsHub.sources.remove"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (!ok) return;
      try {
        await client.removeSkillSource(source.sourceId);
        await invalidate();
      } catch (error) {
        fail(error);
      }
    },
    [client, fail, invalidate, t],
  );

  const refresh = useCallback(
    async (source: SkillSourceStatus) => {
      if (!client) return;
      try {
        await client.browseSkillSources({ sourceId: source.sourceId, refresh: true });
      } catch (error) {
        fail(error);
      }
      // The listing status (error, count, time) changes even when the refresh fails.
      await invalidate();
    },
    [client, fail, invalidate],
  );

  const setApiKey = useCallback(
    async (source: SkillSourceStatus, apiKey: string | null) => {
      if (!client) return false;
      try {
        await client.setSkillSourceApiKey({ sourceId: source.sourceId, apiKey });
        await invalidate();
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
    [client, fail, invalidate],
  );

  const restoreDefaults = useCallback(
    async (repos: readonly string[]) => {
      if (!client) return;
      try {
        for (const repo of repos) await client.addSkillSource({ source: repo });
      } catch (error) {
        fail(error);
      }
      await invalidate();
    },
    [client, fail, invalidate],
  );

  return useMemo(
    () => ({ add, setEnabled, remove, refresh, restoreDefaults, setApiKey }),
    [add, setEnabled, remove, refresh, restoreDefaults, setApiKey],
  );
}
