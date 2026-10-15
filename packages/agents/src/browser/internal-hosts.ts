/**
 * Internal hostnames: sites only this agent's browser can open.
 *
 * A host maps a hostname such as `preview.internal` to code in your agent
 * (`fetch`) or to a deployed Worker (`fetcher`). Browser Run sends the
 * browser's requests for that hostname to it instead of the internet, so a
 * page can be served from a sandbox port, a workspace folder, or a staging
 * site behind credentials, without exposing anything publicly.
 *
 * How a request travels: Browser Run accepts only entrypoints of your own
 * Worker as routes, and keeps them for the whole browser session, across
 * redeploys. So every `fetch` host routes to {@link InternalHostRouter}, which
 * you export from your main module. Its props say which agent and browser
 * own the host, and nothing else. It calls the agent's `fetchInternalHost()`
 * over RPC, and the agent's `Browser` runs the host's `fetch`. `Agent` has
 * that method built in; a plain Durable Object adds it (see
 * {@link InternalHostMessage}). A `fetcher` host goes straight to the Worker
 * you gave it.
 */

import { Validator, type OutputUnit, type Schema } from "@cfworker/json-schema";
import { WorkerEntrypoint } from "cloudflare:workers";

/** The most hostnames one browser can have. A Browser Run limit. */
export const MAX_INTERNAL_HOSTS = 8;

// ── Schemas ────────────────────────────────────────────────────────────────
//
// Standard Schema and Standard JSON Schema (standardschema.dev) are small
// interfaces meant to be copied rather than depended on. zod 4.2+, ArkType,
// and Valibot (through its adapter) implement both.

/** A Standard Schema: something that validates a value. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    readonly types?:
      | { readonly input: Input; readonly output: Output }
      | undefined;
  };
}

type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | {
      readonly issues: ReadonlyArray<{
        readonly message: string;
        readonly path?: ReadonlyArray<
          PropertyKey | { readonly key: PropertyKey }
        >;
      }>;
    };

/** A Standard JSON Schema: something that can describe itself as JSON Schema. */
export interface StandardJSONSchemaV1 {
  readonly "~standard": {
    readonly jsonSchema: {
      readonly input: (options: {
        readonly target: string;
      }) => Record<string, unknown>;
    };
  };
}

/** A typed schema: validates (Standard Schema) and describes itself (Standard JSON Schema). */
export type TypedTargetSchema = StandardSchemaV1 & StandardJSONSchemaV1;

/** A plain JSON Schema object, such as TypeBox output or a hand-written one. */
export type JsonSchemaObject = { readonly [key: string]: unknown };

/**
 * What the model passes to `hosts.assign()` for a host. A typed schema (zod
 * 4.2+, ArkType, Valibot) types `fetch`'s `target`; a plain JSON Schema
 * leaves it `unknown`.
 */
export type TargetSchema = TypedTargetSchema | JsonSchemaObject;

/** The value a schema validates to: typed for a Standard Schema, else `unknown`. */
export type TargetOf<S> =
  S extends StandardSchemaV1<unknown, infer Output> ? Output : unknown;

// ── Hosts ──────────────────────────────────────────────────────────────────

/** A host served by code in your agent. */
export interface InternalHost<S = unknown> {
  /** Shown to the model next to the hostname. */
  description?: string;
  /**
   * What the model passes to `hosts.assign()` to point this host somewhere,
   * as a schema. Omit it for a host that always serves the same thing.
   */
  target?: S & TargetSchema;
  /**
   * Serves every browser request to this hostname. Runs in your agent, with
   * the target the model last assigned (validated by `target`), or
   * `undefined` when the host has no `target` schema.
   */
  fetch: (request: Request, target: TargetOf<S>) => Promise<Response>;
  fetcher?: never;
}

/**
 * A host served by a deployed Worker directly, without going through your
 * agent: a service binding, or `this.ctx.exports.SomeEntrypoint(...)`. Not a
 * Dynamic Worker or Durable Object stub — Browser Run can't hold those.
 */
export interface InternalFetcherHost {
  /** Shown to the model next to the hostname. */
  description?: string;
  /**
   * The Worker that serves this hostname: a service binding, or an
   * entrypoint of your own Worker (`this.ctx.exports.DocsSite`). Requests
   * go straight to it, without waking your agent.
   */
  fetcher: Fetcher;
  target?: never;
  fetch?: never;
}

/** The entrypoint loopback for {@link InternalHostRouter}: `this.ctx.exports.InternalHostRouter`. */
export type InternalHostRouterLoopback = (init: {
  props: InternalHostRouterProps;
}) => Fetcher;

/**
 * `browserRun()`'s `internalHosts`: hostnames only this browser can open.
 *
 * Fixed when a browser starts. Adding or removing a hostname replaces the
 * browser (the model sees `restarted`); changing a host's `fetch`,
 * `description` or `target` doesn't.
 */
