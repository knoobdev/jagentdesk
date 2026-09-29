import { useCallback, useMemo } from "react";
import * as Clipboard from "expo-clipboard";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { SkillEntry } from "@jagentdesk/protocol/native-skills";
import { useToast } from "@/contexts/toast-context";
import { refreshSkillCatalogs } from "@/stores/skills-store";
import { skillErrorMessage, skillProviderLabel } from "@/skills/native-skill-logic";
import { confirmDialog } from "@/utils/confirm-dialog";

/**
 * Daemon mutations behind the Skills UI (spec 22.4/22.6/22.8). Confirms before
 * touching a skill JAgentDesk does not own (ADR-0022 decision 3), reports errors
 * as toasts, and refreshes the cached catalogs afterwards (the daemon also pushes
 * `status:skills_changed`). Every function resolves to null when the user
 * cancels or the request fails.
 */
export interface SkillActions {
  setEnabled: (entry: SkillEntry, enabled: boolean) => Promise<SkillEntry | null>;
  uninstall: (entry: SkillEntry) => Promise<boolean>;
  /** Fork after the "Create your own copy to train?" confirmation. */
  forkToTrain: (entry: SkillEntry) => Promise<SkillEntry | null>;
  /** Plain fork (menu action, no confirmation). */
  fork: (entry: SkillEntry) => Promise<SkillEntry | null>;
  /** Owned copy the given provider can read (composer "Install for <provider>"). */
  installFor: (entry: SkillEntry, provider: string) => Promise<SkillEntry | null>;
  graduate: (entry: SkillEntry) => Promise<boolean>;
  copyPath: (path: string) => void;
}

function cwdFor(entry: SkillEntry): { cwd?: string } {
  return entry.projectRoot ? { cwd: entry.projectRoot } : {};
}

export function useSkillActions(client: DaemonClient | null): SkillActions {
  const { t } = useTranslation();
  const toast = useToast();

  const fail = useCallback(
    (error: unknown) => {
      toast.error(t("skillsHub.toasts.failed", { message: skillErrorMessage(error) }));
    },
    [t, toast],
  );

  const setEnabled = useCallback(
    async (entry: SkillEntry, enabled: boolean): Promise<SkillEntry | null> => {
      if (!client) return null;
      const needsConfirm = !entry.owned && !enabled;
      if (needsConfirm) {
        const ok = await confirmDialog({
          title: t("skillsHub.confirm.disableTitle", { name: entry.name }),
          message: t("skillsHub.confirm.disableMessage"),
          confirmLabel: t("skillsHub.confirm.disable"),
          cancelLabel: t("common.actions.cancel"),
          destructive: true,
        });
        if (!ok) return null;
      }
      try {
        const { skill } = await client.setSkillEnabled({
          skillId: entry.skillId,
          enabled,
          ...cwdFor(entry),
          ...(entry.owned ? {} : { confirm: true }),
        });
        toast.show(
          t(enabled ? "skillsHub.toasts.enabled" : "skillsHub.toasts.disabled", {
            name: entry.name,
          }),
        );
        refreshSkillCatalogs();
        return skill;
      } catch (error) {
        fail(error);
        return null;
      }
    },
    [client, fail, t, toast],
  );

  const uninstall = useCallback(
    async (entry: SkillEntry): Promise<boolean> => {
      if (!client) return false;
      const ok = await confirmDialog({
        title: t("skillsHub.confirm.uninstallTitle", { name: entry.name }),
        message: t(
          entry.owned ? "skillsHub.confirm.uninstallOwned" : "skillsHub.confirm.uninstallExternal",
        ),
        confirmLabel: t("skillsHub.confirm.uninstall"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (!ok) return false;
      try {
        await client.uninstallSkill({
          skillId: entry.skillId,
          ...cwdFor(entry),
          ...(entry.owned ? {} : { confirm: true }),
        });
        toast.show(t("skillsHub.toasts.uninstalled", { name: entry.name }));
        refreshSkillCatalogs();
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
    [client, fail, t, toast],
  );

  const fork = useCallback(
    async (entry: SkillEntry): Promise<SkillEntry | null> => {
      if (!client) return null;
      try {
        const { skill } = await client.forkSkill({ skillId: entry.skillId, ...cwdFor(entry) });
        toast.show(t("skillsHub.toasts.forked", { name: skill.name }));
        refreshSkillCatalogs();
        return skill;
      } catch (error) {
        fail(error);
        return null;
      }
    },
    [client, fail, t, toast],
  );

  const forkToTrain = useCallback(
    async (entry: SkillEntry): Promise<SkillEntry | null> => {
      const ok = await confirmDialog({
        title: t("skillsHub.confirm.forkTitle"),
        message: t("skillsHub.confirm.forkMessage", { name: entry.name }),
        confirmLabel: t("skillsHub.confirm.fork"),
        cancelLabel: t("common.actions.cancel"),
      });
      return ok ? fork(entry) : null;
    },
    [fork, t],
  );

  const installFor = useCallback(
    async (entry: SkillEntry, provider: string): Promise<SkillEntry | null> => {
      const providerLabel = skillProviderLabel(provider);
      const ok = await confirmDialog({
        title: t("skillsHub.confirm.installForTitle", {
          name: entry.name,
          provider: providerLabel,
        }),
        message: t("skillsHub.confirm.installForMessage", { provider: providerLabel }),
        confirmLabel: t("skillsHub.confirm.install"),
        cancelLabel: t("common.actions.cancel"),
      });
      return ok ? fork(entry) : null;
    },
    [fork, t],
  );

  // COMPAT(nativeSkills): there is no native graduate RPC; the legacy mutate op
  // maps onto the owned skill's lock training state (compat id = legacyId ?? skillId).
  const graduate = useCallback(
    async (entry: SkillEntry): Promise<boolean> => {
      if (!client || !entry.owned) return false;
      try {
        await client.mutateSkills({ op: "graduate", id: entry.legacyId ?? entry.skillId });
        refreshSkillCatalogs();
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
    [client, fail],
  );

  const copyPath = useCallback(
    (path: string) => {
      void Clipboard.setStringAsync(path).then(() => {
        toast.show(t("skillsHub.toasts.pathCopied"));
        return undefined;
      });
    },
    [t, toast],
  );

  return useMemo(
    () => ({ setEnabled, uninstall, forkToTrain, fork, installFor, graduate, copyPath }),
    [setEnabled, uninstall, forkToTrain, fork, installFor, graduate, copyPath],
  );
}
