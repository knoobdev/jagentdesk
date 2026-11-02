import type { ServerEnvironment, ServerTool } from "@jagentdesk/protocol/ssh/environment-schemas";

// Pure view model for the server overview (spec 25.13 "Màn máy chủ"): each card lists only the
// facts the detection found (25.10: what is not in ServerEnvironment is not shown).

export type EnvironmentCardId = "system" | "resources" | "software" | "services";

export interface EnvironmentRow {
  /** i18n key under `ssh.environment.rows`, or null for a tool name shown verbatim. */
  labelKey: string | null;
  label: string | null;
  value: string;
  tone: "default" | "warning";
}

export interface EnvironmentCard {
  id: EnvironmentCardId;
  rows: EnvironmentRow[];
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function row(labelKey: string, value: string): EnvironmentRow {
  return { labelKey, label: null, value, tone: "default" };
}

function systemRows(environment: ServerEnvironment): EnvironmentRow[] {
  const { os } = environment;
  const rows = [row("os", os.prettyName ?? os.distroName ?? os.kernelName)];
  rows.push(row("kernel", `${os.kernelName} ${os.kernelRelease}`.trim()));
  if (os.arch) rows.push(row("arch", os.arch));
  if (environment.hostname) rows.push(row("hostname", environment.hostname));
  if (environment.uptimeSeconds !== null) {
    rows.push(row("uptime", formatUptime(environment.uptimeSeconds)));
  }
  if (environment.shell) rows.push(row("shell", environment.shell));
  return rows;
}

function resourceRows(environment: ServerEnvironment): EnvironmentRow[] {
  const rows: EnvironmentRow[] = [];
  if (environment.cpuCores !== null) {
    const model = environment.cpuModel ? ` · ${environment.cpuModel}` : "";
    rows.push(row("cpu", `${environment.cpuCores}${model}`));
  }
  if (environment.memoryTotalBytes !== null) {
    const total = formatBytes(environment.memoryTotalBytes);
    const available = environment.memoryAvailableBytes;
    const value = available === null ? total : `${formatBytes(available)} / ${total}`;
    rows.push(row(available === null ? "memoryTotal" : "memoryAvailable", value));
  }
  if (environment.rootDisk) {
    const disk = environment.rootDisk;
    const usedRatio = disk.totalBytes > 0 ? disk.usedBytes / disk.totalBytes : 0;
    rows.push({
      labelKey: "disk",
      label: null,
      value: `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)} (${Math.round(usedRatio * 100)}%)`,
      tone: usedRatio >= 0.9 ? "warning" : "default",
    });
  }
  return rows;
}

function toolRow(name: string, tool: ServerTool | null): EnvironmentRow[] {
  if (tool === null) return [];
  return [{ labelKey: null, label: name, value: tool.version ?? "", tone: "default" }];
}

function softwareRows(environment: ServerEnvironment): EnvironmentRow[] {
  const docker = environment.docker;
  const dockerRows: EnvironmentRow[] =
    docker === null
      ? []
      : [
          {
            labelKey: null,
            label: "docker",
            value: docker.version ?? docker.socketPath ?? "",
            tone: docker.socketAccessible ? "default" : "warning",
          },
        ];
  const rows = [
    ...dockerRows,
    ...toolRow("podman", environment.podman),
    ...toolRow("kubectl", environment.kubectl),
    ...toolRow("psql", environment.psql),
    ...toolRow("mysql", environment.mysql),
    ...toolRow("redis-cli", environment.redisCli),
    ...toolRow("nginx", environment.nginx),
    ...toolRow("systemctl", environment.systemctl),
  ];
  if (environment.packageManagers.length > 0) {
    rows.push(row("packageManagers", environment.packageManagers.join(", ")));
  }
  return rows;
}

function serviceRows(environment: ServerEnvironment): EnvironmentRow[] {
  const systemd = environment.systemd;
  if (systemd === null) return [];
  const runningCount = `${systemd.runningServices.length}${systemd.runningTruncated ? "+" : ""}`;
  const rows = [row("servicesRunning", runningCount)];
  if (systemd.failedServices.length > 0) {
    rows.push({
      labelKey: "servicesFailed",
      label: null,
      value: systemd.failedServices.join(", "),
      tone: "warning",
    });
  }
  return rows;
}

export function buildEnvironmentCards(environment: ServerEnvironment): EnvironmentCard[] {
  const cards: EnvironmentCard[] = [
    { id: "system", rows: systemRows(environment) },
    { id: "resources", rows: resourceRows(environment) },
    { id: "software", rows: softwareRows(environment) },
    { id: "services", rows: serviceRows(environment) },
  ];
  return cards.filter((card) => card.rows.length > 0);
}

/** Docker section visibility on the server screen (25.10, 25.16 #11/#12). */
export function hasDocker(environment: ServerEnvironment | null): boolean {
  return environment?.docker != null;
}
