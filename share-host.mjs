import { DaemonClient } from "./packages/client/dist/daemon-client.js";
const AGENT = "d1ee5bb7-cc9d-4d79-a831-dc7da993682a";
const c = new DaemonClient({ url: "ws://127.0.0.1:6768/ws", clientId: "share-host-helper" });
await c.connect();

const accepted = new Set();
c.subscribeSessionShareStream((s) => {
  if (s.agentId !== AGENT) return;
  for (const r of s.pendingRequests ?? []) {
    if (r.status === "pending" && !accepted.has(r.requestId)) {
      accepted.add(r.requestId);
      console.log(`JOIN_REQUEST label=${JSON.stringify(r.label)} id=${r.requestId} -> accepting`);
      c.sessionShareRespond(s.shareId, r.requestId, true).catch((e) => console.log("accept err", e?.message));
    }
    if (r.status === "approved" && r.code) {
      console.log(`APPROVED label=${JSON.stringify(r.label)} CODE=${r.code}`);
    }
  }
  const members = (s.members ?? []).map((m) => m.label);
  if (members.length) console.log("MEMBERS:", members.join(", "));
});

const share = await c.sessionShareCreate(AGENT);
console.log("SHARE_URL=" + share.tunnelUrl);
console.log("shareId=" + share.shareId);
console.log("Listening for join requests… (auto-accept on)");
// keep alive
setInterval(() => {}, 1 << 30);
