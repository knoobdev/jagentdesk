import { FileUp, Smartphone, UserRound } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

// Icons follow the theme (light/dark) like the rest of SimFleet.
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export const UploadIcon = withUnistyles(FileUp, muted);
export const DeviceIcon = withUnistyles(Smartphone, muted);
export const AccountIcon = withUnistyles(UserRound, muted);
