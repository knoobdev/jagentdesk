import { DaemonClient } from "./packages/client/dist/daemon-client.js";
const c = new DaemonClient({ url: "ws://127.0.0.1:6768/ws", clientId: "share-helper-probe" });
await c.connect();
const res = await c.fetchAgents({});
console.log("entry count:", (res.entries ?? []).length);
console.log(JSON.stringify(res.entries?.[0] ?? {}, null, 1).slice(0, 800));
await c.close();
process.exit(0);
