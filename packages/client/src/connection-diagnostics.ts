/**
 * In-memory ring buffer of connection, transport and handshake events from
 * every daemon client in this process, so a failure seen only on one device
 * can be read and copied from the app afterwards.
 *
 * Entries carry event names, sizes, codes, stages and reasons. Never put
 * message payloads, keys, nonces, signatures, tokens or passwords in them.
 */

export type ConnectionDiagnosticValue = string | number | boolean | null;

export interface ConnectionDiagnosticEntry {
  /** Wall-clock time the event was recorded (ms since epoch). */
  atMs: number;
  /** Which connection: transport path plus a per-process counter, e.g. `relay#3`. */
  source: string;
  event: string;
  fields: Record<string, ConnectionDiagnosticValue>;
}

export const CONNECTION_DIAGNOSTICS_CAPACITY = 500;
const MAX_STRING_LENGTH = 300;
const MAX_FIELDS = 16;

type Listener = () => void;

export class ConnectionDiagnosticsLog {
  private buffer: ConnectionDiagnosticEntry[] = [];
  private readonly listeners = new Set<Listener>();
  private version = 0;

  constructor(
    private readonly capacity = CONNECTION_DIAGNOSTICS_CAPACITY,
    private readonly now: () => number = Date.now,
  ) {}

  record(source: string, event: string, fields: Record<string, unknown> = {}): void {
    try {
      this.buffer.push({
        atMs: this.now(),
        source: truncate(source),
        event: truncate(event),
        fields: sanitizeFields(fields),
      });
      if (this.buffer.length > this.capacity) {
        this.buffer.splice(0, this.buffer.length - this.capacity);
      }
      this.version += 1;
      for (const listener of this.listeners) {
        try {
          listener();
        } catch {
          // A broken listener must not break the connection that is logging.
        }
      }
    } catch {
      // Diagnostics never throw into the connection path.
    }
  }

  entries(): readonly ConnectionDiagnosticEntry[] {
    return this.buffer.slice();
  }

  /** Changes whenever the log changes; for `useSyncExternalStore`. */
  getVersion(): number {
    return this.version;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(): void {
    this.buffer = [];
    this.version += 1;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // ignore
      }
    }
  }

  /** One line per entry, oldest first, for copying into a bug report. */
  format(): string {
    return this.buffer.map(formatConnectionDiagnosticEntry).join("\n");
  }
}

export function formatConnectionDiagnosticEntry(entry: ConnectionDiagnosticEntry): string {
  const fields = Object.entries(entry.fields)
    .map(([key, value]) => `${key}=${typeof value === "string" ? JSON.stringify(value) : value}`)
    .join(" ");
  const time = new Date(entry.atMs).toISOString();
  return `${time} ${entry.source} ${entry.event}${fields ? ` ${fields}` : ""}`;
}

function sanitizeFields(
  fields: Record<string, unknown>,
): Record<string, ConnectionDiagnosticValue> {
  const out: Record<string, ConnectionDiagnosticValue> = {};
  let count = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (count >= MAX_FIELDS) break;
    if (value === undefined) continue;
    out[truncate(key)] = sanitizeValue(value);
    count += 1;
  }
  return out;
}

function sanitizeValue(value: unknown): ConnectionDiagnosticValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return truncate(value);
  if (value instanceof Error) return truncate(value.message);
  // Objects and arrays could carry payloads; record only their kind.
  return `[${Array.isArray(value) ? "array" : typeof value}]`;
}

function truncate(value: string): string {
  return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH - 1)}…` : value;
}

/** Shared by every daemon client in this process. */
export const connectionDiagnostics = new ConnectionDiagnosticsLog();
