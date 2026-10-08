/**
 * Which URLs a tool that reaches the web may request, shared by `web_fetch`
 * and Think's `fetch_url`. Internal — not an entry point.
 *
 * Hosts are compared as the WHATWG URL parser leaves them. It already
 * canonicalises IP literals (`0x7f.1`, `2130706433`, `0177.0.0.1` become
 * `127.0.0.1`; `[::ffff:127.0.0.1]` becomes `[::ffff:7f00:1]`) and
 * punycodes IDNs, and host patterns go through the same parser, so this
 * module is a URL parser plus a range table.
 *
 * The ranges are a deliberate subset of the IANA IPv4 and IPv6
 * Special-Purpose Address Registries (RFC 6890) — loopback, private,
 * link-local, and unspecified, plus a few cheap extras — not a mirror:
 * https://www.iana.org/assignments/iana-ipv4-special-registry
 * https://www.iana.org/assignments/iana-ipv6-special-registry
 *
 * There is no DNS resolution, so a public name that resolves to a private
 * address (`127.0.0.1.nip.io`) is not caught. Deployed Workers can't reach
 * private networks anyway; this is for `wrangler dev`, non-workerd
 * runtimes, and defence in depth.
 */

/** The default for {@link UrlPolicy.maxUrlLength}, in characters. */
export const DEFAULT_MAX_URL_LENGTH = 2000;

/** What a host may request. Every field is optional. */
export type UrlPolicy = {
  /**
   * Host patterns the URL must match, when non-empty. `example.com` matches
   * that host only; `*.example.com` matches its subdomains at any depth but
   * not `example.com` itself; `*` matches any host. Empty or omitted: any
   * public host.
   */
  allowedHosts?: readonly string[];
  /** Host patterns never requested, in the same syntax. Checked first. */
  blockedHosts?: readonly string[];
  /**
   * Allow loopback, private, link-local, metadata, and local-only names
   * (`localhost`, `*.localhost`, `*.internal`). Off by default; turn on for
   * local development against `localhost`.
   */
  allowPrivateHosts?: boolean;
  /** The longest URL accepted, in characters. Defaults to 2000. */
  maxUrlLength?: number;
};

/**
 * Why {@link validateUrl} rejected a URL: not an absolute URL, longer than
 * `maxUrlLength`, not http(s), carries userinfo, matches `blockedHosts`,
 * matches none of a non-empty `allowedHosts`, or a private or local host.
 */
export type UrlPolicyViolation =
  | "invalid_url"
  | "too_long"
  | "unsupported_protocol"
  | "credentials"
  | "blocked_host"
  | "host_not_allowed"
  | "private_host";

/**
 * The outcome of a URL check. On success, `url` has its fragment removed;
 * on failure, `message` says why, naming the host where there is one.
 */
export type UrlValidation =
  | { ok: true; url: URL }
  | { ok: false; code: UrlPolicyViolation; message: string };

/**
 * Check a URL against a policy. Never throws: a malformed input or policy
 * comes back as a failed result.
 */
export function validateUrl(
  input: string,
  policy: UrlPolicy = {}
): UrlValidation {
  if (typeof input !== "string") {
    return reject("invalid_url", "The URL must be a string.");
  }
  const maxLength = policy.maxUrlLength ?? DEFAULT_MAX_URL_LENGTH;
  if (input.length > maxLength) {
    return reject(
      "too_long",
      `The URL is ${input.length} characters; the limit is ${maxLength}.`
    );
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return reject("invalid_url", "Not a valid absolute URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return reject(
      "unsupported_protocol",
      `Only http and https URLs can be fetched, not ${url.protocol.replace(/:$/, "")}.`
    );
  }
  if (url.username || url.password) {
    return reject(
      "credentials",
      "URLs with a username or password can't be fetched."
    );
  }
  url.hash = "";
  const host = url.hostname.replace(/\.$/, "");
  if (matchesAnyHostPattern(host, policy.blockedHosts)) {
    return reject("blocked_host", `The host ${host} is blocked.`);
  }
  const allowed = policy.allowedHosts;
  if (allowed && allowed.length > 0 && !matchesAnyHostPattern(host, allowed)) {
    return reject("host_not_allowed", `The host ${host} is not allowed.`);
  }
  if (!policy.allowPrivateHosts && isPrivateOrLocalHost(host)) {
    return reject(
      "private_host",
      `The host ${host} is a private or local address.`
    );
  }
  return { ok: true, url };
}

/**
 * Resolve a redirect's `Location` against the URL that sent it and check
 * the target against the same policy as the original request.
 */
export function validateRedirect(
  location: string,
  from: URL,
  policy: UrlPolicy = {}
): UrlValidation {
  let target: URL;
  try {
    target = new URL(location, from);
  } catch {
    return reject("invalid_url", "The redirect target is not a valid URL.");
  }
  return validateUrl(target.href, policy);
}

/**
 * Check a policy's own values when a tool is built. Host configuration
 * errors are programming errors, so this throws a `RangeError`, unlike
 * {@link validateUrl}.
 */
export function validateUrlPolicy(policy: UrlPolicy): void {
  const { maxUrlLength } = policy;
  if (
    maxUrlLength !== undefined &&
    !(Number.isInteger(maxUrlLength) && maxUrlLength > 0)
  ) {
    throw new RangeError(
      `maxUrlLength must be a positive integer; got ${maxUrlLength}.`
    );
  }
  for (const key of ["allowedHosts", "blockedHosts"] as const) {
    const patterns = policy[key];
    if (patterns === undefined) continue;
    if (!Array.isArray(patterns)) {
      throw new RangeError(`${key} must be an array of host patterns.`);
    }
    for (const pattern of patterns) {
      if (canonicalHostPattern(pattern) === undefined) {
        throw new RangeError(
          `${key} has an invalid host pattern ${JSON.stringify(pattern)}: use "example.com", "*.example.com", or "*".`
        );
      }
    }
  }
}

