import type { AgentMcpOAuthProvider } from "./do-oauth-client-provider";

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
    if (!adapted || !onUnauthorized) return;

    adapted.onUnauthorized = async (context) => {
      const tokenBefore = await accessToken(provider);
      await this.#run(async () => {
        const tokenNow = await accessToken(provider);
        if (tokenNow && tokenNow !== tokenBefore) return;
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
