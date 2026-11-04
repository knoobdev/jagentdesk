// Agent activity graph (spec 31) strings. English ships to every locale except Vietnamese, which
// has its own copy in vi.ts; i18next falls back per key anyway.
export const activityGraphStrings = {
  toggle: "Activity graph",
  title: "Activity graph",
  live: "Live",
  close: "Close activity graph",
  flow: "Flow",
  plan: "Plan",
  turnPicker: "Choose a turn",
  turnCurrent: "Current turn",
  turnNumber: "Turn {{number}}",
  fit: "Fit",
  resize: "Resize activity graph",
  loading: "Drawing the graph…",
  empty: "No activity yet",
  emptyHint: "Send a prompt and the agent's steps appear here.",
  offline: "Connect to the host to see the activity graph.",
  failed: "Couldn't draw the activity graph.",
  retry: "Retry",
  legend: {
    running: "Running",
    waiting: "Waiting",
    done: "Done",
    failed: "Failed",
    pending: "Planned",
  },
} as const;
