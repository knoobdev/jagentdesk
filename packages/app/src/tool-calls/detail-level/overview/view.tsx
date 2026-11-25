import { IndentRail } from "@/components/indent-rail";
import { useOverviewSummaryLabel } from "./label";
import { useDisclosureHold } from "@/agent-stream/disclosure";
import { memo, useCallback, useRef, type ReactNode } from "react";
import { ScrollView } from "react-native";
import { Wrench } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { ExpandableBadge } from "@/components/message";
import { type OverviewToolCallGroup } from "./model";

interface OverviewGroupProps {
  group: OverviewToolCallGroup;
  expanded: boolean;
  isLastInSequence: boolean;
  onExpandedChange: (groupId: string, expanded: boolean) => void;
  children: ReactNode;
}

const TOOL_CALL_GROUP_MAX_HEIGHT = 400;

export const OverviewToolCallGroupView = memo(function OverviewToolCallGroupView({
  group,
  expanded,
  isLastInSequence,
  onExpandedChange,
  children,
}: OverviewGroupProps) {
  const aggregateSummary = useOverviewSummaryLabel(group.summary);
  const hold = useDisclosureHold();
  const toggle = useCallback(() => {
    hold(() => onExpandedChange(group.run.id, !expanded));
  }, [expanded, group.run.id, hold, onExpandedChange]);
  const renderDetails = useCallback(
    () => <InlineGroupDetails latestCallId={group.run.latest.id}>{children}</InlineGroupDetails>,
    [children, group.run.latest.id],
  );

  return (
    <ExpandableBadge
      testID="tool-call-group"
      label={aggregateSummary}
      icon={Wrench}
      isLoading={group.isLoading}
      isExpanded={expanded}
      isLastInSequence={isLastInSequence}
      onToggle={toggle}
      renderDetails={renderDetails}
      borderlessWhenExpanded
    />
  );
});

function InlineGroupDetails({
  latestCallId,
  children,
}: {
  latestCallId: string;
  children: ReactNode;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const lastRevealedCall = useRef<string | null>(null);
  const revealLatestCall = useCallback(() => {
    // A disclosure changes height without appending a call. Keep the reader's place then.
    if (lastRevealedCall.current === latestCallId) return;
    lastRevealedCall.current = latestCallId;
    scrollRef.current?.scrollToEnd({ animated: false });
  }, [latestCallId]);
  return (
    <ScrollView
      ref={scrollRef}
      style={styles.scroll}
      contentContainerStyle={styles.content}
      nestedScrollEnabled
      showsVerticalScrollIndicator
      onContentSizeChange={revealLatestCall}
    >
      <IndentRail>{children}</IndentRail>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  scroll: {
    maxHeight: TOOL_CALL_GROUP_MAX_HEIGHT,
  },
  content: {
    paddingTop: theme.spacing[1],
    paddingHorizontal: 13,
  },
}));
