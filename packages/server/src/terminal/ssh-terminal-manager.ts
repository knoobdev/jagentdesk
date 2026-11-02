import type { TerminalActivityState } from "@jagentdesk/protocol/terminal-activity";
import type {
  TerminalActivityListener,
  TerminalManager,
  TerminalWorkspaceContributionChangedListener,
  TerminalsChangedListener,
} from "./terminal-manager.js";
import { captureTerminalLines } from "./terminal-capture.js";
import type { TerminalStateSnapshotOptions, TerminalSession } from "./terminal.js";

// Composite manager (spec 25.4): SSH terminal sessions live in the daemon main
// process (ssh2 is not available inside the forked terminal worker). This wrapper
// resolves an id against the SSH registry first and delegates everything else to
// the underlying (worker) manager, so subscribe/input/resize/capture/kill/rename
// — and the controller's snapshot-slot machinery — drive SSH terminals unchanged.
// SSH terminals carry no workspace and a pseudo cwd, so directory listing and the
// workspace-scoped APIs stay purely on the base manager.

export interface SshTerminalRegistryView {
  getSshTerminal(terminalId: string): TerminalSession | undefined;
  subscribeTerminalActivity(listener: TerminalActivityListener): () => void;
  killAllTerminals(): void;
}

export function createSshTerminalManager(
  base: TerminalManager,
  getRegistry: () => SshTerminalRegistryView | null,
): TerminalManager {
  function ssh(terminalId: string): TerminalSession | undefined {
    return getRegistry()?.getSshTerminal(terminalId);
  }

  return {
    getTerminals(cwd, options) {
      return base.getTerminals(cwd, options);
    },

    createTerminal(options) {
      return base.createTerminal(options);
    },

    registerCwdEnv(options) {
      base.registerCwdEnv(options);
    },

    validateTerminalActivityToken(terminalId, token) {
      return base.validateTerminalActivityToken(terminalId, token);
    },

    getTerminal(terminalId) {
      return ssh(terminalId) ?? base.getTerminal(terminalId);
    },

    async getTerminalState(terminalId, options?: TerminalStateSnapshotOptions) {
      const session = ssh(terminalId);
      if (session) {
        return session.getStateSnapshot(options);
      }
      return base.getTerminalState(terminalId, options);
    },

    setTerminalTitle(terminalId, title) {
      const session = ssh(terminalId);
      if (session) {
        session.setTitle(title);
        return true;
      }
      return base.setTerminalTitle(terminalId, title);
    },

    async setTerminalActivity(terminalId, state: TerminalActivityState) {
      const session = ssh(terminalId);
      if (session) {
        session.setActivity(state);
        return true;
      }
      return base.setTerminalActivity(terminalId, state);
    },

    async clearTerminalAttention(terminalId) {
      const session = ssh(terminalId);
      if (session) {
        return session.clearActivityAttention();
      }
      return base.clearTerminalAttention(terminalId);
    },

    killTerminal(terminalId) {
      const session = ssh(terminalId);
      if (session) {
        session.kill();
        return;
      }
      base.killTerminal(terminalId);
    },

    async killTerminalAndWait(terminalId, options) {
      const session = ssh(terminalId);
      if (session) {
        await session.killAndWait(options);
        return;
      }
      await base.killTerminalAndWait(terminalId, options);
    },

    async captureTerminal(terminalId, options) {
      const session = ssh(terminalId);
      if (session) {
        return captureTerminalLines(session, options);
      }
      return base.captureTerminal(terminalId, options);
    },

    listDirectories() {
      return base.listDirectories();
    },

    killAll() {
      getRegistry()?.killAllTerminals();
      base.killAll();
    },

    subscribeTerminalsChanged(listener: TerminalsChangedListener) {
      return base.subscribeTerminalsChanged(listener);
    },

    subscribeTerminalActivity(listener: TerminalActivityListener) {
      const unsubscribeBase = base.subscribeTerminalActivity(listener);
      const unsubscribeSsh = getRegistry()?.subscribeTerminalActivity(listener) ?? null;
      return () => {
        unsubscribeBase();
        unsubscribeSsh?.();
      };
    },

    subscribeTerminalWorkspaceContributionChanged(
      listener: TerminalWorkspaceContributionChangedListener,
    ) {
      return base.subscribeTerminalWorkspaceContributionChanged(listener);
    },
  };
}
