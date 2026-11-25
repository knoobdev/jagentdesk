import { useCallback, useState } from "react";
import type {
  JiraBoardColumn,
  JiraFieldInput,
  JiraStatus,
  JiraTransition,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import { errorMessage, JiraRpcError, useJiraCall } from "../api";
import { useJiraInvalidate } from "../queries";

// "Drop a card into column C" (reference §2.3, spec 29.3): the transitions whose target status is
// mapped to C; none → refuse with a reason; several → the user picks; a screen with required
// fields → the fields dialog; then run it. A failure leaves the card where it was (the board only
// moves after the refetch) and keeps the message visible.

export interface TransitionTarget {
  issue: { key: string; status: JiraStatus };
  column: JiraBoardColumn;
}

export type TransitionFlowState =
  | { kind: "idle" }
  | { kind: "loading"; issueKey: string }
  | { kind: "choose"; target: TransitionTarget; transitions: JiraTransition[] }
  | {
      kind: "fields";
      target: TransitionTarget;
      transition: JiraTransition;
      running: boolean;
      error: string | null;
      fieldErrors: Record<string, string>;
    }
  | { kind: "running"; issueKey: string }
  | { kind: "failed"; message: string };

export interface TransitionFlow {
  state: TransitionFlowState;
  start: (target: TransitionTarget) => Promise<void>;
  choose: (target: TransitionTarget, transition: JiraTransition) => Promise<void>;
  submitFields: (fields: Record<string, JiraFieldInput>) => Promise<void>;
  cancel: () => void;
}

function needsScreen(transition: JiraTransition): boolean {
  return transition.hasScreen && transition.fields.some((field) => field.required);
}

export function useTransitionFlow(input: {
  serverId: string;
  connectionId: string;
  onMoved?: (issueKey: string) => void;
}): TransitionFlow {
  const { serverId, connectionId, onMoved } = input;
  const call = useJiraCall(serverId);
  const invalidate = useJiraInvalidate(serverId, connectionId);
  const [state, setState] = useState<TransitionFlowState>({ kind: "idle" });

  const run = useCallback(
    async (
      target: TransitionTarget,
      transition: JiraTransition,
      fields: Record<string, JiraFieldInput>,
    ) => {
      try {
        await call("jira.issue.transition.request", {
          connectionId,
          issueKey: target.issue.key,
          transitionId: transition.id,
          ...(Object.keys(fields).length > 0 ? { fields } : {}),
        });
        await invalidate();
        setState({ kind: "idle" });
        onMoved?.(target.issue.key);
      } catch (error) {
        const fieldErrors = error instanceof JiraRpcError ? error.fieldErrors : {};
        if (needsScreen(transition) || Object.keys(fieldErrors).length > 0) {
          setState({
            kind: "fields",
            target,
            transition,
            running: false,
            error: errorMessage(error),
            fieldErrors,
          });
          return;
        }
        setState({ kind: "failed", message: errorMessage(error) });
      }
    },
    [call, connectionId, invalidate, onMoved],
  );

  const choose = useCallback(
    async (target: TransitionTarget, transition: JiraTransition) => {
      if (needsScreen(transition)) {
        setState({
          kind: "fields",
          target,
          transition,
          running: false,
          error: null,
          fieldErrors: {},
        });
        return;
      }
      setState({ kind: "running", issueKey: target.issue.key });
      await run(target, transition, {});
    },
    [run],
  );

  const start = useCallback(
    async (target: TransitionTarget) => {
      setState({ kind: "loading", issueKey: target.issue.key });
      let transitions: JiraTransition[];
      try {
        transitions = (
          await call("jira.issue.transitions.request", { connectionId, issueKey: target.issue.key })
        ).transitions;
      } catch (error) {
        setState({ kind: "failed", message: errorMessage(error) });
        return;
      }
      const statusIds = new Set(target.column.statusIds);
      const candidates = transitions.filter((transition) => statusIds.has(transition.to.id));
      const only = candidates[0];
      if (candidates.length === 0 || !only) {
        setState({
          kind: "failed",
          message: `No transition from ${target.issue.status.name} to ${target.column.name}.`,
        });
        return;
      }
      if (candidates.length > 1) {
        setState({ kind: "choose", target, transitions: candidates });
        return;
      }
      await choose(target, only);
    },
    [call, choose, connectionId],
  );

  const submitFields = useCallback(
    async (fields: Record<string, JiraFieldInput>) => {
      if (state.kind !== "fields") return;
      setState({ ...state, running: true, error: null, fieldErrors: {} });
      await run(state.target, state.transition, fields);
    },
    [run, state],
  );

  const cancel = useCallback(() => setState({ kind: "idle" }), []);

  return { state, start, choose, submitFields, cancel };
}

/** The issue key a flow is busy with, to show a spinner on that card. */
export function busyIssueKey(state: TransitionFlowState): string | null {
  if (state.kind === "loading" || state.kind === "running") return state.issueKey;
  if (state.kind === "fields" && state.running) return state.target.issue.key;
  return null;
}
