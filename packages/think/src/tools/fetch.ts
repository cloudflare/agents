import type { JSONValue, ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";

// ── Public types ──────────────────────────────────────────────────
//
// A conservative, opt-in HTTP read capability for Think agents. It is
// deliberately read-only (GET), allowlisted, and bounded. It is NOT a
// general-purpose HTTP client and NOT an SSRF primitive — mutations and
// rendered-page automation live elsewhere (explicit actions, Browser Run).
//
// @experimental The API surface may change before stabilizing.

export type FetchResponseMode = "text" | "json" | "auto" | "workspace";
export type FetchRedirectPolicy = "allowlisted" | "same-origin" | "none";

export type FetchErrorCode =
  | "disallowed_url"
  | "disallowed_redirect"
  | "timeout"
  | "aborted"
  | "non_2xx"
  | "unsupported_content_type"
  | "invalid_json"
  | "too_large"
  | "request_failed";

export type FetchResult =
  | {
      ok: true;
      status: number;
      finalUrl: string;
      contentType: string;
      bytes: number;
      truncated: boolean;
      response: "text" | "json" | "workspace";
      body?: string;
      json?: JSONValue;
      path?: string;
    }
  | {
      ok: false;
      code: FetchErrorCode;
      status?: number;
      finalUrl?: string;
      message: string;
    };

export interface FetchToolEvent {
  tool: string;
  ok: boolean;
  requestedUrl: string;
  finalUrl?: string;
  status?: number;
  bytes?: number;
  truncated?: boolean;
  response?: FetchResponseMode;
  code?: FetchErrorCode;
}

/**
 * Minimal workspace surface the fetch tool needs to spill large/binary
 * responses to a file. A concrete `Workspace` from `@cloudflare/shell`
 * satisfies this.
 */
export interface FetchWorkspace {
  writeFile(path: string, content: string): Promise<void> | void;
  writeFileBytes?(path: string, content: Uint8Array): Promise<void> | void;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> | void;
}

export interface FetchBindingTarget {
  /** The service binding / Fetcher requests are routed through. */
  binding: Fetcher;
  /** Documented purpose — surfaced in the generated tool description. */
  description?: string;
  /**
   * Allowlist for this target. Entries starting with `/` match the request
   * pathname (e.g. `/v1/docs/**`); entries starting with `http(s)://` match
   * the full canonical URL.
   */
  allowlist: string[];
  /** Fixed, server-side headers. Never settable by the model, never echoed. */
  headers?: Record<string, string>;
  /** Base URL used to resolve relative paths. Defaults to `https://binding.local`. */
  baseUrl?: string;
}

export interface CreateFetchToolsOptions {
  /**
   * Allowlist for the generic public `fetch_url` tool. Entries are absolute
   * URL/origin/path globs (e.g. `https://developers.cloudflare.com/**`). When
   * omitted/empty, `fetch_url` is not registered.
   */
  allowlist?: string[];
  /**
   * Named binding targets. Each entry generates a `fetch_<name>` tool with the
   * binding, allowlist, and fixed headers baked in.
   */
  bindings?: Record<string, FetchBindingTarget>;
  /** Hard download cap in bytes. Default 1_000_000. */
  maxBytes?: number;
  /** Model-facing text truncation in characters. Default 24_000. */
  maxModelChars?: number;
  /** Allow large/binary bodies to spill to a workspace file. Default false. */
  spillToWorkspace?: boolean;
  /** Workspace used for `response: "workspace"` / spill. */
  workspace?: FetchWorkspace;
  /** Per-request timeout in ms. Default 10_000. */
  timeoutMs?: number;
  /** Default response handling. Default `"auto"`. */
  response?: FetchResponseMode;
  /** Redirect policy. Default `"allowlisted"`. */
  followRedirects?: FetchRedirectPolicy;
  /** Header names the model may set. Default `["accept", "accept-language", "range"]`. */
  modelHeaderAllowlist?: string[];
  /**
   * Default `Accept` header sent when neither the binding's fixed headers nor
   * the model already set one. Defaults to a markdown-first, weighted value so
   * content-negotiating endpoints return clean markdown/plain text/JSON instead
   * of HTML. Set to `""` to send no default `Accept` header.
   */
  defaultAccept?: string;
  /** Observability hook. Fires once per fetch (success or failure/block). */
  onEvent?: (event: FetchToolEvent) => void;
}

const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_MAX_MODEL_CHARS = 24_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MODEL_HEADER_ALLOWLIST = ["accept", "accept-language", "range"];
// Markdown-first, but still accepts everything (`*/*;q=0.1`) so a strict
// content-negotiating server never answers 406.
const DEFAULT_ACCEPT =
  "text/markdown, text/plain;q=0.9, application/json;q=0.8, text/html;q=0.5, */*;q=0.1";
const MAX_REDIRECTS = 5;

interface ResolvedConfig {
  maxBytes: number;
  maxModelChars: number;
  spillToWorkspace: boolean;
  workspace?: FetchWorkspace;
  timeoutMs: number;
  response: FetchResponseMode;
  followRedirects: FetchRedirectPolicy;
  modelHeaderAllowlist: Set<string>;
  defaultAccept: string;
  onEvent?: (event: FetchToolEvent) => void;
}

interface CompiledPattern {
  scope: "path" | "url";
  re: RegExp;
}

interface ResolvedTarget {
  kind: "public" | "binding";
  binding?: Fetcher;
  allowlist: CompiledPattern[];
  fixedHeaders: Record<string, string>;
  baseUrl: string;
}

/**
 * Create the Think fetch tools.
 *
 * Returns a generic `fetch_url` tool (when a public `allowlist` is configured)
 * plus one `fetch_<name>` tool per configured binding target. Throws when no
 * allowlist and no bindings are configured, so a misconfiguration fails loudly
 * instead of silently registering nothing.
 *
 * @example
 * ```ts
 * createFetchTools({
 *   allowlist: ["https://developers.cloudflare.com/**"],
 *   bindings: {
 *     docsApi: { binding: env.DOCS_API, allowlist: ["/v1/docs/**"] }
 *   }
 * });
 * ```
 */
export function createFetchTools(options: CreateFetchToolsOptions): ToolSet {
  const publicAllowlist = (options.allowlist ?? []).filter(
    (entry) => entry.length > 0
  );
  const bindings = options.bindings ?? {};
  const bindingNames = Object.keys(bindings);

  if (publicAllowlist.length === 0 && bindingNames.length === 0) {
    throw new Error(
      "createFetchTools requires a non-empty `allowlist` or at least one `bindings` target."
    );
  }

  const config: ResolvedConfig = {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    maxModelChars: options.maxModelChars ?? DEFAULT_MAX_MODEL_CHARS,
    spillToWorkspace: options.spillToWorkspace ?? false,
    workspace: options.workspace,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    response: options.response ?? "auto",
    followRedirects: options.followRedirects ?? "allowlisted",
    modelHeaderAllowlist: new Set(
      (options.modelHeaderAllowlist ?? DEFAULT_MODEL_HEADER_ALLOWLIST).map(
        (name) => name.toLowerCase()
      )
    ),
    defaultAccept: options.defaultAccept ?? DEFAULT_ACCEPT,
    onEvent: options.onEvent
  };

  const tools: ToolSet = {};

  if (publicAllowlist.length > 0) {
    const target: ResolvedTarget = {
      kind: "public",
      allowlist: publicAllowlist.map(compilePattern),
      fixedHeaders: {},
      baseUrl: ""
    };
    tools.fetch_url = tool({
      description:
        "Fetch an allowlisted public URL over HTTP(S) (read-only GET). " +
        "Returns the response body as text or JSON, or spills large/binary " +
        "bodies to a workspace file. The URL must be on the configured " +
        "allowlist; disallowed or private-network URLs are rejected.",
      inputSchema: z.object({
        url: z
          .string()
          .describe("Absolute http(s) URL to fetch. Must be allowlisted."),
        response: responseModeSchema,
        headers: headersSchema
      }),
      execute: (input: FetchUrlInput, opts) =>
        runFetch({
          toolName: "fetch_url",
          target,
          config,
          requested: input.url,
          responseOverride: input.response,
          modelHeaders: input.headers,
          abortSignal: opts?.abortSignal
        }),
      toModelOutput: ({ output }) => toModelOutput(output as FetchResult)
    });
  }

  for (const name of bindingNames) {
    const def = bindings[name];
    const toolName = `fetch_${sanitizeName(name)}`;
    const target: ResolvedTarget = {
      kind: "binding",
      binding: def.binding,
      allowlist: def.allowlist.map(compilePattern),
      fixedHeaders: def.headers ?? {},
      baseUrl: def.baseUrl ?? "https://binding.local"
    };
    const purpose = def.description ? ` ${def.description}` : "";
    tools[toolName] = tool({
      description:
        `Fetch a read-only resource from the "${name}" service binding.${purpose} ` +
        "Provide a path (or an allowlisted absolute URL). Requests are routed " +
        "through the configured binding with fixed server-side headers.",
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            "Path (e.g. /v1/docs/search) or an allowlisted absolute URL."
          ),
        response: responseModeSchema,
        headers: headersSchema
      }),
      execute: (input: FetchBindingInput, opts) =>
        runFetch({
          toolName,
          target,
          config,
          requested: input.path,
          responseOverride: input.response,
          modelHeaders: input.headers,
          abortSignal: opts?.abortSignal
        }),
      toModelOutput: ({ output }) => toModelOutput(output as FetchResult)
    });
  }

  return tools;
}

