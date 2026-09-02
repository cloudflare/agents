/**
 * Error classes for the Sessions capability. Each carries a stable `name` so
 * hosts and tests can classify failures without depending on message text.
 */

/**
 * Thrown when a message is not JSON-serializable.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class SessionSerializationError extends Error {
  constructor(context: string, detail: string) {
    super(`Cannot serialize ${context}: ${detail}`);
    this.name = "SessionSerializationError";
  }
}

/**
 * Thrown by `search()` when FTS indexing is disabled. Construct the
 * capability with `searchIndexing: true` to maintain the index.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class SessionSearchDisabledError extends Error {
  constructor() {
    super(
      "Session search requires the FTS index. Construct the Sessions " +
        "capability with { searchIndexing: true } to maintain it."
    );
    this.name = "SessionSearchDisabledError";
  }
}