export interface InternalHostsOptions<S = Record<string, unknown>> {
  /**
   * Your Worker's {@link InternalHostRouter} export, as
   * `this.ctx.exports.InternalHostRouter`. Needed for `fetch` hosts.
   */
  router?: InternalHostRouterLoopback;
  /**
   * At most {@link MAX_INTERNAL_HOSTS} hostnames: bare and lowercase, no
   * scheme, port, or path. Use a name that can't be a real site, like
   * `preview.internal`.
   */
  hosts: { [K in keyof S]: InternalHost<S[K]> | InternalFetcherHost };
}

/** A host as erased internally, once its schema type no longer matters. */
export type AnyInternalHost = InternalHost<unknown> | InternalFetcherHost;

/** One host, as the host API and the model see it. */
export interface InternalHostInfo {
  /** The hostname, such as `preview.internal`. */
  host: string;
  /** Where the browser opens it: `http://<host>/`. */
  url: string;
  description?: string;
  /** Whether the model can point it somewhere with `hosts.assign()`. */
  assignable: boolean;
  /** The JSON Schema `hosts.assign()` checks the target against. */
  targetSchema?: Record<string, unknown>;
  /** The target last assigned, when there is one. */
  target?: unknown;
}

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Why `host` can't be an internal hostname, or undefined when it can. */
function hostnameProblem(host: string): string | undefined {
  if (host.includes("://")) return "drop the scheme";
  if (host.includes("/")) return "drop the path";
  if (host.includes(":")) return "drop the port (only port 80 is routed)";
  if (host !== host.toLowerCase()) return "use lowercase";
  if (/^\d+(\.\d+){3}$/.test(host)) return "use a name, not an IP address";
  if (host === "localhost") return "Chrome blocks localhost";
  if (!HOSTNAME.test(host)) return "not a valid hostname";
  return undefined;
}

/**
 * Check `internalHosts` when the provider is created, so a mistake fails at
 * startup instead of at the first browser launch.
 */
export function validateInternalHosts(options: InternalHostsOptions): void {
  const hosts = Object.entries(options.hosts) as [string, AnyInternalHost][];
  if (hosts.length === 0) {
    throw new Error("internalHosts.hosts needs at least one hostname");
  }
  if (hosts.length > MAX_INTERNAL_HOSTS) {
    throw new Error(
      `internalHosts has ${hosts.length} hostnames; Browser Run allows at most ${MAX_INTERNAL_HOSTS} per browser`
    );
  }
  for (const [host, config] of hosts) {
    const problem = hostnameProblem(host);
    if (problem) {
      throw new Error(`Internal hostname "${host}": ${problem}`);
    }
    const hasFetch = typeof config.fetch === "function";
    const hasFetcher = config.fetcher !== undefined;
    if (hasFetch === hasFetcher) {
      throw new Error(
        `Internal hostname "${host}" needs exactly one of fetch or fetcher`
      );
    }
    if (hasFetcher && config.target !== undefined) {
      throw new Error(
        `Internal hostname "${host}": target needs fetch; a fetcher host can't be assigned`
      );
    }
    if (hasFetch && !options.router) {
      throw new Error(
        `Internal hostname "${host}" uses fetch, which needs internalHosts.router: this.ctx.exports.InternalHostRouter (and \`export { InternalHostRouter } from "agents/browser"\` in your main module)`
      );
    }
    if (config.target !== undefined) targetJsonSchema(host, config.target);
  }
}

/**
 * Identifies the set of hostnames and how each is routed. A browser started
 * with a different set is replaced: Browser Run fixes routes at launch.
 */
export function internalHostsSignature(
  options: InternalHostsOptions | undefined
): string | undefined {
  if (!options) return undefined;
  const hosts = Object.entries(options.hosts) as [string, AnyInternalHost][];
  return hosts
    .map(([host, config]) => `${host}=${config.fetcher ? "fetcher" : "fetch"}`)
    .sort()
    .join(",");
}

/**
 * The route Browser Run gets for a `fetcher` host. A `ctx.exports`
 * entrypoint is a loopback stub that Browser Run can't take as is, so it's
 * called (with empty props) to get a Fetcher it can.
 */
export function fetcherRoute(fetcher: Fetcher): Fetcher {
  if (typeof fetcher !== "function") return fetcher;
  const loopback = fetcher as unknown as (init: { props: object }) => Fetcher;
  return loopback({ props: {} });
}

// ── Targets ────────────────────────────────────────────────────────────────

function isStandardSchema(schema: TargetSchema): schema is TypedTargetSchema {
  return typeof schema === "object" && schema !== null && "~standard" in schema;
}