const responseModeSchema = z
  .enum(["text", "json", "auto", "workspace"])
  .optional()
  .describe(
    "How to handle the response body. Defaults to the configured mode."
  );

const headersSchema = z
  .record(z.string(), z.string())
  .optional()
  .describe("Optional request headers; only safe read headers are honored.");

interface FetchUrlInput {
  url: string;
  response?: FetchResponseMode;
  headers?: Record<string, string>;
}

interface FetchBindingInput {
  path: string;
  response?: FetchResponseMode;
  headers?: Record<string, string>;
}

interface RunFetchArgs {
  toolName: string;
  target: ResolvedTarget;
  config: ResolvedConfig;
  requested: string;
  responseOverride?: FetchResponseMode;
  modelHeaders?: Record<string, string>;
  abortSignal?: AbortSignal;
}

async function runFetch(args: RunFetchArgs): Promise<FetchResult> {
  const { toolName, config, requested } = args;
  const result = await runFetchInner(args);
  if (config.onEvent) {
    try {
      config.onEvent(
        result.ok
          ? {
              tool: toolName,
              ok: true,
              requestedUrl: requested,
              finalUrl: result.finalUrl,
              status: result.status,
              bytes: result.bytes,
              truncated: result.truncated,
              response: result.response
            }
          : {
              tool: toolName,
              ok: false,
              requestedUrl: requested,
              finalUrl: result.finalUrl,
              status: result.status,
              code: result.code
            }
      );
    } catch {
      // Observability must never break a tool call.
    }
  }
  return result;
}

