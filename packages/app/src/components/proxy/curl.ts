import type {
  ProxyTransactionFull,
  ProxyTransactionRow,
} from "@jagentdesk/protocol/proxy/rpc-schemas";
import { bytesToUtf8, decodeBase64 } from "./base64";

// Burp's "Copy URL" / "Copy as cURL" — the two clipboard actions the history context menu offers in
// P1. The absolute URL omits the port when it is the scheme default, matching what Burp shows.
export function absoluteUrl(
  row: Pick<ProxyTransactionRow, "secure" | "host" | "port" | "url">,
): string {
  const scheme = row.secure ? "https" : "http";
  const defaultPort = row.secure ? 443 : 80;
  const authority = row.port === defaultPort ? row.host : `${row.host}:${row.port}`;
  return `${scheme}://${authority}${row.url}`;
}

export function buildCurl(tx: ProxyTransactionFull): string {
  const parts = [`curl -i -X ${tx.method} ${shellQuote(absoluteUrl(tx))}`];
  for (const h of tx.requestHeaders) {
    if (h.name.toLowerCase() === "content-length") continue;
    parts.push(`  -H ${shellQuote(`${h.name}: ${h.value}`)}`);
  }
  const body = decodeBase64(tx.requestBodyB64);
  if (body.length > 0 && tx.requestBodyIsText) {
    parts.push(`  --data-raw ${shellQuote(bytesToUtf8(body))}`);
  }
  return parts.join(" \\\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