/** A host's target schema as JSON Schema, for the model and for plain validation. */
export function targetJsonSchema(
  host: string,
  schema: TargetSchema
): Record<string, unknown> {
  if (!isStandardSchema(schema)) {
    if (typeof schema !== "object" || schema === null) {
      throw new Error(`Internal hostname "${host}": target must be a schema`);
    }
    return schema as Record<string, unknown>;
  }
  const { jsonSchema } = schema["~standard"];
  if (!jsonSchema?.input) {
    throw new Error(
      `Internal hostname "${host}": target needs a schema that can describe itself as JSON Schema (Standard JSON Schema, such as zod 4.2+), or a plain JSON Schema object`
    );
  }
  try {
    return jsonSchema.input({ target: "draft-07" });
  } catch {
    return jsonSchema.input({ target: "draft-2020-12" });
  }
}

const plainValidators = new WeakMap<object, Validator>();

function formatIssues(
  issues: ReadonlyArray<{ message: string; path?: string }>
): string {
  return issues
    .map((issue) =>
      issue.path ? `${issue.path}: ${issue.message}` : issue.message
    )
    .join("; ");
}

function pathString(
  path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined
): string | undefined {
  if (!path?.length) return undefined;
  return path
    .map((part) => String(typeof part === "object" ? part.key : part))
    .join(".");
}

function plainIssues(errors: OutputUnit[]) {
  const specific = errors.filter((error) => error.keyword !== "properties");
  return (specific.length > 0 ? specific : errors).map((error) => ({
    message: error.error,
    path:
      error.instanceLocation.replace(/^#\/?/, "").replaceAll("/", ".") ||
      undefined
  }));
}

/**
 * Validate a target against a host's schema. Returns the validated value
 * (a Standard Schema's output, which may differ from its input), or a
 * message saying what's wrong.
 */
export async function validateTarget(
  schema: TargetSchema,
  value: unknown
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  if (isStandardSchema(schema)) {
    const result = await schema["~standard"].validate(value);
    if (result.issues) {
      return {
        ok: false,
        error: formatIssues(
          result.issues.map((issue) => ({
            message: issue.message,
            path: pathString(issue.path)
          }))
        )
      };
    }
    return { ok: true, value: result.value };
  }
  let validator = plainValidators.get(schema);
  if (!validator) {
    validator = new Validator(schema as unknown as Schema, "7", false);
    plainValidators.set(schema, validator);
  }
  const result = validator.validate(value);
  return result.valid
    ? { ok: true, value }
    : { ok: false, error: formatIssues(plainIssues(result.errors)) };
}

// ── Router ─────────────────────────────────────────────────────────────────

/**
 * What {@link InternalHostRouter} is given for one hostname: which agent and
 * browser own it. Browser Run keeps these for the whole session, across
 * redeploys, so they hold names only, never secrets or config.
 */
export type InternalHostRouterProps = {
  readonly v: 1;
  /** The agent's class name, as exported from the Worker. */
  readonly className: string;
  /** The agent's name. */
  readonly name: string;
  /** The name of the `Browser` that owns the host. */
  readonly browser: string;
  /** The hostname this route serves. */
  readonly host: string;
};

/**
 * One browser request to an internal hostname, as {@link InternalHostRouter}
 * hands it to the agent's `fetchInternalHost()`.
 *
 * `Agent` has `fetchInternalHost()` built in. A plain Durable Object adds it
 * and passes the message to its `Browser`:
 *
 * ```ts
 * fetchInternalHost(message: InternalHostMessage) {
 *   return this.browser.fetchInternalHost(message);
 * }
 * ```
 */
export type InternalHostMessage = {
  /** The name of the `Browser` that owns the host. */
  readonly browser: string;
  /** The hostname, such as `preview.internal`. */
  readonly host: string;
  /** The browser's request. */
  readonly request: Request;
};

export function isInternalHostMessage(
  value: unknown
): value is InternalHostMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<InternalHostMessage>;
  return (
    typeof message.browser === "string" &&
    typeof message.host === "string" &&
    message.request instanceof Request
  );
}

/** A plain-text response the browser shows for a failed internal request. */
export function internalHostError(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" }
  });
}

/** What {@link InternalHostRouter} calls on the agent that owns a host. */
type InternalHostTarget = {
  fetchInternalHost(message: InternalHostMessage): Promise<unknown>;
};

type OwnerNamespace = {
  getByName(name: string): InternalHostTarget;
};

/** Whether an RPC call failed because the agent has no `fetchInternalHost()`. */
function isMissingMethod(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("fetchInternalHost") &&
    /does not implement|is not a function/.test(error.message)
  );
}

