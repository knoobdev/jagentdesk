import { useCallback, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import type { JiraIssueDetail, JiraLinkType } from "@jagentdesk/protocol/jira/rpc-schemas";
import { Button } from "@/components/ui/button";
import { useJiraCall } from "../api";
import { useJiraInvalidate } from "../queries";
import { ErrorBanner, Field, Input, IssueTypeIcon, StatusLozenge } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";
import { ValueChip, ValueRow } from "./controls";
import { openExternal, useAsyncAction } from "./shared";

// Subtasks, linked issues and web links of an issue (spec 29.3).

interface Props {
  serverId: string;
  connectionId: string;
  issue: JiraIssueDetail;
  onOpenIssue: (issueKey: string) => void;
}

type IssueProps = Omit<Props, "onOpenIssue">;

function SectionTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <View style={jiraStyles.row}>
      <Text style={jiraStyles.sectionLabel}>{title}</Text>
      <View style={jiraStyles.spacer} />
      {children}
    </View>
  );
}

function useToggle(): [boolean, () => void, () => void] {
  const [on, setOn] = useState(false);
  const toggle = useCallback(() => setOn((value) => !value), []);
  const off = useCallback(() => setOn(false), []);
  return [on, toggle, off];
}

function Subtasks({ serverId, connectionId, issue, onOpenIssue }: Props) {
  const [adding, toggleAdding, stopAdding] = useToggle();
  const [summary, setSummary] = useState("");
  const call = useJiraCall(serverId);
  const invalidate = useJiraInvalidate(serverId, connectionId);
  const create = useAsyncAction(
    useCallback(async () => {
      const meta = await call("jira.issue.create_meta.request", {
        connectionId,
        projectKey: issue.projectKey,
      });
      const subtaskType = meta.issueTypes.find((type) => type.subtask);
      if (!subtaskType) throw new Error("This project has no subtask issue type.");
      await call("jira.issue.create.request", {
        connectionId,
        projectKey: issue.projectKey,
        issueTypeId: subtaskType.id,
        summary: summary.trim(),
        parentKey: issue.key,
      });
      await invalidate();
      setSummary("");
      stopAdding();
    }, [call, connectionId, invalidate, issue.key, issue.projectKey, stopAdding, summary]),
  );
  const { run } = create;
  const submit = useCallback(() => void run(), [run]);
  if (issue.type.subtask) return null;
  return (
    <View style={jiraStyles.sheetBody} testID="jira-issue-subtasks">
      <SectionTitle title={`Subtasks (${issue.subtasks.length})`}>
        <Button size="xs" variant="ghost" onPress={toggleAdding} testID="jira-subtask-add">
          {adding ? "Cancel" : "Add subtask"}
        </Button>
      </SectionTitle>
      {issue.subtasks.map((subtask) => (
        <ValueRow
          key={subtask.id}
          value={subtask.key}
          onSelect={onOpenIssue}
          accessibilityLabel={`${subtask.key} ${subtask.summary}`}
          testID={`jira-subtask-${subtask.key}`}
        >
          <IssueTypeIcon type={subtask.type} />
          <Text style={jiraStyles.mono}>{subtask.key}</Text>
          <Text style={[jiraStyles.text, jiraStyles.spacer]} numberOfLines={1}>
            {subtask.summary}
          </Text>
          <StatusLozenge status={subtask.status} />
        </ValueRow>
      ))}
      {adding ? (
        <View style={jiraStyles.row}>
          <View style={jiraStyles.spacer}>
            <Input
              value={summary}
              onChangeText={setSummary}
              placeholder="What needs to be done?"
              autoFocus
              testID="jira-subtask-summary"
            />
          </View>
          <Button
            size="sm"
            variant="default"
            loading={create.pending}
            disabled={summary.trim().length === 0}
            onPress={submit}
            testID="jira-subtask-create"
          >
            Create
          </Button>
        </View>
      ) : null}
      {create.error ? <ErrorBanner message={create.error} /> : null}
    </View>
  );
}

interface LinkChoice {
  key: string;
  typeId: string;
  direction: "outward" | "inward";
  label: string;
}

function linkChoices(types: JiraLinkType[]): LinkChoice[] {
  return types.flatMap((type) => {
    const outward: LinkChoice = {
      key: `${type.id}-out`,
      typeId: type.id,
      direction: "outward",
      label: type.outward,
    };
    if (type.inward === type.outward) return [outward];
    const inward: LinkChoice = {
      key: `${type.id}-in`,
      typeId: type.id,
      direction: "inward",
      label: type.inward,
    };
    return [outward, inward];
  });
}

