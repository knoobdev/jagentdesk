import { useEffect, useRef } from "react";
import { useRouter, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { confirmDialog } from "@/utils/confirm-dialog";
import { getHostRuntimeStore, useHostRegistryLoaded } from "@/runtime/host-runtime";
import { recreateLocalHost } from "@/runtime/migration/recreate-local-host";

/**
 * REQ 6: show a one-time warning when the user switches to Local connection mode
 * while tailnet hosts exist, because mobile devices can no longer reach the
 * daemon over Tailscale. The runtime store raises the flag; this hook renders it
 * through the shared toast host (which survives the navigation that Local-mode
 * switches typically trigger).
 */
function useConnectionModeLocalWarning(): void {
  const toast = useToast();
  const { t } = useTranslation();

  useEffect(() => {
    const store = getHostRuntimeStore();
    const show = () => {
      if (store.consumeLocalModeWarning()) {
        toast.show(t("connection.localMode.mobileWarning"), {
          variant: "warning",
          durationMs: 6000,
        });
      }
    };
    // Consume any warning raised before this listener mounted.
    show();
    return store.subscribeLocalModeWarning(show);
  }, [t, toast]);
}

/**
 * REQ 3: on app startup, re-notify the user about hosts that were still failing
 * to connect when the app was last closed. Tailnet hosts likely need a fresh
 * Tailscale login; local hosts exhausted their retries and are offered a
 * remove-and-recreate. Runs once per app session, after the host registry (and
 * the persisted timing-out set) has loaded.
 */
function useTimingOutHostNotifications(): void {
  const registryLoaded = useHostRegistryLoaded();
  const router = useRouter();
  const { t } = useTranslation();
  const toast = useToast();
  const notifiedRef = useRef(false);

  useEffect(() => {
    if (!registryLoaded || notifiedRef.current) {
      return;
    }
    notifiedRef.current = true;

    const entries = getHostRuntimeStore().getPersistedTimingOutHosts();
    if (entries.length === 0) {
      return;
    }

    void (async () => {
      for (const entry of entries) {
        if (entry.kind === "tailnet") {
          const confirmed = await confirmDialog({
            title: t("connection.timingOut.tailnet.title", { hostName: entry.label }),
            message: t("connection.timingOut.tailnet.message"),
            confirmLabel: t("connection.timingOut.tailnet.action"),
            cancelLabel: t("common.actions.dismiss"),
          });
          if (confirmed) {
            router.push("/tailscale-login" as Href);
            return;
          }
          continue;
        }

        const confirmed = await confirmDialog({
          title: t("connection.timingOut.local.title", { hostName: entry.label }),
          message: t("connection.timingOut.local.message"),
          confirmLabel: t("connection.timingOut.local.action"),
          cancelLabel: t("common.actions.dismiss"),
          destructive: true,
        });
        if (confirmed) {
          // Re-probe the same local endpoint and carry the host's data across
          // (REQ 4 + REQ 5). On probe failure the old host is preserved.
          try {
            const outcome = await recreateLocalHost(entry.serverId, {
              hostRuntime: getHostRuntimeStore(),
            });
            toast.show(
              outcome.status === "recreated"
                ? t("migration.recreateSuccess", { hostName: entry.label })
                : t("migration.recreateHealed", { hostName: entry.label }),
              { variant: "success" },
            );
          } catch (error) {
            console.error("[ConnectionNotifications] Failed to recreate local host", error);
            toast.show(t("migration.recreateFailed", { hostName: entry.label }), {
              variant: "error",
            });
          }
        }
      }
    })();
  }, [registryLoaded, router, t, toast]);
}

/**
 * Mounts the app-wide connection-health notifications (REQ 3 + REQ 6). Renders
 * nothing; it exists to run the hooks under the toast/dialog providers near the
 * root layout.
 */
export function ConnectionNotifications(): null {
  useConnectionModeLocalWarning();
  useTimingOutHostNotifications();
  return null;
}
