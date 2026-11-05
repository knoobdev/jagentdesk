// Figma smoke against a built daemon: feature flag, connections, Link bridge status, pairing guard.
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
const port = Number(process.argv[2] ?? 47995);
const c = new DaemonClient({
  url: `ws://127.0.0.1:${port}/ws`,
  clientId: `clid_figma_${randomBytes(3).toString("hex")}`,
  clientType: "cli",
  appVersion: "0.9.52",
  webSocketFactory: (u, o) => new WebSocket(u, o?.protocols, { headers: o?.headers }),
});
await c.connect();
await new Promise((r) => setTimeout(r, 500));
const out = (k, v) =>
  console.log(k.padEnd(28), typeof v === "string" ? v : JSON.stringify(v).slice(0, 260));
out("feature figma", c.getLastServerInfoMessage()?.features?.figma);
out("connections.list", await c.figmaRequest("figma.connections.list.request", {}));
const st = await c.figmaRequest("figma.link.status.request", {});
out("link.status", {
  error: st.error,
  server: st.status?.server,
  port: st.status?.port,
  pluginInstalled: st.status?.pluginInstalled,
  manifestPath: st.status?.manifestPath,
  runScript: st.status?.runScriptEnabled,
});
out(
  "files.add bad url",
  await c.figmaRequest("figma.files.add.request", {
    connectionId: "fgc_none",
    url: "not a figma url",
  }),
);
out("pending.list", await c.figmaRequest("figma.pending.list.request", { fileKey: "AbCdEf123" }));
out(
  "link.op (unlinked)",
  await c.figmaRequest("figma.link.op.request", {
    fileKey: "AbCdEf123",
    ops: [{ op: "rename", nodeId: "1:2", name: "x" }],
  }),
);
// A local WebSocket that is not the paired plugin must not run anything (ADR-0035 §3).
await new Promise((resolve) => {
  const ws = new WebSocket("ws://127.0.0.1:41995/ws", {
    headers: { Origin: "https://evil.invalid" },
  });
  ws.on("unexpected-response", (_r, res) => {
    out("bridge evil Origin", `HTTP ${res.statusCode}`);
    resolve();
  });
  ws.on("open", () => {
    out("bridge evil Origin", "OPENED (bad)");
    ws.close();
    resolve();
  });
  ws.on("error", (e) => {
    out("bridge evil Origin", `error ${e.message}`);
    resolve();
  });
});
await new Promise((resolve) => {
  const ws = new WebSocket("ws://127.0.0.1:41995/ws");
  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "request", id: "x1", method: "get_document", params: {} }));
  });
  ws.on("message", (m) => {
    out("bridge unpaired call", String(m).slice(0, 200));
    ws.close();
    resolve();
  });
  ws.on("error", (e) => {
    out("bridge unpaired call", `error ${e.message}`);
    resolve();
  });
  setTimeout(() => {
    out("bridge unpaired call", "no answer in 3s (nothing executed)");
    ws.close();
    resolve();
  }, 3000);
});
process.exit(0);
