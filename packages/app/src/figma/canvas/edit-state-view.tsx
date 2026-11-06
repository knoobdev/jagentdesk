import { Pressable, Text, View } from "react-native";
import { useMemo } from "react";
import { ErrorBanner } from "@/jira/ui/primitives";
import { jiraStyles } from "@/jira/ui/styles";
import { Badge } from "../ui/primitives";

// UI-only helpers for honest edit states (spec 32.6.1): what the Inspect panel and the edit
// toolbar render while changes sit in the pending queue, and what a failed edit looks like.
// The pure logic lives in ./edit-state.ts; the -view suffix keeps the two resolvable apart.

/** Pill marking a field whose displayed value comes from the queue, not from Figma. */
export function PendingBadge({ label = "Pending" }: { label?: string }) {
  return <Badge label={label} testID="figma-edit-pending" />;
}

/**
 * Panel-level caption: queued changes are not saved to the original file in Figma. The wording
 * claims nothing about where the queue lives (the daemon holds it, possibly remote), so the
 * only guarantee rendered here is "not saved in Figma yet" (32.6.1).
 */
export function PendingNote({ count }: { count: number }) {
  const noun = count === 1 ? "pending change" : "pending changes";
  return (
    <Text style={jiraStyles.textSmall} testID="figma-inspect-pending-note">
      {`${count} ${noun} here — not saved in Figma yet.`}
    </Text>
  );
}

/** A failed edit stays visible in the same context until the user retries or dismisses it. */
export function EditFailureBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  const action = useMemo(
    () => (
      <Pressable
        onPress={onDismiss}
        accessibilityRole="button"
        hitSlop={6}
        testID="figma-edit-error-dismiss"
      >
        <Text style={jiraStyles.textSmall}>Dismiss</Text>
      </Pressable>
    ),
    [onDismiss],
  );
  return (
    <View testID="figma-edit-error">
      <ErrorBanner message={message} action={action} />
    </View>
  );
}
