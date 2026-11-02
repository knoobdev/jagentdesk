import {
  TelnetTerminalSession,
  createTelnetTerminalSession,
  type CreateTelnetTerminalSessionOptions,
} from "./terminal-session.js";

// Owns the live telnet sessions keyed by id. Deliberately independent of S1's
// SshService: the spec owner wires this registry into the session layer.
export class TelnetService {
  private readonly sessions = new Map<string, TelnetTerminalSession>();

  async createSession(options: CreateTelnetTerminalSessionOptions): Promise<TelnetTerminalSession> {
    const session = await createTelnetTerminalSession(options);
    this.sessions.set(session.id, session);
    session.onExit(() => {
      this.sessions.delete(session.id);
    });
    return session;
  }

  getSession(id: string): TelnetTerminalSession | undefined {
    return this.sessions.get(id);
  }

  async destroySession(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }
    this.sessions.delete(id);
    await session.killAndWait();
    return true;
  }

  async dispose(): Promise<void> {
    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.killAndWait()));
  }
}
