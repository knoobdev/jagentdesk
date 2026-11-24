import { z } from "zod";

const Envelope = z.object({ ok: z.boolean(), error: z.string().optional() }).passthrough();
/** Injectable endpoint keeps local acceptance tests off Slack's network. */
export class SlackApi {
  constructor(private readonly baseUrl = "https://slack.com/api/") {}
  async call<T>(
    token: string,
    method: string,
    body: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(
        new URL(method, this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      throw new Error("Slack API unavailable");
    }
    if (!response.ok) throw new Error(`Slack HTTP ${response.status}`);
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error("Invalid Slack response");
    }
    const raw = Envelope.safeParse(value);
    if (!raw.success) throw new Error("Invalid Slack response");
    // Slack error identifiers are safe to show. Never include a response body or request credentials.
    if (!raw.data.ok)
      throw new Error(
        `Slack: ${/^[a-z0-9_]+$/.test(raw.data.error ?? "") ? raw.data.error : "request_failed"}`,
      );
    const parsed = schema.safeParse(raw.data);
    if (!parsed.success) throw new Error("Invalid Slack response");
    return parsed.data;
  }
}
