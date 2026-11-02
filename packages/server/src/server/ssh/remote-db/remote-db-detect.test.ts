import { describe, expect, it } from "vitest";
import {
  DEFAULT_DB_PORTS,
  defaultDbPort,
  engineForDefaultPort,
  suggestDbEndpoints,
} from "./remote-db-detect.js";

describe("DEFAULT_DB_PORTS (spec 25.10)", () => {
  it("maps each tunneled engine to its canonical listening port", () => {
    expect(DEFAULT_DB_PORTS).toEqual({
      postgres: 5432,
      mysql: 3306,
      redis: 6379,
      mongodb: 27017,
    });
  });

  it("defaultDbPort returns the engine's port and rejects unknown engines", () => {
    expect(defaultDbPort("postgres")).toBe(5432);
    expect(defaultDbPort("mysql")).toBe(3306);
    expect(defaultDbPort("redis")).toBe(6379);
    expect(defaultDbPort("mongodb")).toBe(27017);
    expect(() => defaultDbPort("sqlite" as never)).toThrow("unknown remote-db engine: sqlite");
  });

  it("engineForDefaultPort round-trips each port and returns null for unclaimed ones", () => {
    expect(engineForDefaultPort(5432)).toBe("postgres");
    expect(engineForDefaultPort(3306)).toBe("mysql");
    expect(engineForDefaultPort(6379)).toBe("redis");
    expect(engineForDefaultPort(27017)).toBe("mongodb");
    expect(engineForDefaultPort(5433)).toBeNull();
    expect(engineForDefaultPort(22)).toBeNull();
  });
});

describe("suggestDbEndpoints", () => {
  it("suggests nothing for an environment with no default DB ports listening", () => {
    expect(suggestDbEndpoints({ listeningPorts: [22, 80, 443, 5433, 33060] })).toEqual([]);
  });

  it("suggests one loopback endpoint per engine whose default port is listening", () => {
    expect(suggestDbEndpoints({ listeningPorts: [5432] })).toEqual([
      { engine: "postgres", remoteHost: "127.0.0.1", remotePort: 5432 },
    ]);
    expect(suggestDbEndpoints({ listeningPorts: [3306, 6379] })).toEqual([
      { engine: "mysql", remoteHost: "127.0.0.1", remotePort: 3306 },
      { engine: "redis", remoteHost: "127.0.0.1", remotePort: 6379 },
    ]);
  });

  it("suggests all four engines and keeps engine order, not input order", () => {
    const suggestions = suggestDbEndpoints({ listeningPorts: [27017, 6379, 3306, 5432] });
    expect(suggestions.map((s) => s.engine)).toEqual(["postgres", "mysql", "redis", "mongodb"]);
    expect(suggestions.map((s) => s.remotePort)).toEqual([5432, 3306, 6379, 27017]);
  });

  it("collapses duplicate listening ports into a single suggestion", () => {
    expect(suggestDbEndpoints({ listeningPorts: [5432, 5432, 5432] })).toEqual([
      { engine: "postgres", remoteHost: "127.0.0.1", remotePort: 5432 },
    ]);
  });

  it("treats a non-default port as not a suggestion (user types those)", () => {
    expect(suggestDbEndpoints({ listeningPorts: [5432, 5433] })).toEqual([
      { engine: "postgres", remoteHost: "127.0.0.1", remotePort: 5432 },
    ]);
  });
});
