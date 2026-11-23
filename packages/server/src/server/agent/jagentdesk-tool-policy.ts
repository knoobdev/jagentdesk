import type { ProviderJAgentDeskToolsPolicy } from "@jagentdesk/protocol/provider-config";

interface ProviderJAgentDeskToolSettings {
  jagentdeskTools?: ProviderJAgentDeskToolsPolicy;
}

export function resolveJAgentDeskToolPolicy(
  providerId: string,
  providerSettings: Readonly<Record<string, ProviderJAgentDeskToolSettings>> | undefined,
): ProviderJAgentDeskToolsPolicy | undefined {
  return providerSettings?.[providerId]?.jagentdeskTools;
}

export function isJAgentDeskToolEnabled(
  policy: ProviderJAgentDeskToolsPolicy | undefined,
  toolName: string,
): boolean {
  if (toolName === "speak") {
    return true;
  }
  if (!isJAgentDeskToolPolicyEnabled(policy)) {
    return false;
  }
  return !policy?.disabledTools?.includes(toolName);
}

export function isJAgentDeskToolPolicyEnabled(
  policy: ProviderJAgentDeskToolsPolicy | undefined,
): boolean {
  return policy?.enabled !== false;
}
