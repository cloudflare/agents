import type { AgentMcpOAuthProvider } from "./do-oauth-client-provider";

/** The `fetch` shape the SDK's HTTP transports accept. */
export type TransportFetch = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>;

/**
 * How long a `401` waits for an earlier one's authorization to settle before
 * it is handed to the SDK anyway, so a flow that fails can't hold the
 * connection forever.
 */
const AUTHORIZATION_TURN_TIMEOUT_MS = 10_000;

/**
 * One OAuth flow at a time per connection.
 *
 * The SDK transport answers every `401` from the MCP endpoint by running its
 * own authorization: it registers a client when none is saved, then builds an
 * authorization URL with a fresh state and code verifier. When several
 * requests get a `401` together (catalog discovery lists tools, prompts and
 * resources in parallel, alongside the listen stream), those flows interleave
 * on one provider: each registers its own client, and the link the manager
 * saves can belong to a different client than the verifier stored for it, so
 * the link can never complete. Concurrent refreshes have the same shape.
 *
 * Requests still go out together, and responses other than `401` return at
 * once. A `401` for an MCP request waits until the authorization started by
 * the previous one has settled (it built a link or saved tokens), so the next
 * flow reuses the client and tokens the previous one saved. MCP requests are
 * recognised by what they carry, not where they go: the SSE transport posts
 * to a per-session message endpoint, and the SDK's own OAuth requests share
 * this `fetch` and may share the server's origin.
 */
export class AuthorizationTurns {
  /** Settles when the authorization currently running has finished. */
  #turn: Promise<void> = Promise.resolve();
  /** Ends the authorization currently running. */
  #endTurn: (() => void) | undefined;

  /**
   * A `fetch` for the transport: MCP requests that get a `401` take turns
   * before the SDK sees them.
   */
  wrapFetch(base: TransportFetch | undefined): TransportFetch {
    return async (input, init) => {
      const response = await (base ?? fetch)(input, init);
      if (response.status !== 401 || !isMcpRequest(init)) return response;
      await this.#takeTurn();
      return response;
    };
  }

  /**
   * The provider to hand the transport: the same provider, reporting when an
   * authorization settles so the next `401` can take its turn.
   */
  wrapProvider(provider: AgentMcpOAuthProvider): AgentMcpOAuthProvider {
    const settled = () => this.#settle();
    return new Proxy(provider, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (
          property === "redirectToAuthorization" ||
          property === "saveTokens"
        ) {
          return async (...args: unknown[]) => {
            try {
              return await value.apply(target, args);
            } finally {
              settled();
            }
          };
        }
        return value.bind(target);
      },
      set(target, property, value) {
        return Reflect.set(target, property, value, target);
      }
    });
  }

  /** Wait for the running authorization, then start the next one. */
  async #takeTurn(): Promise<void> {
    const previous = this.#turn;
    let end!: () => void;
    const current = new Promise<void>((resolve) => {
      end = resolve;
    });
    this.#turn = previous.then(() => current);
    await previous;

    const timer = setTimeout(
      () => this.#settle(),
      AUTHORIZATION_TURN_TIMEOUT_MS
    );
    this.#endTurn = () => {
      clearTimeout(timer);
      end();
    };
  }

  #settle(): void {
    const endTurn = this.#endTurn;
    this.#endTurn = undefined;
    endTurn?.();
  }
}

/**
 * Whether a transport request carries MCP traffic: a JSON-RPC message, or the
 * GET that opens a server-sent event stream. OAuth discovery, registration
 * and token requests are neither.
 */
function isMcpRequest(init: RequestInit | undefined): boolean {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET") {
    const accept = new Headers(init?.headers).get("accept") ?? "";
    return accept.includes("text/event-stream");
  }
  if (typeof init?.body !== "string") return false;
  try {
    const message: unknown = JSON.parse(init.body);
    const first = Array.isArray(message) ? message[0] : message;
    return (
      typeof first === "object" &&
      first !== null &&
      (first as { jsonrpc?: unknown }).jsonrpc === "2.0"
    );
  } catch {
    return false;
  }
}
