import { withUnistyles } from "react-native-unistyles";
import {
  Box,
  Boxes,
  Clock,
  Copy,
  Database,
  FileText,
  HardDrive,
  KeyRound,
  Layers,
  Network,
  Server,
  Settings2,
  Shield,
  TriangleAlert,
  Waypoints,
} from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import type { ComponentType } from "react";

const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const activeColor = (theme: Theme) => ({ color: theme.colors.foreground });

type IconComp = ComponentType<{ size?: number; uniProps?: (theme: Theme) => { color: string } }>;

const ThemedBox = withUnistyles(Box) as IconComp;
const ThemedBoxes = withUnistyles(Boxes) as IconComp;
const ThemedClock = withUnistyles(Clock) as IconComp;
const ThemedCopy = withUnistyles(Copy) as IconComp;
const ThemedDatabase = withUnistyles(Database) as IconComp;
const ThemedFileText = withUnistyles(FileText) as IconComp;
const ThemedHardDrive = withUnistyles(HardDrive) as IconComp;
const ThemedKeyRound = withUnistyles(KeyRound) as IconComp;
const ThemedLayers = withUnistyles(Layers) as IconComp;
const ThemedNetwork = withUnistyles(Network) as IconComp;
const ThemedServer = withUnistyles(Server) as IconComp;
const ThemedSettings2 = withUnistyles(Settings2) as IconComp;
const ThemedShield = withUnistyles(Shield) as IconComp;
const ThemedTriangleAlert = withUnistyles(TriangleAlert) as IconComp;
const ThemedWaypoints = withUnistyles(Waypoints) as IconComp;

const KIND_ICON: Record<string, IconComp> = {
  Pod: ThemedBox,
  Deployment: ThemedLayers,
  ReplicaSet: ThemedCopy,
  ReplicationController: ThemedCopy,
  DaemonSet: ThemedCopy,
  StatefulSet: ThemedDatabase,
  Job: ThemedClock,
  CronJob: ThemedClock,
  Node: ThemedServer,
  Namespace: ThemedBoxes,
  Event: ThemedTriangleAlert,
  ConfigMap: ThemedFileText,
  Secret: ThemedKeyRound,
  ResourceQuota: ThemedFileText,
  LimitRange: ThemedFileText,
  Service: ThemedNetwork,
  Endpoints: ThemedNetwork,
  Ingress: ThemedWaypoints,
  IngressClass: ThemedWaypoints,
  NetworkPolicy: ThemedWaypoints,
  PersistentVolumeClaim: ThemedDatabase,
  PersistentVolume: ThemedHardDrive,
  StorageClass: ThemedHardDrive,
  ServiceAccount: ThemedShield,
  Role: ThemedShield,
  ClusterRole: ThemedShield,
  RoleBinding: ThemedShield,
  ClusterRoleBinding: ThemedShield,
};

export function KindIcon({ kind, active }: { kind: string; active?: boolean }) {
  const Icon = KIND_ICON[kind] ?? ThemedSettings2;
  return <Icon size={15} uniProps={active ? activeColor : mutedColor} />;
}