/**
 * Carries a browser's requests for an internal hostname to the agent that
 * owns it. Export it from your Worker's main module, so
 * `this.ctx.exports.InternalHostRouter` exists:
 *
 * ```ts
 * export { InternalHostRouter } from "agents/browser";
 * ```
 *
 * It holds no logic of its own: it calls the agent's `fetchInternalHost()`
 * with an {@link InternalHostMessage}, and the agent's `Browser` runs the
 * host's `fetch`. `Agent` has `fetchInternalHost()` built in; a plain
 * Durable Object adds it (see {@link InternalHostMessage}).
 *
 * @experimental The API may change before it stabilizes.
 */
export class InternalHostRouter extends WorkerEntrypoint<
  unknown,
  InternalHostRouterProps
> {
  override async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props;
    const exports = (
      this.ctx as unknown as { exports?: Record<string, unknown> }
    ).exports;
    const namespace = exports?.[props.className] as OwnerNamespace | undefined;
    if (!namespace?.getByName) {
      return internalHostError(
        502,
        `${props.host}: the agent class "${props.className}" isn't exported from this Worker`
      );
    }
    try {
      const response = await namespace.getByName(props.name).fetchInternalHost({
        browser: props.browser,
        host: props.host,
        request
      });
      if (response instanceof Response) return response;
      return internalHostError(
        502,
        `${props.host}: the agent didn't answer with a Response`
      );
    } catch (error) {
      if (isMissingMethod(error)) {
        return internalHostError(
          502,
          `${props.host}: ${props.className} has no fetchInternalHost() method. Agent has it built in; on a plain Durable Object add: fetchInternalHost(message) { return this.browser.fetchInternalHost(message); }`
        );
      }
      return internalHostError(
        502,
        `${props.host}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

// ── proxyTo ────────────────────────────────────────────────────────────────

export interface ProxyToOptions {
  /** Headers to set on every request, such as credentials. */
  headers?: Record<string, string>;
}

/**
 * A `fetch` for a host that forwards each request to `url`, keeping the path
 * and query. The browser stays on the internal hostname: redirects to `url`
 * are rewritten to the internal host, and cookies are stored for it.
 *
 * @example
 * ```ts
 * "docs.internal": {
 *   fetch: proxyTo("https://docs-staging.example.com", {
 *     headers: { Authorization: `Bearer ${this.env.DOCS_TOKEN}` }
 *   })
 * }
 * ```
 */
export function proxyTo(
  url: string,
  options: ProxyToOptions = {}
): (request: Request) => Promise<Response> {
  const upstream = new URL(url);
  const base = upstream.pathname.replace(/\/+$/, "");
  return async (request) => {
    const incoming = new URL(request.url);
    const target = new URL(upstream.origin);
    target.pathname = `${base}${incoming.pathname}`;
    target.search = incoming.search;

    const headers = new Headers(request.headers);
    headers.delete("host");
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      headers.set(name, value);
    }
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const response = await fetch(target, {
      method: request.method,
      headers,
      ...(hasBody ? { body: request.body } : {}),
      // Redirects go back to the browser, rewritten to the internal host.
      redirect: "manual"
    });

    const rewritten = new Headers(response.headers);
    const location = rewritten.get("location");
    if (location) {
      const resolved = new URL(location, target);
      if (pointsAtUpstream(resolved, upstream)) {
        const path = resolved.pathname.startsWith(base)
          ? resolved.pathname.slice(base.length) || "/"
          : resolved.pathname;
        rewritten.set(
          "location",
          `${incoming.origin}${path}${resolved.search}${resolved.hash}`
        );
      }
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) {
      rewritten.delete("set-cookie");
      for (const cookie of cookies) {
        rewritten.append("set-cookie", forInternalHost(cookie));
      }
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: rewritten
    });
  };
}

/**
 * Whether a redirect leads back to the upstream. An https site behind a
 * TLS-terminating proxy often redirects to its own host over plain http
 * (`http://httpbin.org/...`), so that counts too.
 */
function pointsAtUpstream(url: URL, upstream: URL): boolean {
  if (url.origin === upstream.origin) return true;
  return (
    upstream.protocol === "https:" &&
    url.protocol === "http:" &&
    url.hostname === upstream.hostname &&
    url.port === "" &&
    upstream.port === ""
  );
}

/**
 * Make an upstream cookie stick on the internal host: drop `Domain` (it
 * names the upstream) and `Secure` (the internal host is plain http).
 * `SameSite=None` needs `Secure`, so it becomes `Lax`. Cookies named
 * `__Secure-` or `__Host-` need `Secure` too, and Chrome drops them.
 */
function forInternalHost(cookie: string): string {
  return cookie
    .split(";")
    .filter((part) => !/^\s*(domain|secure)\s*(=|$)/i.test(part))
    .map((part) =>
      /^\s*samesite\s*=\s*none\s*$/i.test(part) ? " SameSite=Lax" : part
    )
    .join(";");
}
