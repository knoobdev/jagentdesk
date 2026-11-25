import {
  useHostFeature,
  type BuiltinClientHost,
  type BuiltinClientProps,
} from "../../../packages/app/src/plugins/builtin/host-api";
import { BrowserFingerprintProfilesCard } from "./fingerprint-profiles-card";
import { BrowserToolsOptInCard } from "./settings-card";

// The opt-in card serves daemons older than built-in plugin state; newer hosts turn the
// feature on in Settings → Plugins.
// COMPAT(builtinPlugins): added in v0.9.59; remove after 2027-05-24 once daemon floor supports feature gates.
function LegacyBrowserToolsOptInCard({ serverId }: BuiltinClientProps) {
  return useHostFeature(serverId, "builtinPlugins") ? null : (
    <BrowserToolsOptInCard serverId={serverId} />
  );
}

export function register(app: BuiltinClientHost) {
  app.agentSettingsCard("browser-tools-opt-in", LegacyBrowserToolsOptInCard, 10);
  app.agentSettingsCard("fingerprint-profiles", BrowserFingerprintProfilesCard, 40);
}
