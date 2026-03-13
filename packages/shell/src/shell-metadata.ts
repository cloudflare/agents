/**
 * Shell Metadata
 *
 * Shared source of truth for shell version and process information.
 * Used by both variable expansion ($BASH_VERSION, $PPID, etc.)
 * and /proc filesystem initialization.
 */

/**
 * Simulated bash version string
 */
export const BASH_VERSION = "5.1.0(1)-release";

/**
 * Simulated kernel version for /proc/version
 */
export const KERNEL_VERSION =
  "Linux version 5.15.0-generic (@cloudflare/shell) #1 SMP PREEMPT";

/**
 * Format /proc/self/status content using virtual process info.
 * Never exposes real host process information.
 */
export function formatProcStatus(info: {
  pid: number;
  ppid: number;
  uid: number;
  gid: number;
}): string {
  const { pid, ppid, uid, gid } = info;
  return `Name:\tbash
State:\tR (running)
Pid:\t${pid}
PPid:\t${ppid}
Uid:\t${uid}\t${uid}\t${uid}\t${uid}
Gid:\t${gid}\t${gid}\t${gid}\t${gid}
`;
}
