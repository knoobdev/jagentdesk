// Real-device check: enable control on the first cabled iPhone and count live screen frames
// for 15 s (sizes only; frames are never written to disk). Usage: node scripts/iphone-screen-check.mjs <port>
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { DaemonClient } from "@jagentdesk/client/internal/daemon-client";

const port = Number(process.argv[2] ?? 47981);
const client = new DaemonClient({
  url: `ws://127.0.0.1:${port}/ws`,
  clientId: `clid_iphone_check_${randomBytes(3).toString("hex")}`,
  clientType: "cli",
  appVersion: "0.9.52",
  webSocketFactory: (url, options) =>
    new WebSocket(url, options?.protocols, { headers: options?.headers }),
});
await client.connect();
const list = await client.simulatorList();
const phone = (list.devices ?? []).find(
  (d) => d.kind === "physical" && String(d.udid).startsWith("ios:"),
);
if (!phone) {
  console.log("no cabled iPhone", JSON.stringify(list.availability?.physical));
  process.exit(1);
}
console.log(
  "device",
  phone.model,
  phone.osVersion,
  phone.connection,
  "readiness",
  phone.readiness,
  "control",
  phone.controlEnabled,
);
if (!phone.controlEnabled) await client.simulatorPhysicalEnable({ udid: phone.udid });
const subscriptionId = `sub_${randomBytes(4).toString("hex")}`;
let frames = 0,
  bytes = 0,
  first = 0,
  w = 0,
  h = 0;
const started = Date.now();
client.onSimulatorScreenFrame(subscriptionId, (f) => {
  frames++;
  bytes += f.jpeg?.length ?? f.data?.length ?? 0;
  w = f.width;
  h = f.height;
  if (!first) first = Date.now() - started;
});
try {
  const res = await client.simulatorScreenSubscribe({ subscriptionId, udid: phone.udid });
  console.log("subscribe", JSON.stringify(res).slice(0, 200));
} catch (e) {
  console.log("subscribe error", e.message);
}
await new Promise((r) => setTimeout(r, 15000));
client.simulatorScreenUnsubscribe({ subscriptionId });
const after = (await client.simulatorList()).devices.find((d) => d.udid === phone.udid);
console.log(
  `frames=${frames} in 15s, first after ${first} ms, ${w}x${h}, avg ${frames ? Math.round(bytes / frames / 1024) : 0} KB; readiness now ${after?.readiness}; screenAvailable ${after?.screenAvailable}`,
);
await client.close?.();
process.exit(0);
