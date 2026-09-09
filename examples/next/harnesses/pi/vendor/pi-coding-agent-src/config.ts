// STUB — not upstream pi code. See vendor/pi-coding-agent-src/README.md

/**
 * Upstream reads these from the host filesystem and the process environment.
 * Only the three names the vendored files reference are kept.
 */

export const APP_NAME = "pi";

export const CONFIG_DIR_NAME = ".pi";

/** There is no agent directory under workerd; callers get a stable fake path. */
export function getAgentDir(): string {
  return `/${CONFIG_DIR_NAME}`;
}
