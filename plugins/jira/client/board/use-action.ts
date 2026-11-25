import { useCallback, useReducer } from "react";
import { errorMessage } from "../api";

// One fallible user action (docs/testing.md "Fallible user actions"): pending while it runs,
// the error kept visible until the next attempt or a dismiss.

type ActionStatus = { kind: "idle" } | { kind: "pending" } | { kind: "failed"; message: string };

type ActionEvent =
  | { type: "start" }
  | { type: "succeed" }
  | { type: "fail"; message: string }
  | { type: "clear" };

function reduce(_state: ActionStatus, event: ActionEvent): ActionStatus {
  switch (event.type) {
    case "start":
      return { kind: "pending" };
    case "fail":
      return { kind: "failed", message: event.message };
    case "succeed":
    case "clear":
      return { kind: "idle" };
  }
}

export interface JiraAction {
  pending: boolean;
  error: string | null;
  /** Runs the task; resolves true on success, false when it failed (the error is kept). */
  run: (task: () => Promise<void>) => Promise<boolean>;
  clear: () => void;
}

export function useAction(): JiraAction {
  const [status, dispatch] = useReducer(reduce, { kind: "idle" });
  const run = useCallback(async (task: () => Promise<void>) => {
    dispatch({ type: "start" });
    try {
      await task();
      dispatch({ type: "succeed" });
      return true;
    } catch (error) {
      dispatch({ type: "fail", message: errorMessage(error) });
      return false;
    }
  }, []);
  const clear = useCallback(() => dispatch({ type: "clear" }), []);
  return {
    pending: status.kind === "pending",
    error: status.kind === "failed" ? status.message : null,
    run,
    clear,
  };
}
