/**
 * Format a date as a human-friendly relative time string
 * Examples: "just now", "5m ago", "2h ago", "3d ago", "Jan 15"
 */
export function formatTimeAgo(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 10) {
    return "just now";
  }

  if (diffMin < 1) {
    return `${diffSec}s ago`;
  }

  if (diffHour < 1) {
    return `${diffMin}m ago`;
  }

  if (diffDay < 1) {
    return `${diffHour}h ago`;
  }

  if (diffDay < 7) {
    return `${diffDay}d ago`;
  }

  // For older dates, show abbreviated month and day
  const month = date.toLocaleDateString("en-US", { month: "short" });
  const day = date.getDate();
  return `${month} ${day}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many local midnights lie between two instants: 0 for the same day, 1 for yesterday.
 * Counted on the calendar rather than in elapsed time, so six days and 23 hours ago on
 * today's weekday is 7, and rounded so a DST day of 23 or 25 hours still counts as one.
 */
function localCalendarDaysBetween(earlier: Date, later: Date): number {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((startOfDay(later).getTime() - startOfDay(earlier).getTime()) / DAY_MS);
}

// Cached Intl formatter. Explicitly carrying `hourCycle` from the resolved
// options is what makes the runtime respect the user's OS-level 12h/24h
// preference rather than the locale's default cycle.
let cachedTimeFormatter: Intl.DateTimeFormat | null = null;
function getTimeFormatter(): Intl.DateTimeFormat {
  if (cachedTimeFormatter) return cachedTimeFormatter;
  const resolved = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).resolvedOptions();
  cachedTimeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hourCycle: resolved.hourCycle,
  });
  return cachedTimeFormatter;
}

/**
 * Format a chat-message timestamp for hover-revealed UI.
 * - Same day: "10:11 PM" or "22:11" depending on user preference
 * - The previous 6 calendar days: "Wednesday 10:11 PM"
 * - Older, including today's weekday last week: "14 May 2026, 10:11 PM"
 */
export function formatMessageTimestamp(date: Date, now: Date = new Date()): string {
  const time = getTimeFormatter().format(date);
  const daysAgo = localCalendarDaysBetween(date, now);

  if (daysAgo === 0) {
    return time;
  }

  if (daysAgo > 0 && daysAgo < 7) {
    const weekday = date.toLocaleDateString(undefined, { weekday: "long" });
    return `${weekday} ${time}`;
  }

  const dateLabel = date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${dateLabel}, ${time}`;
}

/**
 * Format a duration as a compact human-readable string.
 * - 0-60s: whole seconds ("47s")
 * - Minutes/hours: integers only ("2m 12s", "1h 5m")
 */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "0s";
  }
  const totalSeconds = durationMs / 1000;

  if (totalSeconds < 60) {
    return `${Math.floor(totalSeconds)}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = Math.floor(totalSeconds) % 60;
    return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const remMinutes = totalMinutes % 60;
  return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
}
