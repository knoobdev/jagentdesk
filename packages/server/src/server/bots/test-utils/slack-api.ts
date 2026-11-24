import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface SlackPost {
  channel: string;
  thread_ts: string;
  text: string;
  ts: string;
}
/** Real loopback HTTP boundary for Slack acceptance; never calls Slack. */
export class LocalSlackApi {
  readonly posts: SlackPost[] = [];
  readonly methods: string[] = [];
  private readonly server: Server;
  baseUrl = "";
  constructor(readonly token: string) {
    this.server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const method = request.url!.slice(1);
        this.methods.push(method);
        response.setHeader("Content-Type", "application/json");
        if (request.headers.authorization !== `Bearer ${this.token}`) {
          response.end(JSON.stringify({ ok: false, error: "invalid_auth" }));
          return;
        }
        if (method === "auth.test")
          response.end(
            JSON.stringify({
              ok: true,
              team: "Local workspace",
              team_id: "T_LOCAL",
              user: "localbot",
              user_id: "U_BOT",
            }),
          );
        else if (method === "users.info")
          response.end(
            JSON.stringify({
              ok: true,
              user: { name: body.user, profile: { display_name: `Name ${body.user}` } },
            }),
          );
        else if (method === "chat.postMessage") {
          const ts = `${2000 + this.posts.length}.000001`;
          this.posts.push({ ...body, ts });
          response.end(JSON.stringify({ ok: true, channel: body.channel, ts }));
        } else response.end(JSON.stringify({ ok: false, error: "unknown_method" }));
      })().catch(() => {
        response.statusCode = 500;
        response.end();
      });
    });
  }
  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/`;
  }
  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
}
