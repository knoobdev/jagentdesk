import { describe, expect, it } from "vitest";
import {
  FORWARD_LOCAL_HOST,
  InvalidRemoteDbRequestError,
  SSH_FORWARD_OPTION_KEY,
  buildRemoteDbConnectionParams,
  isRegistryBackedEngine,
  type RemoteDbConnectionRequest,
} from "./remote-db-params.js";

function request(overrides: Partial<RemoteDbConnectionRequest> = {}): RemoteDbConnectionRequest {
  return {
    engine: "postgres",
    serverId: "srv_alpha",
    serverLabel: "prod-box",
    remoteHost: "db.internal",
    remotePort: 5432,
    localPort: 41500,
    ...overrides,
  };
}

describe("buildRemoteDbConnectionParams (spec 25.10)", () => {
  it("points the client at the local forward and carries the tunnel in options.ssh", () => {
    const params = buildRemoteDbConnectionParams(request({ database: "orders", user: "app" }));
    expect(params).toEqual({
      engine: "postgres",
      displayName: "orders via prod-box",
      config: {
        host: "127.0.0.1",
        port: 41500,
        database: "orders",
        user: "app",
        options: {
          ssh: {
            serverId: "srv_alpha",
            remoteHost: "db.internal",
            remotePort: 5432,
            localPort: 41500,
          },
        },
      },
      forward: {
        serverId: "srv_alpha",
        remoteHost: "db.internal",
        remotePort: 5432,
        localPort: 41500,
      },
    });
  });

  it("uses the forward host, never the remote host, for the client config", () => {
    const params = buildRemoteDbConnectionParams(request({ remoteHost: "10.0.0.7" }));
    expect(params.config.host).toBe(FORWARD_LOCAL_HOST);
    expect(params.config.host).not.toBe("10.0.0.7");
  });

  it("builds params for every engine, each with its own identity preserved", () => {
    for (const engine of ["postgres", "mysql", "redis", "mongodb"] as const) {
      const params = buildRemoteDbConnectionParams(request({ engine }));
      expect(params.engine).toBe(engine);
      expect(params.forward.serverId).toBe("srv_alpha");
      expect(params.config.options?.[SSH_FORWARD_OPTION_KEY]).toEqual({
        serverId: "srv_alpha",
        remoteHost: "db.internal",
        remotePort: 5432,
        localPort: 41500,
      });
    }
  });

  it("omits database and user when not given", () => {
    const params = buildRemoteDbConnectionParams(request());
    expect(params.config).not.toHaveProperty("database");
    expect(params.config).not.toHaveProperty("user");
    expect(params.displayName).toBe("postgres via prod-box");
  });

  it("never emits secret fields in the params", () => {
    const params = buildRemoteDbConnectionParams(request({ database: "orders" }));
    expect(params.config).not.toHaveProperty("password");
    expect(params.config).not.toHaveProperty("dsn");
    expect(params.config).not.toHaveProperty("file");
  });

  it("falls back to engine + serverId when label and database are absent", () => {
    const params = buildRemoteDbConnectionParams(
      request({ serverLabel: undefined, database: undefined }),
    );
    expect(params.displayName).toBe("postgres via srv_alpha");
  });

  it("prefers an explicit displayName over the derived one", () => {
    const params = buildRemoteDbConnectionParams(request({ displayName: " Primary pg " }));
    expect(params.displayName).toBe("Primary pg");
  });

  it("trims serverLabel and serverId into the derived name", () => {
    const params = buildRemoteDbConnectionParams(
      request({ serverLabel: "  boxed  ", serverId: " srv_a " }),
    );
    expect(params.displayName).toBe("postgres via boxed");
  });
});

describe("buildRemoteDbConnectionParams validation", () => {
  it("rejects an engine outside postgres/mysql/redis/mongodb", () => {
    expect(() => buildRemoteDbConnectionParams(request({ engine: "sqlite" as never }))).toThrow(
      InvalidRemoteDbRequestError,
    );
    try {
      buildRemoteDbConnectionParams(request({ engine: "clickhouse" as never }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRemoteDbRequestError);
      expect((error as InvalidRemoteDbRequestError).field).toBe("engine");
    }
  });

  it("rejects a blank serverId", () => {
    expect(() => buildRemoteDbConnectionParams(request({ serverId: "   " }))).toThrow(
      "serverId must not be empty",
    );
  });

  it("rejects blank, whitespace-ridden, or URL-shaped remoteHost", () => {
    expect(() => buildRemoteDbConnectionParams(request({ remoteHost: "" }))).toThrow(
      "remoteHost must not be empty",
    );
    expect(() => buildRemoteDbConnectionParams(request({ remoteHost: "db host" }))).toThrow(
      "remoteHost must not contain whitespace",
    );
    expect(() => buildRemoteDbConnectionParams(request({ remoteHost: "postgres://db" }))).toThrow(
      "remoteHost must be a bare host, not a URL",
    );
  });

  it("rejects ports outside 1–65535 and non-integers, naming the field", () => {
    for (const bad of [0, -1, 65536, 5432.5, Number.NaN]) {
      expect(() => buildRemoteDbConnectionParams(request({ remotePort: bad }))).toThrow(
        "remotePort must be an integer between 1 and 65535",
      );
      expect(() => buildRemoteDbConnectionParams(request({ localPort: bad }))).toThrow(
        "localPort must be an integer between 1 and 65535",
      );
    }
  });

  it("rejects blank database/user but trims real values", () => {
    expect(() => buildRemoteDbConnectionParams(request({ database: " " }))).toThrow(
      "database must not be empty",
    );
    expect(() => buildRemoteDbConnectionParams(request({ user: "" }))).toThrow(
      "user must not be empty",
    );
    const params = buildRemoteDbConnectionParams(request({ database: " orders ", user: " app " }));
    expect(params.config.database).toBe("orders");
    expect(params.config.user).toBe("app");
  });

  it("accepts boundary ports and bare IPv6 hosts", () => {
    const params = buildRemoteDbConnectionParams(
      request({ remoteHost: "::1", remotePort: 1, localPort: 65535 }),
    );
    expect(params.forward).toEqual({
      serverId: "srv_alpha",
      remoteHost: "::1",
      remotePort: 1,
      localPort: 65535,
    });
  });
});

describe("isRegistryBackedEngine", () => {
  it("covers postgres/mysql/mongodb and excludes redis (no registry adapter yet)", () => {
    expect(isRegistryBackedEngine("postgres")).toBe(true);
    expect(isRegistryBackedEngine("mysql")).toBe(true);
    expect(isRegistryBackedEngine("mongodb")).toBe(true);
    expect(isRegistryBackedEngine("redis")).toBe(false);
  });
});
