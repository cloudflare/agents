/**
 * Error classes for the Sessions capability. Each carries a stable `name` so
 * hosts and tests can classify failures without depending on message text.
 */

/**
 * Thrown when `updateMessage()` targets a message id that does not exist in
 * the session. Reads return `null` instead, for existence probes.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class SessionMessageNotFoundError extends Error {
  readonly sessionId: string;
  readonly messageId: string;

  constructor(sessionId: string, messageId: string) {
    super(
      `Message "${messageId}" does not exist in session "${sessionId}". ` +
        `Append it first, or use getMessage() to probe for existence.`
    );
    this.name = "SessionMessageNotFoundError";
    this.sessionId = sessionId;
    this.messageId = messageId;
  }
}

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

/**
 * Thrown when an attachment operation needs a store but none is configured.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class SessionAttachmentStoreMissingError extends Error {
  constructor(operation: string) {
    super(
      `${operation} requires an attachment store. Construct the Sessions ` +
        "capability with { attachments: { store } } (a @cloudflare/shell " +
        "Workspace satisfies the store interface)."
    );
    this.name = "SessionAttachmentStoreMissingError";
  }
}

/**
 * Thrown by the `attachments` API when a pointer's payload is missing from
 * the store. History reads never throw this — they degrade the part to a
 * marker instead.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class SessionAttachmentMissingError extends Error {
  readonly hash: string;

  constructor(hash: string, path: string) {
    super(`Attachment sha256:${hash} is missing from the store at ${path}.`);
    this.name = "SessionAttachmentMissingError";
    this.hash = hash;
  }
}

/**
 * Thrown before storage when one attachment exceeds the configured memory
 * ceiling.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class SessionAttachmentTooLargeError extends Error {
  readonly bytes: number;
  readonly maxBytes: number;

  constructor(bytes: number, maxBytes: number) {
    super(`Attachment is ${bytes} bytes; the configured limit is ${maxBytes}.`);
    this.name = "SessionAttachmentTooLargeError";
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

/**
 * Wraps a failure from the configured attachment store with path context.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class SessionAttachmentStoreError extends Error {
  readonly path: string;

  constructor(path: string, operation: string, cause: unknown) {
    super(
      `Attachment store ${operation} failed for ${path}: ` +
        (cause instanceof Error ? cause.message : String(cause))
    );
    this.name = "SessionAttachmentStoreError";
    this.path = path;
    this.cause = cause;
  }
}
