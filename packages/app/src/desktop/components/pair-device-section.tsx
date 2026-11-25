import { PairDaemonSection } from "./pair-daemon-section";
export function PairDeviceSection(props: { serverId: string; onClose(): void }) {
  return <PairDaemonSection {...props} />;
}
