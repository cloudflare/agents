/**
 * URL allow-list matching
 *
 * This module provides URL allow-list matching that is enforced at the fetch layer,
 * independent of any parsing or user input manipulation.
 */

/**
 * Parses a URL string into its components.
 * Returns null if the URL is invalid.
 */
export function parseUrl(
  urlString: string
): { origin: string; pathname: string; href: string } | null {
  try {
    const url = new URL(urlString);
    return {
      origin: url.origin,
      pathname: url.pathname,
      href: url.href
    };
  } catch {
    return null;
  }
}

/**
 * Normalizes an allow-list entry for consistent matching.
 * - Removes trailing slashes from origins without paths
 * - Preserves path prefixes as-is
 */
export function normalizeAllowListEntry(entry: string): {
  origin: string;
  pathPrefix: string;
} | null {
  const parsed = parseUrl(entry);
  if (!parsed) {
    return null;
  }

  return {
    origin: parsed.origin,
    // Keep the pathname exactly as specified (including trailing slash if present)
    pathPrefix: parsed.pathname
  };
}

/**
 * Checks if a URL matches an allow-list entry.
 *
 * The matching rules are:
 * 1. Origins must match exactly (case-sensitive for scheme and host)
 * 2. The URL's path must start with the allow-list entry's path
 * 3. If the allow-list entry has no path (or just "/"), all paths are allowed
 *
 * @param url The URL to check (as a string)
 * @param allowedEntry The allow-list entry to match against
 * @returns true if the URL matches the allow-list entry
 */
export function matchesAllowListEntry(
  url: string,
  allowedEntry: string
): boolean {
  const parsedUrl = parseUrl(url);
  if (!parsedUrl) {
    return false;
  }

  const normalizedEntry = normalizeAllowListEntry(allowedEntry);
  if (!normalizedEntry) {
    return false;
  }

  // Origins must match exactly
  if (parsedUrl.origin !== normalizedEntry.origin) {
    return false;
  }

  // If the allow-list entry is just the origin (path is "/" or empty), allow all paths
  if (normalizedEntry.pathPrefix === "/" || normalizedEntry.pathPrefix === "") {
    return true;
  }

  // The URL's path must start with the allow-list entry's path prefix
  return parsedUrl.pathname.startsWith(normalizedEntry.pathPrefix);
}

/**
 * Checks if a URL is allowed by any entry in the allow-list.
 *
 * @param url The URL to check
 * @param allowedUrlPrefixes The list of allowed URL prefixes
 * @returns true if the URL is allowed
 */
export function isUrlAllowed(
  url: string,
  allowedUrlPrefixes: string[]
): boolean {
  if (!allowedUrlPrefixes || allowedUrlPrefixes.length === 0) {
    return false;
  }

  return allowedUrlPrefixes.some((entry) => matchesAllowListEntry(url, entry));
}

/**
 * Check if a hostname is a private/loopback IP address.
 * Only checks the string format — does not perform DNS resolution.
 */
export function isPrivateIp(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);

  // localhost and *.localhost are always local-only hostnames.
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }

  const ipv4 = parseIpv4(normalized);
  if (ipv4) {
    return isPrivateIpv4(ipv4);
  }

  const ipv6 = parseIpv6(normalized);
  if (ipv6) {
    return isPrivateIpv6(ipv6);
  }

  return false;
}

function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseIpComponent(part: string): number | null {
  if (!part) return null;

  let base = 10;
  let digits = part;

  if (digits.startsWith("0x") || digits.startsWith("0X")) {
    base = 16;
    digits = digits.slice(2);
  } else if (digits.length > 1 && digits.startsWith("0")) {
    base = 8;
  }

  if (!digits) return null;
  if (base === 16 && !/^[0-9a-fA-F]+$/.test(digits)) return null;
  if (base === 10 && !/^\d+$/.test(digits)) return null;
  if (base === 8 && !/^[0-7]+$/.test(digits)) return null;

  const value = Number.parseInt(digits, base);
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function parseIpv4(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split(".");
  if (parts.length === 0 || parts.length > 4) {
    return null;
  }

  const nums = parts.map((p) => parseIpComponent(p));
  if (nums.some((n) => n === null)) {
    return null;
  }

  const values = nums as number[];
  if (parts.length === 1) {
    const n = values[0];
    if (n > 0xffffffff) return null;
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  }

  if (parts.length === 2) {
    const [a, b] = values;
    if (a > 0xff || b > 0xffffff) return null;
    return [a, (b >>> 16) & 0xff, (b >>> 8) & 0xff, b & 0xff];
  }

  if (parts.length === 3) {
    const [a, b, c] = values;
    if (a > 0xff || b > 0xff || c > 0xffff) return null;
    return [a, b, (c >>> 8) & 0xff, c & 0xff];
  }

  const [a, b, c, d] = values;
  if (a > 0xff || b > 0xff || c > 0xff || d > 0xff) return null;
  return [a, b, c, d];
}

function parseIpv6(hostname: string): number[] | null {
  let host = hostname;
  let ipv4Tail: [number, number, number, number] | null = null;

  if (host.includes(".")) {
    const lastColon = host.lastIndexOf(":");
    if (lastColon < 0) return null;
    const v4Part = host.slice(lastColon + 1);
    const parsedV4 = parseIpv4(v4Part);
    if (!parsedV4) return null;
    ipv4Tail = parsedV4;
    host = host.slice(0, lastColon);
  }

  const doubleColonCount = host.includes("::")
    ? host.split("::").length - 1
    : 0;
  if (doubleColonCount > 1) return null;

  const [leftRaw, rightRaw] = host.split("::");
  const leftParts = leftRaw ? leftRaw.split(":").filter(Boolean) : [];
  const rightParts = rightRaw ? rightRaw.split(":").filter(Boolean) : [];

  const parseHextet = (part: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    return Number.parseInt(part, 16);
  };

  const left = leftParts.map(parseHextet);
  const right = rightParts.map(parseHextet);
  if (left.some((n) => n === null) || right.some((n) => n === null)) {
    return null;
  }

  const tailLength = ipv4Tail ? 2 : 0;
  const explicitLength = left.length + right.length + tailLength;

  let zerosToInsert = 0;
  if (doubleColonCount === 1) {
    zerosToInsert = 8 - explicitLength;
    if (zerosToInsert < 0) return null;
  } else if (explicitLength !== 8) {
    return null;
  }

  const hextets = [
    ...(left as number[]),
    ...new Array(zerosToInsert).fill(0),
    ...(right as number[])
  ];

  if (ipv4Tail) {
    hextets.push((ipv4Tail[0] << 8) | ipv4Tail[1]);
    hextets.push((ipv4Tail[2] << 8) | ipv4Tail[3]);
  }

  return hextets.length === 8 ? hextets : null;
}

function isPrivateIpv4(ip: [number, number, number, number]): boolean {
  const [a, b] = ip;
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 0) return true; // 0.0.0.0/8
  // CGNAT / Shared Address Space (RFC 6598)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10
  // Benchmarking (RFC 2544)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
  // IETF Protocol Assignments (RFC 6890)
  if (a === 192 && b === 0 && ip[2] === 0) return true; // 192.0.0.0/24
  // TEST-NET-1 (RFC 5737)
  if (a === 192 && b === 0 && ip[2] === 2) return true; // 192.0.2.0/24
  // TEST-NET-2 (RFC 5737)
  if (a === 198 && b === 51 && ip[2] === 100) return true; // 198.51.100.0/24
  // TEST-NET-3 (RFC 5737)
  if (a === 203 && b === 0 && ip[2] === 113) return true; // 203.0.113.0/24
  // Reserved + broadcast (RFC 1112)
  if (a >= 240) return true; // 240.0.0.0/4
  return false;
}

