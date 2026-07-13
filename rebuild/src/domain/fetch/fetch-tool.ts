import { z } from "zod";
import { TimeoutError } from "../../kernel/errors.js";
import type { EventBus } from "../../kernel/events.js";
import { stableHash } from "../../kernel/ids.js";
import { truncateForModel } from "../../kernel/json.js";
import type { Clock } from "../../ports/clock.js";
import type { FetchLike } from "../../ports/http.js";
import { tool, type ToolSet } from "../tools/types.js";
import { globToRegExp, type Workspace } from "../workspace/workspace.js";

export interface FetchBindingConfig {
  /** Service binding abstraction: this binding's own outbound fetch. */
  fetch: FetchLike;
  /** Path-based allowlist patterns, e.g. "/v1/docs/**". */
  allowlist: string[];
  /** Fixed server-side headers, never shown to the model. */
  headers?: Record<string, string>;
}

export interface FetchToolConfig {
  /** URL patterns for the generic fetch_url tool. Omit to not expose fetch_url. */
  allowlist?: string[];
  /** One fetch_<name> tool per binding. */
  bindings?: Record<string, FetchBindingConfig>;
  /** Download cap in bytes. Default 1_000_000. */
  maxBytes?: number;
  /** Model-facing text cap in characters. Default 8_000. */
  maxModelChars?: number;
  /** Request timeout in milliseconds. Default 10_000. */
  timeoutMs?: number;
  /** Whether fetch_url follows redirects. Default true. Bindings always may follow same-origin redirects. */
  followRedirects?: boolean;
  /** Header names (case-insensitive) the model may set. Default ["accept","accept-language","range"]. */
  modelHeaderAllowlist?: string[];
  /** Default Accept header sent when the model doesn't supply one. "" disables the default. */
  defaultAccept?: string;
  /** "workspace" always spills the body to the workspace; "auto" (default) spills only oversized/binary bodies. */
  response?: "auto" | "workspace";
}

export interface FetchTimeoutHandle {
  promise: Promise<void>;
  cancel: () => void;
}

export interface FetchToolDeps {
  /** Outbound fetch for the generic fetch_url tool. */
  fetch: FetchLike;
  workspace?: Workspace;
  bus?: EventBus;
  clock: Clock;
  /**
   * Returns a promise that resolves once `ms` has elapsed, plus a cancel to
   * stop it early. Injectable so tests are instant/deterministic. Defaults
   * to a real setTimeout-backed timer.
   */
  timeout?: (ms: number) => FetchTimeoutHandle;
}

export type FetchFailureCode =
  | "disallowed_url"
  | "disallowed_redirect"
  | "timeout"
  | "non_2xx"
  | "unsupported_content_type"
  | "invalid_json"
  | "too_large"
  | "request_failed";

export interface FetchSuccess {
  ok: true;
  status: number;
  finalUrl: string;
  contentType: string;
  bytes: number;
  truncated: boolean;
  body?: string;
  json?: unknown;
  path?: string;
}

export interface FetchFailure {
  ok: false;
  code: FetchFailureCode;
  message: string;
  status?: number;
}

export type FetchResult = FetchSuccess | FetchFailure;

const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_MAX_MODEL_CHARS = 8_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MODEL_HEADER_ALLOWLIST = ["accept", "accept-language", "range"];
const DEFAULT_ACCEPT = "text/markdown;q=1.0, text/plain;q=0.9, application/json;q=0.8, text/html;q=0.7, */*;q=0.1";
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// ---------------------------------------------------------------------------
// Allowlist matching (doc 16 / doc 15 §1 globToRegExp)
// ---------------------------------------------------------------------------

interface ParsedTarget {
  scheme?: string;
  host?: string;
  port?: string;
  path: string;
}

function isAbsoluteUrl(s: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s);
}

function defaultPortFor(protocol: string): string {
  if (protocol === "https:") return "443";
  if (protocol === "http:") return "80";
  return "";
}

