/**
 * Pure path utilities for virtual filesystems.
 *
 * No node:fs or node:path dependencies — safe for browser bundles.
 * Real-FS-backed implementations should import from real-fs-utils.ts
 * (which re-exports these) to keep a single import source.
 */

/** Maximum depth for symlink resolution loops. */
export const MAX_SYMLINK_DEPTH = 40;

/** Default directory permissions. */
export const DEFAULT_DIR_MODE = 0o755;

/** Default file permissions. */
export const DEFAULT_FILE_MODE = 0o644;

/** Default symlink permissions. */
export const SYMLINK_MODE = 0o777;

/**
 * Normalize a virtual path: resolve `.` and `..`, ensure it starts with `/`,
 * strip trailing slashes.  Pure function, no I/O.
 */
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

/**
 * Validate that a path does not contain null bytes.
 * Null bytes in paths can be used to truncate filenames or bypass security
 * filters.
 */
export function validatePath(path: string, operation: string): void {
  if (path.includes("\0")) {
    throw new Error(`ENOENT: path contains null byte, ${operation} '${path}'`);
  }
}

/**
 * Get the directory name of a normalized virtual path.
 */
export function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === 0 ? "/" : normalized.slice(0, lastSlash);
}

/**
 * Resolve a relative path against a base directory.
 * If `path` is absolute, it is normalized and returned directly.
 */
export function resolvePath(base: string, path: string): string {
  if (path.startsWith("/")) {
    return normalizePath(path);
  }
  const combined = base === "/" ? `/${path}` : `${base}/${path}`;
  return normalizePath(combined);
}

/**
 * Join a parent path with a child name.
 * Handles the root-path edge case (`"/" + "child"` → `"/child"`).
 */
export function joinPath(parent: string, child: string): string {
  return parent === "/" ? `/${child}` : `${parent}/${child}`;
}

/**
 * Resolve a symlink target relative to the symlink's location.
 * Absolute targets are normalized directly; relative targets are
 * resolved from the symlink's parent directory.
 */
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
