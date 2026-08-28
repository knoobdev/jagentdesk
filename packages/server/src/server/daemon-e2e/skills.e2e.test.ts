import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

describe("daemon E2E — skills are server-owned and synced across clients", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("XP earned on one client is authoritative, persisted, and broadcast to another", async () => {
    // Seeded starter skills are served from the daemon (not a per-device local store).
    const initial = await ctx.client.getSkills();
    const doctor = initial.skills.find((s) => s.id === "skl_k8s_doctor");
    expect(doctor).toBeDefined();
    expect(doctor?.xp).toBe(0);

    // A second, independent client (think: the mobile app next to the desktop app,
    // both connected to the same daemon).
    const clientB = new DaemonClient({ url: `ws://127.0.0.1:${ctx.daemon.port}/ws` });
    await clientB.connect();

    // Capture the skills_changed broadcast client B should receive.
    const readDoctorXp = (message: { payload: unknown }): number | null => {
      const payload = message.payload as {
        status?: string;
        skills?: Array<{ id: string; xp: number }>;
      };
      if (payload.status !== "skills_changed") return null;
      return payload.skills?.find((s) => s.id === "skl_k8s_doctor")?.xp ?? null;
    };
    const broadcast = new Promise<number>((resolve) => {
      clientB.on("status", (message) => {
        const xp = readDoctorXp(message);
        if (xp !== null) resolve(xp);
      });
    });

    // Client A trains the skill with a 👍 (approved-answer) — worth +60 XP.
    const mutated = await ctx.client.mutateSkills({
      op: "learn",
      id: "skl_k8s_doctor",
      entryId: "lrn_e2e_1",
      rating: "up",
      content: "Pull pod logs and events before guessing a cause.",
    });
    expect(mutated.skills.find((s) => s.id === "skl_k8s_doctor")?.xp).toBe(60);

    // Client B is pushed the authoritative new XP without asking.
    await expect(broadcast).resolves.toBe(60);

    // And a fresh read on client B agrees — the daemon is the single source of truth.
    const fromB = await clientB.getSkills();
    const doctorB = fromB.skills.find((s) => s.id === "skl_k8s_doctor");
    expect(doctorB?.xp).toBe(60);
    expect(doctorB?.learned.map((l) => l.id)).toContain("lrn_e2e_1");

    await clientB.close();
  });
});
