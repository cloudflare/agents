/**
 * Pure path utilities for virtual filesystems.
 *
 * No node:fs or node:path dependencies — safe for browser bundles and Workers.
 */

export const MAX_SYMLINK_DEPTH = 40;
export const DEFAULT_DIR_MODE = 0o755;
export const DEFAULT_FILE_MODE = 0o644;
export const SYMLINK_MODE = 0o777;

export function normalizePath(path: string): string {
  if (!path || path === "/") return "/";

  let normalized =
    path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;

  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }

  const parts = normalized.split("/").filter((p) => p && p !== ".");
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  return `/${resolved.join("/")}`;
}

export function validatePath(path: string, operation: string): void {
  if (path.includes("\0")) {
    throw new Error(`ENOENT: path contains null byte, ${operation} '${path}'`);
  }
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === 0 ? "/" : normalized.slice(0, lastSlash);
}

export function resolvePath(base: string, path: string): string {
  if (path.startsWith("/")) {
    return normalizePath(path);
  }
  const combined = base === "/" ? `/${path}` : `${base}/${path}`;
  return normalizePath(combined);
}

export function joinPath(parent: string, child: string): string {
  return parent === "/" ? `/${child}` : `${parent}/${child}`;
}

export function resolveSymlinkTarget(
  symlinkPath: string,
  target: string
): string {
  if (target.startsWith("/")) {
    return normalizePath(target);
  }
  const dir = dirname(symlinkPath);
  return normalizePath(joinPath(dir, target));
}