function parseTarget(raw: string): ParsedTarget {
  if (isAbsoluteUrl(raw)) {
    const u = new URL(raw);
    return {
      scheme: u.protocol.replace(/:$/, "").toLowerCase(),
      host: u.hostname.toLowerCase(),
      port: u.port || defaultPortFor(u.protocol),
      path: u.pathname,
    };
  }
  const withoutHash = raw.split("#")[0] ?? raw;
  const withoutQuery = withoutHash.split("?")[0] ?? withoutHash;
  return { path: withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}` };
}

function matchesPath(targetPath: string, patternPath: string): boolean {
  // Bare origin ("" or "/"): matches that origin/prefix and every subpath.
  if (patternPath === "" || patternPath === "/") return true;
  if (patternPath.includes("*")) return globToRegExp(patternPath).test(targetPath);
  return targetPath === patternPath;
}

function matchesPattern(target: ParsedTarget, patternRaw: string): boolean {
  const pattern = parseTarget(patternRaw);
  if (pattern.scheme !== undefined) {
    if (target.scheme === undefined) return false;
    if (target.scheme !== pattern.scheme) return false;
    if (target.host !== pattern.host) return false;
    if (target.port !== pattern.port) return false;
  }
  return matchesPath(target.path, pattern.path);
}

/**
 * Compares scheme+host+port+path only (query/fragment ignored, though still
 * sent on the actual request). A bare origin pattern matches every subpath;
 * a path-only pattern (no scheme) matches against the target's path alone,
 * so it works for both a binding's bare-path input and a model-supplied
 * absolute URL to a binding tool.
 */
export function matchesAllowlist(url: string, patterns: string[]): boolean {
  const target = parseTarget(url);
  return patterns.some((pattern) => matchesPattern(target, pattern));
}

// ---------------------------------------------------------------------------
// Forbidden hosts (literal-IP parsing only; DNS resolution out of scope)
// ---------------------------------------------------------------------------

function isIpv4(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

function ipv4Forbidden(hostname: string): boolean {
  const octets = hostname.split(".").map((s) => Number(s));
  const [a, b] = octets;
  if (a === undefined || b === undefined) return false;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function ipv6Forbidden(hostname: string): boolean {
  const literal = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (literal === "::1") return true;
  const first = literal.split(":")[0] ?? "";
  if (first === "") return false;
  const value = Number.parseInt(first, 16);
  if (Number.isNaN(value)) return false;
  if ((value & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((value & 0xffc0) === 0xfe80) return true; // fe80::/10
  return false;
}

function looksLikeIpv6(hostname: string): boolean {
  const literal = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return literal.includes(":");
}

/** Blocks private/loopback/link-local/.internal hosts. Applies to any absolute URL; path-only input has no host and is never forbidden. */
export function isForbiddenHost(url: string): boolean {
  if (!isAbsoluteUrl(url)) return false;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === "localhost" || hostname === "0.0.0.0") return true;
  if (hostname.endsWith(".internal")) return true;
  if (isIpv4(hostname)) return ipv4Forbidden(hostname);
  if (looksLikeIpv6(hostname)) return ipv6Forbidden(hostname);
  return false;
}

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

function defaultTimeout(ms: number): FetchTimeoutHandle {
  let handle: ReturnType<typeof setTimeout>;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => clearTimeout(handle),
  };
}

type RawResponse = Awaited<ReturnType<FetchLike>>;

async function fetchWithTimeout(
  fetchLike: FetchLike,
  url: string,
  init: Parameters<FetchLike>[1],
  timeoutMs: number,
  timeoutFn: (ms: number) => FetchTimeoutHandle
): Promise<RawResponse> {
  const { promise: timeoutPromise, cancel } = timeoutFn(timeoutMs);
  try {
    // The timeout branch's `.then` is registered first so that an
    // already-settled (test) timeout promise wins ties over an
    // already-settled fetch promise — .then() on a settled promise queues a
    // microtask job immediately, and registration order determines queue
    // order when both sides are pre-settled.
    const winner = await Promise.race([
      timeoutPromise.then(() => ({ kind: "timeout" as const })),
      fetchLike(url, init).then((r) => ({ kind: "response" as const, r })),
    ]);
    if (winner.kind === "timeout") {
      throw new TimeoutError(`request timed out after ${timeoutMs}ms`);
    }
    return winner.r;
  } finally {
    cancel();
  }
}

// ---------------------------------------------------------------------------
// URL helpers for redirect resolution
// ---------------------------------------------------------------------------

function originOf(url: string): string | undefined {
  if (!isAbsoluteUrl(url)) return undefined;
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

function resolveRedirect(location: string, base: string): string {
  if (isAbsoluteUrl(location)) return location;
  if (isAbsoluteUrl(base)) return new URL(location, base).toString();
  const basePath = base.startsWith("/") ? base : `/${base}`;
  const resolved = new URL(location, `http://binding.local${basePath}`);
  return resolved.pathname + resolved.search;
}

