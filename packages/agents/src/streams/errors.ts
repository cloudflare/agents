/**
 * Error classes for the Streams capability. Each carries a stable `name` so
 * hosts and tests can classify failures without depending on message text.
 */

/**
 * Thrown when `open()` targets a terminal stream, or an append reaches a
 * stream that settled (or was deleted) after the writer was created.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class StreamClosedError extends Error {
  /** The stream that no longer accepts writes. */
  readonly streamId: string;

  constructor(streamId: string, detail: string) {
    super(`Stream "${streamId}" is closed: ${detail}`);
    this.name = "StreamClosedError";
    this.streamId = streamId;
  }
}

/**
 * Thrown when `read()` targets a stream that was never opened (or was
 * deleted). `status()` returns `null` instead, for existence probes.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class StreamNotFoundError extends Error {
  readonly streamId: string;

  constructor(streamId: string) {
    super(
      `Stream "${streamId}" does not exist. Open it before reading, or use ` +
        `status() to probe for existence.`
    );
    this.name = "StreamNotFoundError";
    this.streamId = streamId;
  }
}

/**
 * Thrown when a chunk or metadata value is not JSON-serializable or exceeds
 * the configured size limit.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class StreamSerializationError extends Error {
  constructor(context: string, detail: string) {
    super(`Cannot serialize ${context}: ${detail}`);
    this.name = "StreamSerializationError";
  }
}
