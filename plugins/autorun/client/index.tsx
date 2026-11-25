import {
  useHostFeature,
  type BuiltinClientHost,
  type BuiltinClientProps,
} from "../../../packages/app/src/plugins/builtin/host-api";
import { AutonomousControl } from "./autonomous-control";
import { AutorunOptInCard } from "./settings-card";

// The opt-in card serves daemons older than built-in plugin state; newer hosts turn the
// feature on in Settings → Plugins.
// COMPAT(builtinPlugins): added in v0.9.59; remove after 2027-05-24 once daemon floor supports feature gates.
function LegacyAutorunOptInCard({ serverId }: BuiltinClientProps) {
  return useHostFeature(serverId, "builtinPlugins") ? null : (
    <AutorunOptInCard serverId={serverId} />
  );
}

export function register(app: BuiltinClientHost) {
  app.agentControl("autorun", AutonomousControl);
  app.agentSettingsCard("autorun-opt-in", LegacyAutorunOptInCard, 20);
}
