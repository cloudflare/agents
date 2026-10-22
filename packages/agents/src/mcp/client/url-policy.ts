/**
 * Rules for the identifiers and URLs the MCP client manager accepts: stable
 * server ids, and the SSRF policy that keeps HTTP connections off private
 * and internal networks.
 */

/** Maximum length of a normalized MCP server id. */
export const MCP_SERVER_ID_MAX_LENGTH = 64;

/**
 * Normalize a caller-supplied MCP server id into a stable, storage- and
 * tool-name-safe form.
 *
 * The id is surfaced in several places where the character set matters:
 *  - as the primary key in the `cf_agents_mcp_servers` SQLite table
 *  - embedded in AI SDK tool names as `` `tool_${id.replace(/-/g, "")}_${tool}` ``
 *    (tool names must match `/^[A-Za-z0-9_]+$/`)
 *  - as a key on the `mcpConnections` map and OAuth provider storage
 *
 * Rules:
 *  1. Lowercase.
 *  2. Replace any run of disallowed characters with a single `-`.
 *  3. Collapse repeated `-` and trim leading/trailing `-`/`_`.
 *  4. Prefix with `id-` if the result is empty or doesn't start with a letter.
 *  5. Truncate to {@link MCP_SERVER_ID_MAX_LENGTH} characters.
 *
 * @example
 * normalizeServerId("my-supplied-id");  // "my-supplied-id"
 * normalizeServerId("GitHub MCP!");     // "github-mcp"
 * normalizeServerId("42-things");       // "id-42-things"
 */
export function normalizeServerId(input: string): string {
  if (typeof input !== "string") {
    throw new TypeError(
      `normalizeServerId: expected string, got ${typeof input}`
    );
  }

  let id = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");

  if (id.length === 0 || !/^[a-z]/.test(id)) {
    id = `id-${id}`.replace(/-+$/g, "");
  }

  if (id.length > MCP_SERVER_ID_MAX_LENGTH) {
    id = id.slice(0, MCP_SERVER_ID_MAX_LENGTH).replace(/-+$/g, "");
  }

  return id;
}

/**
 * Blocked hostname patterns for SSRF protection.
 * Prevents MCP client from connecting to internal/private network addresses
 * while allowing loopback hosts for local development.
 */
const BLOCKED_HOSTNAMES = new Set([
  "0.0.0.0",
  "[::]",
  "metadata.google.internal"
]);

/**
 * Check whether four IPv4 octets belong to a private/reserved range.
 * Blocks RFC 1918, link-local, cloud metadata, and unspecified addresses.
 */
function isPrivateIPv4(octets: number[]): boolean {
  const [a, b] = octets;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8
  if (a === 0) return true;
  return false;
}

/**
 * fe80::/10 — IPv6 link-local (RFC 4291 §2.5.6).
 *
 * The /10 boundary fixes the first 10 bits (1111111010), which means valid
 * first hextets range from fe80 through febf. Only hex digits 8, 9, a, b
 * have high two bits "10" — anything else (e.g. fe7f, fec0) is out of range.
 * The fourth hex digit is unconstrained by the /10 boundary.
 *
 * Historical bug: `startsWith("fe80")` only matched the narrower fe80::/16
 * prefix and let fe81::/feab::/febf:: slip through. See issue #1325.
 */
const IPV6_LINK_LOCAL = /^fe[89ab][0-9a-f]/;

/**
 * Check whether a bracket-stripped, lowercased IPv6 address belongs to a
 * private/reserved range. Also unwraps IPv4-mapped IPv6 (::ffff:...) and
 * delegates to isPrivateIPv4 for those.
 *
 * Loopback (::1) and unspecified (::) are NOT blocked here:
 *   - ::1 is intentionally allowed (parallel to 127.x.x.x for local dev)
 *   - :: (== [::]) is blocked via BLOCKED_HOSTNAMES at the hostname level
 */
function isPrivateIPv6(addr: string): boolean {
  // fc00::/7 — unique local addresses (fc00:: through fdff::).
  // /7 fixes first 7 bits "1111110", so the 8-bit prefix is either
  // fc (11111100) or fd (11111101). No other first hextets qualify.
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true;

  // fe80::/10 — link-local addresses (fe80:: through febf:...).
  if (IPV6_LINK_LOCAL.test(addr)) return true;

  // IPv4-mapped IPv6 (::ffff:x.x.x.x or ::ffff:XXYY:ZZWW).
  // The WHATWG URL parser does NOT canonicalize hex-form tails to dotted
  // form — [::ffff:a00:1] stays as "::ffff:a00:1" and will only be caught
  // by the hex branch. Both forms must therefore be handled here.
  if (addr.startsWith("::ffff:")) {
    const mapped = addr.slice(7);
    const dotParts = mapped.split(".");
    if (dotParts.length === 4 && dotParts.every((p) => /^\d{1,3}$/.test(p))) {
      if (isPrivateIPv4(dotParts.map(Number))) return true;
    } else {
      const hexParts = mapped.split(":");
      if (hexParts.length === 2) {
        const hi = parseInt(hexParts[0], 16);
        const lo = parseInt(hexParts[1], 16);
        if (
          isPrivateIPv4([
            (hi >> 8) & 0xff,
            hi & 0xff,
            (lo >> 8) & 0xff,
            lo & 0xff
          ])
        )
          return true;
      }
    }
  }

  return false;
}

/**
 * Check whether a hostname looks like a private/internal IP address.
 * Blocks RFC 1918, link-local, unique-local, unspecified,
 * and cloud metadata endpoints. Also detects IPv4-mapped IPv6 addresses.
 */
export function isBlockedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true; // Malformed URLs are blocked
  }

  const hostname = parsed.hostname;

  if (BLOCKED_HOSTNAMES.has(hostname)) return true;

  // IPv4 checks
  const ipv4Parts = hostname.split(".");
  if (ipv4Parts.length === 4 && ipv4Parts.every((p) => /^\d{1,3}$/.test(p))) {
    if (isPrivateIPv4(ipv4Parts.map(Number))) return true;
  }

  // IPv6 private range checks.
  // URL parser keeps brackets: hostname for [fc00::1] is "[fc00::1]".
  // The parser also lowercases/canonicalizes the address, but we
  // lowercase again defensively in case this helper is ever called with
  // a non-parser-produced hostname.
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    if (isPrivateIPv6(hostname.slice(1, -1).toLowerCase())) return true;
  }

  return false;
}
