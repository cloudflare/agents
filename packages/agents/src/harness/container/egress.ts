/**
 * Credentials that never enter the container.
 *
 * The CLI in the container is pointed at a placeholder host over plain
 * HTTP (`http://anthropic.harness.internal`) with a placeholder key. The
 * harness intercepts that host with `ctx.container.interceptOutboundHttp()`
 * and hands each request to `ContainerEgress`, a `WorkerEntrypoint` running
 * in your Worker, which drops the placeholder credentials, adds the real
 * ones, and forwards the request to the real upstream (an AI Gateway, or
 * the provider). The container can run any command it likes and still has
 * nothing to steal.
 *
 * Plain HTTP inside the container means no certificate to trust: the
 * connection to the intercept never leaves Cloudflare, and the request to
 * the upstream is HTTPS.
 */

import { WorkerEntrypoint } from "cloudflare:workers";

/** One intercepted host and where its requests go. */
export type EgressRoute = {
  /** The placeholder hostname the CLI calls, such as `anthropic.harness.internal`. */
  readonly host: string;
  /** The real base URL. The request's path and query are appended. */
  readonly upstream: string;
  /** Headers to set on the forwarded request, such as credentials. */
  readonly headers: { readonly [name: string]: string };
  /** Headers to drop from the CLI's request, such as its placeholder key. */
  readonly strip: readonly string[];
};

/** What `ContainerEgress` is given, as its props. */
export type ContainerEgressProps = {
  readonly routes: readonly EgressRoute[];
};

/**
 * The `ctx.exports` entry for `ContainerEgress`: called with props, it
 * returns the `Fetcher` an intercept hands requests to.
 */
export type ContainerEgressBinding = (init: {
  readonly props: ContainerEgressProps;
}) => Fetcher;

/**
 * Forward one intercepted request to its route's upstream.
 *
 * @param request - The request the container made.
 * @param routes - The routes, by placeholder host.
 * @param fetcher - How to make the upstream request. Default `fetch`.
 * @returns The upstream's response, or 403 for a host without a route.
 */
export async function forwardEgress(
  request: Request,
  routes: readonly EgressRoute[],
  fetcher: typeof fetch = fetch
): Promise<Response> {
  const url = new URL(request.url);
  const route = routes.find((each) => each.host === url.hostname);
  if (!route) {
    return new Response(`No egress route for ${url.hostname}`, { status: 403 });
  }
  const target = `${route.upstream.replace(/\/+$/, "")}${url.pathname}${url.search}`;
  const headers = new Headers(request.headers);
  headers.delete("host");
  for (const name of route.strip) headers.delete(name);
  for (const [name, value] of Object.entries(route.headers)) {
    headers.set(name, value);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return fetcher(target, {
    method: request.method,
    headers,
    ...(hasBody ? { body: request.body } : {}),
    // Never follow a redirect with the credentials attached.
    redirect: "manual"
  });
}

/**
 * The egress for a `ContainerHarness`'s credentials. Export it from your
 * Worker's main module so `ctx.exports.ContainerEgress` exists:
 *
 * ```ts
 * export { ContainerEgress } from "agents/harness/container";
 * ```
 *
 * @experimental The API may change before it stabilizes.
 */
export class ContainerEgress extends WorkerEntrypoint<
  unknown,
  ContainerEgressProps
> {
  /**
   * Forward one request the container made.
   *
   * @param request - The intercepted request.
   * @returns The upstream's response.
   */
  override fetch(request: Request): Promise<Response> {
    return forwardEgress(request, this.ctx.props.routes);
  }
}
