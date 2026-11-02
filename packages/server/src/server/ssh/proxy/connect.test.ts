import net from "node:net";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { connectThroughProxy } from "./connect.js";
import { ProxyError } from "./proxy-error.js";
import type { ProxyTarget } from "./connect.js";

const target: ProxyTarget = { host: "example.test", port: 22 };

async function expectProxyError(
  proxy: Parameters<typeof connectThroughProxy>[0],
): Promise<ProxyError> {
  try {
    const socket = await connectThroughProxy(proxy, target);
    socket.destroy();
  } catch (error) {
    if (error instanceof ProxyError) return error;
    throw error;
  }
  throw new Error("expected a ProxyError to be thrown");
}

function endOnFirstData(socket: net.Socket): void {
  socket.on("data", () => socket.end());
}

describe("connectThroughProxy", () => {
  it("reports proxy_unreachable when nothing listens on the proxy port", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const error = await expectProxyError({ type: "socks5", host: "127.0.0.1", port });
    expect(error.code).toBe("proxy_unreachable");
    expect(error.message).toContain("socks5 proxy 127.0.0.1");
  });

  it("reports proxy_unreachable when the proxy host does not resolve", async () => {
    const error = await expectProxyError({
      type: "http",
      host: "proxy.invalid",
      port: 3128,
    });
    expect(error.code).toBe("proxy_unreachable");
    expect(error.message).toContain("http proxy proxy.invalid");
  });

  it("reports proxy_refused when the proxy closes the connection during method selection", async () => {
    const server = net.createServer(endOnFirstData);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const error = await expectProxyError({ type: "socks5", host: "127.0.0.1", port });
      expect(error.code).toBe("proxy_refused");
      expect(error.message).toContain("closed the connection during method selection");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
