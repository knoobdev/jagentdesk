import { request } from "node:https";
import { rootCertificates } from "node:tls";
import type pino from "pino";
import { APPLE_ROOT_CA_PEM } from "./apple-root-ca.js";

/**
 * The one way sideload talks HTTPS (Apple, App Store Connect, a remote anisette server).
 * Every request logs method + host + path only — never headers, query or bodies, which
 * carry tokens, anisette data and passwords. The log line is how 26.12.6 is checked
 * ("no request to gsa.apple.com").
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface AppleHttpRequest {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: Buffer | string;
  timeoutMs?: number;
}

export interface AppleHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export type AppleHttp = (input: AppleHttpRequest) => Promise<AppleHttpResponse>;

export class AppleHttpError extends Error {
  constructor(
    readonly host: string,
    message: string,
  ) {
    super(message);
    this.name = "AppleHttpError";
  }
}

function toBuffer(body: Buffer | string | undefined): Buffer | undefined {
  if (body === undefined || Buffer.isBuffer(body)) return body;
  return Buffer.from(body, "utf8");
}

const TRUST_ANCHORS = [...rootCertificates, APPLE_ROOT_CA_PEM];
const DEFAULT_TIMEOUT_MS = 60_000;

export function createAppleHttp(logger: pino.Logger): AppleHttp {
  return (input) =>
    new Promise<AppleHttpResponse>((resolve, reject) => {
      const url = new URL(input.url);
      logger.info({ method: input.method, host: url.host, path: url.pathname }, "sideload https");
      const body = toBuffer(input.body);
      const headers: Record<string, string> = { ...input.headers };
      if (body) headers["Content-Length"] = String(body.length);
      const req = request(
        {
          method: input.method,
          hostname: url.hostname,
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          headers,
          ca: TRUST_ANCHORS,
          timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const responseHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(res.headers)) {
              if (typeof value === "string") responseHeaders[key.toLowerCase()] = value;
              else if (Array.isArray(value)) responseHeaders[key.toLowerCase()] = value.join(", ");
            }
            resolve({
              status: res.statusCode ?? 0,
              headers: responseHeaders,
              body: Buffer.concat(chunks),
            });
          });
          res.on("error", (error) => reject(new AppleHttpError(url.host, error.message)));
        },
      );
      req.on("timeout", () => {
        req.destroy(new AppleHttpError(url.host, `Request to ${url.host} timed out`));
      });
      req.on("error", (error) =>
        reject(
          error instanceof AppleHttpError ? error : new AppleHttpError(url.host, error.message),
        ),
      );
      if (body) req.write(body);
      req.end();
    });
}

/** Plain-HTTP capable variant for a user's self-hosted anisette server on the LAN. */
export function createAnisetteServerHttp(logger: pino.Logger): AppleHttp {
  const https = createAppleHttp(logger);
  return async (input) => {
    const url = new URL(input.url);
    if (url.protocol === "https:") return https(input);
    logger.info({ method: input.method, host: url.host, path: url.pathname }, "sideload http");
    let response: Response;
    try {
      response = await fetch(url, {
        method: input.method,
        headers: input.headers,
        body:
          typeof input.body === "string" ? input.body : input.body && new Uint8Array(input.body),
        signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      throw new AppleHttpError(url.host, cause instanceof Error ? cause.message : String(cause));
    }
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });
    return {
      status: response.status,
      headers: responseHeaders,
      body: Buffer.from(await response.arrayBuffer()),
    };
  };
}
