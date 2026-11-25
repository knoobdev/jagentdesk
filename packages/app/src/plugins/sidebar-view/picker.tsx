import { useCallback, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsSection } from "@/screens/settings/settings-section";
import { Combobox } from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { settingsStyles } from "@/styles/settings";
import { useInstalledPlugins } from "../registry";
import { sidebarViews } from "./catalog";
import { useSidebarViewSelection } from "./selection";

export function SidebarViewPicker() {
  const plugins = useInstalledPlugins();
  const views = useMemo(() => sidebarViews(plugins), [plugins]);
  const options = useMemo(
    () => [
      { id: "default", label: "Projects" },
      ...views.map((view) => ({ id: view.id, label: view.title })),
    ],
    [views],
  );
  const anchorRef = useRef<View | null>(null);
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const { state, setSelection, pending, error, reload } = useSidebarViewSelection();
  if (state.status === "loading") return <Text style={styles.message}>Loading sidebar views…</Text>;
  if (state.status === "error")
    return (
      <View>
        <Text style={styles.message}>{state.error.message}</Text>
        <Button onPress={reload}>Retry</Button>
      </View>
    );
  const missing =
    state.selection !== "default" && !views.some((view) => view.id === state.selection);
  return (
    <SettingsSection title="Sidebar">
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Sidebar view</Text>
            <Text style={settingsStyles.rowHint}>
              Saved on this device. Plugin views replace the middle of the sidebar.
            </Text>
          </View>
          <Combobox
            options={options}
            value={missing ? "default" : state.selection}
            onSelect={setSelection}
            title="Sidebar view"
            anchorRef={anchorRef}
            open={open}
            onOpenChange={setOpen}
          >
            <View ref={anchorRef}>
              <Button
                variant="outline"
                onPress={show}
                disabled={pending}
                testID="sidebar-view-picker"
              >
                {options.find((option) => option.id === state.selection)?.label ?? "Projects"}
              </Button>
            </View>
          </Combobox>
        </View>
        {missing ? (
          <Text style={styles.message}>
            The selected plugin view is unavailable. Projects is shown.
          </Text>
        ) : null}
        {error ? <Text style={styles.message}>{error.message}</Text> : null}
      </View>
    </SettingsSection>
  );
}
const styles = StyleSheet.create((theme) => ({
  message: { padding: 16, color: theme.colors.foregroundMuted },
}));
