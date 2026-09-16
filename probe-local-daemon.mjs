import { DaemonClient } from "./packages/client/dist/daemon-client.js";
const c = new DaemonClient({ url: "ws://127.0.0.1:6768/ws", clientId: "share-helper-probe" });
const t = setTimeout(() => { console.log("TIMEOUT connecting"); process.exit(2); }, 8000);
try {
  await c.connect();
  clearTimeout(t);
  console.log("connected; features.sessionSharing =", c.getLastServerInfoMessage()?.features?.sessionSharing);
  const shares = await c.sessionShareList();
  console.log("sessionShareList OK, count =", shares.length);
  await c.close();
  process.exit(0);
} catch (e) {
  clearTimeout(t);
  console.log("AUTH/CONNECT FAILED:", e?.message || e);
  process.exit(1);
}
