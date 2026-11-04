import { useCallback, useState } from "react";
import { ScrollView, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Skeleton, useSkeletonPulse } from "@/components/ui/skeleton";
import type { Theme } from "@/styles/theme";
import { errorMessage } from "../api";
import { useJiraIssue } from "../queries";
import { useIssueWatch } from "../use-view-watch";
import { ErrorBanner } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";
import { IssueActivity } from "./activity";
import { IssueAttachments } from "./attachments";
import { IssueDescription } from "./description";
import { IssueFieldsPanel } from "./fields-panel";
import { IssueHeader } from "./header";
import { IssueRelations } from "./relations";

// Issue detail (spec 29.3): header, summary, description, subtasks, links, web links,
// attachments, side fields and Activity. Polls Jira every 15 s while open (useIssueWatch).

export interface IssueViewProps {
  serverId: string;
  connectionId: string;
  issueKey: string;
  active: boolean;
  isCompact: boolean;
  onClose: () => void;
  onOpenIssue: (issueKey: string) => void;
  onAskAi: (issueKey: string) => void;
  onWorkOn: (issueKey: string) => void;
}

// The side fields go beside the main column once the panel is this wide.
const WIDE_PANEL_PX = 760;

function IssueSkeleton() {
  const pulse = useSkeletonPulse();
  return (
    <View style={jiraStyles.sheetBody}>
      <Skeleton width="30%" height={16} pulse={pulse} radius={6} />
      <Skeleton width="80%" height={26} pulse={pulse} radius={6} />
      <Skeleton width="100%" height={120} pulse={pulse} radius={8} />
    </View>
  );
}

export function IssueView(props: IssueViewProps) {
  const { serverId, connectionId, issueKey } = props;
  useIssueWatch({ serverId, connectionId, issueKey, active: props.active });
  const issue = useJiraIssue(serverId, connectionId, issueKey);
  const [width, setWidth] = useState(0);
  const wide = !props.isCompact && width >= WIDE_PANEL_PX;
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width),
    [],
  );
  const { refetch } = issue;
  const retry = useCallback(() => void refetch(), [refetch]);

  if (!issue.data) {
    return (
      <View style={styles.root} testID="jira-issue-view">
        <View style={styles.content}>
          {issue.error ? (
            <View style={jiraStyles.sheetBody}>
              <ErrorBanner message={errorMessage(issue.error)} />
              <View style={jiraStyles.row}>
                <Button size="xs" variant="outline" onPress={retry}>
                  Retry
                </Button>
              </View>
            </View>
          ) : (
            <IssueSkeleton />
          )}
          <Button size="sm" variant="ghost" onPress={props.onClose} testID="jira-issue-close">
            Close
          </Button>
        </View>
      </View>
    );
  }

  const detail = issue.data;
  const main = (
    <View style={styles.mainColumn}>
      <IssueDescription serverId={serverId} connectionId={connectionId} issue={detail} />
      <IssueRelations
        serverId={serverId}
        connectionId={connectionId}
        issue={detail}
        onOpenIssue={props.onOpenIssue}
      />
      <IssueAttachments serverId={serverId} connectionId={connectionId} issue={detail} />
      {wide ? null : (
        <IssueFieldsPanel serverId={serverId} connectionId={connectionId} issue={detail} />
      )}
      <IssueActivity serverId={serverId} connectionId={connectionId} issueKey={detail.key} />
    </View>
  );

  return (
    <View style={styles.root} onLayout={onLayout} testID="jira-issue-view">
      <ScrollView style={jiraStyles.scroll} contentContainerStyle={styles.content}>
        <IssueHeader
          serverId={serverId}
          connectionId={connectionId}
          issue={detail}
          isCompact={props.isCompact}
          onClose={props.onClose}
          onOpenIssue={props.onOpenIssue}
          onAskAi={props.onAskAi}
          onWorkOn={props.onWorkOn}
        />
        {wide ? (
          <View style={styles.columns}>
            {main}
            <View style={styles.sideColumn}>
              <IssueFieldsPanel serverId={serverId} connectionId={connectionId} issue={detail} />
            </View>
          </View>
        ) : (
          main
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  root: { flex: 1, minHeight: 0, minWidth: 0, backgroundColor: theme.colors.surface0 },
  content: { padding: theme.spacing[4], gap: theme.spacing[4] },
  columns: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[6] },
  mainColumn: { flex: 1, minWidth: 0, gap: theme.spacing[6] },
  sideColumn: {
    width: 280,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
}));
