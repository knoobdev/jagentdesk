import { KanbanSquare } from "lucide-react-native";
import type { BuiltinClientHost } from "../../../packages/app/src/plugins/builtin/host-api";
import {
  JiraIssueAutoAttach,
  JiraIssuePill,
  type JiraComposerAttachment,
} from "./composer/jira-issue-attachment";
import { JiraOAuthDelegationBinder } from "./connections/oauth-delegation-binder";
import { JiraProviderConnectorsCard } from "./connections/provider-connectors-card";
import { JiraScreen } from "./jira-screen";
import { SidebarJiraNav } from "./sidebar-jira-nav";

export function register(app: BuiltinClientHost) {
  const destination = {
    id: "jira",
    title: "Jira",
    icon: KanbanSquare,
    group: "Tools" as const,
    route: (serverId: string) => `/h/${encodeURIComponent(serverId)}/jira`,
    routeSegment: "jira",
  };
  app.sidebarDestination(destination);
  app.mobileDrawerEntry(destination);
  app.leftPanel("jira", SidebarJiraNav);
  app.screen("jira", JiraScreen);
  // Desktop half of "Sign in on a desktop" (spec 29.1.1).
  app.hostMount("oauth-delegation", JiraOAuthDelegationBinder);
  app.attachmentPill("jira_issue", ({ attachment, onOpen, ...props }) =>
    attachment.kind === "jira_issue" ? (
      <JiraIssuePill {...props} attachment={attachment as JiraComposerAttachment} onOpen={onOpen} />
    ) : null,
  );
  // Pasted issue links and typed keys become `#ABC-123` chips (spec 29.4, A29.agent.2).
  app.composerTextWatcher("issue-auto-attach", JiraIssueAutoAttach);
  app.agentSettingsCard("provider-connectors", JiraProviderConnectorsCard, 50);
}
