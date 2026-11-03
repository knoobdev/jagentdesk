import type { JiraError } from "@jagentdesk/protocol/jira/rpc-schemas";

export type JiraErrorCode =
  | "auth_failed"
  | "needs_reauth"
  | "forbidden"
  | "not_found"
  | "invalid_input"
  | "rate_limited"
  | "network"
  | "unsupported"
  | "too_large"
  | "jira_error";

/** A Jira call or Jira-side precondition failed. `message` is safe to show to the user. */
export class JiraApiError extends Error {
  readonly code: JiraErrorCode;
  readonly status: number | null;
  readonly fieldErrors: Record<string, string> | undefined;

  constructor(input: {
    code: JiraErrorCode;
    message: string;
    status?: number | null;
    fieldErrors?: Record<string, string>;
  }) {
    super(input.message);
    this.name = "JiraApiError";
    this.code = input.code;
    this.status = input.status ?? null;
    this.fieldErrors = input.fieldErrors;
  }

  toWire(): JiraError {
    return {
      code: this.code,
      message: this.message,
      ...(this.fieldErrors && Object.keys(this.fieldErrors).length > 0
        ? { fieldErrors: this.fieldErrors }
        : {}),
    };
  }
}

const STATUS_CODES: Record<number, JiraErrorCode> = {
  400: "invalid_input",
  401: "auth_failed",
  403: "forbidden",
  404: "not_found",
  413: "too_large",
  422: "invalid_input",
  429: "rate_limited",
};

interface JiraErrorBody {
  errorMessages?: unknown;
  errors?: unknown;
  message?: unknown;
  error_description?: unknown;
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return Object.fromEntries(entries);
}

/** Builds the error for a non-2xx Jira response from its status and (JSON) body text. */
export function jiraErrorFromResponse(status: number, bodyText: string): JiraApiError {
  let body: JiraErrorBody = {};
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed === "object" && parsed !== null) body = parsed as JiraErrorBody;
  } catch {
    // Non-JSON error pages (proxies, maintenance) fall back to the status line below.
  }
  const fieldErrors = stringRecord(body.errors);
  const messages = Array.isArray(body.errorMessages)
    ? body.errorMessages.filter((m): m is string => typeof m === "string")
    : [];
  const fieldText = Object.entries(fieldErrors).map(([field, text]) => `${field}: ${text}`);
  const textual = [
    ...messages,
    ...fieldText,
    ...(typeof body.message === "string" ? [body.message] : []),
  ];
  const message = textual.length > 0 ? textual.join("; ") : `Jira responded ${status}`;
  return new JiraApiError({
    code: STATUS_CODES[status] ?? "jira_error",
    status,
    message,
    fieldErrors,
  });
}