async function runFetchInner(args: RunFetchArgs): Promise<FetchResult> {
  const { target, config, requested, responseOverride, modelHeaders } = args;

  // Resolve the requested string into an absolute URL.
  const rawUrl =
    target.kind === "binding" && !/^https?:\/\//i.test(requested)
      ? resolveAgainstBase(requested, target.baseUrl)
      : requested;
  if (rawUrl === null) {
    return { ok: false, code: "disallowed_url", message: "Invalid path." };
  }

  const normalized = normalizeRequestUrl(rawUrl);
  if ("error" in normalized) {
    return { ok: false, code: "disallowed_url", message: normalized.error };
  }
  const url = normalized.url;

  if (target.kind === "public" && isBlockedHost(url.hostname)) {
    return {
      ok: false,
      code: "disallowed_url",
      message: `Refusing to fetch a private or local address: ${url.hostname}`
    };
  }

  if (!matchesAllowlist(url, target.allowlist)) {
    return {
      ok: false,
      code: "disallowed_url",
      message: `URL is not on the allowlist: ${url.toString()}`
    };
  }

  const responseMode = responseOverride ?? config.response;
  const safeModelHeaders = filterModelHeaders(
    modelHeaders,
    config.modelHeaderAllowlist
  );

  return executeRequest({
    target,
    config,
    initialUrl: url,
    responseMode,
    fixedHeaders: target.fixedHeaders,
    modelHeaders: safeModelHeaders,
    abortSignal: args.abortSignal
  });
}

