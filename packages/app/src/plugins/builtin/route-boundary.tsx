import { useCallback, useState, type ReactNode } from "react";
import { useHostRouteServerId } from "@/navigation/host-route-context";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { builtinPluginForRoute } from "./registry";
import { useBuiltinPluginEnabled, useBuiltinPlugins } from "./hooks";
import type { BuiltinPluginId } from "@jagentdesk/protocol/builtin-plugins";
import { builtinPluginCascade } from "@jagentdesk/protocol/builtin-plugins";
import { confirmDialog } from "@/utils/confirm-dialog";

function DisabledPlugin({ serverId, id }: { serverId: string; id: BuiltinPluginId }) {
  const { t } = useTranslation();
  const state = useBuiltinPlugins(serverId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plugin = state.data?.plugins.find((entry) => entry.id === id);
  const enable = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const plugins = state.data?.plugins ?? [];
      const related = builtinPluginCascade(plugins, id, true);
      if (related.length) {
        const names = plugins
          .filter((entry) => related.includes(entry.id))
          .map((entry) => entry.name)
          .join(", ");
        const title = t("builtinPlugins.alsoTurnOn", { names });
        if (!(await confirmDialog({ title, message: title }))) return;
      }
      await state.set(id, true, related.length > 0);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }, [id, state, t]);
  return (
    <View style={styles.container}>
      <Alert
        title={t("builtinPlugins.turnedOff")}
        description={plugin?.unavailableReason}
        testID="builtin-plugin-turned-off"
      >
        {state.data?.canManage && plugin?.available ? (
          <Button
            variant="outline"
            size="sm"
            disabled={pending || !state.connected}
            onPress={enable}
          >
            {t(pending ? "builtinPlugins.turningOn" : "builtinPlugins.turnOn")}
          </Button>
        ) : null}
      </Alert>
      {error || state.isError ? (
        <Alert variant="error" title={error ?? state.error?.message ?? ""} />
      ) : null}
    </View>
  );
}

export function BuiltinPluginScreenBoundary({
  serverId,
  id,
  children,
}: {
  serverId: string;
  id: BuiltinPluginId;
  children: ReactNode;
}) {
  const enabled = useBuiltinPluginEnabled(serverId, id);
  return enabled ? children : <DisabledPlugin serverId={serverId} id={id} />;
}
function BuiltinHostScreenLayout({
  children,
  routeName,
}: {
  children: ReactNode;
  routeName: string;
}) {
  const serverId = useHostRouteServerId();
  const id = builtinPluginForRoute(`/h/_/${routeName}`);
  if (!serverId || !id) return children;
  return (
    <BuiltinPluginScreenBoundary serverId={serverId} id={id}>
      {children}
    </BuiltinPluginScreenBoundary>
  );
}

// Keep the host navigator mounted: removing it drops its local serverId params on native/web.
// Gate each screen's content so hidden workspace screens retain their own route and state.
export function builtinPluginScreenLayout({
  children,
  route,
}: {
  children: ReactNode;
  route: { name: string };
}) {
  return <BuiltinHostScreenLayout routeName={route.name}>{children}</BuiltinHostScreenLayout>;
}
const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    padding: theme.spacing[6],
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface0,
  },
}));
