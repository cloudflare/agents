import type { AgentPathStep } from "../sub-routing";

// ── Facet identity versioning ────────────────────────────────────────
//
// These strings are stored in DO storage and embedded in facet identity
// names — they are wire/storage-frozen and must never be renamed.

export const SUB_AGENT_IDENTITY_VERSION_LEGACY = "legacy";
export const SUB_AGENT_IDENTITY_VERSION_PATH_V2 = "path-v2";
export const SUB_AGENT_IDENTITY_PATH_V2_PREFIX = "cf-agents:v2:";

export type SubAgentIdentityVersion =
  | typeof SUB_AGENT_IDENTITY_VERSION_LEGACY
  | typeof SUB_AGENT_IDENTITY_VERSION_PATH_V2;

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function pathV2IdentityName(
  logicalName: string,
  digest: string
): string {
  return `${SUB_AGENT_IDENTITY_PATH_V2_PREFIX}${encodeURIComponent(logicalName)}:${digest}`;
}

export function logicalNameFromPathV2Identity(
  identityName: string
): string | null {
  if (!identityName.startsWith(SUB_AGENT_IDENTITY_PATH_V2_PREFIX)) {
    return null;
  }
  const rest = identityName.slice(SUB_AGENT_IDENTITY_PATH_V2_PREFIX.length);
  const separator = rest.lastIndexOf(":");
  if (separator === -1) return null;

  try {
    return decodeURIComponent(rest.slice(0, separator));
  } catch {
    return null;
  }
}

/**
 * Validate that a stored `parentPath` has the expected shape. Used
 * when restoring from DO storage to guard against corrupted data.
 */
export function isValidParentPath(
  value: unknown
): value is Array<{ className: string; name: string }> {
  if (!Array.isArray(value)) return false;
  return value.every(
    (entry) =>
      entry != null &&
      typeof entry === "object" &&
      typeof (entry as { className?: unknown }).className === "string" &&
      typeof (entry as { name?: unknown }).name === "string"
  );
}

export function agentPathKey(
  path: ReadonlyArray<AgentPathStep> | null
): string | null {
  if (!path) return null;
  return path
    .map(
      (step) =>
        `${encodeURIComponent(step.className)}:${encodeURIComponent(step.name)}`
    )
    .join("/");
}
