// The clock rows read (ages, Snoozed / Stale groups), ticking every `intervalMs`. Ported from Orca
// dfdb4fda (MIT) src/renderer/src/components/bots/use-bot-now.ts (its minute clock).
import { useEffect, useState } from "react";

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
