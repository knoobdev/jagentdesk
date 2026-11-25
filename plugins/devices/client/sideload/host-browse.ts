// Path helpers for "Browse host…" (26.9). Paths are the daemon host's, which may be Windows
// (`C:\Users\…`) while the app runs anywhere, so they never go through a platform path module.

export interface HostCrumb {
  label: string;
  path: string;
}

function isWindowsPath(full: string): boolean {
  return /^[A-Za-z]:([\\/]|$)/.test(full);
}

/** Breadcrumb segments of an absolute daemon path, root first; each one opens its folder. */
export function hostCrumbs(full: string): HostCrumb[] {
  if (isWindowsPath(full)) {
    const parts = full.split(/[\\/]/).filter(Boolean);
    const rest = parts.slice(1);
    const root = `${parts[0] ?? ""}\\`;
    const crumbs: HostCrumb[] = [{ label: root, path: root }];
    rest.forEach((part, index) => {
      crumbs.push({ label: part, path: `${root}${rest.slice(0, index + 1).join("\\")}` });
    });
    return crumbs;
  }
  const parts = full.split("/").filter(Boolean);
  const crumbs: HostCrumb[] = [{ label: "/", path: "/" }];
  parts.forEach((part, index) => {
    crumbs.push({ label: part, path: `/${parts.slice(0, index + 1).join("/")}` });
  });
  return crumbs;
}

/** `folder` + `name` with the host's separator. */
export function joinHostPath(folder: string, name: string): string {
  const separator = isWindowsPath(folder) ? "\\" : "/";
  return folder.endsWith("/") || folder.endsWith("\\")
    ? `${folder}${name}`
    : `${folder}${separator}${name}`;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1_048_576) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1_073_741_824) return `${(size / 1_048_576).toFixed(1)} MB`;
  return `${(size / 1_073_741_824).toFixed(2)} GB`;
}
