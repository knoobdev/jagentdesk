/**
 * Rebuilds the command line a user types into an SSH terminal from raw input bytes so
 * the owner can record it in the per-server history (spec 25.7). It understands the
 * editing keys people use on a prompt line (backspace, Ctrl+U, Ctrl+C) and drops
 * escape sequences (arrows, function keys) and bracketed-paste markers. Input typed
 * while the server has echo off (password prompts) must not be fed here: the owner
 * skips the tracker while an auth prompt or `read -s` is active, so nothing secret
 * reaches history.
 */
export class CommandLineTracker {
  private line = "";
  private escape: "none" | "esc" | "csi" | "ss3" | "osc" = "none";

  /** Feeds raw terminal input; returns every command completed by Enter. */
  push(data: string): string[] {
    const completed: string[] = [];
    for (const char of data) {
      if (this.consumeEscape(char)) continue;
      if (char === "\r" || char === "\n") {
        const command = this.line.trim();
        this.line = "";
        if (command !== "") completed.push(command);
      } else if (char === "\x7f" || char === "\b") {
        this.line = [...this.line].slice(0, -1).join("");
      } else if (char === "\x15" || char === "\x03") {
        this.line = "";
      } else if (char === "\x1b") {
        this.escape = "esc";
      } else if (char >= " " || char === "\t") {
        this.line += char;
      }
    }
    return completed;
  }

  /** Forget the partial line, e.g. after an auth prompt took over the terminal. */
  reset(): void {
    this.line = "";
    this.escape = "none";
  }

  private consumeEscape(char: string): boolean {
    switch (this.escape) {
      case "none":
        return false;
      case "esc":
        if (char === "[") {
          this.escape = "csi";
        } else if (char === "O") {
          this.escape = "ss3";
        } else if (char === "]") {
          this.escape = "osc";
        } else {
          this.escape = "none";
        }
        return true;
      case "ss3":
        this.escape = "none";
        return true;
      case "osc":
        if (char === "\x07") this.escape = "none";
        if (char === "\x1b") this.escape = "esc";
        return true;
      case "csi":
        if (char >= "@" && char <= "~") this.escape = "none";
        return true;
    }
  }
}
