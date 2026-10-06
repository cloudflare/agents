import type { UserRequest } from "./extension";
import type { JsonValue } from "./schema";
import type { KeyValueStore } from "./storage";

/** A question waiting for, or holding, the person's answer. */
export type PendingRequest = {
  readonly id: string;
  readonly session: string;
  /** The tool call that asked. */
  readonly tool: string;
  readonly callId: string;
  readonly request: UserRequest;
  readonly askedAt: number;
};

/** Why `reply()` did not take an answer. */
export type ReplyRejected = {
  readonly accepted: false;
  readonly reason: "not_found" | "already_answered" | "invalid";
  readonly message: string;
};

type Stored = PendingRequest &
  (
    | { readonly status: "open" }
    | { readonly status: "answered"; readonly reply: JsonValue }
  );

const PREFIX = "agents.requests/";

/**
 * Durable questions for the person using a session, shared by every
 * harness adapter. A harness opens a request under an id it can recover
 * after an eviction (pi uses the tool task's memo), lists open requests to
 * clients, and resumes the asker when `reply()` stores an answer. Waiters
 * are in memory; the stored answer is what survives.
 */
export class RequestStore {
  readonly #store: KeyValueStore;
  readonly #waiters = new Map<string, Set<(reply: JsonValue) => void>>();

  /** @param store - Where requests are kept. */
  constructor(store: KeyValueStore) {
    this.#store = store;
  }

  /**
   * Open a request, or find the one already opened under this id.
   *
   * @param request - The request and who asked.
   * @returns The stored answer if there is one already.
   */
  open(
    request: PendingRequest
  ):
    | { readonly status: "open" }
    | { readonly status: "answered"; readonly reply: JsonValue } {
    const existing = this.#get(request.id);
    if (existing) {
      return existing.status === "answered"
        ? { status: "answered", reply: existing.reply }
        : { status: "open" };
    }
    this.#store.put(PREFIX + request.id, { ...request, status: "open" });
    return { status: "open" };
  }

  /**
   * Wait for the answer to an open request.
   *
   * @param id - The request's id.
   * @param signal - Aborting stops the wait; the request stays open.
   * @returns The answer.
   */
  wait(id: string, signal: AbortSignal | undefined): Promise<JsonValue> {
    const stored = this.#get(id);
    if (stored?.status === "answered") return Promise.resolve(stored.reply);
    return new Promise<JsonValue>((resolve, reject) => {
      const waiters = this.#waiters.get(id) ?? new Set();
      this.#waiters.set(id, waiters);
      const done = (reply: JsonValue) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(reply);
      };
      const onAbort = () => {
        waiters.delete(done);
        reject(signal?.reason ?? new Error("Aborted"));
      };
      waiters.add(done);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Answer a request. The answer must fit its kind: a boolean for
   * `confirm`, one of the options for `select`, a string for `input`.
   *
   * @param id - The request's id.
   * @param reply - The answer.
   * @returns Whether it was taken, and why not.
   */
  reply(
    id: string,
    reply: unknown
  ): { readonly accepted: true } | ReplyRejected {
    const stored = this.#get(id);
    if (!stored) {
      return {
        accepted: false,
        reason: "not_found",
        message: `No request ${id}`
      };
    }
    if (stored.status === "answered") {
      return {
        accepted: false,
        reason: "already_answered",
        message: `Request ${id} is already answered`
      };
    }
    const parsed = parseReply(stored.request, reply);
    if (parsed === undefined) {
      return {
        accepted: false,
        reason: "invalid",
        message: `Not an answer to a ${stored.request.kind} request`
      };
    }
    this.#store.put(PREFIX + id, {
      ...stored,
      status: "answered",
      reply: parsed
    });
    for (const waiter of this.#waiters.get(id) ?? []) waiter(parsed);
    this.#waiters.delete(id);
    return { accepted: true };
  }

  /**
   * Requests nobody has answered, oldest first.
   *
   * @param session - Only this session's, when given.
   * @returns The open requests.
   */
  pending(session?: string): PendingRequest[] {
    const open: PendingRequest[] = [];
    for (const [, value] of this.#store.list({ prefix: PREFIX })) {
      const stored = parseStored(value);
      if (stored?.status !== "open") continue;
      if (session !== undefined && stored.session !== session) continue;
      const { status: _status, ...request } = stored;
      open.push(request);
    }
    return open.sort((a, b) => a.askedAt - b.askedAt);
  }

  /**
   * Forget a request once its asker has the answer.
   *
   * @param id - The request's id.
   */
  close(id: string): void {
    this.#store.delete(PREFIX + id);
  }

  #get(id: string): Stored | undefined {
    return parseStored(this.#store.get(PREFIX + id));
  }
}

function parseReply(
  request: UserRequest,
  reply: unknown
): JsonValue | undefined {
  switch (request.kind) {
    case "confirm":
      return typeof reply === "boolean" ? reply : undefined;
    case "select":
      return typeof reply === "string" && request.options.includes(reply)
        ? reply
        : undefined;
    case "input":
      return typeof reply === "string" ? reply : undefined;
  }
}

function parseStored(value: unknown): Stored | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("status" in value) || !("id" in value)) return undefined;
  // SAFETY: only open() and reply() write under PREFIX, and both write a
  // Stored. The checks above reject anything else that ended up there.
  return value as Stored;
}