function isPrivateIpv6(hextets: number[]): boolean {
  const allZero = hextets.every((h) => h === 0);
  if (allZero) return true; // ::

  const isLoopback =
    hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1;
  if (isLoopback) return true; // ::1

  // fe80::/10 link-local
  if ((hextets[0] & 0xffc0) === 0xfe80) return true;

  // fc00::/7 unique local
  if ((hextets[0] & 0xfe00) === 0xfc00) return true;

  // IPv4-mapped ::ffff:x.x.x.x
  const isMapped =
    hextets[0] === 0 &&
    hextets[1] === 0 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0xffff;
  if (isMapped) {
    const mapped: [number, number, number, number] = [
      (hextets[6] >>> 8) & 0xff,
      hextets[6] & 0xff,
      (hextets[7] >>> 8) & 0xff,
      hextets[7] & 0xff
    ];
    return isPrivateIpv4(mapped);
  }

  // 2001:db8::/32 — Documentation prefix (RFC 3849)
  if (hextets[0] === 0x2001 && hextets[1] === 0x0db8) return true;

  // 64:ff9b::/96 — NAT64 well-known prefix (RFC 6052)
  // Embedded IPv4 is in the last 32 bits (hextets[6..7])
  if (
    hextets[0] === 0x0064 &&
    hextets[1] === 0xff9b &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0
  ) {
    const embedded: [number, number, number, number] = [
      (hextets[6] >>> 8) & 0xff,
      hextets[6] & 0xff,
      (hextets[7] >>> 8) & 0xff,
      hextets[7] & 0xff
    ];
    return isPrivateIpv4(embedded);
  }

  // 64:ff9b:1::/48 — NAT64 local-use prefix (RFC 8215)
  if (hextets[0] === 0x0064 && hextets[1] === 0xff9b && hextets[2] === 0x0001) {
    return true;
  }

  // 2002::/16 — 6to4 (RFC 3056), embedded IPv4 in bits 16-47 (hextets[1..2])
  if (hextets[0] === 0x2002) {
    const embedded: [number, number, number, number] = [
      (hextets[1] >>> 8) & 0xff,
      hextets[1] & 0xff,
      (hextets[2] >>> 8) & 0xff,
      hextets[2] & 0xff
    ];
    return isPrivateIpv4(embedded);
  }

  return false;
}

/**
 * Validates an allow-list configuration.
 * Each entry must be a full origin (scheme + host), optionally followed by a path prefix.
 * Returns an array of error messages for invalid entries.
 */
export function validateAllowList(allowedUrlPrefixes: string[]): string[] {
  const errors: string[] = [];

  for (const entry of allowedUrlPrefixes) {
    const parsed = parseUrl(entry);
    if (!parsed) {
      errors.push(
        `Invalid URL in allow-list: "${entry}" - must be a valid URL with scheme and host (e.g., "https://example.com")`
      );
      continue;
    }

    const url = new URL(entry);

    // Only allow http and https
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      errors.push(
        `Only http and https URLs are allowed in allow-list: "${entry}"`
      );
      continue;
    }

    // Must have a valid host (not empty)
    if (!url.hostname) {
      errors.push(`Allow-list entry must include a hostname: "${entry}"`);
      continue;
    }

    // Warn about query strings and fragments (they'll be ignored)
    if (url.search || url.hash) {
      errors.push(
        `Query strings and fragments are ignored in allow-list entries: "${entry}"`
      );
    }
  }

  return errors;
}
