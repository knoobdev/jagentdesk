import type { ReactElement } from "react";
import { Activity, CircleDashed, SquareTerminal } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { ICON_SIZE } from "@/styles/theme";

const ThemedSquareTerminal = withUnistyles(SquareTerminal, mutedIconColorMapping);
const ThemedActivity = withUnistyles(Activity, mutedIconColorMapping);
const ThemedCircleDashed = withUnistyles(CircleDashed, mutedIconColorMapping);

export type BackgroundWorkKind = "shell" | "monitor" | "heartbeat" | "other";

export function backgroundWorkKind(kind: string): BackgroundWorkKind {
  if (kind === "shell" || kind === "monitor" || kind === "heartbeat") return kind;
  return "other";
}

/** The 14 px muted glyph for a kind of background work: Shell, Monitor/heartbeat, Other. */
export function BackgroundWorkKindIcon({ kind }: { kind: BackgroundWorkKind }): ReactElement {
  if (kind === "shell") return <ThemedSquareTerminal size={ICON_SIZE.sm} />;
  if (kind === "monitor" || kind === "heartbeat") return <ThemedActivity size={ICON_SIZE.sm} />;
  return <ThemedCircleDashed size={ICON_SIZE.sm} />;
}
