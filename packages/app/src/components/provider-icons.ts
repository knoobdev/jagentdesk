import { AntigravityIcon } from "@/components/icons/antigravity-icon";
import { KiroIcon } from "@/components/icons/kiro-icon";
import { Bot } from "lucide-react-native";
import { createElement, type ComponentType } from "react";
import { SvgXml } from "react-native-svg";
import { TERMINAL_PROFILE_ICON_NAMES } from "@jagentdesk/protocol/provider-icon-names";
import { ClaudeIcon } from "@/components/icons/claude-icon";
import { CodexIcon } from "@/components/icons/codex-icon";
import { CopilotIcon } from "@/components/icons/copilot-icon";
import { MiniMaxIcon } from "@/components/icons/minimax-icon";
import { OpenCodeIcon } from "@/components/icons/opencode-icon";
import { OmpIcon } from "@/components/icons/omp-icon";
import { PiIcon } from "@/components/icons/pi-icon";
import { ACP_PROVIDER_ICON_SVGS } from "@/assets/acp-provider-icons";
import { ACP_PROVIDER_CATALOG } from "@/data/acp-provider-catalog";
import { resolveProviderIconName } from "@/components/provider-icon-name";

export interface ProviderIconProps {
  size: number;
  color: string;
}

export type ProviderIconComponent = ComponentType<ProviderIconProps>;

const BUILTIN_PROVIDER_ICONS: Record<string, ProviderIconComponent> = {
  claude: ClaudeIcon as unknown as ProviderIconComponent,
  codex: CodexIcon as unknown as ProviderIconComponent,
  copilot: CopilotIcon as unknown as ProviderIconComponent,
  antigravity: AntigravityIcon,
  kiro: KiroIcon,
  minimax: MiniMaxIcon as unknown as ProviderIconComponent,
  omp: OmpIcon as unknown as ProviderIconComponent,
  opencode: OpenCodeIcon as unknown as ProviderIconComponent,
  pi: PiIcon as unknown as ProviderIconComponent,
};

const CATALOG_ICON_SVGS = new Map<string, string>(
  ACP_PROVIDER_CATALOG.flatMap((entry) => (entry.iconSvg ? [[entry.id, entry.iconSvg]] : [])),
);

for (const name of TERMINAL_PROFILE_ICON_NAMES) {
  const iconSvg = (ACP_PROVIDER_ICON_SVGS as Record<string, string | undefined>)[name];
  if (iconSvg) {
    CATALOG_ICON_SVGS.set(name, iconSvg);
  }
}

for (const [id, svg] of Object.entries(ACP_PROVIDER_ICON_SVGS)) CATALOG_ICON_SVGS.set(id, svg);

const catalogIconComponents = new Map<string, ProviderIconComponent>();

function createCatalogIcon(provider: string, iconSvg: string): ProviderIconComponent {
  const CatalogProviderIcon: ProviderIconComponent = ({ size, color }) =>
    createElement(SvgXml, {
      xml: iconSvg,
      width: size,
      height: size,
      color,
    });
  CatalogProviderIcon.displayName = `CatalogProviderIcon(${provider})`;
  return CatalogProviderIcon;
}

function getCatalogProviderIcon(provider: string): ProviderIconComponent {
  const cached = catalogIconComponents.get(provider);
  if (cached) {
    return cached;
  }
  const iconSvg = CATALOG_ICON_SVGS.get(provider);
  if (!iconSvg) {
    return Bot;
  }
  const icon = createCatalogIcon(provider, iconSvg);
  catalogIconComponents.set(provider, icon);
  return icon;
}

export function getProviderIcon(provider: string): ProviderIconComponent {
  const name = resolveProviderIconName(provider);
  if (name.kind === "builtin") {
    return BUILTIN_PROVIDER_ICONS[name.id];
  }
  if (name.kind === "catalog") {
    return getCatalogProviderIcon(name.id);
  }
  return Bot;
}

export function SvgIcon({ svg, size, color }: ProviderIconProps & { svg: string }) {
  return createElement(SvgXml, { xml: svg, width: size, height: size, color });
}