/**
 * Whether a host, as `URL.hostname` gives it, is in one of the ranges below
 * (IPv4, or IPv6 including IPv4-mapped, NAT64 and 6to4 forms), or is
 * `localhost` or ends in `.localhost` or `.internal`.
 */
export function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.length === 0) return true;
  if (host.startsWith("[")) return isPrivateIpv6(host.slice(1, -1));
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    return octets.some((n) => n > 255) || isPrivateIpv4(toUint32(octets));
  }
  // Defensive: the URL parser turns a numeric last label into dotted IPv4.
  // If one survives, the runtime's parser didn't, so refuse rather than guess.
  if (/(^|\.)(\d+|0x[0-9a-f]*)$/.test(host)) return true;
  return LOCAL_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s));
}

const LOCAL_SUFFIXES = [".localhost", ".internal"];

function matchesAnyHostPattern(
  host: string,
  patterns: readonly string[] | undefined
): boolean {
  if (!Array.isArray(patterns)) return false;
  return patterns.some((raw) => {
    const pattern = canonicalHostPattern(raw);
    if (pattern === undefined) return false;
    if (pattern === "*") return true;
    if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1));
    return host === pattern;
  });
}

/**
 * `*`, or a bare host with an optional `*.` prefix, canonicalised by the URL
 * parser exactly as a request's host is; `undefined` for anything else.
 */
function canonicalHostPattern(pattern: unknown): string | undefined {
  if (typeof pattern !== "string") return undefined;
  const trimmed = pattern.trim();
  if (trimmed === "*") return "*";
  const wildcard = trimmed.startsWith("*.");
  const rest = wildcard ? trimmed.slice(2) : trimmed;
  // No scheme, port, path, userinfo, or inner wildcard.
  if (rest === "" || /[*/?#@\\\s]/.test(rest)) return undefined;
  // An IPv6 literal is bracketed and nothing follows the bracket, so
  // `[::1]:8080` is as invalid as `example.com:8080`.
  if (rest.includes(":") && !(rest.startsWith("[") && rest.endsWith("]"))) {
    return undefined;
  }
  try {
    const host = new URL(`http://${rest}/`).hostname.replace(/\.$/, "");
    if (host === "") return undefined;
    if (!wildcard) return host;
    // Nothing is a subdomain of an IP literal.
    return host.startsWith("[") || /^[\d.]+$/.test(host)
      ? undefined
      : `*.${host}`;
  } catch {
    return undefined;
  }
}

// ── Address ranges ───────────────────────────────────────────────

/** `[a, b, c, d, prefix length]`: IPv4 registry rows, plus 224/4 and 240/4. */
const PRIVATE_IPV4_RANGES = [
  [0, 0, 0, 0, 8], // "this network"
  [10, 0, 0, 0, 8], // private
  [100, 64, 0, 0, 10], // carrier-grade NAT
  [127, 0, 0, 0, 8], // loopback
  [169, 254, 0, 0, 16], // link-local, including cloud metadata
  [172, 16, 0, 0, 12], // private
  [192, 0, 0, 0, 24], // IETF protocol assignments
  [192, 168, 0, 0, 16], // private
  [198, 18, 0, 0, 15], // benchmarking
  [224, 0, 0, 0, 4], // multicast (RFC 5771)
  [240, 0, 0, 0, 4] // reserved, including broadcast
].map((row) => [toUint32(row), 32 - row[4]] as const);

function toUint32([a, b, c, d]: readonly number[]): number {
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function isPrivateIpv4(address: number): boolean {
  return PRIVATE_IPV4_RANGES.some(
    ([network, shift]) => address >>> shift === network >>> shift
  );
}

/**
 * Whether a canonical IPv6 address (compressed hex, no brackets, dotted
 * tail, or zone; the URL parser rejected anything else) is private.
 */
function isPrivateIpv6(text: string): boolean {
  const [head, tail = ""] = text.split("::");
  const hex = (part: string) =>
    part ? part.split(":").map((x) => Number.parseInt(x, 16)) : [];
  const left = hex(head);
  const right = hex(tail);
  const fill = Math.max(0, 8 - left.length - right.length);
  const g = [...left, ...new Array<number>(fill).fill(0), ...right];
  if (g.length !== 8 || g.some(Number.isNaN)) return true;
  const zeros = (from: number, to: number) =>
    g.slice(from, to).every((x) => x === 0);
  const v4At = (i: number) => g[i] * 0x10000 + g[i + 1];
  if (zeros(0, 6)) return true; // ::, ::1, and IPv4-compatible ::/96
  if (zeros(0, 5) && g[5] === 0xffff) return isPrivateIpv4(v4At(6)); // mapped
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) {
    return isPrivateIpv4(v4At(6)); // NAT64 64:ff9b::/96
  }
  if (g[0] === 0x2002) return isPrivateIpv4(v4At(1)); // 6to4 2002::/16
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local fec0::/10
  return (g[0] & 0xff00) === 0xff00; // multicast ff00::/8
}

function reject(code: UrlPolicyViolation, message: string): UrlValidation {
  return { ok: false, code, message };
}
