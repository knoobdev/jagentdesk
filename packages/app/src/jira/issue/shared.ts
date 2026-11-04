import { useCallback, useState } from "react";
import { Linking } from "react-native";
import { isWeb } from "@/constants/platform";
import { errorMessage } from "../api";

// Small helpers shared by the issue detail parts.

export interface AsyncAction<A extends unknown[]> {
  run: (...args: A) => Promise<boolean>;
  pending: boolean;
  error: string | null;
  clearError: () => void;
}

/** Wraps one fallible user action: pending while running, the error kept until retried. */
export function useAsyncAction<A extends unknown[]>(
  action: (...args: A) => Promise<void>,
): AsyncAction<A> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (...args: A) => {
      setPending(true);
      setError(null);
      try {
        await action(...args);
        return true;
      } catch (caught) {
        setError(errorMessage(caught));
        return false;
      } finally {
        setPending(false);
      }
    },
    [action],
  );
  const clearError = useCallback(() => setError(null), []);
  return { run, pending, error, clearError };
}

export function openExternal(url: string): void {
  if (isWeb) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  void Linking.openURL(url);
}

/** Markdown link handler: mentions (`jira-mention:`) are not links. */
export function handleMarkdownLink(url: string): boolean {
  return !url.startsWith("jira-mention:");
}

export function formatDateTime(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function mentionMarkdown(user: { ref: string; displayName: string }): string {
  return `[@${user.displayName}](jira-mention:${encodeURIComponent(user.ref)})`;
}
