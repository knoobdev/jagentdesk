import { describe, expect, it, vi } from "vitest";

// Mock execFile with a custom promisify wrapper that returns { stdout, stderr }
// matching the real child_process.execFile's promisify behavior.
const customSymbol = Symbol.for("nodejs.util.promisify.custom");

vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn() as ReturnType<typeof vi.fn> & {
    [key: symbol]: (
      file: string,
      args: readonly string[],
      options: Record<string, unknown>,
    ) => Promise<{ stdout: string; stderr: string }>;
  };
  mockExecFile[customSymbol] = (
    file: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ) => {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      mockExecFile(file, args, options, (err: Error | null, stdout: string, stderr: string) => {
        if (err) {
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  };
  return { execFile: mockExecFile };
});

const { execFile } = await import("node:child_process");
const mockExecFile = vi.mocked(execFile);

function mockExecSuccess(stdout: string): void {
  mockExecFile.mockImplementation((_file: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
    (cb as (err: null, stdout: string, stderr: string) => void)(null, stdout, "");
    return {} as ReturnType<typeof execFile>;
  });
}

function mockExecError(err: Error, stderr: string): void {
  (err as { stderr?: string }).stderr = stderr;
  mockExecFile.mockImplementation((_file: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
    (cb as (err: Error, stdout: string, stderr: string) => void)(err, "", stderr);
    return {} as ReturnType<typeof execFile>;
  });
}

function makeEnoent(): Error {
  const err = new Error("ENOENT");
  (err as { code?: string }).code = "ENOENT";
  return err;
}

async function importFresh(): Promise<typeof import("./helm-client.js")> {
  return import("./helm-client.js");
}

describe("helm-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("helmList", () => {
    it("parses helm list -o json output into DTOs", async () => {
      mockExecSuccess(
        JSON.stringify([
          {
            name: "my-release",
            namespace: "default",
            revision: "1",
            updated: "2025-01-15T10:00:00Z",
            status: "deployed",
            chart: "nginx-1.0.0",
            app_version: "1.25",
          },
        ]),
      );

      const { helmList } = await importFresh();
      const releases = await helmList("my-context");

      expect(releases).toHaveLength(1);
      expect(releases[0]).toEqual({
        name: "my-release",
        namespace: "default",
        revision: "1",
        updated: "2025-01-15T10:00:00Z",
        status: "deployed",
        chart: "nginx-1.0.0",
        appVersion: "1.25",
      });
      expect(mockExecFile).toHaveBeenCalledWith(
        "helm",
        ["list", "-A", "-o", "json", "--kube-context", "my-context"],
        expect.objectContaining({ maxBuffer: 10485760 }),
        expect.any(Function),
      );
    });

    it("throws on ENOENT with helm CLI not installed message", async () => {
      mockExecError(makeEnoent(), "");

      const { helmList } = await importFresh();
      await expect(helmList("my-context")).rejects.toThrow("helm CLI not installed on daemon host");
    });

    it("returns empty array for no releases", async () => {
      mockExecSuccess("[]");

      const { helmList } = await importFresh();
      const releases = await helmList("my-context");
      expect(releases).toEqual([]);
    });
  });

  describe("helmHistory", () => {
    it("parses helm history -o json output into DTOs", async () => {
      mockExecSuccess(
        JSON.stringify([
          {
            revision: 1,
            updated: "2025-01-15T10:00:00Z",
            status: "superseded",
            chart: "nginx-1.0.0",
            app_version: "1.25",
            description: "Install complete",
          },
          {
            revision: 2,
            updated: "2025-01-16T10:00:00Z",
            status: "deployed",
            chart: "nginx-1.0.0",
            app_version: "1.25",
            description: "Upgrade complete",
          },
        ]),
      );

      const { helmHistory } = await importFresh();
      const revisions = await helmHistory("my-context", "default", "my-release");

      expect(revisions).toHaveLength(2);
      expect(revisions[0]).toEqual({
        revision: 1,
        updated: "2025-01-15T10:00:00Z",
        status: "superseded",
        chart: "nginx-1.0.0",
        appVersion: "1.25",
        description: "Install complete",
      });
      expect(revisions[1].revision).toBe(2);
    });
  });

  describe("helmValues", () => {
    it("returns yaml text from helm get values", async () => {
      mockExecSuccess("replicaCount: 3\nimage:\n  tag: latest\n");

      const { helmValues } = await importFresh();
      const values = await helmValues("my-context", "default", "my-release");

      expect(values).toContain("replicaCount: 3");
      expect(values).toContain("tag: latest");
    });
  });

  describe("helmRollback", () => {
    it("returns ok on success", async () => {
      mockExecSuccess("Rollback was a success!");

      const { helmRollback } = await importFresh();
      const result = await helmRollback("my-context", "default", "my-release", 1);

      expect(result.ok).toBe(true);
      expect(result.message).toBe("Rollback was a success!");
    });

    it("returns ok false on failure", async () => {
      const err = new Error("Command failed");
      (err as { code?: string }).code = "1";
      mockExecError(err, "release: not found");

      const { helmRollback } = await importFresh();
      const result = await helmRollback("my-context", "default", "my-release", 1);

      expect(result.ok).toBe(false);
      expect(result.message).toBe("release: not found");
    });
  });

  describe("helmUninstall", () => {
    it("returns ok on success", async () => {
      mockExecSuccess('release "my-release" uninstalled');

      const { helmUninstall } = await importFresh();
      const result = await helmUninstall("my-context", "default", "my-release");

      expect(result.ok).toBe(true);
      expect(result.message).toBe('release "my-release" uninstalled');
    });
  });

  describe("ENOENT handling", () => {
    it("helmHistory returns error on ENOENT", async () => {
      mockExecError(makeEnoent(), "");

      const { helmHistory } = await importFresh();
      await expect(helmHistory("ctx", "ns", "name")).rejects.toThrow(
        "helm CLI not installed on daemon host",
      );
    });

    it("helmValues returns error on ENOENT", async () => {
      mockExecError(makeEnoent(), "");

      const { helmValues } = await importFresh();
      await expect(helmValues("ctx", "ns", "name")).rejects.toThrow(
        "helm CLI not installed on daemon host",
      );
    });
  });
});
