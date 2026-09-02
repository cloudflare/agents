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
 * Thrown when a message still exceeds the SQLite row budget after every
 * offloadable string and file part has been moved to attachment storage.
 * Sessions never truncates content to make a row fit.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class SessionMessageTooLargeError extends Error {
  readonly messageId: string;
  readonly bytes: number;
  readonly maxBytes: number;

  constructor(messageId: string, bytes: number, maxBytes: number) {
    super(
      `Message "${messageId}" is ${bytes} bytes after offload; the row budget is ${maxBytes}.`
    );
    this.name = "SessionMessageTooLargeError";
    this.messageId = messageId;
    this.bytes = bytes;
    this.maxBytes = maxBytes;
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
 * Thrown by the `attachments` API when a pointer's payload is missing from
 * the store. History reads never throw this — they degrade the part to a
 * marker instead.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class SessionAttachmentMissingError extends Error {
  readonly hash: string;

  constructor(hash: string, location?: string) {
    super(
      location
        ? `Attachment sha256:${hash} is missing from Sessions storage at ${location}.`
        : `Attachment sha256:${hash} is missing from Sessions storage.`
    );
    this.name = "SessionAttachmentMissingError";
    this.hash = hash;
  }
}

/**
 * Thrown before commit when one attachment exceeds the configured size
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
