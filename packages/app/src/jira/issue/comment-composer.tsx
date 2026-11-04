import { useCallback, useState } from "react";
import { View } from "react-native";
import { AtSign } from "lucide-react-native";
import type { JiraUser } from "@jagentdesk/protocol/jira/rpc-schemas";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { ErrorBanner, Input } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";
import { mentionMarkdown, useAsyncAction } from "./shared";
import { UserPicker } from "./user-picker";

const MENTION_HEADER = { title: "Mention someone" };

// Markdown comment editor with a mention picker; a mention is inserted as
// `[@Name](jira-mention:<ref>)`, which the daemon turns into an ADF mention or `[~username]`.

export function CommentComposer({
  serverId,
  connectionId,
  issueKey,
  initialText = "",
  submitLabel,
  onSubmit,
  onCancel,
  testID,
}: {
  serverId: string;
  connectionId: string;
  issueKey: string;
  initialText?: string;
  submitLabel: string;
  onSubmit: (markdown: string) => Promise<void>;
  onCancel?: () => void;
  testID: string;
}) {
  const [text, setText] = useState(initialText);
  const [picking, setPicking] = useState(false);
  const submit = useAsyncAction(
    useCallback(async () => {
      await onSubmit(text.trim());
      setText("");
    }, [onSubmit, text]),
  );
  const { run } = submit;
  const save = useCallback(() => void run(), [run]);
  const openPicker = useCallback(() => setPicking(true), []);
  const closePicker = useCallback(() => setPicking(false), []);
  const insertMention = useCallback((user: JiraUser) => {
    setText((current) => {
      const gap = current && !current.endsWith(" ") ? " " : "";
      return `${current}${gap}${mentionMarkdown(user)} `;
    });
    setPicking(false);
  }, []);
  return (
    <View style={jiraStyles.sheetBody}>
      <Input
        multiline
        value={text}
        onChangeText={setText}
        placeholder="Add a comment (Markdown)"
        testID={`${testID}-input`}
      />
      {submit.error ? <ErrorBanner message={submit.error} /> : null}
      <View style={jiraStyles.row}>
        <Button
          size="sm"
          variant="ghost"
          leftIcon={AtSign}
          onPress={openPicker}
          testID={`${testID}-mention`}
        >
          Mention
        </Button>
        <View style={jiraStyles.spacer} />
        {onCancel ? (
          <Button size="sm" variant="ghost" onPress={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="default"
          loading={submit.pending}
          disabled={text.trim().length === 0}
          onPress={save}
          testID={`${testID}-save`}
        >
          {submitLabel}
        </Button>
      </View>
      <AdaptiveModalSheet header={MENTION_HEADER} visible={picking} onClose={closePicker}>
        <UserPicker
          serverId={serverId}
          connectionId={connectionId}
          issueKey={issueKey}
          onPick={insertMention}
          testID={`${testID}-mention-picker`}
        />
      </AdaptiveModalSheet>
    </View>
  );
}
