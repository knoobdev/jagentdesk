import type { ComponentType } from "react";
import {
  Bot,
  Brain,
  Eye,
  MicVocal,
  Pencil,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
} from "lucide-react-native";
import type { ToolCallDetail } from "@jagentdesk/protocol/agent-types";
import { JAgentDeskLogo } from "@/components/icons/jagentdesk-logo";
import { resolveToolCallIconName, type ToolCallIcon } from "./tool-call-icon-name";

export type ToolCallIconComponent = ComponentType<{ size?: number; color?: string }>;

const ICON_COMPONENTS: Record<ToolCallIcon, ToolCallIconComponent> = {
  wrench: Wrench,
  square_terminal: SquareTerminal,
  eye: Eye,
  pencil: Pencil,
  search: Search,
  bot: Bot,
  sparkles: Sparkles,
  brain: Brain,
  mic_vocal: MicVocal,
  jagentdesk: JAgentDeskLogo,
};

export function componentForToolCallIcon(name: ToolCallIcon): ToolCallIconComponent {
  return ICON_COMPONENTS[name];
}

export function resolveToolCallIcon(
  toolName: string,
  detail?: ToolCallDetail,
): ToolCallIconComponent {
  return componentForToolCallIcon(resolveToolCallIconName(toolName, detail));
}
