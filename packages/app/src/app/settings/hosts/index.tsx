import { useLocalSearchParams } from "expo-router";
import SettingsScreen from "@/screens/settings-screen";

const HOSTS_VIEW = { kind: "section" as const, section: "hosts" as const };

export default function SettingsHostsSectionRoute() {
  const params = useLocalSearchParams<{ addHost?: string }>();
  const openAddHostIntent = typeof params.addHost === "string" ? params.addHost : null;
  return <SettingsScreen view={HOSTS_VIEW} openAddHostIntent={openAddHostIntent} />;
}
