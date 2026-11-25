import { useCallback } from "react";
import { ScrollView } from "react-native";
import { Container, HardDrive, Image } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { create } from "zustand";
import { GumloopRow } from "../../../packages/app/src/plugins/builtin/host-api";
export type DockerTab = "containers" | "images" | "volumes";
interface DockerNavigation {
  tabs: Record<string, DockerTab>;
  select: (serverId: string, tab: DockerTab) => void;
}
export const useDockerNavigation = create<DockerNavigation>((set) => ({
  tabs: {},
  select: (serverId, tab) => set((state) => ({ tabs: { ...state.tabs, [serverId]: tab } })),
}));
export function DockerSidebar({ serverId }: { serverId: string }) {
  const tab = useDockerNavigation((state) => state.tabs[serverId] ?? "containers");
  const select = useDockerNavigation((state) => state.select);
  const containers = useCallback(() => select(serverId, "containers"), [select, serverId]);
  const images = useCallback(() => select(serverId, "images"), [select, serverId]);
  const volumes = useCallback(() => select(serverId, "volumes"), [select, serverId]);
  return (
    <ScrollView contentContainerStyle={styles.content} testID="gumloop-docker-panel">
      <GumloopRow
        icon={Container}
        label="Containers"
        selected={tab === "containers"}
        onPress={containers}
      />
      <GumloopRow icon={Image} label="Images" selected={tab === "images"} onPress={images} />
      <GumloopRow icon={HardDrive} label="Volumes" selected={tab === "volumes"} onPress={volumes} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({ content: { paddingHorizontal: 10, paddingBottom: 16, gap: 3 } });
