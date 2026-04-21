/**
 * Sub-agent routing primitives — external addressability for facets.
 *
 * The public surface:
 *   - `routeSubAgentRequest(req, parent, options?)` — the sub-agent
 *     analog of `routeAgentRequest`. Use in custom fetch handlers.
 *   - `getSubAgentByName(parent, Cls, name)` — the sub-agent analog
 *     of `getAgentByName`. Returns a typed RPC stub that proxies
 *     method calls through the parent. No `.fetch()` support —
 *     external HTTP/WS routing goes through `routeSubAgentRequest`.
 *
 * Internal:
 *   - `parseSubAgentPath(url)` — URL → `{ childClass, childName, remainingPath }`.
 *   - `forwardToFacet(req, parent, match)` — resolves `ctx.facets.get(...)`
 *     on the parent and returns `facetStub.fetch(rewrittenReq)`.
 *
 * @experimental The API surface may change before stabilizing.
 */

import { camelCaseToKebabCase } from "./utils";
import type { Agent, SubAgentClass, SubAgentStub } from "./index";

/**
 * URL segment marking a parent↔child boundary.
 *
 * Exposed as a constant so callers can build URLs symbolically, but
 * not configurable — the routing layer matches on the literal `sub`
 * token everywhere (parent fetch, client, helpers).
 */
export const SUB_PREFIX = "sub";

export interface SubAgentPathMatch {
  /** CamelCase class name of the child, as it appears in `ctx.exports`. */
  childClass: string;
  /** URL-decoded child name. */
  childName: string;
  /**
   * Request path to forward to the child, with the
   * `/sub/{class}/{name}` segment stripped. Always begins with `/`;
   * may itself contain further `/sub/...` markers when a
   * recursively nested sub-agent is being routed.
   */
  remainingPath: string;
}

/**
 * Parse a URL and extract the first `/sub/{class}/{name}` segment,
 * if any. Recursive nesting is handled naturally: callers parse one
 * level at a time; the child then parses its own URL (which still
 * contains any deeper `/sub/...` markers).
 *
 * Names are URL-decoded. Classes are kebab-to-CamelCase converted
 * via a best-effort match against a provided lookup — pass
 * `ctx.exports` keys to get exact CamelCase; pass `undefined` for
 * a tolerant conversion without validation.
 *
 * Returns `null` when the URL doesn't contain the marker at a
 * recognized position, or when the marker has no following
 * class+name pair.
 */
export function parseSubAgentPath(
  url: string,
  options?: {
    /** CamelCase class names to match against (usually `ctx.exports` keys). */
    knownClasses?: readonly string[];
  }
): SubAgentPathMatch | null {
  const pathname = new URL(url).pathname;
  const parts = pathname.split("/").filter(Boolean);

  const markerIdx = parts.indexOf(SUB_PREFIX);
  if (markerIdx < 0) return null;
  if (markerIdx + 2 >= parts.length) return null;

  const classSegment = parts[markerIdx + 1];
  const nameSegment = parts[markerIdx + 2];

  const childClass = resolveClassName(classSegment, options?.knownClasses);
  if (!childClass) return null;

  let childName: string;
  try {
    childName = decodeURIComponent(nameSegment);
  } catch {
    return null;
  }

  const remainingParts = parts.slice(markerIdx + 3);
  const remainingPath =
    remainingParts.length > 0 ? "/" + remainingParts.join("/") : "/";

  return { childClass, childName, remainingPath };
}

/**
 * Best-effort kebab-to-CamelCase match. If `knownClasses` is
 * provided, returns the matching CamelCase entry (or null if no
 * match). If not, performs a naive kebab→CamelCase conversion.
 */