// ---------------------------------------------------------------------------
// Workspace spill
// ---------------------------------------------------------------------------

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "text/html": "html",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/json": "json",
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function extensionForContentType(contentType: string): string {
  return EXT_BY_CONTENT_TYPE[contentType] ?? "bin";
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function spillToWorkspace(workspace: Workspace, finalUrl: string, contentType: string, buf: ArrayBuffer, clock: Clock): string {
  const host = isAbsoluteUrl(finalUrl) ? new URL(finalUrl).hostname : "binding";
  const hash = stableHash({ url: finalUrl, at: clock.now() }).slice(0, 16);
  const ext = extensionForContentType(contentType);
  const path = `fetch/${host}/${hash}.${ext}`;
  workspace.write(path, arrayBufferToBase64(buf), { encoding: "base64", mediaType: contentType || undefined });
  return path;
}

// ---------------------------------------------------------------------------
// Tool assembly
// ---------------------------------------------------------------------------

type Role =
  | { kind: "public"; allowlist: string[]; fetch: FetchLike; followRedirects: boolean }
  | { kind: "binding"; allowlist: string[]; fetch: FetchLike; fixedHeaders?: Record<string, string> };

interface Shared {
  deps: FetchToolDeps;
  maxBytes: number;
  maxModelChars: number;
  timeoutMs: number;
  modelHeaderAllowlist: string[];
  defaultAccept?: string;
  responseMode: "auto" | "workspace";
}

interface FetchInput {
  url: string;
  accept?: string;
  headers?: Record<string, string>;
  response?: "auto" | "workspace";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildRequestHeaders(input: FetchInput, shared: Shared): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (shared.modelHeaderAllowlist.includes(key.toLowerCase())) {
      out[key.toLowerCase()] = value;
    }
  }
  let accept = shared.defaultAccept;
  if (input.accept !== undefined && shared.modelHeaderAllowlist.includes("accept")) {
    accept = input.accept;
  }
  if (accept !== undefined) out.accept = accept;
  return out;
}

function fail(code: FetchFailureCode, message: string, status?: number): FetchFailure {
  return status === undefined ? { ok: false, code, message } : { ok: false, code, message, status };
}

function isTextContentType(contentType: string): boolean {
  if (contentType === "") return true;
  if (contentType.startsWith("text/")) return true;
  if (contentType === "application/json" || contentType.endsWith("+json")) return true;
  if (contentType === "application/xml" || contentType.endsWith("+xml")) return true;
  if (contentType === "application/javascript") return true;
  return false;
}

function isJsonContentType(contentType: string): boolean {
  return contentType === "application/json" || contentType.endsWith("+json");
}

async function buildResult(finalUrl: string, response: RawResponse, shared: Shared, input: FetchInput): Promise<FetchResult> {
  const status = response.status;
  const contentTypeRaw = response.headers.get("content-type") ?? "";
  const contentType = (contentTypeRaw.split(";")[0] ?? "").trim().toLowerCase();

  if (status < 200 || status >= 300) {
    return fail("non_2xx", `unexpected status ${status}`, status);
  }

  const buf = await response.arrayBuffer();
  const bytes = buf.byteLength;
  const oversized = bytes > shared.maxBytes;
  const text = isTextContentType(contentType);
  const responseMode = input.response ?? shared.responseMode;
  const shouldSpill = shared.deps.workspace !== undefined && (responseMode === "workspace" || oversized || !text);

  if (shouldSpill && shared.deps.workspace) {
    const path = spillToWorkspace(shared.deps.workspace, finalUrl, contentType, buf, shared.deps.clock);
    return { ok: true, status, finalUrl, contentType, bytes, truncated: false, path };
  }

  if (oversized) {
    return fail("too_large", `body exceeds maxBytes (${shared.maxBytes})`, status);
  }

  if (isJsonContentType(contentType)) {
    const decoded = new TextDecoder().decode(buf);
    try {
      const json: unknown = JSON.parse(decoded);
      return { ok: true, status, finalUrl, contentType, bytes, truncated: false, json };
    } catch {
      return fail("invalid_json", "response body is not valid JSON", status);
    }
  }

  if (text) {
    const decoded = new TextDecoder().decode(buf);
    const { text: bounded, truncated } = truncateForModel(decoded, shared.maxModelChars);
    return { ok: true, status, finalUrl, contentType, bytes, truncated, body: bounded };
  }

  return fail("unsupported_content_type", `unsupported content-type: ${contentType || "(none)"}`, status);
}

