import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── DTO types ──────────────────────────────────────────────────────────────

export interface HelmReleaseDTO {
  name: string;
  namespace: string;
  revision: string;
  updated: string;
  status: string;
  chart: string;
  appVersion: string;
}

export interface HelmRevisionDTO {
  revision: number;
  updated: string;
  status: string;
  chart: string;
  appVersion: string;
  description: string;
}

export interface HelmResult {
  ok: boolean;
  message: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function runHelm(
  contextName: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "helm",
      [...args, "--kube-context", contextName],
      { env: process.env, maxBuffer: 10 * 1024 * 1024 },
    );
    return { ok: true, stdout, stderr };
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return { ok: false, stdout: "", stderr: "helm CLI not installed on daemon host" };
    }
    const stderr = isNodeError(err) && typeof err.stderr === "string" ? err.stderr : String(err);
    const stdout = isNodeError(err) && typeof err.stdout === "string" ? err.stdout : "";
    return { ok: false, stdout, stderr };
  }
}

function isNodeError(
  err: unknown,
): err is NodeJS.ErrnoException & { stdout?: string; stderr?: string } {
  return err instanceof Error && "code" in err;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function helmList(contextName: string): Promise<HelmReleaseDTO[]> {
  const result = await runHelm(contextName, ["list", "-A", "-o", "json"]);
  if (!result.ok) {
    throw new Error(result.stderr);
  }
  const raw: Array<{
    name?: string;
    namespace?: string;
    revision?: string;
    updated?: string;
    status?: string;
    chart?: string;
    app_version?: string;
  }> = JSON.parse(result.stdout);
  return raw.map((r) => ({
    name: r.name ?? "",
    namespace: r.namespace ?? "",
    revision: r.revision ?? "",
    updated: r.updated ?? "",
    status: r.status ?? "",
    chart: r.chart ?? "",
    appVersion: r.app_version ?? "",
  }));
}

export async function helmHistory(
  contextName: string,
  namespace: string,
  name: string,
): Promise<HelmRevisionDTO[]> {
  const result = await runHelm(contextName, ["history", name, "-n", namespace, "-o", "json"]);
  if (!result.ok) {
    throw new Error(result.stderr);
  }
  const raw: Array<{
    revision?: number;
    updated?: string;
    status?: string;
    chart?: string;
    app_version?: string;
    description?: string;
  }> = JSON.parse(result.stdout);
  return raw.map((r) => ({
    revision: r.revision ?? 0,
    updated: r.updated ?? "",
    status: r.status ?? "",
    chart: r.chart ?? "",
    appVersion: r.app_version ?? "",
    description: r.description ?? "",
  }));
}

export async function helmValues(
  contextName: string,
  namespace: string,
  name: string,
): Promise<string> {
  const result = await runHelm(contextName, ["get", "values", name, "-n", namespace]);
  if (!result.ok) {
    throw new Error(result.stderr);
  }
  return result.stdout;
}

export async function helmRollback(
  contextName: string,
  namespace: string,
  name: string,
  revision: number,
): Promise<HelmResult> {
  const result = await runHelm(contextName, ["rollback", name, String(revision), "-n", namespace]);
  if (!result.ok) {
    return { ok: false, message: result.stderr };
  }
  return { ok: true, message: result.stdout.trim() };
}

export async function helmUninstall(
  contextName: string,
  namespace: string,
  name: string,
): Promise<HelmResult> {
  const result = await runHelm(contextName, ["uninstall", name, "-n", namespace]);
  if (!result.ok) {
    return { ok: false, message: result.stderr };
  }
  return { ok: true, message: result.stdout.trim() };
}
