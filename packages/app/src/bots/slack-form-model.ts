export class SlackFormModel {
  private readonly listeners = new Set<() => void>();
  private state = { botToken: "", signingSecret: "", canSubmit: false, revision: 0 };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getState = () => this.state;
  set(field: "botToken" | "signingSecret", value: string): void {
    const next = { ...this.state, [field]: value };
    this.state = { ...next, canSubmit: Boolean(next.botToken.trim() && next.signingSecret.trim()) };
    for (const listener of this.listeners) listener();
  }
  clear(): void {
    this.state = {
      botToken: "",
      signingSecret: "",
      canSubmit: false,
      revision: this.state.revision + 1,
    };
    for (const listener of this.listeners) listener();
  }
  input(): { botToken: string; signingSecret: string } {
    if (!this.state.canSubmit) throw new Error("Enter a bot token and signing secret");
    return { botToken: this.state.botToken.trim(), signingSecret: this.state.signingSecret.trim() };
  }
}
