/**
 * Turns raw terminal output into plain text lines for session logs (spec 25.8 "output
 * with escape sequences removed"). It keeps one line buffer with a cursor so carriage
 * returns, backspaces and erase-in-line behave like the screen did (a progress bar
 * logs its final state, not every frame). Escape sequences may be split across
 * chunks; the parser state carries over.
 */
type CleanerState =
  | "text"
  | "esc"
  | "csi"
  | "osc"
  | "osc_esc"
  | "string"
  | "string_esc"
  | "charset";

/** What follows ESC: CSI, OSC, a string sequence (DCS/SOS/PM/APC), a charset pick, or a single char. */
function stateAfterEscape(char: string): CleanerState {
  if (char === "[") return "csi";
  if (char === "]") return "osc";
  if ("PX^_".includes(char)) return "string";
  if ("()*+-./".includes(char)) return "charset";
  return "text";
}

export class TerminalTextCleaner {
  private line: string[] = [];
  private cursor = 0;
  private state: CleanerState = "text";
  private params = "";

  /** Returns the lines completed by this chunk, each ending in "\n". */
  push(chunk: string): string {
    let completed = "";
    for (const char of chunk) {
      if (this.state !== "text") {
        this.consumeEscape(char);
        continue;
      }
      switch (char) {
        case "\x1b":
          this.state = "esc";
          break;
        case "\n":
          completed += `${this.line.join("").trimEnd()}\n`;
          this.line = [];
          this.cursor = 0;
          break;
        case "\r":
          this.cursor = 0;
          break;
        case "\b":
          this.cursor = Math.max(0, this.cursor - 1);
          break;
        case "\t":
          this.put("\t");
          break;
        default:
          if (char >= " " && char !== "\x7f") this.put(char);
      }
    }
    return completed;
  }

  /** The unfinished last line, for when the session ends. */
  flush(): string {
    const rest = this.line.join("").trimEnd();
    this.line = [];
    this.cursor = 0;
    return rest === "" ? "" : `${rest}\n`;
  }

  private put(char: string): void {
    while (this.line.length < this.cursor) this.line.push(" ");
    this.line[this.cursor] = char;
    this.cursor += 1;
  }

  private consumeEscape(char: string): void {
    switch (this.state) {
      case "esc":
        this.params = "";
        this.state = stateAfterEscape(char);
        return;
      case "charset":
        this.state = "text";
        return;
      case "csi":
        if (char >= "@" && char <= "~") {
          this.applyCsi(char);
          this.state = "text";
        } else {
          this.params += char;
        }
        return;
      case "osc":
        if (char === "\x07") this.state = "text";
        else if (char === "\x1b") this.state = "osc_esc";
        return;
      case "osc_esc":
        this.state = char === "\\" ? "text" : "osc";
        return;
      case "string":
        if (char === "\x1b") this.state = "string_esc";
        return;
      case "string_esc":
        this.state = char === "\\" ? "text" : "string";
        return;
      case "text":
        return;
    }
  }

  private applyCsi(final: string): void {
    const first = Number.parseInt(this.params.replace(/^\?/, "").split(";")[0] ?? "", 10);
    const count = Number.isFinite(first) && first > 0 ? first : 1;
    switch (final) {
      case "K": {
        const mode = Number.isFinite(first) ? first : 0;
        if (mode === 0) this.line = this.line.slice(0, this.cursor);
        else if (mode === 1) this.line = this.line.map((c, i) => (i < this.cursor ? " " : c));
        else this.line = [];
        return;
      }
      case "C":
        this.cursor += count;
        return;
      case "D":
        this.cursor = Math.max(0, this.cursor - count);
        return;
      case "G":
        this.cursor = count - 1;
        return;
      case "P":
        this.line.splice(this.cursor, count);
        return;
    }
  }
}
