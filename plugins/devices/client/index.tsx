import { Smartphone } from "lucide-react-native";
import type { BuiltinClientHost } from "../../../packages/app/src/plugins/builtin/host-api";
import { SimFleetScreen } from "./sim-fleet-screen";

export function register(app: BuiltinClientHost) {
  // Simulators, physical phones (spec 27.2) and Sideload (26.9) share one fleet screen; it
  // appears only on hosts that can run one of them (spec 24.4).
  const destination = {
    id: "simulators",
    title: "Simulators",
    shortTitle: "Sims",
    icon: Smartphone,
    group: "Tools" as const,
    route: (serverId: string) => `/h/${encodeURIComponent(serverId)}/simulator`,
    routeSegment: "simulator",
    hostCapabilities: [
      "iosSimulators",
      "androidDevices",
      "androidPhysical",
      "iosPhysical",
      "iosSideload",
    ] as const,
  };
  app.sidebarDestination(destination);
  app.mobileDrawerEntry(destination);
  app.screen("simulator", SimFleetScreen);
}
