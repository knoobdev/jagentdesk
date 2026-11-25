import type {
  BuiltinClientHost,
  BuiltinSidePanelProps,
} from "../../../packages/app/src/plugins/builtin/host-api";
import {
  ActivityGraphSheet,
  ActivityGraphSidePanel,
  ActivityGraphToggle,
  useActivityGraphOpen,
} from "./activity-graph-host";

// Chat + agent activity graph (spec 31.4): a resizable panel right of the chat on desktop, a
// full-screen sheet on phones.
function SidePanel(props: BuiltinSidePanelProps & { containerWidth: number }) {
  const { open } = useActivityGraphOpen(props.serverId, props.agentId);
  return open ? <ActivityGraphSidePanel {...props} /> : null;
}

export function register(app: BuiltinClientHost) {
  app.agentHeaderControl("activity-graph", ActivityGraphToggle);
  app.agentSidePanel("activity-graph", { panel: SidePanel, sheet: ActivityGraphSheet });
}
