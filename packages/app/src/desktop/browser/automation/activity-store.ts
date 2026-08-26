import { create } from "zustand";

/**
 * Live log of the browser-automation commands an agent runs, keyed by browserId.
 * Fed from the single choke point every command passes through
 * (mountBrowserAutomationHandler → begin/finish). This is REAL data — each entry
 * is an actual browser_* tool call the agent issued — and powers the Agentic
 * Browser cockpit's step timeline, "agent driving" badge, and action counter.
 */
export type BrowserStepStatus = "running" | "done" | "failed";

export interface BrowserStep {
  id: string;
  browserId: string | null;
  command: string;
  label: string;
  detail: string;
  status: BrowserStepStatus;
  agentId: string | undefined;
  startedAt: number;
  endedAt: number | null;
  errorCode: string | undefined;
}

interface BeginInput {
  requestId: string;
  command: string;
  browserId: string | null;
  agentId: string | undefined;
  args: Record<string, unknown> | undefined;
}

interface FinishInput {
  requestId: string;
  ok: boolean;
  browserId: string | null;
  errorCode: string | undefined;
}

interface BrowserActivityState {
  /** Steps per browserId, oldest → newest, capped. */
  stepsByBrowser: Record<string, BrowserStep[]>;
  /** Steps whose browserId is not yet known (new_tab in flight), keyed by requestId. */
  pending: Record<string, BrowserStep>;
  begin: (input: BeginInput) => void;
  finish: (input: FinishInput) => void;
  clear: (browserId: string) => void;
}

const MAX_STEPS_PER_BROWSER = 60;

// Not every command name maps 1:1 to a friendly verb; keep it honest and terse.
const COMMAND_LABELS: Record<string, string> = {
  new_tab: "Open tab",
  navigate: "Navigate",
  back: "Back",
  forward: "Forward",
  reload: "Reload",
  click: "Click",
  fill: "Fill field",
  type: "Type",
  keypress: "Press key",
  snapshot: "Read page",
  screenshot: "Screenshot",
  evaluate: "Run script",
  wait: "Wait",
  scroll: "Scroll",
  hover: "Hover",
  select: "Select",
  drag: "Drag",
  upload: "Upload",
  resize: "Resize",
  list_tabs: "List tabs",
  close_tab: "Close tab",
};

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function detailFor(command: string, args: Record<string, unknown> | undefined): string {
  if (!args) {
    return "";
  }
  if (typeof args.url === "string" && args.url) {
    return shortUrl(args.url);
  }
  if (typeof args.ref === "string" && args.ref) {
    return String(args.ref);
  }
  if (command === "wait" && typeof args.text === "string") {
    return `“${args.text}”`;
  }
  if (typeof args.value === "string") {
    return args.value.length > 24 ? `${args.value.slice(0, 24)}…` : args.value;
  }
  return "";
}

function appendStep(list: BrowserStep[] | undefined, step: BrowserStep): BrowserStep[] {
  const next = [...(list ?? []), step];
  return next.length > MAX_STEPS_PER_BROWSER ? next.slice(next.length - MAX_STEPS_PER_BROWSER) : next;
}

export const useBrowserActivityStore = create<BrowserActivityState>()((set) => ({
  stepsByBrowser: {},
  pending: {},
  begin: (input) => {
    const step: BrowserStep = {
      id: input.requestId,
      browserId: input.browserId,
      command: input.command,
      label: COMMAND_LABELS[input.command] ?? input.command,
      detail: detailFor(input.command, input.args),
      status: "running",
      agentId: input.agentId,
      startedAt: Date.now(),
      endedAt: null,
      errorCode: undefined,
    };
    set((state) => {
      if (input.browserId) {
        return {
          stepsByBrowser: {
            ...state.stepsByBrowser,
            [input.browserId]: appendStep(state.stepsByBrowser[input.browserId], step),
          },
        };
      }
      return { pending: { ...state.pending, [input.requestId]: step } };
    });
  },
  finish: (input) => {
    set((state) => {
      const status: BrowserStepStatus = input.ok ? "done" : "failed";
      // Resolve a pending (new_tab) step into its now-known browserId.
      const pendingStep = state.pending[input.requestId];
      if (pendingStep && input.browserId) {
        const resolved: BrowserStep = {
          ...pendingStep,
          browserId: input.browserId,
          status,
          endedAt: Date.now(),
          errorCode: input.errorCode,
        };
        const { [input.requestId]: _omit, ...restPending } = state.pending;
        return {
          pending: restPending,
          stepsByBrowser: {
            ...state.stepsByBrowser,
            [input.browserId]: appendStep(state.stepsByBrowser[input.browserId], resolved),
          },
        };
      }
      if (pendingStep) {
        // new_tab failed before a browserId existed — drop it from pending, keep quiet.
        const { [input.requestId]: _omit, ...restPending } = state.pending;
        return { pending: restPending };
      }
      const browserId = input.browserId;
      if (!browserId) {
        return {};
      }
      const list = state.stepsByBrowser[browserId];
      if (!list) {
        return {};
      }
      const idx = list.findIndex((s) => s.id === input.requestId);
      if (idx === -1) {
        return {};
      }
      const nextList = list.slice();
      nextList[idx] = {
        ...nextList[idx],
        status,
        endedAt: Date.now(),
        errorCode: input.errorCode,
      };
      return {
        stepsByBrowser: { ...state.stepsByBrowser, [browserId]: nextList },
      };
    });
  },
  clear: (browserId) =>
    set((state) => {
      const { [browserId]: _omit, ...rest } = state.stepsByBrowser;
      return { stepsByBrowser: rest };
    }),
}));

export function browserStepsFor(state: BrowserActivityState, browserId: string): BrowserStep[] {
  return state.stepsByBrowser[browserId] ?? [];
}
