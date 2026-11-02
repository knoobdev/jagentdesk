import type {
  ClientMessage,
  TerminalExitInfo,
  ServerMessage,
  TerminalSession,
  TerminalSubscribeOptions,
} from "../../terminal/terminal.js";

// What the SSH service and the milestone modules need from any remote terminal tab, SSH
// or Telnet (spec 25.4 / 25.7 / 25.8): observe output and input, type on the user's
// behalf, and hear about keystrokes that came from a client.
export interface RemoteSessionHandle {
  tapOutput(listener: (data: string) => void): () => void;
  tapInput(listener: (data: string) => void): () => void;
  typeInput(data: string): void;
  onClientInput: ((data: string) => void) | null;
  onExit(listener: (info: TerminalExitInfo) => void): () => void;
}

/**
 * Wraps a module-built TerminalSession (Telnet) so it behaves like an SSH tab for the
 * service: client input is observed in `send`, output through one internal subscription.
 * Every TerminalSession call is forwarded unchanged.
 */
export function wrapRemoteSession(inner: TerminalSession): TerminalSession & RemoteSessionHandle {
  const outputTaps = new Set<(data: string) => void>();
  const inputTaps = new Set<(data: string) => void>();
  const notify = (taps: Set<(data: string) => void>, data: string): void => {
    for (const tap of Array.from(taps)) {
      try {
        tap(data);
      } catch {
        // no-op
      }
    }
  };
  let unsubscribeOutput: (() => void) | null = null;
  const ensureOutputSubscription = (): void => {
    if (unsubscribeOutput) return;
    unsubscribeOutput = inner.subscribe(
      (message: ServerMessage) => {
        if (message.type === "output") notify(outputTaps, message.data);
      },
      { initialSnapshot: "ready" },
    );
  };
  inner.onExit(() => {
    unsubscribeOutput?.();
    outputTaps.clear();
    inputTaps.clear();
  });
  const wrapper: TerminalSession & RemoteSessionHandle = {
    id: inner.id,
    name: inner.name,
    cwd: inner.cwd,
    workspaceId: inner.workspaceId,
    onClientInput: null,
    tapOutput(listener) {
      outputTaps.add(listener);
      ensureOutputSubscription();
      return () => outputTaps.delete(listener);
    },
    tapInput(listener) {
      inputTaps.add(listener);
      return () => inputTaps.delete(listener);
    },
    typeInput(data) {
      notify(inputTaps, data);
      inner.send({ type: "input", data });
    },
    send(message: ClientMessage) {
      if (message.type === "input") {
        notify(inputTaps, message.data);
        wrapper.onClientInput?.(message.data);
      }
      inner.send(message);
    },
    subscribe: (listener: (message: ServerMessage) => void, options?: TerminalSubscribeOptions) =>
      inner.subscribe(listener, options),
    onExit: (listener) => inner.onExit(listener),
    onCommandFinished: (listener) => inner.onCommandFinished(listener),
    onTitleChange: (listener) => inner.onTitleChange(listener),
    onActivityChange: (listener) => inner.onActivityChange(listener),
    getSize: () => inner.getSize(),
    getState: () => inner.getState(),
    getStateSnapshot: (options) => inner.getStateSnapshot(options),
    getReplayPreamble: () => inner.getReplayPreamble(),
    getTitle: () => inner.getTitle(),
    getActivity: () => inner.getActivity(),
    setActivity: (state) => inner.setActivity(state),
    clearActivityAttention: () => inner.clearActivityAttention(),
    setTitle: (title) => inner.setTitle(title),
    getExitInfo: () => inner.getExitInfo(),
    kill: () => inner.kill(),
    killAndWait: (options) => inner.killAndWait(options),
  };
  return wrapper;
}
