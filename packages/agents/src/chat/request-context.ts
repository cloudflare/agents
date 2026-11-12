/**
 * ChatRequestContext — the one owner of a chat's stored request context:
 * the client tools and the custom body that later turns (a tool
 * continuation, `continueLastTurn`, a recovery) run with.
 *
 * `@cloudflare/ai-chat` and `@cloudflare/think` each kept two fields and
 * their own persist, restore, clear and tool-result code for them. This
 * class holds the values and the rules. The host supplies only where the two
 * values are stored.
 *
 * - A chat request replaces the context whole when its turn starts. One that
 *   sends no client tools clears the stored ones ({@link set}).
 * - A tool result that lists client tools replaces the stored tools. One
 *   that lists none leaves them ({@link replaceClientTools}).
 * - A clear drops both ({@link clear}).
 * - Every change is written through, and a value equal to what is stored is
 *   not written again.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import type { ClientToolSchema } from "./client-tools";
import { clientResolvableToolNames } from "./tool-state";

/** The tools and body a chat request leaves stored for later turns. */
export interface ClientRequestContext {
  clientTools: ClientToolSchema[] | undefined;
  body: Record<string, unknown> | undefined;
}

/**
 * The request context a client's chat request stores when its turn starts.
 *
 * The request replaces the stored context whole. One that sends no client
 * tools (no `clientTools` key, or an empty list) clears the stored tools: the
 * tools a turn offers the model are the ones the client that sent the request
 * can run, never the ones an earlier request from another client left behind.
 * The same goes for the body.
 */
export function clientRequestContext(request: {
  clientTools?: ClientToolSchema[] | null;
  body?: Record<string, unknown> | null;
}): ClientRequestContext {
  const { clientTools, body } = request;
  return {
    clientTools:
      Array.isArray(clientTools) && clientTools.length > 0
        ? clientTools
        : undefined,
    body: body && Object.keys(body).length > 0 ? body : undefined
  };
}

/** The two stored keys. Their names are the hosts' existing row keys. */
export type RequestContextKey = "lastClientTools" | "lastBody";

/** Where a host keeps the request context: one JSON string per key. */
export interface RequestContextStore {
  get(key: RequestContextKey): string | undefined;
  set(key: RequestContextKey, json: string): void;
  delete(key: RequestContextKey): void;
}

export class ChatRequestContext {
  /** The client tools later turns offer the model. */
  clientTools: ClientToolSchema[] | undefined;
  /** The custom body later turns run with. */
  body: Record<string, unknown> | undefined;

  /** What storage holds, so an unchanged value is not written again. */
  readonly #stored: Partial<Record<RequestContextKey, string>> = {};

  constructor(private readonly store: RequestContextStore) {}

  /**
   * Load the stored context, or one key of it. A key with no stored value
   * leaves the value in memory as it is. A corrupted value reads as none.
   */
  restore(key?: RequestContextKey): void {
    for (const each of key
      ? [key]
      : (["lastClientTools", "lastBody"] as const)) {
      const raw = this.store.get(each);
      this.#stored[each] = raw;
      if (!raw) continue;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        value = undefined;
      }
      if (each === "lastClientTools") {
        this.clientTools = value as ClientToolSchema[] | undefined;
      } else {
        this.body = value as Record<string, unknown> | undefined;
      }
    }
  }

  /** Write the values that differ from what storage holds. */
  persist(): void {
    this.#persistKey("lastClientTools", this.clientTools);
    this.#persistKey("lastBody", this.body);
  }

  /**
   * Replace the context with what a request sent. See
   * {@link clientRequestContext}: no tools clears the stored tools.
   */
  set(request: {
    clientTools?: ClientToolSchema[] | null;
    body?: Record<string, unknown> | null;
  }): ClientRequestContext {
    const context = clientRequestContext(request);
    this.clientTools = context.clientTools;
    this.body = context.body;
    this.persist();
    return context;
  }

  /**
   * A tool result that lists client tools replaces the stored tools, so the
   * continuation runs with the answering client's latest schemas. One that
   * lists none leaves them: the continuation still belongs to the turn whose
   * request stored them.
   */
  replaceClientTools(clientTools: unknown): void {
    if (!Array.isArray(clientTools) || clientTools.length === 0) return;
    this.clientTools = clientTools as ClientToolSchema[];
    this.persist();
  }

  /**
   * Restore the context a recovered turn was running with. A key the
   * snapshot does not have is left alone.
   */
  applyRecovered(
    data:
      | {
          lastClientTools?: ClientToolSchema[] | null;
          lastBody?: Record<string, unknown> | null;
        }
      | undefined
  ): void {
    if (!data) return;
    if ("lastClientTools" in data) {
      this.clientTools = data.lastClientTools ?? undefined;
    }
    if ("lastBody" in data) {
      this.body = data.lastBody ?? undefined;
    }
    this.persist();
  }

  /** Drop the context (a chat clear). */
  clear(): void {
    this.clientTools = undefined;
    this.body = undefined;
    this.persist();
  }

  /**
   * Names of the tools a client is known to run: the schemas it sent. An
   * unanswered call to one of them can still be answered by the client.
   */
  clientToolNames(): Set<string> {
    return clientResolvableToolNames(this.clientTools);
  }

  #persistKey(key: RequestContextKey, value: unknown): void {
    const json = value ? JSON.stringify(value) : undefined;
    if (this.#stored[key] === json) return;
    if (json === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, json);
    }
    this.#stored[key] = json;
  }
}
