import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { SyncedLoader } from "@/components/synced-loader";
import type { Theme } from "@/styles/theme";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor } from "@/utils/status-dot-color";
const Loader = withUnistyles(SyncedLoader);
const colorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
export function ComposerTrackMark({ bucket }: { bucket: SidebarStateBucket | null }) {
  if (!bucket) return null;
  if (bucket === "running") return <Loader size={10} uniProps={colorMapping} />;
  return <View style={styles[bucket]} />;
}
const styles = StyleSheet.create((theme) => {
  const dot = (bucket: SidebarStateBucket) => ({
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: getStatusDotColor({ theme, bucket, showDoneAsInactive: true }) ?? undefined,
  });
  return {
    needs_input: dot("needs_input"),
    failed: dot("failed"),
    attention: dot("attention"),
    done: dot("done"),
  };
});
