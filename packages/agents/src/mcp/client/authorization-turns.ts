import type { AgentMcpOAuthProvider } from "./do-oauth-client-provider";

/** The `fetch` shape the SDK's HTTP transports accept. */
export type TransportFetch = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>;

/** The part of the SDK's adapted auth provider a transport calls on a 401. */
type UnauthorizedHandler = {
  onUnauthorized?: (context: unknown) => Promise<void>;
};

/**
 * One OAuth flow at a time per connection.
 *
 * The SDK transport answers every `401` by calling its auth provider's
 * `onUnauthorized`, which refreshes the token or registers a client and builds
 * an authorization URL with a fresh state and code verifier. When several
 * requests get a `401` together (catalog discovery lists tools, prompts and
 * resources in parallel, alongside the listen stream), those flows interleave
 * on one provider: each registers its own client, and the link the manager
 * saves can belong to a different client than the verifier stored for it, so
 * the link can never complete. Two refreshes racing on a rotating refresh
 * token lose the same way.
 *
 * Requests still go out together. Each `401`'s authorization waits until the
 * one before it has finished, whether it succeeded, built a link or failed,
 * so it reuses the client and tokens the previous flow saved. When that flow
 * already saved a newer access token, there is nothing left to authorize:
 * the SDK retries the request with the new token.
 */
export class AuthorizationTurns {
  /** Settles when every flow started so far has finished. */
  #tail: Promise<void> = Promise.resolve();
  /** The access token each 401 response's request was sent with. */
  readonly #sentTokens = new WeakMap<Response, string | undefined>();
  #warnedUnwrapped = false;

  /**
   * A `fetch` for the transport that remembers which access token a request
   * carried when it got a 401, so its authorization can tell whether a
   * newer token already exists.
   */
  wrapFetch(base: TransportFetch | undefined): TransportFetch {
    return async (input, init) => {
      const response = await (base ?? fetch)(input, init);
      if (response.status === 401) {
        this.#sentTokens.set(response, bearerToken(init?.headers));
      }
      return response;
    };
  }

  /**
   * Take a transport's 401 handling in turns. The SDK keeps the adapted
   * provider on the transport as `_authProvider`; when a later SDK moves it,
   * this does nothing, and the integration tests that send concurrent 401s
   * fail.
   */
  wrapTransport(transport: object, provider: AgentMcpOAuthProvider): void {
    const adapted = (transport as { _authProvider?: UnauthorizedHandler })
      ._authProvider;
    const onUnauthorized = adapted?.onUnauthorized?.bind(adapted);
    if (!adapted || !onUnauthorized) {
      if (!this.#warnedUnwrapped) {
        this.#warnedUnwrapped = true;
        console.warn(
          "[MCPClientManager] The MCP SDK transport no longer exposes its auth provider; concurrent 401s will not share one OAuth flow."
        );
      }
      return;
    }

    adapted.onUnauthorized = async (context) => {
      // The token the failed request carried, else the one held now.
      const response = responseOf(context);
      const tokenSent =
        response && this.#sentTokens.has(response)
          ? this.#sentTokens.get(response)
          : await accessToken(provider);
      await this.#run(async () => {
        const tokenNow = await accessToken(provider);
        if (tokenNow && tokenNow !== tokenSent) return;
        await onUnauthorized(context);
      });
    };
  }

  /** Run `flow` once every flow started before it has finished. */
  #run(flow: () => Promise<void>): Promise<void> {
    const result = this.#tail.then(flow);
    this.#tail = result.catch(() => {});
    return result;
  }
}

async function accessToken(
  provider: AgentMcpOAuthProvider
): Promise<string | undefined> {
  try {
    return (await provider.tokens())?.access_token;
  } catch {
    return undefined;
  }
}

function bearerToken(headers: HeadersInit | undefined): string | undefined {
  const value = new Headers(headers).get("authorization");
  return value?.startsWith("Bearer ")
    ? value.slice("Bearer ".length)
    : undefined;
}

function responseOf(context: unknown): Response | undefined {
  if (typeof context !== "object" || context === null) return undefined;
  const { response } = context as { response?: unknown };
  return response instanceof Response ? response : undefined;
}
