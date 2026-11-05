import { Agent, type Connection } from "../../index.ts";

/**
 * Throws from `onRequest` when the request has a `fail` query. With a `hook`
 * query, `onFetchError` answers with the error it received and the hooks
 * that ran before it; without one, it declines and the default is sent.
 */
export class TestFetchErrorAgent extends Agent<Cloudflare.Env> {
  readonly #hookOrder: string[] = [];

  onRequest(request: Request): Response {
    if (new URL(request.url).searchParams.has("fail")) {
      throw new Error("agent request failed");
    }
    return new Response("ok");
  }

  override onError(connection: Connection, error: unknown): void;
  override onError(error: unknown): void;
  override onError(connectionOrError: Connection | unknown, error?: unknown) {
    this.#hookOrder.push("onError");
    throw error ?? connectionOrError;
  }

  override onFetchError(request: Request, error: unknown): Response | void {
    this.#hookOrder.push("onFetchError");
    if (!new URL(request.url).searchParams.has("hook")) return;
    return Response.json(
      {
        error: error instanceof Error ? error.message : String(error),
        hookOrder: this.#hookOrder
      },
      { status: 503 }
    );
  }
}
