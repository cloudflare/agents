import {
  Agent,
  getCurrentAgent,
  type Connection,
  type ConnectionContext
} from "../../index.ts";

/**
 * An Agent whose `onStart`, `onRequest`, and `onConnect` can fail.
 *
 * - An instance named `fail-start-*` fails `onStart`.
 * - A request or upgrade with a `fail` query fails `onRequest` or `onConnect`.
 * - An instance named `log-only-*` has an `onError` that returns instead of
 *   rethrowing, as the logging examples in the docs do.
 * - With a `hook` query, `onFetchError` answers 503 with its instance name
 *   and what it saw; without one, it declines and the default is sent.
 *
 * It can be its own sub-agent, under `/sub/test-fetch-error-agent/{name}`.
 */
export class TestFetchErrorAgent extends Agent<Cloudflare.Env> {
  readonly #hookOrder: string[] = [];

  onStart(): void {
    if (this.name.startsWith("fail-start-")) {
      throw new Error("agent startup failed");
    }
  }

  onRequest(request: Request): Response {
    if (new URL(request.url).searchParams.has("fail")) {
      throw new Error("agent request failed");
    }
    return new Response("ok");
  }

  onConnect(_connection: Connection, { request }: ConnectionContext): void {
    if (new URL(request.url).searchParams.has("fail")) {
      throw new Error("agent connect failed");
    }
  }

  override onError(connection: Connection, error: unknown): void;
  override onError(error: unknown): void;
  override onError(connectionOrError: Connection | unknown, error?: unknown) {
    this.#hookOrder.push("onError");
    if (this.name.startsWith("log-only-")) return;
    throw error ?? connectionOrError;
  }

  override onFetchError(request: Request, error: unknown): Response | void {
    this.#hookOrder.push("onFetchError");
    if (!new URL(request.url).searchParams.has("hook")) return;
    return Response.json(
      {
        name: this.name,
        error: error instanceof Error ? error.message : String(error),
        hookOrder: this.#hookOrder,
        inAgentContext: getCurrentAgent().agent === this
      },
      { status: 503 }
    );
  }
}