interface ExecuteRequestArgs {
  target: ResolvedTarget;
  config: ResolvedConfig;
  initialUrl: URL;
  responseMode: FetchResponseMode;
  fixedHeaders: Record<string, string>;
  modelHeaders: Record<string, string>;
  abortSignal?: AbortSignal;
}

async function executeRequest(args: ExecuteRequestArgs): Promise<FetchResult> {
  const { target, config, initialUrl, responseMode } = args;
  const method = "GET";

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (args.abortSignal) {
    if (args.abortSignal.aborted) controller.abort();
    else args.abortSignal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  const initialOrigin = initialUrl.origin;
  let currentUrl = initialUrl;
  let headers: Record<string, string> = applyDefaultAccept(
    mergeHeaders(args.fixedHeaders, args.modelHeaders),
    config.defaultAccept
  );

  try {
    for (let hop = 0; ; hop++) {
      if (hop > MAX_REDIRECTS) {
        return {
          ok: false,
          code: "request_failed",
          finalUrl: currentUrl.toString(),
          message: "Too many redirects."
        };
      }

      const res = await doFetch(
        target,
        currentUrl,
        method,
        headers,
        controller.signal
      );

      if (isRedirect(res.status)) {
        const location = res.headers.get("location");
        if (location) {
          const redirectOutcome = resolveRedirect({
            target,
            config,
            location,
            currentUrl,
            initialOrigin
          });
          if ("error" in redirectOutcome) {
            discardBody(res);
            return {
              ok: false,
              code: "disallowed_redirect",
              status: res.status,
              finalUrl: currentUrl.toString(),
              message: redirectOutcome.error
            };
          }
          // We're following the redirect; drop the 3xx body before the next hop.
          discardBody(res);
          // Strip credentials/headers on cross-origin hops, but keep a safe
          // default Accept so the next hop still negotiates for clean content.
          if (redirectOutcome.url.origin !== currentUrl.origin) {
            headers = applyDefaultAccept({}, config.defaultAccept);
          }
          currentUrl = redirectOutcome.url;
          continue;
        }
      }

      if (res.status < 200 || res.status >= 300) {
        discardBody(res);
        return {
          ok: false,
          code: "non_2xx",
          status: res.status,
          finalUrl: currentUrl.toString(),
          message: `HTTP ${res.status}`
        };
      }

      return finalizeResponse({
        res,
        config,
        responseMode,
        finalUrl: currentUrl.toString()
      });
    }
  } catch (error) {
    if (controller.signal.aborted) {
      const aborted = args.abortSignal?.aborted ?? false;
      return {
        ok: false,
        code: aborted ? "aborted" : "timeout",
        finalUrl: currentUrl.toString(),
        message: aborted ? "Request aborted." : "Request timed out."
      };
    }
    return {
      ok: false,
      code: "request_failed",
      finalUrl: currentUrl.toString(),
      message: errorMessage(error)
    };
  } finally {
    clearTimeout(timer);
    args.abortSignal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Cancel a response body we won't read (non-2xx, blocked/followed redirects)
 * so the underlying connection isn't left dangling.
 */
function discardBody(res: Response): void {
  res.body?.cancel().catch(() => {});
}

function doFetch(
  target: ResolvedTarget,
  url: URL,
  method: string,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers,
    redirect: "manual",
    signal
  };
  if (target.kind === "binding" && target.binding) {
    return target.binding.fetch(url.toString(), init);
  }
  return fetch(url.toString(), init);
}

interface ResolveRedirectArgs {
  target: ResolvedTarget;
  config: ResolvedConfig;
  location: string;
  currentUrl: URL;
  initialOrigin: string;
}

function resolveRedirect(
  args: ResolveRedirectArgs
): { url: URL } | { error: string } {
  const { target, config, location, currentUrl, initialOrigin } = args;
  if (config.followRedirects === "none") {
    return { error: "Redirects are disabled." };
  }

  let next: URL;
  try {
    next = new URL(location, currentUrl);
  } catch {
    return { error: "Invalid redirect target." };
  }
  if (next.protocol !== "http:" && next.protocol !== "https:") {
    return { error: "Redirect to a non-http(s) URL is not allowed." };
  }
  if (next.username || next.password) {
    return { error: "Redirect to a URL with credentials is not allowed." };
  }

  // Bindings are a transport, not a generic client: never redirect off-origin.
  if (target.kind === "binding" && next.origin !== currentUrl.origin) {
    return { error: "Cross-origin redirects are not allowed for bindings." };
  }

  if (target.kind === "public" && isBlockedHost(next.hostname)) {
    return {
      error: `Redirect to a private or local address: ${next.hostname}`
    };
  }

  if (config.followRedirects === "same-origin") {
    if (next.origin !== initialOrigin) {
      return { error: "Redirect escaped the original origin." };
    }
  } else if (config.followRedirects === "allowlisted") {
    if (!matchesAllowlist(next, target.allowlist)) {
      return { error: "Redirect target is not on the allowlist." };
    }
  }

  return { url: next };
}

interface FinalizeArgs {
  res: Response;
  config: ResolvedConfig;
  responseMode: FetchResponseMode;
  finalUrl: string;
}

async function finalizeResponse(args: FinalizeArgs): Promise<FetchResult> {
  const { res, config, responseMode, finalUrl } = args;
  const contentType = (res.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();

  const { bytes, capped } = await readCapped(res, config.maxBytes);
  const mode = resolveResponseMode(responseMode, contentType, config);

  // An empty body (204, HEAD-like, or a content-less 2xx) is a successful
  // empty-text read, not an unsupported content type.
  if (bytes.byteLength === 0 && mode !== "workspace") {
    return {
      ok: true,
      status: res.status,
      finalUrl,
      contentType,
      bytes: 0,
      truncated: false,
      response: "text",
      body: ""
    };
  }

  if (mode === "unsupported") {
    return {
      ok: false,
      code: "unsupported_content_type",
      finalUrl,
      message: `Unsupported content type: ${contentType || "unknown"}. Use response: "workspace" to store it.`
    };
  }

  if (mode === "workspace") {
    return spillToWorkspace({
      bytes,
      capped,
      contentType,
      finalUrl,
      status: res.status,
      config
    });
  }

  const text = new TextDecoder().decode(bytes);

  if (mode === "json") {
    if (capped) {
      return {
        ok: false,
        code: "too_large",
        finalUrl,
        message: `Response exceeded the ${config.maxBytes} byte cap and cannot be parsed as JSON. Use response: "workspace".`
      };
    }
    try {
      const json = JSON.parse(text) as JSONValue;
      return {
        ok: true,
        status: res.status,
        finalUrl,
        contentType,
        bytes: bytes.byteLength,
        truncated: false,
        response: "json",
        json
      };
    } catch {
      return {
        ok: false,
        code: "invalid_json",
        finalUrl,
        message: "Response body is not valid JSON."
      };
    }
  }

  const { value, truncated: textTruncated } = truncateText(
    text,
    config.maxModelChars
  );
  return {
    ok: true,
    status: res.status,
    finalUrl,
    contentType,
    bytes: bytes.byteLength,
    truncated: capped || textTruncated,
    response: "text",
    body: value
  };
}

interface SpillArgs {
  bytes: Uint8Array;
  capped: boolean;
  contentType: string;
  finalUrl: string;
  status: number;
  config: ResolvedConfig;
}

async function spillToWorkspace(args: SpillArgs): Promise<FetchResult> {
  const { bytes, capped, contentType, finalUrl, status, config } = args;
  const ws = config.workspace;
  if (!ws) {
    return {
      ok: false,
      code: "unsupported_content_type",
      finalUrl,
      message:
        'response: "workspace" requires a workspace, but none is configured.'
    };
  }

  const isTextual = isTextualContentType(contentType);
  const path = `/fetched/${Date.now()}-${randomToken()}.${extensionFor(contentType)}`;
  try {
    await ws.mkdir("/fetched", { recursive: true });
    if (isTextual) {
      await ws.writeFile(path, new TextDecoder().decode(bytes));
    } else if (ws.writeFileBytes) {
      await ws.writeFileBytes(path, bytes);
    } else {
      return {
        ok: false,
        code: "unsupported_content_type",
        finalUrl,
        message:
          "Binary response cannot be stored: workspace does not support writeFileBytes."
      };
    }
  } catch (error) {
    return {
      ok: false,
      code: "request_failed",
      finalUrl,
      message: `Failed to write workspace file: ${errorMessage(error)}`
    };
  }

  return {
    ok: true,
    status,
    finalUrl,
    contentType,
    bytes: bytes.byteLength,
    truncated: capped,
    response: "workspace",
    path
  };
}

async function readCapped(
  res: Response,
  maxBytes: number
): Promise<{ bytes: Uint8Array; capped: boolean }> {
  const body = res.body;
  if (!body) return { bytes: new Uint8Array(0), capped: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let capped = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.byteLength > maxBytes) {
      const remaining = Math.max(0, maxBytes - total);
      if (remaining > 0) chunks.push(value.slice(0, remaining));
      total += remaining;
      capped = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: out, capped };
}

type ResolvedResponseMode = "text" | "json" | "workspace" | "unsupported";

function resolveResponseMode(
  mode: FetchResponseMode,
  contentType: string,
  config: ResolvedConfig
): ResolvedResponseMode {
  if (mode === "text") return "text";
  if (mode === "json") return "json";
  if (mode === "workspace") return "workspace";

  // auto
  if (isJsonContentType(contentType)) return "json";
  if (isTextualContentType(contentType)) return "text";
  if (config.spillToWorkspace && config.workspace) return "workspace";
  return "unsupported";
}

// ── Allowlist + URL helpers ───────────────────────────────────────

function normalizeRequestUrl(raw: string): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: "Invalid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "Only http(s) URLs are allowed." };
  }
  if (url.username || url.password) {
    return { error: "URLs with embedded credentials are not allowed." };
  }
  return { url };
}

function resolveAgainstBase(pathOrUrl: string, baseUrl: string): string | null {
  try {
    return new URL(pathOrUrl, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * A bare origin (`https://example.com`, no path) is treated as the origin and
 * everything under it, since the canonical URL always has at least a `/` path.
 * Patterns with an explicit path are matched literally unless they include
 * globs.
 */
function normalizeAllowlistPattern(pattern: string): string {
  if (/^https?:\/\/[^/]+$/i.test(pattern)) return `${pattern}/**`;
  return pattern;
}

/**
 * Compile an allowlist pattern once at config time so we don't rebuild a
 * `RegExp` on every request. Path-only patterns (`/v1/**`) match against the
 * URL pathname; everything else matches against the canonical origin+path.
 */
function compilePattern(pattern: string): CompiledPattern {
  const normalized = normalizeAllowlistPattern(pattern);
  return {
    scope: normalized.startsWith("/") ? "path" : "url",
    re: globToRegExp(normalized)
  };
}

function canonicalForMatch(url: URL): string {
  const host = url.hostname.replace(/\.$/, "");
  const port = url.port ? `:${url.port}` : "";
  return `${url.protocol}//${host}${port}${url.pathname}`;
}

function matchesAllowlist(url: URL, patterns: CompiledPattern[]): boolean {
  const canonical = canonicalForMatch(url);
  for (const pattern of patterns) {
    const subject = pattern.scope === "path" ? url.pathname : canonical;
    if (pattern.re.test(subject)) return true;
  }
  return false;
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h.length === 0) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".internal")) return true;

  if (h.startsWith("[") && h.endsWith("]")) {
    return isBlockedIpv6(h.slice(1, -1));
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    return isBlockedIpv4(h);
  }
  // Defensive: pure-integer / hex hosts (WHATWG normally normalizes these to
  // dotted IPv4, but reject them outright in case a runtime does not).
  if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/.test(h)) return true;
  return false;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (
    parts.length !== 4 ||
    parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)
  ) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  // IPv4-mapped, dotted form (::ffff:127.0.0.1).
  const dotted = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return isBlockedIpv4(dotted[1]);
  // IPv4-mapped, hex form. The WHATWG URL parser serializes
  // `::ffff:127.0.0.1` as `::ffff:7f00:1`, so decode the trailing two hextets
  // back into dotted IPv4 and reuse the v4 rules.
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    const v4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
    return isBlockedIpv4(v4);
  }
  return false;
}