function resolveClassName(
  segment: string,
  knownClasses?: readonly string[]
): string | null {
  if (knownClasses) {
    const match = knownClasses.find(
      (name) => camelCaseToKebabCase(name) === segment
    );
    return match ?? null;
  }
  return segment
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

// ── routeSubAgentRequest ───────────────────────────────────────────

/**
 * Minimal parent-side shape that `routeSubAgentRequest` relies on:
 * something fetchable (a DO stub, a sub-agent stub, etc.).
 *
 * @internal
 */
interface FetchableParent {
  fetch(req: Request): Promise<Response>;
}

/**
 * Route a request into a sub-agent via its parent DO.
 *
 * Use this in a custom fetch handler when your URL shape doesn't
 * match the `/agents/{class}/{name}` default — you identify and
 * fetch the parent yourself, then let this helper parse the
 * `/sub/{child}/...` tail and forward it.
 *
 * Runs `onBeforeSubAgent` on the parent DO (authorization / request
 * mutation / short-circuit response).
 *
 * For the default `/agents/...` URL shape, use `routeAgentRequest`
 * instead — it handles the parent lookup and this dispatch in one
 * call.
 *
 * @example
 * ```ts
 * export default {
 *   async fetch(req, env) {
 *     const { parentName, rest } = myCustomParse(req.url);
 *     const parent = await getAgentByName(env.Inbox, parentName);
 *     return routeSubAgentRequest(req, parent, { fromPath: rest });
 *   }
 * };
 * ```
 *
 * @experimental The API surface may change before stabilizing.
 */
export async function routeSubAgentRequest(
  req: Request,
  parent: unknown,
  options?: {
    /**
     * Path to route on. Defaults to `req.url`'s pathname. Useful
     * when your outer URL is custom (e.g. `/api/v1/...`) and you
     * want to route the sub-agent tail without rewriting the
     * Request first.
     */
    fromPath?: string;
  }
): Promise<Response> {
  // We don't know the parent's ctx.exports from here, so parse with
  // a permissive resolver. If the class doesn't exist, the parent's
  // bridge will 404. This lets us keep the helper self-contained.
  const pathForParsing = options?.fromPath
    ? `http://placeholder${options.fromPath.startsWith("/") ? "" : "/"}${options.fromPath}`
    : req.url;

  const match = parseSubAgentPath(pathForParsing);
  if (!match) {
    return new Response("Sub-agent path not found in request URL", {
      status: 400
    });
  }

  // Hand the request to the parent so `onBeforeSubAgent` fires in
  // the parent's isolate. The parent's `fetch` handler recognizes
  // the marker internally — we preserve the original request URL
  // (possibly rewritten by `fromPath`) so the parent's parse sees
  // the same match.
  const forwardReq =
    options?.fromPath !== undefined
      ? new Request(
          new URL(
            options.fromPath.startsWith("/")
              ? options.fromPath
              : `/${options.fromPath}`,
            req.url
          ).toString(),
          req
        )
      : req;

  return (parent as FetchableParent).fetch(forwardReq);
}

// ── getSubAgentByName ──────────────────────────────────────────────

/**
 * Parent-side RPC bridge shape that `getSubAgentByName` relies on.
 *
 * @internal
 */
interface SubAgentInvokeEndpoint {
  _cf_invokeSubAgent(
    className: string,
    name: string,
    method: string,
    args: unknown[]
  ): Promise<unknown>;
}

/**
 * Get a typed RPC stub for a sub-agent from outside the parent DO.
 *
 * The returned stub proxies method calls through the parent via a
 * stateless per-call bridge (caller → parent → facet), so each
 * method invocation costs one extra RPC hop. Works across parent
 * hibernation — no cached references to go stale.
 *
 * Limitations:
 *   - RPC methods only. `.fetch()` is not supported (will throw).
 *     Use `routeSubAgentRequest` for external HTTP/WS.
 *   - Arguments and return values must be structured-cloneable,
 *     same as any DO RPC call.
 *   - Does not run `onBeforeSubAgent` on the parent — analogous to
 *     `getAgentByName` not running `onBeforeConnect`. The caller is
 *     assumed to have performed whatever access checks are needed.
 *
 * @example
 * ```ts
 * const inbox = await getAgentByName(env.MyInbox, userId);
 * const chat = await getSubAgentByName(inbox, MyChat, chatId);
 * await chat.addMessage({ role: "user", content: "hi" });
 * ```
 *
 * @experimental The API surface may change before stabilizing.
 */
export async function getSubAgentByName<T extends Agent>(
  parent: unknown,
  cls: SubAgentClass<T>,
  name: string
): Promise<SubAgentStub<T>> {
  if (name.includes("\0")) {
    throw new Error(
      `Sub-agent name contains null character (\\0), which is reserved.`
    );
  }

  const bridge = parent as SubAgentInvokeEndpoint;
  const className = cls?.name;
  if (!className) {
    throw new Error(
      `getSubAgentByName: could not determine class name from ${cls}. ` +
        `Ensure you are passing the class constructor (e.g. getSubAgentByName(parent, MyChat, name)), not a string or undefined.`
    );
  }

  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        // Thenable guard — prevents `await getSubAgentByName(...)`
        // from triggering a ghost `.then()` method call on the
        // returned Proxy (the returned Promise already resolved; the
        // value is the Proxy itself, and awaiting it probes `.then`).
        if (prop === "then") return undefined;
        // `.fetch` gets a dedicated error so users who try to use
        // the stub for HTTP/WS get a helpful pointer.
        if (prop === "fetch") {
          return () => {
            throw new Error(
              `getSubAgentByName returns an RPC-only stub — .fetch() is ` +
                `not supported. Use routeSubAgentRequest() or the ` +
                `/agents/{parent}/{name}/sub/{child}/{name} URL for ` +
                `external HTTP/WS routing.`
            );
          };
        }
        return async (...args: unknown[]) =>
          bridge._cf_invokeSubAgent(className, name, prop, args);
      }
    }
  ) as SubAgentStub<T>;
}
