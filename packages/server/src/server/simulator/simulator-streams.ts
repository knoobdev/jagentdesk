import type { ChildProcess } from "node:child_process";
import { spawnProcess } from "../../utils/spawn.js";
import type { SimSnapshot, SimulatorService } from "./simulator-service.js";

const FLEET_POLL_MS = 2500;

interface FleetSub {
  timer: ReturnType<typeof setInterval>;
  inFlight: boolean;
}

// Owns the long-lived children behind SimFleet's realtime streams. One instance per session.
// simctl has no `events`-style firehose (unlike docker), so the fleet snapshot is a lightweight
// poll of `simctl list`; logs are a real streamed child (`simctl spawn <udid> log stream`).
export class SimulatorStreams {
  private readonly fleet = new Map<string, FleetSub>();
  private readonly logs = new Map<string, ChildProcess>();

  constructor(private readonly service: SimulatorService) {}

  async subscribeFleet(
    subscriptionId: string,
    emit: (snapshot: SimSnapshot) => void,
  ): Promise<void> {
    this.unsubscribeFleet(subscriptionId);
    // Push the current state immediately so the UI is never empty.
    emit(await this.service.list());
    const sub: FleetSub = {
      inFlight: false,
      timer: setInterval(() => {
        if (sub.inFlight) return;
        sub.inFlight = true;
        void this.service
          .list()
          .then(emit)
          .catch(() => {})
          .finally(() => {
            sub.inFlight = false;
          });
      }, FLEET_POLL_MS),
    };
    this.fleet.set(subscriptionId, sub);
  }

  unsubscribeFleet(subscriptionId: string): void {
    const sub = this.fleet.get(subscriptionId);
    if (!sub) return;
    clearInterval(sub.timer);
    this.fleet.delete(subscriptionId);
  }

  subscribeLogs(subscriptionId: string, udid: string, emit: (chunk: string) => void): void {
    this.unsubscribeLogs(subscriptionId);
    const child = spawnProcess("xcrun", [
      "simctl",
      "spawn",
      udid,
      "log",
      "stream",
      "--style",
      "compact",
      "--level",
      "info",
    ]);
    this.logs.set(subscriptionId, child);
    const onData = (d: Buffer) => emit(d.toString("utf8"));
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", () => {});
  }

  unsubscribeLogs(subscriptionId: string): void {
    const child = this.logs.get(subscriptionId);
    if (!child) return;
    child.kill();
    this.logs.delete(subscriptionId);
  }

  disposeAll(): void {
    for (const id of Array.from(this.fleet.keys())) this.unsubscribeFleet(id);
    for (const id of Array.from(this.logs.keys())) this.unsubscribeLogs(id);
  }
}
