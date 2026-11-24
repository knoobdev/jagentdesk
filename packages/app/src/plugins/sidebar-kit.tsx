import { createContext, useContext } from "react";
import { View } from "react-native";
import { Blocks } from "lucide-react-native";
import type { SidebarRowProps } from "@jagentdesk/plugin/client/ui";
import { StyleSheet } from "react-native-unistyles";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { resolvePluginIcon } from "./icons";
export const SidebarFrame = createContext<{ title: string; testID: string } | null>(null);
export function SidebarRow({ id, icon, label, onPress, active, trailing }: SidebarRowProps) {
  const frame = useContext(SidebarFrame);
  if (!frame) throw new Error("SidebarRow must be rendered inside a plugin sidebar item");
  const Icon = icon ? resolvePluginIcon(icon) : Blocks;
  return (
    <View style={styles.row}>
      <View style={styles.rowBody}>
        <SidebarHeaderRow
          icon={Icon as typeof Blocks}
          label={label ?? frame.title}
          onPress={onPress}
          isActive={active}
          variant="compact"
          testID={id ? `${frame.testID}-${id}` : frame.testID}
        />
      </View>
      {trailing}
    </View>
  );
}
export function SidebarSeparator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: "row", alignItems: "center" },
  rowBody: { flex: 1 },
  separator: { height: 1, backgroundColor: theme.colors.border, marginVertical: theme.spacing[2] },
}));