/**
 * Merge fixed (server-side) and model headers into a lowercased-key map. Fixed
 * headers win, so the model can never override a binding's configured header,
 * and case-only duplicates (`Accept` vs `accept`) can't both be sent.
 */
function mergeHeaders(
  fixed: Record<string, string>,
  model: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(model)) {
    out[name.toLowerCase()] = value;
  }
  for (const [name, value] of Object.entries(fixed)) {
    out[name.toLowerCase()] = value;
  }
  return out;
}

function applyDefaultAccept(
  headers: Record<string, string>,
  defaultAccept: string
): Record<string, string> {
  if (!defaultAccept) return headers;
  const hasAccept = Object.keys(headers).some(
    (name) => name.toLowerCase() === "accept"
  );
  if (hasAccept) return headers;
  return { ...headers, accept: defaultAccept };
}

function filterModelHeaders(
  headers: Record<string, string> | undefined,
  allowlist: Set<string>
): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (allowlist.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

// ── Content-type helpers ──────────────────────────────────────────

function isJsonContentType(contentType: string): boolean {
  return (
    contentType === "application/json" ||
    contentType.endsWith("+json") ||
    contentType === "text/json"
  );
}

function isTextualContentType(contentType: string): boolean {
  if (contentType.length === 0) return false;
  if (contentType.startsWith("text/")) return true;
  if (isJsonContentType(contentType)) return true;
  return (
    contentType === "application/xml" ||
    contentType === "application/javascript" ||
    contentType === "application/x-www-form-urlencoded"
  );
}

function extensionFor(contentType: string): string {
  if (isJsonContentType(contentType)) return "json";
  if (contentType === "text/html") return "html";
  if (contentType.includes("xml")) return "xml";
  if (contentType.startsWith("text/")) return "txt";
  if (contentType === "application/pdf") return "pdf";
  if (contentType.startsWith("image/")) {
    return contentType.slice("image/".length).split("+")[0] || "img";
  }
  return "bin";
}

function truncateText(
  value: string,
  maxChars: number
): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false };
  return {
    value: `${value.slice(0, maxChars)}\n... (truncated ${value.length - maxChars} chars)`,
    truncated: true
  };
}

function isRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

function randomToken(): string {
  return Math.random().toString(36).slice(2, 10);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Model output mapping ──────────────────────────────────────────

function toModelOutput(
  output: FetchResult
):
  | { type: "text"; value: string }
  | { type: "error-text"; value: string }
  | { type: "json"; value: JSONValue } {
  if (!output.ok) {
    return { type: "error-text", value: output.message };
  }
  if (output.response === "json") {
    return {
      type: "json",
      value: {
        status: output.status,
        finalUrl: output.finalUrl,
        contentType: output.contentType,
        json: output.json ?? null
      }
    };
  }
  if (output.response === "workspace") {
    return {
      type: "text",
      value:
        `Fetched ${output.finalUrl} (${output.contentType || "unknown"}, ` +
        `${output.bytes} bytes${output.truncated ? ", truncated" : ""}) ` +
        `and saved to ${output.path}.`
    };
  }
  const prefix = `Fetched ${output.finalUrl} (HTTP ${output.status}, ${output.contentType || "unknown"}${output.truncated ? ", truncated" : ""}):\n\n`;
  return { type: "text", value: prefix + (output.body ?? "") };
}