function LinkIssueForm({
  serverId,
  connectionId,
  issue,
  onDone,
}: IssueProps & { onDone: () => void }) {
  const [choice, setChoice] = useState<LinkChoice | null>(null);
  const [target, setTarget] = useState("");
  const call = useJiraCall(serverId);
  const invalidate = useJiraInvalidate(serverId, connectionId);
  const choices = linkChoices(issue.linkTypes);
  const selected = choice ?? choices[0] ?? null;
  const linkType = issue.linkTypes.find((type) => type.id === selected?.typeId) ?? null;
  const add = useAsyncAction(
    useCallback(async () => {
      if (!linkType || !selected) throw new Error("Pick a link type.");
      await call("jira.issue.links.add.request", {
        connectionId,
        issueKey: issue.key,
        link: {
          kind: "issue",
          linkTypeName: linkType.name,
          direction: selected.direction,
          targetKey: target.trim().toUpperCase(),
        },
      });
      await invalidate();
      onDone();
    }, [call, connectionId, invalidate, issue.key, linkType, onDone, selected, target]),
  );
  const { run } = add;
  const submit = useCallback(() => void run(), [run]);
  return (
    <View style={jiraStyles.sheetBody} testID="jira-link-form">
      <View style={jiraStyles.rowWrap}>
        {choices.map((option) => (
          <ValueChip
            key={option.key}
            label={option.label}
            value={option}
            active={selected?.key === option.key}
            onSelect={setChoice}
          />
        ))}
      </View>
      <Input
        value={target}
        onChangeText={setTarget}
        placeholder="Issue key, e.g. ABC-12"
        testID="jira-link-target"
      />
      {add.error ? <ErrorBanner message={add.error} /> : null}
      <View style={jiraStyles.sheetFooter}>
        <Button
          size="sm"
          variant="default"
          loading={add.pending}
          disabled={target.trim().length === 0 || !linkType}
          onPress={submit}
          testID="jira-link-save"
        >
          Link
        </Button>
      </View>
    </View>
  );
}

function LinkedIssues(props: Props) {
  const { issue, onOpenIssue } = props;
  const [adding, toggleAdding, stopAdding] = useToggle();
  return (
    <View style={jiraStyles.sheetBody} testID="jira-issue-links">
      <SectionTitle title={`Linked issues (${issue.links.length})`}>
        <Button size="xs" variant="ghost" onPress={toggleAdding} testID="jira-link-add">
          {adding ? "Cancel" : "Link issue"}
        </Button>
      </SectionTitle>
      {issue.links.map((link) => (
        <ValueRow
          key={link.id}
          value={link.issue.key}
          onSelect={onOpenIssue}
          accessibilityLabel={`${link.relation} ${link.issue.key}`}
          testID={`jira-link-${link.issue.key}`}
        >
          <Text style={jiraStyles.textSmall}>{link.relation}</Text>
          <Text style={jiraStyles.mono}>{link.issue.key}</Text>
          <Text style={[jiraStyles.text, jiraStyles.spacer]} numberOfLines={1}>
            {link.issue.summary}
          </Text>
          <StatusLozenge status={link.issue.status} />
        </ValueRow>
      ))}
      {adding ? (
        <LinkIssueForm
          serverId={props.serverId}
          connectionId={props.connectionId}
          issue={issue}
          onDone={stopAdding}
        />
      ) : null}
    </View>
  );
}

function WebLinks({ serverId, connectionId, issue }: IssueProps) {
  const [adding, toggleAdding, stopAdding] = useToggle();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const call = useJiraCall(serverId);
  const invalidate = useJiraInvalidate(serverId, connectionId);
  const add = useAsyncAction(
    useCallback(async () => {
      await call("jira.issue.links.add.request", {
        connectionId,
        issueKey: issue.key,
        link: { kind: "web", url: url.trim(), title: title.trim() || url.trim() },
      });
      await invalidate();
      setUrl("");
      setTitle("");
      stopAdding();
    }, [call, connectionId, invalidate, issue.key, stopAdding, title, url]),
  );
  const { run } = add;
  const submit = useCallback(() => void run(), [run]);
  return (
    <View style={jiraStyles.sheetBody} testID="jira-issue-weblinks">
      <SectionTitle title={`Web links (${issue.remoteLinks.length})`}>
        <Button size="xs" variant="ghost" onPress={toggleAdding} testID="jira-weblink-add">
          {adding ? "Cancel" : "Add web link"}
        </Button>
      </SectionTitle>
      {issue.remoteLinks.map((link) => (
        <ValueRow
          key={link.id}
          value={link.url}
          onSelect={openExternal}
          accessibilityLabel={link.title}
        >
          <Text style={jiraStyles.text} numberOfLines={1}>
            {link.title}
          </Text>
          <Text style={[jiraStyles.textSmall, jiraStyles.spacer]} numberOfLines={1}>
            {link.url}
          </Text>
        </ValueRow>
      ))}
      {adding ? (
        <View style={jiraStyles.sheetBody}>
          <Field label="URL">
            <Input
              value={url}
              onChangeText={setUrl}
              placeholder="https://"
              testID="jira-weblink-url"
            />
          </Field>
          <Field label="Title">
            <Input value={title} onChangeText={setTitle} testID="jira-weblink-title" />
          </Field>
          {add.error ? <ErrorBanner message={add.error} /> : null}
          <View style={jiraStyles.sheetFooter}>
            <Button
              size="sm"
              variant="default"
              loading={add.pending}
              disabled={!/^https?:\/\//.test(url.trim())}
              onPress={submit}
              testID="jira-weblink-save"
            >
              Add
            </Button>
          </View>
        </View>
      ) : null}
    </View>
  );
}

export function IssueRelations(props: Props) {
  return (
    <View style={jiraStyles.sheetBody}>
      <Subtasks {...props} />
      <LinkedIssues {...props} />
      <WebLinks serverId={props.serverId} connectionId={props.connectionId} issue={props.issue} />
    </View>
  );
}