async function performFetch(input: FetchInput, role: Role, shared: Shared): Promise<FetchResult> {
  let url = input.url;
  const headers = buildRequestHeaders(input, shared);
  const baseOrigin = originOf(url);
  let hopCount = 0;

  while (true) {
    const isFirstHop = hopCount === 0;

    if (!matchesAllowlist(url, role.allowlist)) {
      return fail(isFirstHop ? "disallowed_url" : "disallowed_redirect", `URL not in allowlist: ${url}`);
    }
    if (isForbiddenHost(url)) {
      return fail("disallowed_url", `host is not allowed: ${url}`);
    }

    let requestHeaders = { ...headers };
    if (role.kind === "binding" && role.fixedHeaders) {
      requestHeaders = { ...requestHeaders, ...role.fixedHeaders };
    }

    let response: RawResponse;
    try {
      response = await fetchWithTimeout(
        role.fetch,
        url,
        { method: "GET", headers: requestHeaders, redirect: "manual" },
        shared.timeoutMs,
        shared.deps.timeout ?? defaultTimeout
      );
    } catch (err) {
      if (err instanceof TimeoutError) return fail("timeout", err.message);
      return fail("request_failed", errorMessage(err));
    }

    const canFollow = role.kind === "public" ? role.followRedirects : true;
    if (REDIRECT_STATUSES.has(response.status) && canFollow) {
      const location = response.headers.get("location");
      if (!location) {
        return fail("request_failed", "redirect response missing Location header");
      }
      const nextUrl = resolveRedirect(location, url);
      hopCount++;
      if (hopCount > MAX_REDIRECTS) {
        return fail("disallowed_redirect", "too many redirects");
      }
      if (role.kind === "binding" && originOf(nextUrl) !== baseOrigin) {
        return fail("disallowed_redirect", "binding tools do not follow cross-origin redirects");
      }
      url = nextUrl;
      continue;
    }

    return buildResult(url, response, shared, input);
  }
}

const fetchInputSchema = z.object({
  url: z.string(),
  accept: z.string().optional(),
  headers: z.record(z.string()).optional(),
  response: z.enum(["auto", "workspace"]).optional(),
});

function buildFetchTool(name: string, role: Role, shared: Shared) {
  return tool<FetchInput, FetchResult>({
    description:
      role.kind === "public"
        ? "Fetch a URL over HTTP GET. Restricted to an allowlist of origins/paths; blocks private/internal hosts."
        : `Fetch a path via the ${name.replace(/^fetch_/, "")} service binding, restricted to an allowlist of paths.`,
    inputSchema: fetchInputSchema,
    metadata: { capability: "fetch" },
    async execute(input) {
      const result = await performFetch(input, role, shared);
      const payload: Record<string, unknown> = { url: input.url, ok: result.ok };
      if (!result.ok) payload.code = result.code;
      if (result.status !== undefined) payload.status = result.status;
      if (result.ok) payload.bytes = result.bytes;
      shared.deps.bus?.emit("tool:fetch", payload);
      return result;
    },
  });
}

/** Builds fetch_url (if `config.allowlist` is set) and one fetch_<name> per binding. */
export function createFetchTools(config: FetchToolConfig, deps: FetchToolDeps): ToolSet {
  const shared: Shared = {
    deps,
    maxBytes: config.maxBytes ?? DEFAULT_MAX_BYTES,
    maxModelChars: config.maxModelChars ?? DEFAULT_MAX_MODEL_CHARS,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    modelHeaderAllowlist: (config.modelHeaderAllowlist ?? DEFAULT_MODEL_HEADER_ALLOWLIST).map((h) => h.toLowerCase()),
    defaultAccept: config.defaultAccept === "" ? undefined : (config.defaultAccept ?? DEFAULT_ACCEPT),
    responseMode: config.response ?? "auto",
  };

  const tools: ToolSet = {};

  if (config.allowlist) {
    const role: Role = {
      kind: "public",
      allowlist: config.allowlist,
      fetch: deps.fetch,
      followRedirects: config.followRedirects ?? true,
    };
    tools.fetch_url = buildFetchTool("fetch_url", role, shared);
  }

  for (const [name, binding] of Object.entries(config.bindings ?? {})) {
    const role: Role = {
      kind: "binding",
      allowlist: binding.allowlist,
      fetch: binding.fetch,
      fixedHeaders: binding.headers,
    };
    tools[`fetch_${name}`] = buildFetchTool(`fetch_${name}`, role, shared);
  }

  return tools;
}
