import { DaemonClient } from "./packages/client/dist/daemon-client.js";
const c = new DaemonClient({ url: "ws://127.0.0.1:6768/ws", clientId: "inspect-tl" });
await c.connect();
const res = await c.fetchAgentTimeline("d1ee5bb7-cc9d-4d79-a831-dc7da993682a", { direction: "tail", limit: 40 });
const rows = res.rows ?? res.items ?? res.entries ?? [];
console.log("row count:", rows.length, "| payload keys:", Object.keys(res));
for (const row of rows.slice(-20)) {
  const it = row.item ?? row;
  const t = it.type;
  const text = (it.text ?? it.message ?? "").toString().replace(/\n/g, "\\n").slice(0, 40);
  console.log(`seq=${row.seq} type=${t} len=${(it.text ?? "").length} id=${it.id ?? it.messageId ?? "-"} text="${text}"`);
}
await c.close(); process.exit(0);
